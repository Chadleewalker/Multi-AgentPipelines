// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

// Frozen acceptance suite — the conveyor dashboard: show every idea from intake through
// review (repo-29l). Written from the issue criteria alone, before any implementation of the
// GET /conveyor-state endpoint or its served view exists, so every non-guard check below is
// RED at the fork point. The one existing-behaviour pin (legacy /state preserved, unknown
// routes refused) lives in the sibling guard.js and is GREEN at the fork point.
//
// CRITERIA (issue-canonical; the issue wins over any planning draft) and the tests that prove
// each. Every criterion is named by at least one test, and every test names its criterion.
//
//   CC1  GET /conveyor-state is a bounded, no-store, localhost-only pure-reader endpoint; it
//        preserves the legacy /state schema/behaviour and refuses unknown routes.
//          -> drive C1 (endpoint contract) + guard.js (legacy /state, unknown routes).
//   CC2  It reads intake-only and supervisor-backed ideas from known safe artifact layouts,
//        correlates only exact canonical target/proposal/issue/run identities, exposes only
//        display-safe fields, rejects path escapes/links, and reports explicit incomplete or
//        degraded evidence per affected idea/project.
//          -> drive C2 (intake+supervisor reading, correlation, redaction, links, degraded).
//   CC3  The self-contained served dashboard polls /conveyor-state and renders fixture
//        proposal identities, titles, stages, preparation states and merged/pending/rejected
//        verdicts as inert text while preserving the existing /state run rendering.
//          -> drive C3 (DOM harness over the real served page and endpoint output).
//   CC4  Deterministic bounded fixtures cover independent projects, all required preparation
//        and implementation/review observations, restart identity preservation, next-poll
//        appended evidence, malformed sibling isolation, finite-limit warnings, hostile text,
//        identity/hash mismatch, contradictory review verdict, and a merged verdict remaining
//        at review.
//          -> drive C4 (the enumerated scenarios, over the endpoint).
//   CC5  Acceptance verifies no filesystem mutation, subprocess, network or other prohibited
//        side effect; it uses real artifact shapes, stays credential-free, and proves its DOM
//        harness with a deterministic positive control.
//          -> drive C5 (in-process side-effect detection + snapshot) and C3 (positive control).
//
// Docker-free, node built-ins plus the repo's own durable-state path helpers (kickoff and the
// proposal supervisor) so the fixture is placed at exactly the canonical layout the reader
// must read. Every host is example.invalid; every path is under this test's temp root; every
// secret marker is invented here and must never reach the endpoint output.

const fs = require('fs');
const os = require('os');
const net = require('net');
const vm = require('vm');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'dashboard.js');
const kickoff = require(path.join(ROOT, 'scripts', 'kickoff'));
const supervisor = require(path.join(ROOT, 'runner', 'proposal-supervisor'));

let failed = 0;
const kids = [];
function check(name, cond) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) failed = 1;
  return !!cond;
}
function fail(name, why) { console.log(`FAIL - ${name}${why ? `: ${why}` : ''}`); failed = 1; }
function skip(name) { console.log(`skip - ${name}`); }
function note(msg) { console.log(`# ${msg}`); }
const jtext = (x) => JSON.stringify(x);
// Inspect display VALUES, not keys such as "degraded" or a fixture's identity/title.
function evidenceText(node, omit = []) {
  const excluded = new Set(omit);
  const values = [];
  function visit(value) {
    if (typeof value === 'string') { if (!excluded.has(value)) values.push(value); }
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  }
  visit(node);
  return values.join('\n');
}
const iso = (ms) => new Date(ms).toISOString();

// ---- deep-search helpers over the endpoint JSON -----------------------------------------
// The contract pins { schema, now, projects:[...] } and that display values are reachable in
// the tree; it deliberately does NOT pin every field path, so a correct implementation is not
// forced into one internal shape. Values are located by unique markers.
function allObjects(node, acc) {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) { for (const v of node) allObjects(v, acc); return acc; }
  acc.push(node);
  for (const k of Object.keys(node)) allObjects(node[k], acc);
  return acc;
}
function smallest(root, str) {
  let best = null;
  for (const o of allObjects(root, [])) {
    const s = jtext(o);
    if (s.includes(str) && (best === null || s.length < jtext(best).length)) best = o;
  }
  return best;
}
function projectEntry(state, marker) {
  return state && Array.isArray(state.projects)
    ? state.projects.find((p) => jtext(p).includes(marker)) : undefined;
}
// The smallest object carrying BOTH a proposal's unique id and its unique title — its own
// idea record, whose stage/verdict/preparation fields are therefore inside it.
function ideaBlob(state, id, title) {
  let best = null;
  for (const o of allObjects(state, [])) {
    const s = jtext(o);
    if (s.includes(id) && s.includes(title) && (best === null || s.length < jtext(best).length)) best = o;
  }
  return best;
}

// ==== the durable fixture, at the canonical PIPELINE_STATE_DIR layout =====================
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-29l-'));
const STATE = path.join(TMP, 'state');            // PIPELINE_STATE_DIR
const RUNS = path.join(TMP, 'runs');              // DASHBOARD_RUNS_DIR (legacy /state)
const TARGETS = path.join(TMP, 'targets');
fs.mkdirSync(STATE, { recursive: true });
fs.mkdirSync(RUNS, { recursive: true });
fs.mkdirSync(TARGETS, { recursive: true });
process.env.PIPELINE_STATE_DIR = STATE;           // the path helpers read this at call time

const NONCE = crypto.randomBytes(6).toString('hex');
const API_SECRET = `sk-ant-LIVEKEYFAKE-${NONCE}`;         // credential — never displayed
const SPEC_SECRET = `SPECBODYMODELOUTPUT-${NONCE}`;       // model output/spec — never displayed
const LEASE_SECRET = `LEASETOKEN-${NONCE}`;               // grant/lease token — never displayed
const CONSTRAINT_SECRET = `KICKOFFCONSTRAINT-${NONCE}`;   // full kickoff constraints — never displayed
const DESC_SECRET = `KICKOFFDESCRIPTION-${NONCE}`;        // kickoff description — never displayed
// (Off-tree link escapes are proven non-vacuously by the LINK_*_SENTINEL fixtures below, so
// there is no separate "symlink secret" here — following a link is a display leak, tested by
// its own sentinel, not a redaction failure.)
const ALL_SECRETS = [API_SECRET, SPEC_SECRET, LEASE_SECRET, CONSTRAINT_SECRET, DESC_SECRET];
const HOSTILE = `<script>window.__pwned_${NONCE}=1</script><img src=x onerror="window.__pwned_${NONCE}=1">`;

// Escape sentinels: each is the display TITLE of a genuinely valid record/journal that sits
// OUTSIDE the state tree behind a real link. A reader that follows the link surfaces the
// title; a reader that refuses does not. They are titles (never redacted) precisely so their
// absence proves link refusal rather than field redaction. LINK_LEGAL_SENTINEL is the same
// shape placed in a LEGAL layout: it MUST appear, proving the refusal above is non-vacuous.
const LINK_RECORD_SENTINEL = `LINKRECORD-${NONCE}`;       // valid record file that is a symlink out
const LINK_ANCESTRY_SENTINEL = `LINKANCESTRY-${NONCE}`;   // valid record under a linked proposals dir
const LINK_JOURNAL_SENTINEL = `LINKJOURNAL-${NONCE}`;     // valid journal that is a symlink out
const LINK_LEGAL_SENTINEL = `LINKLEGAL-${NONCE}`;         // same record shape, legal layout: MUST show
// Correlation sentinels: valid-shaped records that must NOT be able to rename or reassociate a
// healthy idea, and MUST NOT surface as a healthy idea themselves. Correction 2.
const FOREIGN_TARGET_SENTINEL = `FOREIGNTARGET-${NONCE}`; // valid record for target X, dropped in Y's partition
const FILENAME_MISMATCH_SENTINEL = `FILEIDMISMATCH-${NONCE}`; // record.id disagrees with its filename
const SUBMIT_RENAME_SENTINEL = `SUBMITRENAME-${NONCE}`;   // unverified journal title trying to rename an idea

const NOW = Date.now();
function targetDir(name) { const d = path.join(TARGETS, name); fs.mkdirSync(d, { recursive: true }); return d; }

