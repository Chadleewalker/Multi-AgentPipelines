// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// One supervisor authority with scoped child operations — DESIGN.md §3.10, §4.12, §7, §8.
//
// `runner/lock.js` gives one canonical target one live coordinator, host-globally. That is
// exactly right while every coordinator is a peer: a run, a preparation batch, an author or a
// proof each want the whole project to themselves, and the loser is refused by the winner's
// name. It is the wrong shape the moment a project supervisor wants to RUN those commands —
// its own preparation and its own implementation children then contend with their own parent
// and with each other, as unrelated strangers, and the only way through is to give up the
// exclusion that keeps two writers off one Beads queue.
//
// So this module adds ONE thing to that layer and inherits everything else:
//
//   THE LEASE IS THE LOCK. A supervisor takes the same host-global canonical-target authority
//   `lock.acquire` takes, with its supervisor id as the record's `runId`. That is what makes
//   every standalone coordinator — `runner/run.js`, `scripts/prepare-batch.js`,
//   `scripts/author-tests.js`, `scripts/prove-tests.js` — refuse by the supervisor's own name
//   with no second exclusion primitive to keep in step, and it is why identity, liveness,
//   crash takeover and preparation uncertainty all keep working unchanged. A sidecar record
//   beside the lock says "this holder is a supervisor" and carries the lease token; nothing
//   in it can grant anything the lock did not already grant.
//
//   AUTHORITY IS A HOST RECORD, NOT A FILE YOU HOLD. A child is admitted only when a grant
//   record written by a LIVE parent, outside every model-editable tree, matches the presented
//   authority byte for byte, names this canonical target, is unspent, unexpired, unsettled,
//   and was issued for the scope the entry point is asking for. Copying the authority file or
//   exporting the environment variable therefore buys nothing: the record is the authority and
//   the file is only a way to name it. Every refusal is decided before Beads, Git, Docker or
//   network mutation, and no refusal edits or removes an ownership record — a refusal that
//   rewrote state would be a way to attack the thing it protects.
//
//   TWO SECTIONS, NOT ONE LOCK. Two authorized children may be live at once; what may never
//   overlap is a Beads write with another Beads write, or an integration publication with
//   another integration publication. Those are named host-global critical sections keyed on
//   (canonical target, section), and they are INDEPENDENT resources — otherwise "two workers
//   live together" would have no content left, since both workers do both things.
//
// Node built-ins only, synchronous, no container engine and no network — the same constraints
// `runner/lock.js` works under, and for the same reason: this runs inside startup gates and
// exit paths that cannot await.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const lock = require('./lock');

// The two scopes a child operation can be granted, and the two host-global critical sections
// an admitted child may enter. Both are closed sets on purpose: a child that could name a
// third scope, or reach for a third section, would be widening its own authority.
const SCOPES = ['preparation', 'implementation'];
const SECTIONS = ['beads-write', 'integration-publish'];

// The channel both existing entry paths read their child authority from. Deliberately an
// environment variable naming a FILE rather than a new flag: no coordinator's command line
// changes, so an operator's muscle memory and every script that shells one keep working.
const AUTHORITY_ENV = 'PIPELINE_CHILD_AUTHORITY';

// A grant that outlives its usefulness is still evidence; a grant that outlives the machine's
// patience is not authority. Bounded so a forgotten child cannot hold a scope open forever.
const MAX_TTL_MS = 24 * 60 * 60 * 1000;
// How long a child waits for a busy critical section before giving up. Long enough for a real
// Beads transaction or a real push behind another worker, short enough that a wedged section
// becomes a reported failure rather than a run that never ends.
const SECTION_WAIT_MS = 120000;
const SECTION_POLL_MS = 50;

// ---- where the records live -------------------------------------------------------------
// Beside the host-global lock authority, never inside a pipeline checkout: two checkouts
// naming one canonical target must see one supervisor, and no model-editable tree may hold
// the thing that decides who may write.

