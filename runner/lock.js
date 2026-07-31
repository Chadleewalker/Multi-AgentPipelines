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
// So a run takes a lock on its target repo before it does anything else, and a second run
// against the same repo is refused by name. This is the same move `scripts/test-all.sh`
// already makes for test sweeps, and the lock lives beside that one, under `runs/`.
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

// Beside `runs/.test-all.lock`, the sweep lock this is modelled on. `runs/` is
// git-ignored, host-only, and already the home of everything a run produces.
const LOCK_SUBDIR = path.join('runs', 'locks');

// The uptime counter can be read a moment apart in two processes; only a decrease well
// beyond that is evidence of a reboot.
const UPTIME_SLACK_MS = 5000;
// How much longer than the host's uptime a lock may claim to have existed before we call
// it pre-reboot. Generous on purpose: on a host whose uptime counter stops during sleep,
// a suspended-and-resumed machine looks briefly like a rebooted one, and mistaking a LIVE
// holder for a dead one is the expensive direction of this error.
const PRE_BOOT_GRACE_MS = 15 * 60 * 1000;

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

// A readable name for whoever finds the file, plus a digest of the canonical path so two
// projects with the same basename cannot share a lock. The digest is what decides
// identity; the slug is only there so `ls runs/locks` means something.
function lockPath(repoRoot, targetRepoPath) {
  const canon = canonicalTarget(targetRepoPath);
  const digest = crypto.createHash('sha1').update(canon).digest('hex').slice(0, 12);
  const slug = path.basename(canon).toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 32);
  return path.join(repoRoot, LOCK_SUBDIR, `${slug || 'project'}-${digest}.lock`);
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

function selfRecord(runId, canonTarget) {
  return {
    runId: String(runId),
    pid: process.pid,
    target: canonTarget,
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

// acquire(repoRoot, targetRepoPath, runId)
//   -> { ok: true,  tookOver: false }                        the project was free
//   -> { ok: true,  tookOver: true, previous: {runId, pid} } the holder was gone; seized
//   -> { ok: false, holder: {runId, pid, since, ...} }       someone live holds it
//
// Deliberately NOT registered against process exit: a crashed run must leave its lock
// behind for the next run to take over, and that path is the only protection there is
// when a process dies without running handlers. Releasing is the caller's job.
function acquire(repoRoot, targetRepoPath, runId) {
  if (!repoRoot || typeof repoRoot !== 'string') throw new Error('lock: a pipeline repo root is required');
  const canon = canonicalTarget(targetRepoPath);
  const file = lockPath(repoRoot, targetRepoPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  // Bounded retry: each pass either settles or loses a race to another challenger, and a
  // challenger that wins becomes the live holder the next pass reports.
  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (tryCreate(file, selfRecord(runId, canon))) return { ok: true, tookOver: false };

    last = readRecord(file);
    if (isHolderLive(last)) return { ok: false, holder: holderOf(last, file) };

    // Gone, or unreadable: clear it and re-take it through the same exclusive create, so
    // a second challenger arriving mid-takeover still loses cleanly rather than sharing.
    try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (tryCreate(file, selfRecord(runId, canon))) {
      return {
        ok: true,
        tookOver: true,
        previous: {
          runId: (last && last.runId) || '(unreadable lock record)',
          pid: (last && last.pid) || null,
          since: (last && last.startedAt) || null,
        },
      };
    }
  }
  return { ok: false, holder: holderOf(readRecord(file) || last, file) };
}

// Release ours and only ours. A run that was refused still runs its exit path, and
// removing the lock it was just refused by would hand the project to the next run to
// ask — so the record has to say it is us before the file goes.
function release(repoRoot, targetRepoPath) {
  const file = lockPath(repoRoot, targetRepoPath);
  const rec = readRecord(file);
  if (!rec || rec.pid !== process.pid) return;
  try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

module.exports = { acquire, release, lockPath, canonicalTarget };