// A real intake record, built exactly as scripts/kickoff.js submit builds it and validated by
// the module's own verifyRecord so the fixture is a genuine artifact shape, not a guess.
function packetIntent(title) {
  const packet = { version: kickoff.VERSION, title, description: DESC_SECRET,
    constraints: [CONSTRAINT_SECRET], priority: 3 };
  const canon = kickoff.canonicalPacket(Buffer.from(JSON.stringify(packet), 'utf8'));
  return JSON.stringify(canon);
}
function writeIntake(target, id, title, opts = {}) {
  const paths = kickoff.statePathsFor(target);
  fs.mkdirSync(paths.proposals, { recursive: true, mode: 0o700 });
  const intent = packetIntent(title);
  const goodHash = `sha256:${crypto.createHash('sha256').update(Buffer.from(intent, 'utf8')).digest('hex')}`;
  const record = { version: kickoff.VERSION, id, target: paths.target,
    hash: opts.tamper ? `sha256:${'0'.repeat(64)}` : goodHash, intent, createdAt: iso(NOW - 3600000) };
  if (!opts.tamper) kickoff.verifyRecord(record, id, paths.target);   // proves the real shape
  fs.writeFileSync(path.join(paths.proposals, `${id}.json`), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}
function journalFile(target) {
  const dir = supervisor.supervisorStateDirFor(target);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, 'events.jsonl');
}
// A genuine intake record object (validated by the module's own verifyRecord), returned but
// NOT written — used to place a valid record OUTSIDE the tree behind a link, and to place the
// byte-identical record in a legal layout as the positive control. Because the record is
// real, refusing the link cannot be faked by rejecting an invalid shape.
function buildRecord(target, id, title) {
  const paths = kickoff.statePathsFor(target);
  const intent = packetIntent(title);
  const hash = `sha256:${crypto.createHash('sha256').update(Buffer.from(intent, 'utf8')).digest('hex')}`;
  const record = { version: kickoff.VERSION, id, target: paths.target, hash, intent, createdAt: iso(NOW - 3600000) };
  kickoff.verifyRecord(record, id, paths.target);       // proves this is a real artifact shape
  return { record, text: `${JSON.stringify(record, null, 2)}\n`, paths };
}
// Only readable file symlinks count as supported file-link fixtures; a directory
// junction aimed at a file can be unreadable and make refusal vacuous.
function tryLink(dest, linkPath, kind) {
  const order = kind === 'dir' ? ['junction', 'dir'] : ['file'];
  for (const type of order) {
    let created = false;
    try {
      fs.symlinkSync(dest, linkPath, type); created = true;
      if (kind === 'file' && !fs.readFileSync(linkPath).equals(fs.readFileSync(dest))) {
        throw new Error('file link does not expose the intended bytes');
      }
      return true;
    } catch {
      if (created) fs.unlinkSync(linkPath);
    }
  }
  return false;
}

// One proposal's real supervisor journal events, along a valid ordered stage chain up to its
// target stage, with the preparation / implementation / review observations that stage implies.
const STAGE_CHAIN = ['queued', 'specifying', 'criticizing', 'authoring-tests', 'proving',
  'freezing', 'ready', 'implementing', 'publishing', 'review'];
const PREP_STATE = { 'authoring-tests': 'authoring', proving: 'proving', freezing: 'proven-at-base' };
function specResult(spec, kickoffHash) {
  return { status: 'ready', issueId: spec.issueId, specHash: `sha256:${'a'.repeat(64)}`,
    evidenceHash: `sha256:${'b'.repeat(64)}`, model: 'claude-opus-4-8', tokens: { input: 10, output: 20 },
    config: { targetRepoPath: spec.target, ANTHROPIC_API_KEY: API_SECRET },
    receipt: { issueId: spec.issueId, specHash: `sha256:${'a'.repeat(64)}`, kickoffHash,
      proposal: { title: spec.title, spec: `${SPEC_SECRET} implement it`, acceptanceCriteria: ['a criterion'],
        designReferences: ['DESIGN.md#5-the-review-phase'], difficulty: 'medium' } } };
}
function prepEvidence(issueId, state, unrelatedIssue) {
  // When an unrelated issue is present it is deliberately placed FIRST, so a reader that
  // trusts evidence.issues[0] instead of correlating by the proposal's own known issue id
  // reports the wrong issue's state. The correct row is the one whose id === issueId.
  const issues = [];
  if (unrelatedIssue) issues.push({ id: unrelatedIssue, state: 'authoring', events: [], workers: [] });
  issues.push({ id: issueId, state, events: [], workers: [] });
  return { ok: true, headHash: `sha256:${'d'.repeat(64)}`, issues };
}
function emitProposal(events, spec) {
  let seq = events.length;
  const push = (type, body) => events.push({ sequence: ++seq, type, at: iso(NOW - 1800000 + seq * 1000), ...body });
  writeIntake(spec.target, spec.id, spec.title);
  // The verified intake title is the idea's identity. `submitTitle` lets a scenario put a
  // DIFFERENT, unverified title on the journal's proposal.submitted record: a reader that
  // accepts the journal record's title unverified would silently rename the healthy idea.
  const recordTitle = spec.submitTitle || spec.title;
  const record = { version: kickoff.VERSION, id: spec.id, target: kickoff.statePathsFor(spec.target).target,
    hash: `sha256:${crypto.createHash('sha256').update(Buffer.from(packetIntent(recordTitle), 'utf8')).digest('hex')}`,
    intent: packetIntent(recordTitle), createdAt: iso(NOW - 3600000) };
  push('proposal.submitted', { proposalId: spec.id, record });
  const upTo = STAGE_CHAIN.indexOf(spec.upTo);
  for (let i = 0; i <= upTo; i += 1) {
    const st = STAGE_CHAIN[i];
    push('stage', { proposalId: spec.id, stage: st });
    if (st === 'specifying') push('specification.completed', { proposalId: spec.id, result: specResult(spec, record.hash) });
    if (st === 'criticizing') {
      push('preparation.granted', { proposalId: spec.id,
        grant: { scope: 'preparation', nonce: crypto.randomBytes(8).toString('hex'), lease: { id: 'lease-1', token: LEASE_SECRET } } });
      push('preparation.started', { proposalId: spec.id, operation: { id: `op-${spec.id}`, batchId: `proposal-${spec.id}` } });
    }
    if (PREP_STATE[st]) {
      push('preparation.observed', { proposalId: spec.id, evidence: prepEvidence(spec.issueId, PREP_STATE[st], spec.unrelatedIssue),
        operationState: st === 'freezing' ? 'completed' : 'running', attention: null });
    }
    if (st === 'freezing') {
      push('publication.observed', { proposalId: spec.id, evidence: { published: false, issueId: spec.issueId } });
      push('preparation.completed', { proposalId: spec.id, evidence: prepEvidence(spec.issueId, 'proven-at-base', spec.unrelatedIssue) });
      push('preparation.settled', { proposalId: spec.id, outcome: 'complete' });
    }
    if (st === 'implementing') {
      push('proposal.assigned', { proposalId: spec.id, feedId: 'feed-A', runId: spec.runId });
      push('implementation.observed', { proposalId: spec.id,
        implementation: { operationId: 'feed-A', runId: spec.runId, issueId: spec.issueId, operationState: 'running', outcome: null },
        task: { issueId: spec.issueId, outcome: null } });
    }
    if (st === 'publishing') {
      push('implementation.observed', { proposalId: spec.id,
        implementation: { operationId: 'feed-A', runId: spec.runId, issueId: spec.issueId, operationState: 'completed', outcome: 'done' },
        task: { issueId: spec.issueId, outcome: 'done', prUrl: spec.prUrl, branch: `task/${spec.issueId}` } });
    }
    if (st === 'review') {
      const decided = spec.decided || null;
      push('review.observed', { proposalId: spec.id,
        evidence: { proposalId: spec.id, issueId: spec.issueId, runId: spec.runId, prUrl: spec.prUrl,
          verdict: decided || 'pending',
          evidence: decided ? { issueId: spec.issueId, runId: spec.runId, prUrl: spec.prUrl, verdict: decided, reason: spec.reason } : null } });
      if (spec.attention) push('review.attention', { proposalId: spec.id, attention: spec.attention });
      if (decided) push('review.decided', { proposalId: spec.id, verdict: decided, reason: spec.reason });
      // A later, contradictory review observation arriving AFTER a valid accepted decision,
      // carrying no pre-labelled conflict/attention text at all. The reader must keep the
      // accepted disposition yet still expose the contradiction it can only get by comparing
      // the two observations — echoing a baked-in warning string cannot pass this.
      if (spec.laterVerdict) {
        push('review.observed', { proposalId: spec.id,
          evidence: { proposalId: spec.id, issueId: spec.issueId, runId: spec.runId, prUrl: spec.prUrl,
            verdict: spec.laterVerdict,
            evidence: { issueId: spec.issueId, runId: spec.runId, prUrl: spec.prUrl, verdict: spec.laterVerdict, reason: spec.laterReason || 'reviewer changed the recorded verdict' } } });
      }
    }
  }
  if (spec.finalStage === 'rejected') push('stage', { proposalId: spec.id, stage: 'rejected' });
}

