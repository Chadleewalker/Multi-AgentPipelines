// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Beads access for the runner — the host is the SOLE Beads writer (DESIGN.md §4.10).
// Uses host `bd` when installed (§6 prerequisite); otherwise falls back to running
// `bd` inside the base image against the target repo, so a machine without bd
// installed still works. Either way the canonical database is the working copy at
// cfg.targetRepoPath (§4.12) — never a task branch.
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// An npm-installed `bd` on Windows is a pair of shims — an extensionless /bin/sh script
// and a `.cmd` batch file — and spawnSync can execute NEITHER: the first returns ENOENT,
// the second EINVAL (Node refuses to run a batch file without a shell). The probe then
// answered "no host bd" forever and every call silently took the Docker fallback, one
// container per bd invocation; suites that drive their own `docker run … bd` against the
// same fixture deadlocked against it and were killed at 900s. Nothing errored anywhere —
// the fallback is fail-safe, so it degraded quietly for every run after bd was reinstalled.
//
// A shell is NOT the fix. bd carries agent-authored text — attempt notes, memories, spec
// concerns — and cmd.exe would mangle any quote or metacharacter in it. Instead resolve
// the shim's JS entry point and run it with process.execPath, the same move the unit
// suites' bd stub makes and for the same reason: the node binary behaves identically on
// both platforms.