function supervisorDir(target) {
  return `${lock.globalLockPath(target)}.supervisor`;
}
const leaseFile = (target) => path.join(supervisorDir(target), 'lease.json');
const grantsDir = (target) => path.join(supervisorDir(target), 'grants');
const grantFile = (target, nonce) => path.join(grantsDir(target), `${nonce}.json`);
const sectionsDir = (target) => path.join(supervisorDir(target), 'sections');
const sectionFile = (target, section) => path.join(sectionsDir(target), `${section}.section`);

function readJson(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : null;
  } catch { return null; }             // half-written by a process that died mid-write
}

// Replace a record atomically: an in-place truncate leaves an interval where a live record
// reads as absent, and absent is the answer that lets somebody else take over.
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const scratch = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(scratch, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(scratch, file);
  } finally {
    try { fs.unlinkSync(scratch); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}

function removeFile(file) {
  if (!file) return;
  try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

// Exclusive create — the atom section entry rests on. Two processes racing here, one gets the
// file and the other gets EEXIST; nobody gets a shared section.
function tryCreate(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let fd;
  try { fd = fs.openSync(file, 'wx', 0o600); }
  catch (e) { if (e.code === 'EEXIST') return false; throw e; }
  try { fs.writeSync(fd, `${JSON.stringify(value, null, 2)}\n`); } finally { fs.closeSync(fd); }
  return true;
}

// ---- integrity ---------------------------------------------------------------------------

// Key order is not authority. A record round-tripped through a file, an environment and a
// second JSON.parse must compare equal to the one the parent wrote, and a record with one
// extra field must not.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function hashOf(body) {
  return crypto.createHash('sha256').update(canonical(body)).digest('hex');
}

function sealed(body) {
  return { ...body, recordHash: hashOf(body) };
}

// A record we cannot prove we wrote is not a record we may act on. Same rule the preparation
// uncertainty markers already follow: tampering is refused, never believed.
function unseal(record) {
  if (!record || typeof record !== 'object' || typeof record.recordHash !== 'string') return null;
  const body = { ...record };
  delete body.recordHash;
  return hashOf(body) === record.recordHash ? record : null;
}

// ---- the lease ---------------------------------------------------------------------------

function leaseRecordFor(id, target, token, ownership) {
  return sealed({
    schema: 1,
    kind: 'supervisor-lease',
    target,
    id: String(id),
    token,
    runId: String(id),
    ownerToken: ownership && ownership.token ? String(ownership.token) : null,
    startedAt: new Date().toISOString(),
    ...lock.livenessFields(),
  });
}

// The lease sidecar is only believed while the lock record still agrees with it: a lease naming
// a holder the lock no longer knows is a leftover, not a supervisor. Returns the record plus
// whether that holder is still the process it says it is, decided by `runner/lock.js` — the
// liveness rules live in one place or they drift.
function readLease(target) {
  const record = unseal(readJson(leaseFile(target)));
  if (!record || record.kind !== 'supervisor-lease' || record.target !== target) return null;
  const held = readJson(lock.globalLockPath(target));
  if (!held || held.runId !== record.id || held.pid !== record.pid) return null;
  return { record, live: lock.isHolderLive(held) && lock.isHolderLive(record) };
}

function holderFrom(record, live) {
  return {
    id: record.id,
    pid: record.pid,
    since: record.startedAt || null,
    host: record.host || null,
    live: !!live,
  };
}

// A supervisor is PRESENT for admission purposes while it is live, and also while it is gone
// but left unsettled children behind: taking a dead supervisor's project as a stranger, with
// its children still outstanding, is the silent takeover C5 exists to forbid.
function supervisorPresence(targetRepoPath) {
  const target = lock.canonicalTarget(targetRepoPath);
  const lease = readLease(target);
  if (!lease) return null;
  if (lease.live) return holderFrom(lease.record, true);
  return outstanding(targetRepoPath).length ? holderFrom(lease.record, false) : null;
}

function leaseHolder(targetRepoPath) {
  const lease = readLease(lock.canonicalTarget(targetRepoPath));
  return lease ? holderFrom(lease.record, lease.live) : null;
}

// The lease this process holds, or an error naming why the caller is not the parent. A child
// holds an ADMISSION and no token, so this is also what stops a child granting itself
// anything: there is no way to reach a lease record from the far side of `admit`.
function ourLease(lease) {
  if (!lease || typeof lease !== 'object' || typeof lease.token !== 'string' || !lease.token) {
    return { ok: false, error: 'a live supervisor lease is required; an admission is not a lease' };
  }
  let target;
  try { target = lock.canonicalTarget(lease.target); }
  catch { return { ok: false, error: 'the lease names no canonical target' }; }
  const held = readLease(target);
  if (!held) return { ok: false, error: `no supervisor lease is recorded for ${target}` };
  if (held.record.token !== lease.token || held.record.id !== lease.id) {
    return { ok: false, error: `the supervisor lease for ${target} is now held by ${held.record.id}` };
  }
  if (held.record.pid !== process.pid) {
    return { ok: false, error: `the supervisor lease for ${target} belongs to pid ${held.record.pid}, not this process` };
  }
  if (!held.live) return { ok: false, error: `the supervisor lease for ${target} is no longer live` };
  return { ok: true, target, record: held.record };
}

// acquire(repoRoot, targetRepoPath, supervisorId, options)
//   -> { ok: true,  tookOver: false, lease }
//   -> { ok: true,  tookOver: true, previous: { id, pid, outstanding }, lease }
//   -> { ok: false, holder: { id, pid, since, host }, outstanding: [...] }
//
// `repoRoot` selects only the observer mirror, exactly as in `lock.acquire`: two pipeline
// checkouts naming one canonical target contend, which is the whole point of a host-global
// authority. `options.reclaim` is a licence over a PROVABLY DEAD parent that left evidence,
// and never a licence over a live one — a bounded retry that eventually wins would be the
// two-writers bug wearing a hat.
function acquire(repoRoot, targetRepoPath, supervisorId, options = {}) {
  if (!repoRoot || typeof repoRoot !== 'string') throw new Error('supervisor: a pipeline repo root is required');
  const id = String(supervisorId || '').trim();
  if (!id) throw new Error('supervisor: a supervisor id is required');
  const target = lock.canonicalTarget(targetRepoPath);

  // Decided BEFORE `lock.acquire`, because `lock.acquire` seizes a dead holder's record on
  // sight. A dead parent with unsettled children must be refused with its evidence intact,
  // and a refusal that had already rewritten the record would have taken it over anyway.
  const existing = readLease(target);
  if (existing) {
    const live = outstanding(targetRepoPath);
    if (existing.live) {
      return { ok: false, holder: holderFrom(existing.record, true), outstanding: live };
    }
    if (live.length && options.reclaim !== true) {
      return {
        ok: false,
        holder: holderFrom(existing.record, false),
        outstanding: live,
        reason: `supervisor ${existing.record.id} (pid ${existing.record.pid}) is gone but left`
          + ` ${live.length} unsettled child operation(s): ${live.map((e) => `${e.nonce} (${e.scope} ${e.issueId || 'no issue'}, ${e.state})`).join(', ')}.`
          + ' Reclaim explicitly once you have settled or stopped them.',
      };
    }
  }
  const priorOutstanding = existing ? outstanding(targetRepoPath) : [];

  // An explicit reclaim of a dead parent may pass an uncertain preparation marker; it may
  // never delete one. The marker outlives the reclaim and still needs its own acknowledgement.
  const held = lock.acquire(repoRoot, targetRepoPath, id,
    options.reclaim === true ? { allowPreparationRecovery: true } : undefined);
  if (!held.ok) {
    const h = held.holder || {};
    return {
      ok: false,
      holder: {
        id: h.runId || '(unknown owner)',
        pid: h.pid || null,
        since: h.since || null,
        host: h.host || null,
        live: true,
        ...(h.preparationUncertain ? { preparationUncertain: true, nonce: h.nonce } : {}),
      },
      outstanding: priorOutstanding,
    };
  }
  const token = crypto.randomBytes(24).toString('hex');
  const record = leaseRecordFor(id, target, token, held.ownership);
  writeJson(leaseFile(target), record);
  const lease = {
    id, token, target, pid: process.pid,
    since: record.startedAt,
    ownership: held.ownership,
  };
  const tookOver = !!held.tookOver || !!existing;
  return {
    ok: true,
    tookOver,
    ...(tookOver ? {
      previous: {
        id: (existing && existing.record.id) || (held.previous && held.previous.runId) || '(unknown supervisor)',
        pid: (existing && existing.record.pid) || (held.previous && held.previous.pid) || null,
        outstanding: priorOutstanding,
      },
    } : {}),
    lease,
  };
}

// Release ours and only ours. Grants are NOT swept: an unsettled child is evidence, and
// evidence that disappears when its parent tidies up is evidence nobody can act on.
function release(repoRoot, targetRepoPath, lease) {
  const target = lock.canonicalTarget(targetRepoPath);
  const current = unseal(readJson(leaseFile(target)));
  if (current && lease && current.token === lease.token && current.pid === process.pid) {
    removeFile(leaseFile(target));
  }
  if (lease && lease.ownership) lock.release(repoRoot, targetRepoPath, lease.ownership);
}

// ---- grants ------------------------------------------------------------------------------

function readGrant(target, nonce) {
  const record = unseal(readJson(grantFile(target, nonce)));
  if (!record || record.kind !== 'supervisor-grant' || record.target !== target
      || record.nonce !== nonce || !record.authority) return null;
  return record;
}

// Every grant not yet settled by its parent, oldest first. A grant is NEVER removed by
// inference — not by expiry, not by the parent dying, not by a reclaim — so this is the one
// place a person looks to find out what a killed supervisor left behind.
function outstanding(targetRepoPath) {
  const target = lock.canonicalTarget(targetRepoPath);
  const dir = grantsDir(target);
  let names;
  try { names = fs.readdirSync(dir); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const rows = [];
  for (const name of names.filter((n) => !n.startsWith('.')).sort()) {
    if (!/^[a-f0-9]{32,128}\.json$/.test(name)) throw new Error(`supervisor: unexpected grant record ${name}`);
    const nonce = name.slice(0, -5);
    const record = readGrant(target, nonce);
    if (!record) throw new Error(`supervisor: tampered or unreadable grant record ${name}`);
    if (record.state !== 'granted' && record.state !== 'redeemed') continue;
    rows.push({
      nonce,
      scope: record.authority.scope,
      issueId: record.authority.issueId,
      batch: record.authority.batch,
      state: record.state,
      expiresAt: record.authority.expiresAt,
      createdAtMs: record.createdAtMs,
    });
  }
  rows.sort((a, b) => (a.createdAtMs - b.createdAtMs) || (a.nonce < b.nonce ? -1 : 1));
  return rows.map(({ createdAtMs, ...row }) => row);
}

// grant(lease, { scope, issueId, batch, ttlMs }) -> { ok, authority } | { ok: false, error }
// Narrow by construction: one scope, one issue, one batch, one expiry, one unguessable nonce,
// and the canonical target it is good for. The record is what authorises; the returned object
// is only the child's way of naming it.
function grant(lease, options = {}) {
  const held = ourLease(lease);
  if (!held.ok) return { ok: false, error: `supervisor: cannot grant child authority — ${held.error}` };
  const scope = String(options.scope || '');
  if (!SCOPES.includes(scope)) {
    return { ok: false, error: `supervisor: '${scope}' is not a child scope (${SCOPES.join(', ')})` };
  }
  const ttlMs = Number(options.ttlMs);
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    return { ok: false, error: 'supervisor: child authority must expire — ttlMs must be a positive number of milliseconds' };
  }
  if (ttlMs > MAX_TTL_MS) {
    return { ok: false, error: `supervisor: child authority may not outlive ${MAX_TTL_MS}ms` };
  }
  const now = Date.now();
  const authority = {
    nonce: crypto.randomBytes(24).toString('hex'),
    scope,
    issueId: options.issueId === undefined || options.issueId === null ? null : String(options.issueId),
    batch: options.batch === undefined || options.batch === null ? null : String(options.batch),
    target: held.target,
    parent: { id: held.record.id, pid: held.record.pid },
    expiresAt: new Date(now + ttlMs).toISOString(),
  };
  const record = sealed({
    schema: 1,
    kind: 'supervisor-grant',
    target: held.target,
    nonce: authority.nonce,
    authority,
    state: 'granted',
    createdAt: new Date(now).toISOString(),
    createdAtMs: now,
    ttlMs,
  });
  if (!tryCreate(grantFile(held.target, authority.nonce), record)) {
    return { ok: false, error: 'supervisor: a grant record with that nonce already exists' };
  }
  return { ok: true, authority };
}

// settle(lease, nonce, { outcome }) — the ONLY thing that removes a grant from `outstanding`.
// Only the parent may settle: a child declaring itself complete is exactly the evidence a
// person needs never to be able to trust.
function settle(lease, nonce, options = {}) {
  const held = ourLease(lease);
  if (!held.ok) return { ok: false, error: `supervisor: cannot settle child authority — ${held.error}` };
  const outcome = String(options.outcome || '');
  if (!['complete', 'released'].includes(outcome)) {
    return { ok: false, error: `supervisor: '${outcome}' is not a settlement outcome (complete, released)` };
  }
  const record = readGrant(held.target, String(nonce || ''));
  if (!record) return { ok: false, error: `supervisor: no grant record for ${nonce}` };
  if (record.authority.parent.id !== held.record.id || record.authority.parent.pid !== held.record.pid) {
    return { ok: false, error: `supervisor: ${nonce} was granted by ${record.authority.parent.id}, not by this supervisor` };
  }
  if (record.state !== 'granted' && record.state !== 'redeemed') {
    return { ok: false, error: `supervisor: ${nonce} was already settled as ${record.state}` };
  }
  const body = { ...record };
  delete body.recordHash;
  writeJson(grantFile(held.target, record.nonce), sealed({
    ...body, state: outcome, settledAt: new Date().toISOString(), settledBy: held.record.id,
  }));
  return { ok: true };
}

// Parent-side recovery query for a caller that durably recorded settlement intent but lost
// the result. This does not mutate the grant: it reports only what the authenticated host
// record proves, so an unreadable, foreign or released record cannot be guessed into success.
function settlementState(lease, nonce) {
  const held = ourLease(lease);
  if (!held.ok) return { ok: false, error: `supervisor: cannot inspect child settlement — ${held.error}` };
  const record = readGrant(held.target, String(nonce || ''));
  if (!record) return { ok: false, error: `supervisor: no grant record for ${nonce}` };
  if (record.authority.parent.id !== held.record.id || record.authority.parent.pid !== held.record.pid) {
    return { ok: false, error: `supervisor: ${nonce} was granted by another supervisor` };
  }
  if (record.state === 'complete') return { ok: true, settled: true, nonce: record.nonce };
  if (record.state === 'granted' || record.state === 'redeemed') {
    return { ok: true, settled: false, nonce: record.nonce };
  }
  return { ok: false, error: `supervisor: grant ${nonce} is settled as ${record.state}, not complete` };
}

// ---- admission -----------------------------------------------------------------------------

const REASONS = ['no-authority', 'forged', 'replayed', 'expired', 'wrong-target',
  'wrong-parent', 'released', 'wrong-scope', 'supervisor-held'];

// A refusal a person cannot act on has not helped anybody: every one of them names the nonce
// that was presented and the parent it claims, so the operator can find the grant and the
// process without reading this file.
function refuse(reason, authority, detail) {
  const nonce = authority && authority.nonce ? String(authority.nonce) : '(no nonce)';
  const parent = authority && authority.parent && authority.parent.id
    ? `${authority.parent.id} (pid ${authority.parent.pid === undefined ? 'unknown' : authority.parent.pid})`
    : '(no parent named)';
  return {
    ok: false,
    reason,
    message: `child authority ${nonce} claiming supervisor ${parent} refused (${reason}): ${detail}`,
  };
}

// admit(authority, { targetRepoPath, scope, now }) -> { ok, admission } | { ok: false, reason, message }
//
// The five conjuncts of criterion 2 — host record, parent liveness, target, nonce and
// requested scope — are checked one at a time and in an order that answers the question the
// operator actually asked. Target before expiry, so authority presented at the wrong project
// says so rather than blaming the clock; parent and settlement before expiry, for the same
// reason. Nothing here mutates until the answer is yes.
function admit(authority, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const scope = String(options.scope || '');
  if (!authority || typeof authority !== 'object' || Array.isArray(authority)) {
    return refuse('no-authority', null, 'no child authority record was presented');
  }
  const nonce = String(authority.nonce || '');
  if (!/^[a-f0-9]{32,128}$/.test(nonce)) {
    return refuse('forged', authority, 'the nonce is not an unguessable hexadecimal identifier');
  }
  let target;
  try { target = lock.canonicalTarget(options.targetRepoPath); }
  catch (e) { return refuse('wrong-target', authority, `the entry names no canonical target: ${e.message}`); }

  let claimed = null;
  try { claimed = authority.target ? lock.canonicalTarget(authority.target) : null; } catch { claimed = null; }
  if (claimed !== target) {
    return refuse('wrong-target', authority,
      `it is good for ${claimed || '(no target)'}, and this entry is for ${target}`);
  }

  const record = readGrant(target, nonce);
  if (!record) return refuse('forged', authority, `no supervisor on this host granted ${nonce} for ${target}`);
  if (canonical(record.authority) !== canonical(authority)) {
    return refuse('forged', authority, 'it does not match the host record of that grant, field for field');
  }

  const lease = readLease(target);
  if (!lease || !lease.live) {
    return refuse('wrong-parent', authority,
      `the granting supervisor is no longer live for ${target}; the grant stays outstanding as evidence`);
  }
  if (lease.record.id !== record.authority.parent.id || lease.record.pid !== record.authority.parent.pid) {
    return refuse('wrong-parent', authority,
      `${target} is now supervised by ${lease.record.id} (pid ${lease.record.pid}), not by the parent this authority names`);
  }

  if (record.state !== 'granted' && record.state !== 'redeemed') {
    return refuse('released', authority, `its parent already settled it as ${record.state}`);
  }
  if (record.state === 'redeemed') {
    return refuse('replayed', authority, 'it was already redeemed once; child authority is single use');
  }
  const expiresAt = Date.parse(String(record.authority.expiresAt));
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    return refuse('expired', authority, `it expired at ${record.authority.expiresAt}`);
  }
  if (!SCOPES.includes(scope)) {
    return refuse('wrong-scope', authority, `'${scope}' is not a child scope (${SCOPES.join(', ')})`);
  }
  if (record.authority.scope !== scope) {
    return refuse('wrong-scope', authority,
      `it was granted for ${record.authority.scope} and this entry is ${scope}`);
  }

  const body = { ...record };
  delete body.recordHash;
  writeJson(grantFile(target, nonce), sealed({
    ...body, state: 'redeemed', redeemedAt: new Date(now).toISOString(), redeemedPid: process.pid,
  }));
  return {
    ok: true,
    admission: {
      nonce,
      scope: record.authority.scope,
      issueId: record.authority.issueId,
      batch: record.authority.batch,
      target,
      parent: { ...record.authority.parent },
      sections: [...SECTIONS],
    },
  };
}