// ---- Project A: the full conveyor, one proposal parked at each observable position -------
const TGT_A = targetDir('alpha-app');
const A = {
  auth: { id: 'kp-00000000000000a1', issueId: 'bd-a-auth', title: `A authoring idea ${NONCE}`, upTo: 'authoring-tests' },
  prove: { id: 'kp-00000000000000a2', issueId: 'bd-a-prove', title: `A proving idea ${NONCE}`, upTo: 'proving' },
  freeze: { id: 'kp-00000000000000a3', issueId: 'bd-a-freeze', title: `A freezing idea ${NONCE}`, upTo: 'freezing' },
  impl: { id: 'kp-00000000000000a4', issueId: 'bd-a-impl', title: `A implementing idea ${NONCE}`, upTo: 'implementing', runId: 'run-a-100' },
  merged: { id: 'kp-00000000000000a5', issueId: 'bd-a-merged', title: `A merged idea ${NONCE}`, upTo: 'review', runId: 'run-a-101', prUrl: 'https://example.invalid/pull/5', decided: 'merged', reason: 'Merged after review.' },
  pending: { id: 'kp-00000000000000a6', issueId: 'bd-a-pending', title: `A pending idea ${NONCE}`, upTo: 'review', runId: 'run-a-102', prUrl: 'https://example.invalid/pull/6' },
  rejected: { id: 'kp-00000000000000a7', issueId: 'bd-a-reject', title: `A rejected idea ${NONCE}`, upTo: 'review', runId: 'run-a-103', prUrl: 'https://example.invalid/pull/7', decided: 'rejected', reason: 'Rejected after review.', finalStage: 'rejected' },
  conflict: { id: 'kp-00000000000000a8', issueId: 'bd-a-conflict', title: `A conflict idea ${NONCE}`, upTo: 'review', runId: 'run-a-104', prUrl: 'https://example.invalid/pull/8', decided: 'merged', reason: 'Accepted merged.', attention: 'review evidence conflict: accepted merged; canonical record now says rejected' },
  // A silently contradictory idea: accepted merged, THEN a later rejected observation, with no
  // attention field and no conflict wording anywhere in its fixture. Correction 5.
  silent: { id: 'kp-00000000000000a9', issueId: 'bd-a-silent', title: `A late-reversal idea ${NONCE}`, upTo: 'review', runId: 'run-a-105', prUrl: 'https://example.invalid/pull/9', decided: 'merged', reason: 'Merged after review.', laterVerdict: 'rejected' },
};
const A_JOURNAL = [];
for (const spec of Object.values(A)) emitProposal(A_JOURNAL, Object.assign(spec, { target: TGT_A }));
fs.writeFileSync(journalFile(TGT_A), A_JOURNAL.map((e) => JSON.stringify(e)).join('\n') + '\n');
// Intake-only ideas in A (no supervisor journal entry): a normal one, one with hostile text,
// and one tampered record whose hash does not match its immutable intent.
const A_INTAKE = writeIntake(TGT_A, 'kp-00000000000000b1', `A intake-only idea ${NONCE}`);
const A_HOSTILE = writeIntake(TGT_A, 'kp-00000000000000b2', `A hostile idea ${NONCE} ${HOSTILE}`);
const A_TAMPERED_TITLE = `A tampered idea ${NONCE}`;
writeIntake(TGT_A, 'kp-00000000000000b3', A_TAMPERED_TITLE, { tamper: true });

// ---- Project B: independent; must never be cross-associated with A -----------------------
const TGT_B = targetDir('beta-game');
const B_JOURNAL = [];
const B = { merged: { id: 'kp-00000000000000c1', issueId: 'bd-b-merged', title: `B merged idea ${NONCE}`, upTo: 'review', runId: 'run-b-200', prUrl: 'https://example.invalid/pull/20', decided: 'merged', reason: 'B merged.' } };
emitProposal(B_JOURNAL, Object.assign(B.merged, { target: TGT_B }));
fs.writeFileSync(journalFile(TGT_B), B_JOURNAL.map((e) => JSON.stringify(e)).join('\n') + '\n');
const B_INTAKE = writeIntake(TGT_B, 'kp-00000000000000c2', `B intake-only idea ${NONCE}`);

// ---- Project C: a malformed sibling — its journal has a garbage line; healthy A/B survive.
const TGT_C = targetDir('gamma-tool');
const C_INTAKE = writeIntake(TGT_C, 'kp-00000000000000d1', `C healthy idea ${NONCE}`);
fs.writeFileSync(journalFile(TGT_C), '{ this is not a valid json event line\n');
// A malformed proposal record sits beside the healthy one; the healthy one must still show.
fs.writeFileSync(path.join(kickoff.statePathsFor(TGT_C).proposals, 'kp-00000000000000d2.json'), '{ broken record');

// ---- Links / path escapes (Correction 1) -------------------------------------------------
// Everything reachable ONLY by following a link lives here, OUTSIDE the state root, and every
// linked artifact is a GENUINELY VALID record or journal (verified when built), so a reader
// cannot dodge the check by rejecting an invalid shape — only by refusing to traverse links.
const OUTSIDE = path.join(TMP, 'offtree');
fs.mkdirSync(OUTSIDE, { recursive: true });

// L0 positive control: the same record shape, in a LEGAL (real, unlinked) layout. If a correct
// reader does NOT surface this, the escape checks below are vacuous, so this must show.
const TGT_LEGAL = targetDir('legal-ctrl');
{ const { text, paths } = buildRecord(TGT_LEGAL, 'kp-0000000000000fc1', `legal control ${LINK_LEGAL_SENTINEL}`);
  fs.mkdirSync(paths.proposals, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(paths.proposals, 'kp-0000000000000fc1.json'), text); }

// L1: a proposal record FILE that is a symlink to a valid off-tree record. A real healthy
// record sits beside it and must still render.
const TGT_D = targetDir('delta-svc');
const D_INTAKE = writeIntake(TGT_D, 'kp-00000000000000e1', `D healthy idea ${NONCE}`);
let LINK_RECORD = false;
{ const outFile = path.join(OUTSIDE, 'd-record.json');
  const { text } = buildRecord(TGT_D, 'kp-00000000000000e2', `D linked record ${LINK_RECORD_SENTINEL}`);
  fs.writeFileSync(outFile, text);
  LINK_RECORD = tryLink(outFile, path.join(kickoff.statePathsFor(TGT_D).proposals, 'kp-00000000000000e2.json'), 'file'); }

// L2: a linked ANCESTRY — the whole proposals directory of a partition is a junction to an
// off-tree directory holding a valid record. The reader must refuse to descend it.
const TGT_DIRLINK = targetDir('delta-dirlink');
let LINK_ANCESTRY = false;
{ const outDir = path.join(OUTSIDE, 'dirlink-proposals');
  fs.mkdirSync(outDir, { recursive: true });
  const { text } = buildRecord(TGT_DIRLINK, 'kp-00000000000000e3', `dirlink record ${LINK_ANCESTRY_SENTINEL}`);
  fs.writeFileSync(path.join(outDir, 'kp-00000000000000e3.json'), text);
  const p = kickoff.statePathsFor(TGT_DIRLINK);
  fs.mkdirSync(p.state, { recursive: true, mode: 0o700 });         // the partition dir is real
  LINK_ANCESTRY = tryLink(outDir, p.proposals, 'dir');             // its proposals child is a junction
}

