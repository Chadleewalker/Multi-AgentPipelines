// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// The per-project run lock — DESIGN.md §4.12.
//
// §4.8/§4.12 made two *different* projects independent: each run creates and destroys
// only its own network and sidecar. That leaves the other way to corrupt a run, and it
// is the easy one to make by hand: starting the SAME project twice. Two runners draining
// one Beads queue both ask for ready work, both can claim the same issue, and both push a
// branch for it — the host being the sole Beads writer (§4.10) assumes one writer, not
// two. Nothing about the second run looks wrong while it happens.
//
// So a run takes a host-global lock on its target repo before it does anything else, and a
// second run against the same repo is refused by name even when it started from another
// pipeline checkout. A mirror remains under this checkout's `runs/locks/` for the dashboard
// and sweep readers; it is evidence, not the exclusion primitive.
//
// Two properties do all the work here:
//
//   IDENTITY. A project is its target repo, not the string a config spelled it with.
//   Configs write `targetRepoPath` with forward slashes while `path.join` produces
//   backslashes on the Windows host, and a trailing separator is free to appear on either.
//   All of those reach one repo, so all of them must reach one lock — a lock keyed on the
//   raw string protects nothing against the very mistake it exists to catch (a second
//   config, written by hand, naming the same repo differently).
//
//   LIVENESS. A lock left behind by a crashed or killed run must not block the machine
//   forever, so a record whose owner is gone is taken over — and the takeover says whose
//   lock it seized, because "took over" with no id cannot be told apart from an
//   implementation that reports one every time. `process.kill(pid, 0)` alone is not
//   enough to decide "gone": it reports a recycled or foreign pid as alive (EPERM counts
//   as alive), so a record carrying only a pid can refuse to take over after a reboot —
//   which is the block-forever this is meant to prevent. The record therefore carries
//   falsifiable evidence beside the pid (see `isHolderLive` for what each platform can
//   actually prove).
//
// Node built-ins only. Every operation is synchronous: the callers are the runner's
// startup gate and its exit path, and an exit handler cannot await.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const CONTROL_PLANE = require('./control-plane');

// Observer-mirror location. `runs/` is git-ignored, host-only, and already the home of
// everything a run produces; the authoritative exclusion file is globalLockPath().
const LOCK_SUBDIR = path.join('runs', 'locks');

// The uptime counter can be read a moment apart in two processes; only a decrease well
// beyond that is evidence of a reboot.
const UPTIME_SLACK_MS = 5000;
// How much longer than the host's uptime a lock may claim to have existed before we call
// it pre-reboot. Generous on purpose: on a host whose uptime counter stops during sleep,
// a suspended-and-resumed machine looks briefly like a rebooted one, and mistaking a LIVE
// holder for a dead one is the expensive direction of this error.
const PRE_BOOT_GRACE_MS = 15 * 60 * 1000;
const OWNER_TOKEN_KEY = CONTROL_PLANE.beads.ownerMetadata.token;
const OWNER_RUN_KEY = CONTROL_PLANE.beads.ownerMetadata.runId;

// One user on one host gets one authority directory, independent of which pipeline checkout
// launched the runner. The user digest prevents a shared POSIX temp directory from merging
// unrelated users' locks while keeping the path writable on the Windows reference host.
// Tests may re-aim it, but a blank seam is deliberately treated as unset.
function globalLockRoot() {
  const explicit = String(process.env.PIPELINE_GLOBAL_LOCK_DIR || '').trim();
  if (explicit) return path.resolve(explicit);
  const userKey = crypto.createHash('sha256').update(os.homedir()).digest('hex').slice(0, 12);
  return path.join(os.tmpdir(), `multi-agent-pipelines-${userKey}`, 'locks');
}

// ---- project identity ---------------------------------------------------------------

// One repo, one key, however the path was spelled. `path.resolve` folds `.`, `..` and any
// trailing separator; on Windows the separator flip and the case-insensitive filesystem
// are folded too. `realpath` is best effort — it is what makes a symlinked spelling agree
// with the real one, and a path that does not resolve (not created yet) still gets a
// stable key from the resolved form.
function canonicalTarget(targetRepoPath) {
  if (!targetRepoPath || typeof targetRepoPath !== 'string' || !targetRepoPath.trim()) {
    throw new Error('lock: a target repo path is required');
  }
  let p = targetRepoPath.trim();
  // Only on Windows: a backslash is a legal character in a POSIX file name, so rewriting
  // it there would merge two genuinely different repos into one lock.
  if (process.platform === 'win32') p = p.replace(/\//g, '\\');
  p = path.resolve(p);
  try { p = fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p); } catch { /* not created yet */ }
  if (process.platform === 'win32') p = p.toLowerCase();
  return p;
}

