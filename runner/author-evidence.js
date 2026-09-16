// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

// Durable author-generation evidence for one acceptance suite (DESIGN.md §3.2).
//
// A suite directory is not evidence. A managed author process that is killed after writing
// `test.js` and `guard.js`, but before a terminal provider result or the two-direction proof,
// leaves exactly the same files behind as a finished one — so any reader that asks only
// "does the directory hold files?" reports an interrupted half-generation as freeze-ready and
// prints a freeze command for it.
//
// The authority is therefore the durable preparation record (`runner/preparation-state.js`), which
// lives under the host's preparation root and never inside the model-editable worktree: a started
// record with no result, or a result whose outcome says the AUTHORING half never reached a
// terminal completed result, contradicts the files on disk no matter how complete they look.
//
// This module is pure policy plus two bounded readers. It never writes, never launches anything,
// and never decides a freeze: `mayPrintFreezeCommand` only says whether a caller is permitted to
// offer the existing human-approval step, which remains the sole freeze boundary.

const fs = require('fs');
const path = require('path');
const prepState = require('./preparation-state');
const lock = require('./lock');

const STATES = Object.freeze({
  ABSENT: 'absent',
  AUTHORING: 'authoring',
  INTERRUPTED_PARTIAL: 'interrupted-partial',
  AUTHORED_UNPROVEN: 'authored-unproven',
  PROVEN: 'proven',
  FROZEN: 'frozen',
});

// Worker outcomes (`scripts/prepare-batch-worker.js` -> `writeWorkerResult`) that mean the
// author-proof attempt's AUTHORING half never reached a terminal completed result. Every one of
// them is compatible with a suite directory holding a complete-looking set of files.
//   agent-failed        the provider exited nonzero
//   agent-incomplete    the provider exited zero with no terminal completed result (repo-7a0)
//   boundary-violation  the session wrote outside its suite; its suite bytes are not trustworthy
//   interrupted         the worker was killed, crashed, or lost its own result channel
//   setup-failed        the attempt never got as far as launching a model
//   abandoned           a human acknowledged that the worker and descendants were stopped
//   invalid             the worker's envelope was unreadable, so nothing about it is known
const AUTHOR_INCOMPLETE_OUTCOMES = Object.freeze([
  'agent-failed', 'agent-incomplete', 'boundary-violation', 'interrupted',
  'setup-failed', 'abandoned', 'invalid', 'usage-limit',
]);

// `proven-at-base` is the worker vocabulary; `proven` is the solo `authorIssue` vocabulary.
const PROVEN_OUTCOMES = Object.freeze(['proven-at-base', 'proven']);

// The three states in which suite files are what they appear to be. Nothing else may be offered
// the freeze command, because a freeze command is a claim that a human has something to approve.
const FREEZE_COMMAND_STATES = Object.freeze([
  STATES.AUTHORED_UNPROVEN, STATES.PROVEN, STATES.FROZEN,
]);

function phaseOf(started) {
  if (!started) return null;
  return started.phase || (started.data && started.data.action) || null;
}

function outcomeOf(result) {
  return result && typeof result.outcome === 'string' ? result.outcome : null;
}

// Pure and synchronous: every input is supplied by the caller so the same decision can be
// replayed from a test fixture, a CLI, or the batch coordinator without touching a disk.
//
//   frozen      the suite already crossed the publication boundary
//   suiteFiles  null (no suite directory) or the file names present in it
//   latest      the newest `{ started, result }` attempt, or null when none was ever recorded
//   isLive      liveness oracle for an attempt that recorded no result
function classify(input = {}) {
  const isLive = typeof input.isLive === 'function' ? input.isLive : () => false;
  if (input.frozen) {
    return { state: STATES.FROZEN, reason: 'the suite is frozen on the integration branch' };
  }
  const latest = input.latest || null;
  const started = latest && latest.started ? latest.started : null;
  const result = latest && latest.result ? latest.result : null;
  const files = Array.isArray(input.suiteFiles) ? input.suiteFiles : null;

  if (!started) {
    // Nothing durable contradicts the working tree. A hand-authored or legacy suite is still
    // read exactly as it always was — this module only ever subtracts confidence it can justify.
    return files && files.length
      ? { state: STATES.AUTHORED_UNPROVEN,
        reason: 'suite files exist and no recorded author attempt contradicts them' }
      : { state: STATES.ABSENT, reason: 'no suite files and no recorded author attempt' };
  }

  const phase = phaseOf(started);
  const outcome = outcomeOf(result);

  if (phase === 'author-proof') {
    if (!result) {
      // The only signal separating "still writing" from "stopped mid-write" is whether the
      // recorded worker identity is still running. It is best effort by construction.
      return isLive(started.process || started)
        ? { state: STATES.AUTHORING, reason: 'the recorded author-proof worker is still running' }
        : { state: STATES.INTERRUPTED_PARTIAL,
          reason: 'an author-proof worker recorded no result and is no longer running' };
    }
    if (PROVEN_OUTCOMES.includes(outcome)) {
      return { state: STATES.PROVEN, reason: `author-proof attempt settled ${outcome}` };
    }
    if (AUTHOR_INCOMPLETE_OUTCOMES.includes(outcome)) {
      // Deliberately independent of `suiteFiles`: however many files are on disk, this attempt
      // never finished authoring them, so their presence cannot select freeze.
      return { state: STATES.INTERRUPTED_PARTIAL,
        reason: `author-proof attempt settled ${outcome} before authoring completed` };
    }
    // `unproven` and any other terminal outcome: authoring finished, the proof did not.
    return { state: STATES.AUTHORED_UNPROVEN,
      reason: `author-proof attempt settled ${outcome || 'with no recorded outcome'} after authoring completed` };
  }

  // A standalone `proof` attempt only exists once authoring has already completed, so an
  // interruption inside it says nothing about the suite bytes.
  if (PROVEN_OUTCOMES.includes(outcome)) {
    return { state: STATES.PROVEN, reason: `proof attempt settled ${outcome}` };
  }
  return { state: STATES.AUTHORED_UNPROVEN,
    reason: result
      ? `proof attempt settled ${outcome || 'with no recorded outcome'}`
      : 'a proof attempt is unresolved; authoring already completed before it started' };
}