// L3: a supervisor events.jsonl that is a symlink to a valid off-tree journal. A healthy
// intake idea in the same project must still render.
const TGT_JLINK = targetDir('delta-jlink');
const JLINK_INTAKE = writeIntake(TGT_JLINK, 'kp-00000000000000e4', `J healthy idea ${NONCE}`);
let LINK_JOURNAL = false;
{ const outEvents = path.join(OUTSIDE, 'jlink-events.jsonl');
  const rec = buildRecord(TGT_JLINK, 'kp-00000000000000e5', `J linked journal ${LINK_JOURNAL_SENTINEL}`).record;
  const evs = [
    { sequence: 1, type: 'proposal.submitted', at: iso(NOW - 1700000), proposalId: 'kp-00000000000000e5', record: rec },
    { sequence: 2, type: 'stage', at: iso(NOW - 1699000), proposalId: 'kp-00000000000000e5', stage: 'queued' },
  ];
  fs.writeFileSync(outEvents, evs.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const jdir = supervisor.supervisorStateDirFor(TGT_JLINK);
  fs.mkdirSync(jdir, { recursive: true, mode: 0o700 });
  LINK_JOURNAL = tryLink(outEvents, path.join(jdir, 'events.jsonl'), 'file'); }

// Count attempted off-tree content reads, including through a followed realpath spelling.
// Each link has one known regular file whose exact bytes can be read by the positive control.
const LINK_READ_FILES = [];
const addLinkRead = (enabled, linked, outside) => {
  if (enabled) LINK_READ_FILES.push({ linked: path.resolve(linked), outside: path.resolve(outside) });
};
addLinkRead(LINK_RECORD, path.join(kickoff.statePathsFor(TGT_D).proposals, 'kp-00000000000000e2.json'), path.join(OUTSIDE, 'd-record.json'));
addLinkRead(LINK_ANCESTRY, path.join(kickoff.statePathsFor(TGT_DIRLINK).proposals, 'kp-00000000000000e3.json'), path.join(OUTSIDE, 'dirlink-proposals', 'kp-00000000000000e3.json'));
addLinkRead(LINK_JOURNAL, path.join(supervisor.supervisorStateDirFor(TGT_JLINK), 'events.jsonl'), path.join(OUTSIDE, 'jlink-events.jsonl'));
const LINK_READ_PATHS = new Set(LINK_READ_FILES.flatMap((row) => [row.linked, row.outside]));

// ---- Correlation adversaries (Correction 2) ----------------------------------------------
// One project holding a healthy supervised control PLUS three valid-shaped identity attacks.
const TGT_CORR = targetDir('corr-app');
const CORR_JOURNAL = [];
// Healthy control: correct issue correlation, with an UNRELATED issue placed FIRST in the
// preparation evidence so a reader that reads evidence.issues[0] reports the wrong state.
const CORR_OK = { id: 'kp-0000000000000c01', issueId: 'bd-corr-ok', title: `corr healthy idea ${NONCE}`,
  upTo: 'freezing', unrelatedIssue: 'bd-corr-unrelated' };
emitProposal(CORR_JOURNAL, Object.assign({}, CORR_OK, { target: TGT_CORR }));
// Rename attack: a healthy intake idea whose journal proposal.submitted carries a DIFFERENT,
// unverified title. The verified intake title must win; the sentinel must not become identity.
const CORR_RENAME = { id: 'kp-0000000000000c02', issueId: 'bd-corr-rename', title: `corr real title ${NONCE}`,
  upTo: 'queued', submitTitle: `corr forged ${SUBMIT_RENAME_SENTINEL}` };
emitProposal(CORR_JOURNAL, Object.assign({}, CORR_RENAME, { target: TGT_CORR }));
fs.writeFileSync(journalFile(TGT_CORR), CORR_JOURNAL.map((e) => JSON.stringify(e)).join('\n') + '\n');
// A valid record whose internal target is a FOREIGN target, physically dropped into corr's
// partition. sha256(record.target) != this partition, so it must not surface or reassociate.
{ const { text } = buildRecord(targetDir('corr-foreign'), 'kp-0000000000000c03', `corr foreign ${FOREIGN_TARGET_SENTINEL}`);
  fs.writeFileSync(path.join(kickoff.statePathsFor(TGT_CORR).proposals, 'kp-0000000000000c03.json'), text); }
// A record whose id disagrees with its filename: written under a mismatched filename.
{ const { text } = buildRecord(TGT_CORR, 'kp-0000000000000c04', `corr mismatch ${FILENAME_MISMATCH_SENTINEL}`);
  fs.writeFileSync(path.join(kickoff.statePathsFor(TGT_CORR).proposals, 'kp-0000000000000cff.json'), text); }

// ---- Bounded work (Correction 3) ---------------------------------------------------------
// (a) A flood of MALFORMED proposal records — none verify. A reader whose scan budget counts
// only verified records never trips its cap and reads all of them; a bounded reader caps the
// scan and says so. A healthy record sits beside them.
const TGT_MALFLOOD = targetDir('malformed-flood-app');
const MALFLOOD_HEALTHY = writeIntake(TGT_MALFLOOD, 'kp-0000000000000d10', `malflood healthy ${NONCE}`);
// A practical fixture budget, not a copy of an implementation's private scan cap.
const MALFLOOD_COUNT = 4096;
const MALFORMED_FILES = new Set();
for (let i = 0; i < MALFLOOD_COUNT; i += 1) {
  const id = `kp-${(0x200000000 + i).toString(16).padStart(16, '0')}`;
  const file = path.join(kickoff.statePathsFor(TGT_MALFLOOD).proposals, `${id}.json`);
  MALFORMED_FILES.add(path.resolve(file));
  fs.writeFileSync(file, '{ not valid json record ');
}
// (b) An OVERSIZED journal (valid healthy prefix, then megabytes of parseable noise) beside a
// healthy sibling project. A reader that reads the whole journal wholesale does unbounded work.
const OVERSIZE_BYTES = 12 * 1024 * 1024;
const TGT_HEAVY = targetDir('heavy-journal-app');
const HEAVY_INTAKE = writeIntake(TGT_HEAVY, 'kp-0000000000000d20', `heavy healthy idea ${NONCE}`);
const HEAVY_JOURNAL_FILE = journalFile(TGT_HEAVY);
{ const head = [
    { sequence: 1, type: 'proposal.submitted', at: iso(NOW - 1600000), proposalId: 'kp-0000000000000d20',
      record: buildRecord(TGT_HEAVY, 'kp-0000000000000d20', `heavy healthy idea ${NONCE}`).record },
    { sequence: 2, type: 'stage', at: iso(NOW - 1599000), proposalId: 'kp-0000000000000d20', stage: 'queued' },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n';
  const pad = crypto.randomBytes(4096).toString('hex');
  const fd = fs.openSync(HEAVY_JOURNAL_FILE, 'w', 0o600);
  try {
    fs.writeSync(fd, head);
    let n = head.length; let seq = 3;
    while (n < OVERSIZE_BYTES) { const line = `${JSON.stringify({ sequence: seq++, type: 'noise', pad })}\n`; fs.writeSync(fd, line); n += line.length; }
  } finally { fs.closeSync(fd); }
}
const HEAVY_JOURNAL_SIZE = fs.statSync(HEAVY_JOURNAL_FILE).size;
// (c) An OVERSIZED single record FILE beside a healthy record in the same partition.
const TGT_BIGREC = targetDir('big-record-app');
const BIGREC_HEALTHY = writeIntake(TGT_BIGREC, 'kp-0000000000000d30', `bigrec healthy ${NONCE}`);
const BIGREC_FILE = path.join(kickoff.statePathsFor(TGT_BIGREC).proposals, 'kp-0000000000000d31.json');
{ const fd = fs.openSync(BIGREC_FILE, 'w', 0o600);
  try { const chunk = Buffer.alloc(1024 * 1024, 0x78); let n = 0; while (n < OVERSIZE_BYTES) { fs.writeSync(fd, chunk); n += chunk.length; } }
  finally { fs.closeSync(fd); } }

// ---- Project F: the finite-limit flood — more intake proposals than any documented scan cap.

// ---- Project F: the finite-limit flood — more intake proposals than any documented scan cap.
const TGT_F = targetDir('flood-app');
const FLOOD_COUNT = 512;
for (let i = 0; i < FLOOD_COUNT; i += 1) {
  const id = `kp-${(0x100000000 + i).toString(16).padStart(16, '0')}`;
  writeIntake(TGT_F, id, `flood idea ${i} ${NONCE}`);
}

// ---- the legacy /state fixture (one finished run) so C3 can prove run rendering survives.
const RUN_L = 'run-legacy-001';
fs.mkdirSync(path.join(RUNS, RUN_L), { recursive: true });
const LEGACY_TASK_ID = 'app-legacy-1';
const LEGACY_TASK_TITLE = `Legacy run task ${NONCE}`;
fs.writeFileSync(path.join(RUNS, RUN_L, 'run.json'), `${JSON.stringify({
  runId: RUN_L, startedAt: iso(NOW - 7200000), finishedAt: iso(NOW - 7000000),
  targetRepo: 'https://example.invalid/legacy.git', concurrency: 1,
  tasks: [{ issueId: LEGACY_TASK_ID, title: LEGACY_TASK_TITLE, outcome: 'done', exitCode: 0, attempts: 1, pauses: 0 }],
}, null, 2)}\n`);

// ==== child dashboard plumbing (mirrors the host invocation) ==============================
const READY_RE = /^dashboard: http:\/\/127\.0\.0\.1:(\d+)\/$/m;
function childEnv(overrides) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === 'NODE_OPTIONS' || k === 'NODE_DEBUG') continue;
    if (/^DASHBOARD_/i.test(k)) continue;
    env[k] = v;
  }
  return Object.assign(env, overrides);
}
function startDashboard(overrides) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT], { env: childEnv(overrides), stdio: ['ignore', 'pipe', 'pipe'] });
    kids.push(child);
    let out = '';
    let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(t); resolve(r); } };
    const t = setTimeout(() => { try { child.kill(); } catch { /* gone */ } finish({ ok: false, why: 'no ready line' }); }, 15000);
    child.stdout.on('data', (d) => { out += d; const m = out.match(READY_RE); if (m) finish({ ok: true, port: Number(m[1]), child }); });
    child.on('error', (e) => finish({ ok: false, why: e.message }));
    child.on('exit', (c) => finish({ ok: false, why: `exit ${c}` }));
  });
}
function stop(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return resolve();
    child.on('exit', () => resolve());
    try { child.kill(); } catch { resolve(); }
  });
}
function get(port, reqPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: reqPath, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(20000, () => req.destroy(new Error(`timeout ${reqPath}`)));
    req.on('error', reject);
    req.end();
  });
}
async function getJson(port, p) {
  const res = await get(port, p);
  let st = null;
  try { st = JSON.parse(res.body); } catch { /* callers assert */ }
  return { res, st };
}
function connectFails(host, port) {
  return new Promise((resolve) => {
    let s;
    try { s = net.connect({ host, port }); } catch { return resolve(true); }
    const done = (v) => { try { s.destroy(); } catch { /* gone */ } resolve(v); };
    s.setTimeout(3000, () => done(true));
    s.on('connect', () => done(false));
    s.on('error', () => done(true));
  });
}