// admitEntry(entry, { targetRepoPath, repoRoot, env, now })
//   -> { ok: true,  mode: 'supervisor-child', admission }
//   -> { ok: true,  mode: 'standalone' }
//   -> { ok: false, mode: 'refused', reason, message }
//
// THE ONE ADMISSION STEP both existing entry paths call, first, ahead of every lock
// acquisition and ahead of any Beads, Git, Docker or network mutation. Reads are unavoidable
// and are not the harm — the config has to be read to know which project this even is.
function admitEntry(entry, options = {}) {
  const env = options.env || process.env;
  const scope = String(entry || '');
  if (!SCOPES.includes(scope)) {
    return { ok: false, mode: 'refused', reason: 'wrong-scope',
      message: `supervisor: '${scope}' is not an entry scope (${SCOPES.join(', ')})` };
  }
  const file = String(env[AUTHORITY_ENV] || '').trim();
  if (file) {
    const authority = readJson(file);
    if (!authority) {
      return { ok: false, mode: 'refused', reason: 'no-authority',
        message: `${AUTHORITY_ENV} names ${file}, which holds no readable child authority record` };
    }
    const admitted = admit(authority, {
      targetRepoPath: options.targetRepoPath, scope, now: options.now,
    });
    if (!admitted.ok) {
      return { ok: false, mode: 'refused', reason: admitted.reason, message: admitted.message };
    }
    return { ok: true, mode: 'supervisor-child', admission: admitted.admission };
  }
  const holder = supervisorPresence(options.targetRepoPath);
  if (holder) {
    return {
      ok: false,
      mode: 'refused',
      reason: 'supervisor-held',
      message: `${options.targetRepoPath} is under supervisor ${holder.id} (pid ${holder.pid}`
        + `${holder.live ? '' : ', gone'}${holder.since ? `, since ${holder.since}` : ''})`
        + ` and this ${scope} entry presented no child authority.`
        + ` Ask that supervisor for a scoped grant, or wait for it to finish.`,
    };
  }
  return { ok: true, mode: 'standalone' };
}