// A readable observer-mirror name for whoever finds the file, plus a digest of the
// canonical path. The authority uses the full digest; the slug is only there so
// `ls runs/locks` means something.
function lockPath(repoRoot, targetRepoPath) {
  const canon = canonicalTarget(targetRepoPath);
  const digest = crypto.createHash('sha1').update(canon).digest('hex').slice(0, 12);
  const slug = path.basename(canon).toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 32);
  return path.join(repoRoot, LOCK_SUBDIR, `${slug || 'project'}-${digest}.lock`);
}

// The authoritative path has no pipeline-repo argument on purpose. Two checkouts that name
// the same canonical target must compute the same file or the lock protects only a folder.
function globalLockPath(targetRepoPath) {
  const canon = canonicalTarget(targetRepoPath);
  const digest = crypto.createHash('sha256').update(canon).digest('hex');
  return path.join(globalLockRoot(), `${digest}.lock`);
}

// A preparation worker can outlive the coordinator which held the ordinary target lock.
// Keep that uncertainty beside the host-global lock authority, not in one pipeline checkout,
// so every future runner and standalone planning command sees it before admission.
function preparationUncertainDir(targetRepoPath) {
  return `${globalLockPath(targetRepoPath)}.preparation-uncertain`;
}

function preparationNonce(value) {
  const nonce = String(value || '');
  if (!/^[a-f0-9]{32,64}$/.test(nonce)) throw new Error('lock: preparation nonce must be 32 to 64 lowercase hexadecimal characters');
  return nonce;
}

function preparationMarkerHash(body) {
  return crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

function readPreparationMarker(file, expectedTarget, expectedNonce) {
  const value = readRecord(file);
  if (!value || value.schema !== 1 || value.kind !== 'preparation-uncertain'
      || value.target !== expectedTarget || value.nonce !== expectedNonce
      || typeof value.markerHash !== 'string') {
    throw new Error(`lock: invalid preparation-uncertain marker ${file}`);
  }
  const body = { ...value }; delete body.markerHash;
  if (preparationMarkerHash(body) !== value.markerHash) {
    throw new Error(`lock: tampered preparation-uncertain marker ${file}`);
  }
  return value;
}

function listPreparationUncertain(targetRepoPath) {
  const target = canonicalTarget(targetRepoPath);
  const dir = preparationUncertainDir(targetRepoPath);
  let names;
  try { names = fs.readdirSync(dir); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`lock: preparation uncertainty path is not a real directory: ${dir}`);
  const visible = names.filter((name) => !name.startsWith('.')).sort();
  for (const name of visible) {
    if (!/^[a-f0-9]{32,64}\.json$/.test(name)) throw new Error(`lock: unexpected preparation uncertainty marker ${name}`);
  }
  return visible.map((name) => {
    const nonce = name.slice(0, -5);
    return readPreparationMarker(path.join(dir, name), target, nonce);
  });
}

function preparationHolder(marker, targetRepoPath) {
  return {
    runId: `preparation-uncertain:${marker.batch || 'unknown'}/${marker.issueId || 'unknown'}`,
    pid: Number.isInteger(marker.pid) ? marker.pid : null,
    since: marker.createdAt || null,
    host: marker.host || null,
    lockFile: preparationUncertainDir(targetRepoPath),
    preparationUncertain: true,
    nonce: marker.nonce,
    issueId: marker.issueId || null,
    batch: marker.batch || null,
    phase: marker.phase || null,
  };
}

function markPreparationUncertain(ownership, data = {}) {
  const rec = ownedRecord(ownership);
  const nonce = preparationNonce(data.nonce);
  const dir = preparationUncertainDir(rec.target);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('lock: preparation uncertainty path is not a real directory');
  const body = {
    schema: 1,
    kind: 'preparation-uncertain',
    target: rec.target,
    nonce,
    batch: String(data.batch || '').slice(0, 128),
    issueId: String(data.issueId || '').slice(0, 256),
    phase: String(data.phase || '').slice(0, 64),
    pid: Number.isInteger(data.pid) && data.pid > 0 ? data.pid : null,
    host: os.hostname(),
    createdAt: new Date().toISOString(),
  };
  const marker = { ...body, markerHash: preparationMarkerHash(body) };
  const file = path.join(dir, `${nonce}.json`);
  let fd;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(marker, null, 2) + '\n', 'utf8');
    fs.fsyncSync(fd);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
  return marker;
}