// ==== a tiny deterministic DOM so the served page script can be executed (CC3/CC5) ========
// Only the vocabulary the existing self-contained page uses, plus a recording innerHTML sink,
// so "rendered as inert text" is decidable: a value that reaches textContent is inert; one
// that reaches innerHTML is not.
let DOM_SINKS = [];
function collectText(n) {
  if (!n) return '';
  if (n.__text !== undefined) return n.__text;
  let s = n._text || '';
  for (const c of n.children) s += collectText(c);
  return s;
}
function makeNode(tag) {
  const n = { tagName: String(tag || '').toUpperCase(), children: [], attrs: {}, style: {}, dataset: {},
    className: '', _text: '', open: false, listeners: {} };
  n.appendChild = (c) => { if (c && c.__frag) { for (const x of c.children) n.children.push(x); c.children = []; } else if (c) n.children.push(c); return c; };
  n.removeChild = (c) => { const i = n.children.indexOf(c); if (i >= 0) n.children.splice(i, 1); return c; };
  n.append = (...cs) => cs.forEach((c) => n.appendChild(c));
  n.prepend = (...cs) => { n.children.unshift(...cs.filter(Boolean)); };
  n.insertBefore = (nw, ref) => { const i = n.children.indexOf(ref); if (i < 0) n.appendChild(nw); else n.children.splice(i, 0, nw); return nw; };
  n.replaceChildren = (...cs) => { n.children = []; n._text = ''; cs.forEach((c) => n.appendChild(c)); };
  n.remove = () => {};
  n.setAttribute = (k, v) => { n.attrs[k] = String(v); if (k === 'id') n.id = String(v); };
  n.getAttribute = (k) => (k in n.attrs ? n.attrs[k] : null);
  n.hasAttribute = (k) => k in n.attrs;
  n.removeAttribute = (k) => { delete n.attrs[k]; };
  n.classList = { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false };
  n.addEventListener = (t, f) => { (n.listeners[t] = n.listeners[t] || []).push(f); };
  n.removeEventListener = () => {};
  Object.defineProperty(n, 'firstChild', { configurable: true, get() { return n.children[0] || null; } });
  Object.defineProperty(n, 'lastChild', { configurable: true, get() { return n.children[n.children.length - 1] || null; } });
  Object.defineProperty(n, 'childNodes', { configurable: true, get() { return n.children; } });
  Object.defineProperty(n, 'textContent', { configurable: true,
    get() { return collectText(n); }, set(v) { n.children = []; n._text = v == null ? '' : String(v); } });
  Object.defineProperty(n, 'innerHTML', { configurable: true,
    get() { return n._innerHTML || ''; }, set(v) { n._innerHTML = String(v); DOM_SINKS.push(String(v)); n.children = []; n._text = ''; } });
  return n;
}
function buildDom(pageHtml) {
  const registry = {};
  const re = /id\s*=\s*(?:"([^"]+)"|'([^']+)')/g;
  let m;
  while ((m = re.exec(pageHtml))) { const id = m[1] || m[2]; if (!registry[id]) { registry[id] = makeNode('div'); registry[id].id = id; } }
  registry.__ctrl_root__ = makeNode('div');            // a root the positive control owns
  const document = {
    createElement: (t) => makeNode(t),
    createElementNS: (ns, t) => makeNode(t),
    createTextNode: (t) => ({ __text: String(t == null ? '' : t), children: [] }),
    createComment: () => ({ __text: '', children: [] }),
    createDocumentFragment: () => { const f = makeNode('#fragment'); f.__frag = true; return f; },
    getElementById: (id) => registry[id] || null,
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener: () => {}, removeEventListener: () => {},
    body: makeNode('body'), documentElement: makeNode('html'), head: makeNode('head'),
  };
  return { document, registry, text: () => Object.values(registry).map(collectText).join('\n') + collectText(document.body) };
}
async function flush() { for (let i = 0; i < 25; i += 1) { await Promise.resolve(); await new Promise((r) => setImmediate(r)); } }
// Include sibling detail nodes within one idea card. Reject any ancestor carrying
// another proposal identity, so references elsewhere on the page cannot satisfy this item.
function allDomNodes(n, acc) {
  if (!n || typeof n !== 'object') return acc;
  acc.push(n);
  for (const c of (n.children || [])) allDomNodes(c, acc);
  return acc;
}
function ideaRenderedText(dom, a, b) {
  const roots = [dom.document.body, dom.document.documentElement, dom.document.head, ...Object.values(dom.registry)];
  const seen = new Set();
  let best = null;
  for (const r of roots) {
    for (const n of allDomNodes(r, [])) {
      if (seen.has(n)) continue; seen.add(n);
      const t = collectText(n);
      const ids = new Set(t.match(/kp-[0-9a-f]{16}/g) || []);
      if (t.includes(a) && t.includes(b) && ids.size === 1 && ids.has(a)
          && (best === null || t.length > best.length)) best = t;
    }
  }
  return best;
}
async function runInDom(dom, scriptSrc, fetchImpl) {
  DOM_SINKS = [];
  const pollFns = [];
  const fetchLog = [];
  const wrappedFetch = (url, opts) => { fetchLog.push(String(url)); return fetchImpl(String(url), opts); };
  const sandbox = { document: dom.document, console: { log() {}, error() {}, warn() {}, info() {} },
    fetch: wrappedFetch, setInterval: (fn) => { pollFns.push(fn); return pollFns.length; }, clearInterval: () => {},
    setTimeout: (fn) => { if (typeof fn === 'function') setImmediate(() => { try { fn(); } catch { /* deferred */ } }); return 0; },
    clearTimeout: () => {}, requestAnimationFrame: (fn) => { if (typeof fn === 'function') setImmediate(() => { try { fn(); } catch { /* raf */ } }); return 0; },
    cancelAnimationFrame: () => {},
    queueMicrotask: (fn) => Promise.resolve().then(fn) };
  sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(scriptSrc, ctx, { timeout: 5000 });
  await flush();
  return { pollFns, fetchLog, sandbox };
}

// ==== the drives =========================================================================
const watchdog = setTimeout(() => {
  console.log('FAIL - global watchdog: the suite exceeded 540s');
  for (const k of kids) { try { k.kill(); } catch { /* gone */ } }
  process.exit(1);
}, 540000);