// A lock-side handle a supervisor child may use for the narrow set of ownership records that
// are keyed on the TARGET rather than on the holder — preparation uncertainty being the one
// that matters, because a preparation worker can outlive its coordinator whether that
// coordinator was standalone or a child. It deliberately cannot rewrite the parent's lease
// record: `runner/lock.js` refuses a delegated handle there.
function childOwnership(admission) {
  if (!admission || !admission.nonce || !admission.target) {
    throw new Error('supervisor: a child admission is required');
  }
  const short = String(admission.nonce).slice(0, 12);
  return {
    runId: `supervisor-child-${short}`,
    token: String(admission.nonce),
    actor: `pipeline-child-${short}`,
    target: lock.canonicalTarget(admission.target),
    authorityFile: lock.globalLockPath(admission.target),
    observerFile: null,
    recoveryOwners: [],
    keepForRecovery: false,
    delegation: {
      nonce: String(admission.nonce),
      parentId: admission.parent && admission.parent.id,
      parentPid: admission.parent && admission.parent.pid,
    },
  };
}

// ---- the two critical sections -------------------------------------------------------------

// An admission is checked against the host record before it can enter anything: a hand-made
// admission object naming a nonce nobody redeemed opens no section, and a section outside
// SECTIONS is refused whatever the admission says. Together those are the two ways a child
// could try to widen its own scope.
function verifyAdmission(admission, section) {
  if (!SECTIONS.includes(section)) {
    return { ok: false, reason: 'wrong-scope',
      message: `supervisor: '${section}' is not a critical section (${SECTIONS.join(', ')})` };
  }
  if (!admission || typeof admission !== 'object' || !Array.isArray(admission.sections)
      || !admission.sections.includes(section)) {
    return { ok: false, reason: 'wrong-scope',
      message: `supervisor: this admission was not granted the ${section} section` };
  }
  let target;
  try { target = lock.canonicalTarget(admission.target); }
  catch { return { ok: false, reason: 'wrong-target', message: 'supervisor: the admission names no canonical target' }; }
  const record = readGrant(target, String(admission.nonce || ''));
  if (!record || record.state !== 'redeemed' || record.authority.scope !== admission.scope) {
    return { ok: false, reason: 'forged',
      message: `supervisor: no redeemed grant record backs admission ${admission.nonce} for ${target}` };
  }
  return { ok: true, target };
}