function clearPreparationUncertain(ownership, nonceValue) {
  const rec = ownedRecord(ownership);
  const nonce = preparationNonce(nonceValue);
  const dir = preparationUncertainDir(rec.target);
  const file = path.join(dir, `${nonce}.json`);
  readPreparationMarker(file, rec.target, nonce);
  removeFile(file);
  try { fs.rmdirSync(dir); } catch (e) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(e.code)) throw e; }
}

// ---- liveness -------------------------------------------------------------------------

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';       // exists, owned by someone else
  }
}

// Linux: field 22 of /proc/<pid>/stat is the process start time in clock ticks since
// boot — an exact identity for a pid, which is what makes recycled pids decidable rather
// than merely improbable. The comm field can contain spaces and parentheses, so the parse
// starts after its closing paren.
function procStartTicks(pid) {
  if (process.platform !== 'linux') return null;
  let raw;
  try { raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { return null; }
  const close = raw.lastIndexOf(')');
  if (close < 0) return null;
  const fields = raw.slice(close + 1).trim().split(/\s+/);
  return fields.length > 19 ? fields[19] : null;
}

// Did this host reboot since the record was written? Both tests use the uptime counter
// rather than a stored boot timestamp, because a boot timestamp computed as
// `now - uptime` drifts between two processes and would have to be compared with a
// tolerance in the direction that matters.
function rebootedSince(rec) {
  const up = os.uptime();
  if (typeof up !== 'number' || !Number.isFinite(up)) return false;
  // The counter went backwards: it only resets at boot.
  if (typeof rec.uptimeSeconds === 'number' && up * 1000 + UPTIME_SLACK_MS < rec.uptimeSeconds * 1000) return true;
  // The lock claims to predate the machine being up: it was taken before this boot.
  if (typeof rec.takenAtMs === 'number') {
    const elapsed = Date.now() - rec.takenAtMs;
    if (elapsed > up * 1000 + PRE_BOOT_GRACE_MS) return true;
  }
  return false;
}

// True only when the recorded holder is still the process it says it is. Anything we can
// disprove counts as gone — a lock nobody can be shown to hold is the block-forever case.
function isHolderLive(rec) {
  if (!rec || !Number.isInteger(rec.pid)) return false;
  // A cleanly ended run with unfinished claims deliberately leaves its ownership record
  // behind. It is recoverable immediately; the Node process need not have exited yet.
  if (rec.releasedAt) return false;
  if (rebootedSince(rec)) return false;
  if (!pidAlive(rec.pid)) return false;
  // Where the OS will tell us when that pid started, a mismatch means the pid was
  // recycled and the holder is gone. Where it will not (Windows, macOS), the reboot test
  // above is the falsifier, and a pid recycled *within* one boot reads as still held —
  // the safe direction: a spurious refusal is visible and recoverable, a spurious
  // takeover puts two runners on one queue.
  const ticks = procStartTicks(rec.pid);
  if (ticks !== null && rec.procStart !== null && rec.procStart !== undefined && ticks !== rec.procStart) return false;
  return true;
}

// ---- the record ------------------------------------------------------------------------

function selfRecord(runId, canonTarget, observerFile, recoveryOwners = []) {
  const ownerToken = crypto.randomUUID();
  return {
    runId: String(runId),
    ownerToken,
    actor: `pipeline-run-${ownerToken.slice(0, 12)}`,
    pid: process.pid,
    target: canonTarget,
    observerFile,
    claims: [],
    recoveryOwners,
    host: os.hostname(),
    platform: process.platform,
    startedAt: new Date().toISOString(),
    takenAtMs: Date.now(),
    uptimeSeconds: Math.floor(os.uptime()),
    procStart: procStartTicks(process.pid),
  };
}

function readRecord(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  try {
    const rec = JSON.parse(raw);
    return rec && typeof rec === 'object' ? rec : null;
  } catch {
    return null;                     // half-written by a run that died mid-acquire
  }
}

// Replace a record atomically. An in-place truncate creates a dangerous interval where a
// live holder looks unreadable and a challenger may take it over. The temp file is in the
// same directory so rename remains one filesystem operation.
function writeRecord(file, rec) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const scratch = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(scratch, JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(scratch, file);
  } finally {
    try { fs.unlinkSync(scratch); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}

function removeFile(file) {
  if (!file) return;
  try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

function recoveryOwner(rec) {
  if (!rec || !rec.ownerToken || !rec.runId || !rec.actor) return null;
  return { runId: String(rec.runId), token: String(rec.ownerToken), actor: String(rec.actor) };
}

function recoveryOwnersAfter(rec) {
  const owners = Array.isArray(rec && rec.recoveryOwners) ? rec.recoveryOwners.filter(Boolean) : [];
  const prior = recoveryOwner(rec);
  if (prior && !owners.some((o) => o && o.token === prior.token)) owners.push(prior);
  return owners;
}

function ownershipOf(rec, authorityFile, observerFile) {
  return {
    runId: String(rec.runId),
    token: String(rec.ownerToken),
    actor: String(rec.actor),
    target: String(rec.target),
    authorityFile,
    observerFile,
    recoveryOwners: Array.isArray(rec.recoveryOwners) ? rec.recoveryOwners.map((o) => ({ ...o })) : [],
    keepForRecovery: false,
  };
}

// Exclusive create — the atom the whole thing rests on. Two processes racing here, one
// gets the file and the other gets EEXIST; nobody gets a shared lock.
function tryCreate(file, rec) {
  let fd;
  try {
    fd = fs.openSync(file, 'wx');
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  }
  try { fs.writeSync(fd, JSON.stringify(rec, null, 2) + '\n'); } finally { fs.closeSync(fd); }
  return true;
}

function holderOf(rec, file) {
  return {
    runId: (rec && rec.runId) || '(unknown run)',
    pid: (rec && rec.pid) || null,
    since: (rec && rec.startedAt) || null,
    host: (rec && rec.host) || null,
    lockFile: file,
  };
}

// ---- the interface ---------------------------------------------------------------------

// acquire(repoRoot, targetRepoPath, runId). repoRoot selects only the observer mirror;
// the authoritative path deliberately does not depend on it.
//   -> { ok: true,  tookOver: false }                        the project was free
//   -> { ok: true,  tookOver: true, previous: {runId, pid} } the holder was gone; seized
//   -> { ok: false, holder: {runId, pid, since, ...} }       someone live holds it
//
// Deliberately NOT registered against process exit: a crashed run must leave its lock
// behind for the next run to take over, and that path is the only protection there is
// when a process dies without running handlers. Releasing is the caller's job.
function acquire(repoRoot, targetRepoPath, runId, options = {}) {
  if (!repoRoot || typeof repoRoot !== 'string') throw new Error('lock: a pipeline repo root is required');
  const canon = canonicalTarget(targetRepoPath);
  const observerFile = lockPath(repoRoot, targetRepoPath);
  const file = globalLockPath(targetRepoPath);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(observerFile), { recursive: true });

  const uncertainRefusal = () => {
    if (options && options.allowPreparationRecovery === true) return null;
    const markers = listPreparationUncertain(targetRepoPath);
    return markers.length ? { ok: false, holder: preparationHolder(markers[0], targetRepoPath) } : null;
  };
  const initialUncertain = uncertainRefusal();
  if (initialUncertain) return initialUncertain;

  // Upgrade bridge: an older runner may already hold the checkout-local lock. Copy that
  // record into the global authority with exclusive create before competing there. This
  // makes a mixed-version rollout refuse safely instead of ignoring the live old process.
  let unreadableLegacy = false;
  if (!fs.existsSync(file) && fs.existsSync(observerFile)) {
    const legacy = readRecord(observerFile);
    if (legacy) {
      const bridged = {
        ...legacy,
        target: canon,
        observerFile,
        claims: Array.isArray(legacy.claims) ? legacy.claims : [],
        recoveryOwners: Array.isArray(legacy.recoveryOwners) ? legacy.recoveryOwners : [],
      };
      tryCreate(file, bridged);
    } else {
      unreadableLegacy = true;
      removeFile(observerFile);
    }
  }

  // Bounded retry: each pass either settles or loses a race to another challenger, and a
  // challenger that wins becomes the live holder the next pass reports.
  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const uncertain = uncertainRefusal();
    if (uncertain) return uncertain;
    const rec = selfRecord(runId, canon, observerFile);
    if (tryCreate(file, rec)) {
      writeRecord(observerFile, rec);
      return {
        ok: true,
        tookOver: unreadableLegacy,
        ...(unreadableLegacy ? {
          previous: { runId: '(unreadable lock record)', pid: null, since: null, ownerToken: null, actor: null, claims: [] },
        } : {}),
        ownership: ownershipOf(rec, file, observerFile),
      };
    }

    last = readRecord(file);
    if (isHolderLive(last)) return { ok: false, holder: holderOf(last, file) };

    const staleUncertain = uncertainRefusal();
    if (staleUncertain) return staleUncertain;

    // Gone, or unreadable: clear it and re-take it through the same exclusive create, so
    // a second challenger arriving mid-takeover still loses cleanly rather than sharing.
    removeFile(file);
    const takeover = selfRecord(runId, canon, observerFile, recoveryOwnersAfter(last));
    if (tryCreate(file, takeover)) {
      if (last && last.observerFile && last.observerFile !== observerFile) removeFile(last.observerFile);
      writeRecord(observerFile, takeover);
      return {
        ok: true,
        tookOver: true,
        previous: {
          runId: (last && last.runId) || '(unreadable lock record)',
          pid: (last && last.pid) || null,
          since: (last && last.startedAt) || null,
          ownerToken: (last && last.ownerToken) || null,
          actor: (last && last.actor) || null,
          claims: Array.isArray(last && last.claims) ? [...last.claims] : [],
        },
        ownership: ownershipOf(takeover, file, observerFile),
      };
    }
  }
  return { ok: false, holder: holderOf(readRecord(file) || last, file) };
}

function ownedRecord(ownership) {
  if (!ownership || !ownership.authorityFile) throw new Error('lock: run ownership is required');
  const rec = readRecord(ownership.authorityFile);
  if (!rec || rec.pid !== process.pid || rec.runId !== ownership.runId
      || rec.ownerToken !== ownership.token || rec.target !== ownership.target) {
    throw new Error(`lock: run ${ownership.runId} no longer owns the target lock`);
  }
  return rec;
}

function persistOwned(ownership, rec) {
  writeRecord(ownership.authorityFile, rec);
  writeRecord(ownership.observerFile, rec);
  ownership.recoveryOwners = Array.isArray(rec.recoveryOwners)
    ? rec.recoveryOwners.map((o) => ({ ...o })) : [];
}

// Called only after the same Beads transaction atomically claimed the issue and wrote the
// owner token. The lock-side list decides whether release may remove the proof record; the
// metadata token remains the authoritative proof used by recovery.
function recordClaim(ownership, issueId) {
  const rec = ownedRecord(ownership);
  const id = String(issueId);
  if (!Array.isArray(rec.claims)) rec.claims = [];
  if (!rec.claims.includes(id)) rec.claims.push(id);
  persistOwned(ownership, rec);
}

// Remove a claim only after its terminal Beads transition succeeds. Publication failures,
// pauses and write-back failures deliberately leave it present for the next run.
function completeClaim(ownership, issueId) {
  if (!ownership) return;
  const rec = ownedRecord(ownership);
  const id = String(issueId);
  rec.claims = (Array.isArray(rec.claims) ? rec.claims : []).filter((v) => v !== id);
  persistOwned(ownership, rec);
}

function clearRecoveryOwner(ownership, token) {
  const rec = ownedRecord(ownership);
  rec.recoveryOwners = (Array.isArray(rec.recoveryOwners) ? rec.recoveryOwners : [])
    .filter((o) => o && o.token !== token);
  persistOwned(ownership, rec);
}

// Release ours and only ours. A run that was refused still runs its exit path, and
// removing the lock it was just refused by would hand the project to the next run to
// ask — so the record has to say it is us before the file goes.
function release(repoRoot, targetRepoPath, ownership) {
  const observerFile = lockPath(repoRoot, targetRepoPath);
  const file = globalLockPath(targetRepoPath);
  const rec = readRecord(file);
  if (!rec || rec.pid !== process.pid) return;
  const unfinished = (Array.isArray(rec.claims) && rec.claims.length > 0)
    || (Array.isArray(rec.recoveryOwners) && rec.recoveryOwners.length > 0)
    || rec.recoveryPending || (ownership && ownership.keepForRecovery);
  if (unfinished) {
    if (ownership && ownership.keepForRecovery) rec.recoveryPending = true;
    rec.releasedAt = new Date().toISOString();
    writeRecord(file, rec);
    writeRecord(rec.observerFile || observerFile, rec);
    return;
  }
  removeFile(file);
  removeFile(rec.observerFile || observerFile);
  if (observerFile !== rec.observerFile) removeFile(observerFile);
}

module.exports = {
  acquire, release, recordClaim, completeClaim, clearRecoveryOwner,
  lockPath, globalLockPath, globalLockRoot, canonicalTarget, isHolderLive,
  preparationUncertainDir, listPreparationUncertain,
  markPreparationUncertain, clearPreparationUncertain,
  OWNER_TOKEN_KEY, OWNER_RUN_KEY,
};