async function main() {
  if (!fs.existsSync(SCRIPT)) { fail('scripts/dashboard.js does not exist'); return; }

  const server = await startDashboard({ PIPELINE_STATE_DIR: STATE, DASHBOARD_RUNS_DIR: RUNS, DASHBOARD_PORT: '0' });
  if (!check('CC1 the dashboard starts and announces a loopback port', server.ok)) {
    fail('CC1/CC2/CC3/CC4 not testable: the dashboard did not start', server.why);
    return;
  }
  const port = server.port;

  // ---- C1: the GET /conveyor-state endpoint contract (CC1) -------------------------------
  const first = await getJson(port, '/conveyor-state');
  check('CC1 GET /conveyor-state answers 200 with parseable JSON', first.res.status === 200 && !!first.st);
  check('CC1 /conveyor-state is application/json',
    String(first.res.headers['content-type'] || '').startsWith('application/json'));
  check('CC1 /conveyor-state is served Cache-Control: no-store',
    String(first.res.headers['cache-control'] || '') === 'no-store');
  check('CC1 /conveyor-state carries { schema:<int>, now:<iso>, projects:[] }',
    !!first.st && Number.isInteger(first.st.schema) && typeof first.st.now === 'string'
    && !Number.isNaN(Date.parse(first.st.now)) && Array.isArray(first.st.projects));
  {
    const legacy = await getJson(port, '/state');
    check('CC1 the legacy /state endpoint still answers its schema:1 contract beside the new route',
      legacy.res.status === 200 && !!legacy.st && legacy.st.schema === 1 && Array.isArray(legacy.st.projects));
    for (const p of ['/conveyor-state/x', '/conveyor', '/state/../pipeline.config.json', '/nope-29l']) {
      const r = await get(port, p);
      check(`CC1 unknown route ${p} is refused 404 with body "not found\\n"`, r.status === 404 && r.body === 'not found\n');
    }
    check('CC1 the endpoint bound loopback only ([::1] connect does not succeed)', await connectFails('::1', port));
  }

  const st = first.st || { projects: [] };
  const S = jtext(st);

  // ---- C2: reads both layouts, correlates exactly, redacts, reports degraded (CC2) ------
  check('CC2 a supervisor-backed idea is present by its exact proposal identity', S.includes(A.merged.id));
  check('CC2 a supervisor-backed idea exposes its display title', S.includes(A.merged.title));
  check('CC2 an intake-only idea (no supervisor journal) is visible by identity and title',
    S.includes(A_INTAKE.id) && S.includes(`A intake-only idea ${NONCE}`));

  // Exact identity correlation: A's project entry holds A ideas, never B's, and vice versa.
  const entA = projectEntry(st, 'alpha-app');
  const entB = projectEntry(st, 'beta-game');
  check('CC2 project A and project B are independent entries', !!entA && !!entB && entA !== entB);
  check('CC2 project A carries its own ideas and never cross-associates project B ideas',
    !!entA && jtext(entA).includes(A.merged.id) && !jtext(entA).includes(B.merged.id) && !jtext(entA).includes(B_INTAKE.id));
  check('CC2 project B carries its own ideas and never cross-associates project A ideas',
    !!entB && jtext(entB).includes(B.merged.id) && !jtext(entB).includes(A.merged.id) && !jtext(entB).includes(A_INTAKE.id));

  // Display-safe fields only: titles yes, raw kickoff/constraints/model/config/credentials no.
  for (const secret of ALL_SECRETS) {
    check(`CC2 the endpoint never discloses the ${secret.split('-')[0]} secret material`, !S.includes(secret));
  }

  // Identity/hash mismatch: a tampered intake record is refused, healthy siblings survive.
  check('CC2 a tampered-intent intake record is not surfaced as a healthy idea', !S.includes(A_TAMPERED_TITLE));
  check('CC2 the healthy intake-only idea beside the tampered one is still shown', S.includes(`A intake-only idea ${NONCE}`));

  // Malformed sibling isolation and explicit degraded evidence.
  check('CC2 project C with a malformed journal still surfaces (degraded), not omitted',
    !!projectEntry(st, 'gamma-tool'));
  check('CC2 project C healthy intake idea beside the malformed record still renders', S.includes(C_INTAKE.id));
  {
    const entC = projectEntry(st, 'gamma-tool');
    check('CC2 project C reports explicit degraded/incomplete evidence for the malformed artifacts',
      !!entC && /degrad|incomplete|unreadable|malformed|invalid|unavailable|attention/i.test(jtext(entC)));
  }
  check('CC2 healthy projects A and B are unaffected by C\'s malformed sibling',
    S.includes(A.merged.id) && S.includes(B.merged.id));

  // Reject links / path escapes (Correction 1). Non-vacuous: every linked artifact is a REAL
  // valid record/journal, and the byte-identical shape in a legal layout is proven to surface
  // first, so an absent sentinel means the link was refused, not that the shape was rejected.
  check('CC2 [control] a valid record in a LEGAL layout surfaces its title (escape checks are non-vacuous)',
    S.includes(LINK_LEGAL_SENTINEL));
  if (LINK_RECORD) {
    check('CC2 a proposal record that is a symlink out of the tree is not followed', !S.includes(LINK_RECORD_SENTINEL));
    check('CC2 the healthy real record beside the linked record still renders', S.includes(D_INTAKE.id));
    check('CC2 the project with a linked record reports explicit degraded/refused evidence',
      !!projectEntry(st, 'delta-svc') && /degrad|refus|link|unreadable|escape|unavailable|attention|incomplete/i.test(evidenceText(projectEntry(st, 'delta-svc') || {})));
  } else { skip('CC2 linked proposal record refusal (links are not creatable on this host)'); }
  if (LINK_ANCESTRY) {
    check('CC2 a linked proposals-directory ancestry is not descended (off-tree record hidden)', !S.includes(LINK_ANCESTRY_SENTINEL));
  } else { skip('CC2 linked ancestry refusal (links are not creatable on this host)'); }
  if (LINK_JOURNAL) {
    check('CC2 a supervisor journal that is a symlink out of the tree is not followed', !S.includes(LINK_JOURNAL_SENTINEL));
    check('CC2 the healthy intake idea beside the linked journal still renders', S.includes(JLINK_INTAKE.id));
  } else { skip('CC2 linked supervisor journal refusal (links are not creatable on this host)'); }
  check('CC2 healthy projects A and B are unaffected by the link/path-escape siblings',
    S.includes(A.merged.id) && S.includes(B.merged.id));

  // Exact identity correlation (Correction 2). Valid-shaped attacks must neither surface as a
  // healthy idea nor rename/reassociate one; a healthy supervised control must still show, so
  // an implementation that simply drops all supervisor data cannot pass.
  // The unrelated issue is placed first with state 'authoring'; the correct issue's latest
  // state is 'proven-at-base'. A reader keying evidence.issues[0] reports 'authoring' as the
  // current preparation state and never reaches 'proven-at-base' for the known issue.
  const corrOkBlob = ideaBlob(st, CORR_OK.id, CORR_OK.title);
  check('CC2 [control] the healthy supervised idea correlates by its exact issue, not evidence.issues[0]',
    !!corrOkBlob && jtext(corrOkBlob).includes('proven-at-base'));
  check('CC2 a valid foreign-target record dropped into another partition never surfaces',
    !S.includes(FOREIGN_TARGET_SENTINEL));
  check('CC2 a record whose id disagrees with its filename never surfaces', !S.includes(FILENAME_MISMATCH_SENTINEL));
  {
    const renameBlob = ideaBlob(st, CORR_RENAME.id, CORR_RENAME.title);
    check('CC2 an unverified journal title cannot rename a healthy idea (verified intake title wins)',
      !!renameBlob && !S.includes(SUBMIT_RENAME_SENTINEL));
  }
  check('CC2 the corr project still surfaces its healthy idea despite the identity attacks beside it',
    !!projectEntry(st, 'corr-app') && S.includes(CORR_OK.id));

  // ---- C4: the enumerated deterministic scenarios (CC4) ----------------------------------
  // Each idea is located by its unique id AND unique title, so the located object is the idea's
  // own record and its stage/verdict/preparation fields sit inside it.
  const idea = (spec) => ideaBlob(st, spec.id, spec.title);
  const has = (spec, term) => { const b = idea(spec); return !!b && jtext(b).includes(term); };
  check('CC4 an authoring-tests idea shows its stage and preparation state (authoring)',
    has(A.auth, 'authoring-tests') && has(A.auth, 'authoring'));
  check('CC4 a proving idea shows its stage and preparation state (proving)',
    has(A.prove, 'proving'));
  check('CC4 a freezing / awaiting-approval idea shows its stage and proven-at-base preparation',
    has(A.freeze, 'freezing') && has(A.freeze, 'proven-at-base'));
  check('CC4 an implementing idea shows the actual implementation stage',
    has(A.impl, 'implementing'));
  check('CC4 a merged verdict remains at review — stage review with verdict merged, not pending',
    has(A.merged, 'review') && has(A.merged, 'merged') && !has(A.merged, 'pending'));
  check('CC4 a pending review idea shows the pending verdict',
    has(A.pending, 'review') && has(A.pending, 'pending'));
  check('CC4 a rejected idea shows the rejected verdict at the rejected stage',
    has(A.rejected, 'rejected'));
  check('CC4 a contradictory review keeps the accepted merged disposition and surfaces the conflict',
    has(A.conflict, 'merged') && /conflict/i.test(jtext(idea(A.conflict) || {})));
  check('CC4 independent projects: at least three project entries with no cross-association',
    Array.isArray(st.projects) && st.projects.length >= 3);
  check('CC4 hostile artifact text is passed through verbatim (escaping is the browser\'s job)',
    allObjects(st, []).some((o) => Object.values(o).includes(JSON.parse(A_HOSTILE.intent).title)));
  {
    const entF = projectEntry(st, 'flood-app');
    check('CC4 a finite-limit flood project surfaces an explicit incomplete/limit warning',
      !!entF && /limit|truncat|incomplete|capp|bound|partial|too many|exceed|overflow/i.test(jtext(entF)));
  }

  // Displayed references and update time (Correction 4). The fixture carries issue id, run id,
  // PR reference and an event timestamp for the merged idea; the idea's own record must expose
  // them as inert values, not drop them. Located within the idea's own smallest object.
  {
    const b = idea(A.merged);
    const bt = jtext(b || {});
    check('CC4 the merged idea exposes its exact issue id', !!b && bt.includes(A.merged.issueId));
    check('CC4 the merged idea exposes its exact run id', !!b && bt.includes(A.merged.runId));
    check('CC4 the merged idea exposes its exact PR reference (inert text)', !!b && bt.includes(A.merged.prUrl));
    check('CC4 the merged idea exposes a recorded update/observation timestamp',
      !!b && /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(bt));
  }
  // An intake-only idea needs an explicit recorded/unknown stage indication, not a bare gap.
  {
    const b = ideaBlob(st, A_INTAKE.id, `A intake-only idea ${NONCE}`);
    check('CC4 an intake-only idea carries an explicit stage/status indication (recorded or unknown), not an unlabelled gap',
      !!b && /intake|submitted|unknown|recorded|awaiting|none|pending|no-run|not started|queued/i.test(evidenceText(b, [A_INTAKE.id, `A intake-only idea ${NONCE}`])));
  }

  // Degradation reflects evidence, not an echoed label (Correction 5). The silent-conflict idea
  // carries two contradictory review observations and NO pre-baked conflict wording, so surfacing
  // the contradiction requires comparing the observations.
  {
    const b = idea(A.silent);
    const bt = evidenceText(b || {}, [A.silent.id, A.silent.title]);
    check('CC5 [control] the silent-conflict fixture contains no pre-baked conflict wording',
      !/conflict|contradict|mismatch|disagree/i.test(A_JOURNAL.filter((e) => e.proposalId === A.silent.id).map((e) => jtext(e)).join('')));
    check('CC4 a silently contradictory review keeps the accepted merged disposition',
      !!b && bt.includes('merged'));
    check('CC4 a silently contradictory review exposes the contradiction derived from the evidence',
      !!b && /conflict|contradict|mismatch|disagree/i.test(bt));
  }

  // Bounded WORK, not just bounded results (Correction 3a): a flood of malformed records that
  // never verify must still trip the scan limit. A reader whose budget counts only verified
  // records reads all of them silently.
  {
    const entM = projectEntry(st, 'malformed-flood-app');
    check('CC4 a malformed-record flood surfaces an explicit limit/truncation term (attempted work is bounded)',
      !!entM && /limit|truncat|incomplete|capp|bound|partial|too many|exceed|overflow/i.test(evidenceText(entM)));
    check('CC4 the healthy record beside the malformed flood still renders', S.includes(MALFLOOD_HEALTHY.id));
  }

  // Restart identity preservation + next-poll appended evidence + determinism (CC4/CC1).
  {
    const a = await get(port, '/conveyor-state');
    const b = await get(port, '/conveyor-state');
    const holdNow = (body) => String(body).replace(/("now"\s*:\s*)"[^"]*"/, '$1"NOW"');
    check('CC4 two polls of an unchanged tree are byte-identical except now (re-read per request)',
      holdNow(a.body) === holdNow(b.body));
    // Append a genuinely new intake idea; the very next poll must reflect it.
    const APPEND_ID = 'kp-00000000000000f9';
    writeIntake(TGT_A, APPEND_ID, `A appended idea ${NONCE}`);
    const c = await getJson(port, '/conveyor-state');
    check('CC4 an appended intake idea is visible on the next poll (no startup cache)',
      !!c.st && jtext(c.st).includes(APPEND_ID));
    // Restart the reader as a fresh process; the existing identities are preserved.
    const restart = await startDashboard({ PIPELINE_STATE_DIR: STATE, DASHBOARD_RUNS_DIR: RUNS, DASHBOARD_PORT: '0' });
    if (check('CC4 the reader restarts', restart.ok)) {
      const d = await getJson(restart.port, '/conveyor-state');
      check('CC4 restart preserves idea identities (the same proposal ids reappear)',
        !!d.st && jtext(d.st).includes(A.merged.id) && jtext(d.st).includes(A_INTAKE.id) && jtext(d.st).includes(APPEND_ID));
      await stop(restart.child);
    }
  }

  // ---- C3: the served page executes, polls /conveyor-state, renders inert text (CC3) -----
  {
    const pageRes = await get(port, '/');
    const scripts = [...pageRes.body.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((mm) => mm[1]).join('\n;\n');
    const conveyor = (await getJson(port, '/conveyor-state')).st || {};
    const legacy = (await getJson(port, '/state')).st || {};
    const fetchImpl = (url) => {
      const body = /conveyor-state/.test(url) ? conveyor : (/state/.test(url) ? legacy : {});
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve(jtext(body)) });
    };

    // Positive control FIRST: prove the harness itself renders text, independent of the page.
    {
      const dom = buildDom(pageRes.body);
      const MARK = `CTRL-OK-${NONCE}`;
      const ctrl = `'use strict';var r=document.getElementById('__ctrl_root__');var d=document.createElement('div');`
        + `d.textContent=${JSON.stringify(MARK)};r.appendChild(d);`;
      try {
        await runInDom(dom, ctrl, fetchImpl);
        check('CC5 the DOM harness positive control renders known text (a broken harness cannot pass)',
          dom.text().includes(MARK));
      } catch (e) { fail('CC5 the DOM harness positive control threw', e.message); }
    }

    if (!scripts.trim()) {
      fail('CC3 the served page carries no inline script to execute');
    } else {
      const dom = buildDom(pageRes.body);
      let run = null;
      try { run = await runInDom(dom, scripts, fetchImpl); }
      catch (e) { fail('CC3 the served page script threw in the DOM harness', e.message); }
      if (run) {
        const rendered = dom.text();
        check('CC3 the served page polls the /conveyor-state endpoint',
          run.fetchLog.some((u) => /conveyor-state/.test(u)));
        check('CC3 the page installs a repeating poll (setInterval) for live updates',
          run.pollFns.length >= 1);
        check('CC3 the page renders a fixture proposal identity as text', rendered.includes(A.merged.id));
        check('CC3 the page renders a fixture proposal title as text', rendered.includes(A.merged.title));
        check('CC3 the page renders a fixture stage as text', rendered.includes('review') || rendered.includes('implementing'));
        check('CC3 the page renders a fixture preparation state as text',
          rendered.includes('proving') || rendered.includes('proven-at-base') || rendered.includes('authoring'));
        check('CC3 the page renders merged/pending/rejected verdicts as text',
          rendered.includes('merged') && rendered.includes('pending') && rendered.includes('rejected'));
        check('CC3 hostile artifact text is rendered as inert text, never as live HTML',
          rendered.includes(HOSTILE) && !DOM_SINKS.some((s) => s.includes(HOSTILE))
          && run.sandbox[`__pwned_${NONCE}`] === undefined);
        check('CC3 the existing /state run rendering is preserved (legacy run task still shown)',
          rendered.includes(LEGACY_TASK_ID) || rendered.includes(LEGACY_TASK_TITLE));

        // Displayed references live WITHIN the merged idea's own rendered item, not merely
        // somewhere on the page (Correction 4). References may be siblings of the header;
        // the enclosing card must contain only this proposal identity.
        const itemText = ideaRenderedText(dom, A.merged.id, A.merged.title);
        check('CC3 the merged idea\'s rendered item carries its exact run id (not a match elsewhere)',
          !!itemText && itemText.includes(A.merged.runId));
        check('CC3 the merged idea\'s rendered item carries its exact PR reference as inert text',
          !!itemText && itemText.includes(A.merged.prUrl)
          && !DOM_SINKS.some((s) => s.includes(A.merged.prUrl)));
      }
    }

    // A failed /conveyor-state poll must show a visible unavailable/degraded state while the
    // legacy /state run view remains distinguishable (Correction 5). The conveyor fetch
    // rejects; /state still resolves.
    if (scripts.trim()) {
      const dom = buildDom(pageRes.body);
      const failConveyor = (url) => {
        if (/conveyor-state/.test(url)) return Promise.reject(new Error('poll failed'));
        const body = /state/.test(url) ? legacy : {};
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body), text: () => Promise.resolve(jtext(body)) });
      };
      let run2 = null;
      try { run2 = await runInDom(dom, scripts, failConveyor); }
      catch (e) { fail('CC5 the served page throws while handling a failed conveyor poll', e.message); }
      if (run2) {
        const rendered = dom.text();
        check('CC5 a failed /conveyor-state poll surfaces a visible unavailable/degraded state',
          /unavailable|degrad|cannot|stalled|unreachable|failed|not running|offline|error/i.test(rendered));
        check('CC5 the legacy /state run view remains distinguishable when /conveyor-state is down',
          rendered.includes(LEGACY_TASK_ID) || rendered.includes(LEGACY_TASK_TITLE));
      }
    }
  }

  // Empty state root is NOT a read failure (Correction 5): a never-created/empty root means
  // "no ideas", answered 200 with no degraded/unavailable flag — distinct from an access error.
  {
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-29l-'));
    const emptyServer = await startDashboard({ PIPELINE_STATE_DIR: emptyRoot, DASHBOARD_RUNS_DIR: RUNS, DASHBOARD_PORT: '0' });
    if (check('CC5 the reader starts against an empty state root', emptyServer.ok)) {
      const e = await getJson(emptyServer.port, '/conveyor-state');
      check('CC5 an empty state root answers 200 with an empty idea set and no read-failure flag',
        e.res.status === 200 && !!e.st && Array.isArray(e.st.projects)
        && !e.st.projects.some((p) => /idea|proposal/i.test(jtext(p)))
        && !/unreadable|read-failure|read-error|root-unreadable|access-denied/i.test(jtext(e.st)));
      await stop(emptyServer.child);
    }
  }

  // ---- C5: a pure reader, proved by in-process side-effect detection (CC5) ---------------
  {
    const src = fs.readFileSync(SCRIPT, 'utf8');
    check('CC5 the dashboard source contains no child_process token anywhere', !src.includes('child_process'));

    // Snapshot the whole state tree, then call the reader in-process with every write, spawn
    // and outbound-network sink patched to record. A pure reader trips none of them.
    const snap = snapshot(STATE);
    const violations = [];
    const cp = require('child_process');
    const dns = require('dns');
    const saved = [];
    const trap = (obj, name, label) => {
      if (!obj || typeof obj[name] !== 'function') return;
      saved.push([obj, name, obj[name]]);
      obj[name] = (...args) => { violations.push(`${label}.${name}`); throw new Error(`prohibited ${label}.${name}`); };
    };
    for (const n of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) trap(cp, n, 'child_process');
    for (const n of ['request', 'get']) { trap(http, n, 'http'); trap(require('https'), n, 'https'); }
    for (const n of ['connect', 'createConnection']) trap(net, n, 'net');
    for (const n of ['lookup', 'resolve', 'resolve4']) trap(dns, n, 'dns');
    for (const n of ['writeFileSync', 'appendFileSync', 'writeSync', 'mkdirSync', 'mkdtempSync', 'rmSync',
      'rmdirSync', 'unlinkSync', 'renameSync', 'symlinkSync', 'linkSync', 'truncateSync', 'copyFileSync',
      'chmodSync', 'writev', 'createWriteStream', 'writeFile', 'appendFile', 'mkdir', 'rm']) trap(fs, n, 'fs-write');

    // Measure bytes once and count distinct malformed-file content attempts. Track
    // descriptors so openSync/readSync readers obey the same checks as readFileSync.
    const readWork = { total: 0, malformed: new Set(), linked: new Set() };
    const origReadFileSync = fs.readFileSync;
    const origReadSync = fs.readSync;
    const origOpenSync = fs.openSync;
    const origCloseSync = fs.closeSync;
    const descriptors = new Map();
    let wholeFileDepth = 0;
    const attempted = (value) => {
      const file = typeof value === 'number' ? descriptors.get(value) : value;
      if (typeof file !== 'string') return;
      const resolved = path.resolve(file);
      if (MALFORMED_FILES.has(resolved)) readWork.malformed.add(resolved);
      if (LINK_READ_PATHS.has(resolved)) readWork.linked.add(resolved);
    };
    const installReadCounter = () => {
      fs.openSync = (...args) => {
        const fd = origOpenSync(...args); descriptors.set(fd, args[0]); return fd;
      };
      fs.closeSync = (...args) => {
        try { return origCloseSync(...args); } finally { descriptors.delete(args[0]); }
      };
      fs.readFileSync = (...args) => {
        attempted(args[0]); wholeFileDepth++;
        try {
          const value = origReadFileSync(...args);
          readWork.total += Buffer.isBuffer(value) ? value.length : Buffer.byteLength(value, 'utf8');
          return value;
        } finally { wholeFileDepth--; }
      };
      fs.readSync = (...args) => {
        attempted(args[0]);
        const count = origReadSync(...args);
        if (!wholeFileDepth) readWork.total += count;
        return count;
      };
    };
    const restoreReadCounter = () => {
      fs.readFileSync = origReadFileSync; fs.readSync = origReadSync;
      fs.openSync = origOpenSync; fs.closeSync = origCloseSync;
      descriptors.clear();
    };

    let built = null;
    let threw = null;
    try {
      delete require.cache[require.resolve(SCRIPT)];
      const mod = require(SCRIPT);                     // module load happens BEFORE counting
      if (typeof mod.buildConveyorState !== 'function') {
        threw = 'scripts/dashboard.js does not export a buildConveyorState reader';
      } else {
        installReadCounter();
        try { built = mod.buildConveyorState(STATE); }
        finally { restoreReadCounter(); }
      }
    } catch (e) { threw = e.message; restoreReadCounter(); }
    finally { for (const [obj, name, fn] of saved.reverse()) obj[name] = fn; }

    const observedWork = { total: readWork.total, malformed: readWork.malformed.size, linked: readWork.linked.size };
    // Exercise the actual installed instrumentation, not a separately recreated wrapper.
    readWork.total = 0; readWork.malformed.clear(); readWork.linked.clear();
    let readableLinks = true;
    installReadCounter();
    try {
      fs.readFileSync(HEAVY_JOURNAL_FILE);
      fs.readFileSync(MALFORMED_FILES.values().next().value);
      for (const row of LINK_READ_FILES) {
        if (!fs.readFileSync(row.linked).equals(origReadFileSync(row.outside))) readableLinks = false;
      }
    } catch { readableLinks = false; }
    finally { restoreReadCounter(); }
    check('CC5 [control] installed read instrumentation detects a wholesale oversized read',
      readWork.total >= HEAVY_JOURNAL_SIZE);
    check('CC5 [control] installed read instrumentation counts a malformed content attempt',
      readWork.malformed.size === 1);
    if (LINK_READ_FILES.length) {
      check('CC5 [control] constructed links expose the intended bytes and read instrumentation detects them',
        readableLinks && LINK_READ_FILES.every((row) => readWork.linked.has(row.linked)));
      check('CC5 the reader makes no content-read attempt through linked artifacts or their outside targets',
        !!built && observedWork.linked === 0);
    }

    check('CC5 the in-process conveyor reader runs without a subprocess, network or write side effect',
      !threw && violations.length === 0);
    if (threw) note(`in-process reader unavailable: ${threw}`);
    for (const v of violations) note(`prohibited side effect: ${v}`);
    check('CC5 the in-process reader returns the same display data (a proposal identity is present)',
      !!built && jtext(built).includes(A.merged.id) && jtext(built).includes(A_INTAKE.id));
    check('CC5 the state tree is byte-identical after the reader runs (no filesystem mutation)',
      sameSnapshot(snap, snapshot(STATE)));
    check('CC5 the in-process reader also discloses no credential or secret material',
      !!built && !ALL_SECRETS.some((s) => jtext(built).includes(s)));

    // Bounded WORK (Correction 3b/3c): the reader must not read the oversized journal or record
    // wholesale. The total bytes it read stays below a single oversized file, and the affected
    // idea/project reports explicit truncation/degradation while healthy siblings survive.
    const heavyBlob = built ? projectEntry(built, 'heavy-journal-app') : null;
    const bigrecBlob = built ? projectEntry(built, 'big-record-app') : null;
    const DEG_RE = /limit|truncat|incomplete|capp|bound|partial|too many|exceed|overflow|degrad|unreadable|oversize/i;
    check('CC5 the reader does not read the oversized artifacts wholesale (total read work < one oversized file)',
      !!built && observedWork.total < HEAVY_JOURNAL_SIZE);
    check('CC5 malformed-record work stops before reading every file in the practical flood fixture',
      !!built && observedWork.malformed < MALFLOOD_COUNT);
    check('CC5 the oversized-journal project reports explicit truncation/degradation',
      !!heavyBlob && DEG_RE.test(evidenceText(heavyBlob)));
    check('CC5 the healthy idea beside the oversized journal still surfaces',
      !!built && jtext(built).includes(HEAVY_INTAKE.id));
    check('CC5 the oversized single record is reported as degraded/truncated, not read wholesale',
      !!bigrecBlob && DEG_RE.test(evidenceText(bigrecBlob)));
    check('CC5 the healthy record beside the oversized record still surfaces',
      !!built && jtext(built).includes(BIGREC_HEALTHY.id));
  }

  await stop(server.child);
}

// ---- filesystem snapshot (byte-wise) ----------------------------------------------------
function snapshot(root) {
  const map = new Map();
  if (!fs.existsSync(root)) return map;
  (function walk(dir) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(dir, e.name);
      const rel = path.relative(root, p).split(path.sep).join('/');
      if (e.isDirectory()) { map.set(`${rel}/`, 'dir'); walk(p); }
      else { try { map.set(rel, crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex')); } catch { map.set(rel, 'unreadable'); } }
    }
  }(root));
  return map;
}
function sameSnapshot(a, b) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

process.on('unhandledRejection', (e) => {
  console.log(`FAIL - unhandled rejection: ${e && e.message ? e.message : e}`);
  for (const k of kids) { try { k.kill(); } catch { /* gone */ } }
  process.exit(1);
});

main().then(() => {
  clearTimeout(watchdog);
  for (const k of kids) { try { k.kill(); } catch { /* gone */ } }
  process.exit(failed);
}, (e) => {
  console.log(`FAIL - the suite threw: ${e && e.stack ? e.stack.split('\n')[0] : e}`);
  clearTimeout(watchdog);
  for (const k of kids) { try { k.kill(); } catch { /* gone */ } }
  process.exit(1);
});