// Both shim flavours name their target relative to the shim's own directory:
//   sh   ->  exec node  "$basedir/node_modules/@beads/bd/bin/bd.js" "$@"
//   cmd  ->  "%_prog%"  "%dp0%\node_modules\@beads\bd\bin\bd.js" %*
// Exported for tests/unit/bd-shim.test.js — the probe itself depends on the host, but
// this parsing does not, so it is the part that can be pinned.
function shimTarget(text, dir) {
  const m = /(?:\$basedir|%dp0%)[\\/]([^"'\s]+\.js)/.exec(String(text || ''));
  if (!m) return null;
  return path.join(dir, m[1].replace(/\\/g, '/'));
}

// { cmd, pre } — how to invoke host bd, or null when there is none. Memoized: the probe
// costs a process spawn and the answer cannot change inside one run.
//
// EXPORTED, and not only for the runner. `scripts/batch.js` assembles its own read-only
// `ready --json` argv and spawns it once, because every general entry point below falls
// back to `bdInImage` when no host bd resolves — a pure reader must not start a container
// during a launch ritual. What it must NOT do is carry a second copy of this probe: the
// shim shapes are a host fact, and two copies of a host fact drift (change-log row
// `sweep-trustworthy` exported `isHolderLive` for the same reason). So the probe is shared
// and only the argv differs.
let hostBd; // undefined = not probed yet, null = no host bd
function hostBdSpec() {
  if (hostBd !== undefined) return hostBd;
  hostBd = null;
  // A real executable on PATH (every POSIX host, and a native bd.exe on Windows).
  if (spawnSync('bd', ['version'], spawnOptions()).status === 0) {
    hostBd = { cmd: 'bd', pre: [] };
    return hostBd;
  }
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const name of ['bd', 'bd.cmd']) {
      let text;
      try { text = fs.readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
      const js = shimTarget(text, dir);
      // Verify by running it: a shim that names a target which was uninstalled, or a
      // parse that produced a plausible-but-wrong path, must not be trusted on shape.
      if (js && spawnSync(process.execPath, [js, 'version'], spawnOptions()).status === 0) {
        hostBd = { cmd: process.execPath, pre: [js] };
        return hostBd;
      }
    }
  }
  return hostBd;
}

function haveHostBd() {
  return hostBdSpec() !== null;
}

// ---- the bound (§4.1: the runner enforces timeouts) ---------------------------------
// Every runner Beads call is bounded, because an unbounded one parks the whole run: `bd`
// has been seen printing its complete JSON output and then never exiting, and two calls
// against one embedded Dolt database have been seen blocking on each other indefinitely.
// The sweep harness kills a stuck suite at 900s; a real run has no such backstop, and the
// remember/finish pair runs AFTER the container exits — a hang there strands finished work
// with the issue still in_progress and the outcome unwritten.
//
// The bound is spawnSync's own `timeout`, never an asynchronous spawn. In a single-threaded
// runner spawnSync is what makes two bd calls unable to interleave over one embedded
// database, which is what the sole-writer rule (§4.10) rests on once tasks run concurrently.
const DEFAULT_BD_TIMEOUT_MS = 60000;
// `timeout(1)`'s exit code, so a timed-out call is a non-zero status like any other
// failure — every caller already handles that path, and none of them change behaviour.
const TIMEOUT_STATUS = 124;

// The single source of spawn options for this module. Every spawnSync below is built from
// it, INCLUDING the two host-bd probes: a probe that hangs parks the run exactly as a call
// that hangs does. `extra` wins, so a call site can still add env or override the bound.
function spawnOptions(cfg, extra = {}) {
  const want = cfg && cfg.bdTimeoutMs;
  const timeout = Number.isInteger(want) && want > 0 ? want : DEFAULT_BD_TIMEOUT_MS;
  // SIGKILL, not the default SIGTERM: a bound a wedged process can decline to honour is
  // not a bound, and by the time it fires the call is already pathological. Note this
  // reaches the `docker run` client on the fallback path, not the container it started.
  return { encoding: 'utf8', timeout, killSignal: 'SIGKILL', ...extra };
}

// Turn the kernel's version of a timeout into the loud, self-describing failure the
// callers already understand. A silent empty result here would be the same quiet
// degradation this bound exists to prevent, so the message names the bound that fired.
function bounded(r, cfg, opts) {
  const { timeout, killSignal } = spawnOptions(cfg, opts);
  const hitBound = (r.error && (r.error.code === 'ETIMEDOUT' || /ETIMEDOUT/.test(r.error.message || '')))
    || (r.status === null && r.signal === killSignal);
  if (!hitBound) return r;
  const note = `bd timed out after ${timeout}ms (run.config.json bdTimeoutMs) and was killed`;
  return {
    ...r,
    status: TIMEOUT_STATUS,
    timedOut: true,
    stderr: `${(r.stderr || '').trim() ? `${r.stderr}\n` : ''}${note}`,
  };
}

// Docker Desktop on Windows needs a Windows-style mount source; Git Bash's MSYS
// path conversion must also be disabled for container-side paths.
function toMountPath(p) {
  const m = /^\/([a-z])\/(.*)$/i.exec(p);            // /c/projects/... -> C:/projects/...
  if (m) return `${m[1].toUpperCase()}:/${m[2]}`;
  return p.replace(/\\/g, '/');
}

function bd(cfg, args, opts = {}) {
  // Test seam (never set in production): spawn the named executable directly with the
  // bare bd argument vector — no `-C` prefix, no host probe, no Docker fallback — so
  // Docker-free suites can stub the whole bd layer. Takes absolute precedence.
  if (process.env.PIPELINE_BD_CMD) {
    return bounded(
      spawnSync(process.env.PIPELINE_BD_CMD, args, spawnOptions(cfg, { env: process.env, ...opts })),
      cfg, opts
    );
  }
  const host = hostBdSpec();
  if (host) {
    return bounded(
      spawnSync(host.cmd, [...host.pre, '-C', cfg.targetRepoPath, ...args], spawnOptions(cfg, opts)),
      cfg, opts
    );
  }
  return bdInImage(cfg, args, opts);
}

// bd INSIDE THE PER-PROJECT IMAGE, reachable on its own rather than only as `bd()`'s last
// resort. Same invocation `bd()` has always fallen back to; naming it changes no behaviour.
//
// WHY IT NEEDS ITS OWN SEAM. `PIPELINE_BD_CMD` takes absolute precedence over every path in
// `bd()` — that is what lets a Docker-free suite stub the whole layer, and it is deliberate.
// But it means host bd and image bd collapse into one stub, so a check that COMPARES the two
// cannot be driven Docker-free at all: both sides answer identically by construction. That is
// not a hypothetical — it is why `repo-ixa` (abort when the host and image bd versions
// disagree) could not be frozen. A second seam is what makes the two sides distinguishable.
//
// `PIPELINE_IMAGE_BD_CMD` is a TEST SEAM and production must never set it, exactly as with
// `PIPELINE_BD_CMD` (§4.3). Note the asymmetry is real and intended: `bd()` still prefers
// `PIPELINE_BD_CMD` over everything, so a suite that stubs only the general seam keeps its
// existing behaviour untouched.
function bdInImage(cfg, args, opts = {}) {
  if (process.env.PIPELINE_IMAGE_BD_CMD) {
    return bounded(
      spawnSync(process.env.PIPELINE_IMAGE_BD_CMD, args,
        spawnOptions(cfg, { env: process.env, ...opts })),
      cfg, opts
    );
  }
  const mount = `${toMountPath(cfg.targetRepoPath)}:/repo`;
  return bounded(
    spawnSync(
      'docker',
      ['run', '--rm', '-v', mount, '-w', '/repo', cfg.image, 'bd', ...args],
      spawnOptions(cfg, { env: { ...process.env, MSYS_NO_PATHCONV: '1' }, ...opts })
    ),
    cfg, opts
  );
}

// bd ON THE HOST, reachable on its own — the other half of the pair `bdInImage` exists for.
// Returns null when there is no host bd at all, which is a different answer from "ran and
// failed" and the caller must not conflate them: with no host bd there is nothing to compare
// an image version against, and a version gate has no skew to report rather than a skew of
// unknown size.
function bdOnHost(cfg, args, opts = {}) {
  if (process.env.PIPELINE_BD_CMD) {
    return bounded(
      spawnSync(process.env.PIPELINE_BD_CMD, args, spawnOptions(cfg, { env: process.env, ...opts })),
      cfg, opts
    );
  }
  const host = hostBdSpec();
  if (!host) return null;
  return bounded(
    spawnSync(host.cmd, [...host.pre, '-C', cfg.targetRepoPath, ...args], spawnOptions(cfg, opts)),
    cfg, opts
  );
}

function bdJson(cfg, args) {
  const r = bd(cfg, [...args, '--json']);
  if (r.status !== 0) return { ok: false, error: (r.stderr || r.stdout || 'bd failed').trim() };
  try {
    return { ok: true, data: JSON.parse(r.stdout || '[]') };
  } catch {
    return { ok: false, error: 'bd --json returned unparseable output' };
  }
}

module.exports = {
  bd, bdJson, bdOnHost, bdInImage, haveHostBd, hostBdSpec, toMountPath, shimTarget,
  spawnOptions, DEFAULT_BD_TIMEOUT_MS,
};