// tryEnterSection(admission, section) -> { ok: true, held } | { ok: false, holder }
// Host-global mutual exclusion per (canonical target, section). The two sections are
// INDEPENDENT resources, so one worker may publish while another writes Beads; what may never
// happen is two workers inside one named section at once. A section whose holder is provably
// gone is taken over, on the same evidence `runner/lock.js` uses — a section nobody can be
// shown to be in is the block-forever case.
function tryEnterSection(admission, section) {
  const verified = verifyAdmission(admission, section);
  if (!verified.ok) return { ok: false, reason: verified.reason, message: verified.message, holder: null };
  const file = sectionFile(verified.target, section);
  const token = crypto.randomBytes(16).toString('hex');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const record = sealed({
      schema: 1,
      kind: 'supervisor-section',
      target: verified.target,
      section,
      nonce: String(admission.nonce),
      issueId: admission.issueId === undefined ? null : admission.issueId,
      scope: admission.scope,
      token,
      enteredAt: new Date().toISOString(),
      ...lock.livenessFields(),
    });
    if (tryCreate(file, record)) {
      return { ok: true, held: { file, section, target: verified.target, nonce: record.nonce, token } };
    }
    const current = unseal(readJson(file));
    if (current && lock.isHolderLive(current)) {
      return {
        ok: false,
        reason: 'section-held',
        holder: { nonce: current.nonce, issueId: current.issueId, section, pid: current.pid },
        message: `supervisor: the ${section} section for ${verified.target} is held by child ${current.nonce}`
          + `${current.issueId ? ` (${current.issueId})` : ''}`,
      };
    }
    removeFile(file);                  // the holder is gone: its section is not evidence
  }
  const current = unseal(readJson(file));
  return {
    ok: false,
    reason: 'section-held',
    holder: current
      ? { nonce: current.nonce, issueId: current.issueId, section, pid: current.pid }
      : { nonce: null, issueId: null, section, pid: null },
    message: `supervisor: could not enter the ${section} section for ${verified.target}`,
  };
}