function mayPrintFreezeCommand(state) {
  return FREEZE_COMMAND_STATES.includes(state);
}

// ---- bounded readers -------------------------------------------------------------------------

// The file names of one suite directory, using the same visibility rule `scripts/spec-brief.js`
// applies (the freeze gate's own receipt is controller metadata, not authored content).
function suiteFileNames(root, suiteId) {
  if (typeof root !== 'string' || !root || typeof suiteId !== 'string' || !suiteId) return null;
  try {
    return fs.readdirSync(path.join(root, 'tests', 'acceptance', suiteId))
      .filter((name) => name !== '.freeze-gate.json');
  } catch { return null; }
}

function manifestValue(record) {
  return record && record.value && typeof record.value === 'object' ? record.value : record;
}

function attemptRank(row) {
  const at = Date.parse((row.started && row.started.startedAt) || '');
  return [Number.isFinite(at) ? at : 0, Number.isInteger(row.generation) ? row.generation : 0];
}

function newer(candidate, best) {
  if (!best) return true;
  const a = attemptRank(candidate); const b = attemptRank(best);
  return a[0] !== b[0] ? a[0] > b[0] : a[1] >= b[1];
}

// The newest durable attempt recorded for one issue on one target, across every preparation
// batch. Read-only and fail-soft: an unreadable, absent or foreign record answers `null`, which
// callers must read as "nothing contradicts the working tree", never as "nothing happened".
function findLatestAttempt(cfg, issueId, opts = {}) {
  if (typeof issueId !== 'string' || !issueId) return null;
  const state = opts.state || prepState;
  let root;
  try { root = (opts.preparationRoot || state.preparationRoot)(process.env); }
  catch { return null; }
  let target = null;
  try { if (cfg && cfg.targetRepoPath) target = lock.canonicalTarget(cfg.targetRepoPath); }
  catch { target = null; }
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); }
  catch { return null; }
  let best = null;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    let rows = [];
    try {
      const value = manifestValue(state.readManifest(root, entry.name)) || {};
      const recorded = value.config && value.config.targetRepoPath;
      if (target && recorded && lock.canonicalTarget(recorded) !== target) continue;
      rows = state.readWorkerRecords(root, entry.name, issueId);
    } catch { continue; }
    for (const row of rows) {
      if (row && row.started && newer(row, best)) best = row;
    }
  }
  return best ? { started: best.started, result: best.result || null } : null;
}

// Evidence for one already-built spec brief. `freeze`/`re-gate` mean the brief itself saw suite
// files; a reader that cannot list the directory (a remote-only re-gate, a synthetic brief) must
// not silently downgrade that to `absent`.
function forBrief(built, opts = {}) {
  if (!built || typeof built !== 'object') {
    return { state: STATES.ABSENT, reason: 'no spec brief was supplied' };
  }
  const suiteId = built.suiteId || built.id || null;
  const folderDir = built.folder && built.folder.dir;
  let files = suiteFileNames(folderDir, suiteId);
  if (files === null && (built.state === 'freeze' || built.state === 're-gate')) {
    files = ['(suite present on the branch or in the issue worktree)'];
  }
  return classify({
    frozen: built.state === 'ready',
    suiteFiles: files,
    latest: Object.prototype.hasOwnProperty.call(opts, 'latest')
      ? opts.latest : findLatestAttempt(built.cfg, suiteId, opts),
    isLive: opts.isLive || lock.isHolderLive,
  });
}

// Evidence for one suite directory in one checkout, used where no brief object exists yet.
// Answers `null` when nothing durable was ever recorded, so a caller can keep its historical
// behaviour byte for byte instead of inventing a state.
function forSuite(cfg, suiteId, opts = {}) {
  const latest = Object.prototype.hasOwnProperty.call(opts, 'latest')
    ? opts.latest : findLatestAttempt(cfg, suiteId, opts);
  if (!latest) return null;
  return classify({
    frozen: opts.frozen === true,
    suiteFiles: Object.prototype.hasOwnProperty.call(opts, 'suiteFiles')
      ? opts.suiteFiles : suiteFileNames(opts.folderDir, suiteId),
    latest,
    isLive: opts.isLive || lock.isHolderLive,
  });
}

module.exports = {
  STATES, AUTHOR_INCOMPLETE_OUTCOMES, PROVEN_OUTCOMES, FREEZE_COMMAND_STATES,
  classify, mayPrintFreezeCommand, suiteFileNames, findLatestAttempt, forBrief, forSuite,
  phaseOf,
};