function exitSection(held) {
  if (!held || !held.file) return;
  const current = unseal(readJson(held.file));
  if (current && current.token === held.token) removeFile(held.file);
}

// A synchronous bounded wait, because every caller of a critical section here is a
// synchronous Beads or Git transaction inside an async task body: sleeping on a timer would
// mean releasing the section at the await, which is the opposite of what a section is for.
function sleepSync(ms) {
  const buffer = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buffer, 0, 0, ms);
}

function enterSection(admission, section, options = {}) {
  const deadline = Date.now() + (Number.isFinite(options.timeoutMs) ? options.timeoutMs : SECTION_WAIT_MS);
  let last = tryEnterSection(admission, section);
  while (!last.ok && last.reason === 'section-held' && Date.now() < deadline) {
    sleepSync(Number.isFinite(options.pollMs) ? options.pollMs : SECTION_POLL_MS);
    last = tryEnterSection(admission, section);
  }
  return last;
}

// The wiring both worker entry paths use. With no admission this is a straight passthrough,
// which is exactly what keeps standalone behaviour byte-identical: a standalone coordinator
// already holds the whole target and needs no section at all.
function withSection(admission, section, fn, options = {}) {
  if (!admission) return fn();
  const entered = enterSection(admission, section, options);
  if (!entered.ok) {
    const holder = entered.holder || {};
    throw new Error(`supervisor: could not enter the ${section} section`
      + `${holder.nonce ? ` — held by child ${holder.nonce}${holder.issueId ? ` (${holder.issueId})` : ''}` : ''}`
      + `${entered.message ? `; ${entered.message}` : ''}`);
  }
  try { return fn(); } finally { exitSection(entered.held); }
}

module.exports = {
  SCOPES, SECTIONS, REASONS, AUTHORITY_ENV, MAX_TTL_MS,
  acquire, release, leaseHolder, supervisorPresence,
  grant, settle, settlementState, outstanding,
  admit, admitEntry, childOwnership,
  tryEnterSection, exitSection, enterSection, withSection,
  supervisorDir,
};
