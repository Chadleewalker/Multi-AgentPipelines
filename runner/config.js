// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// run.config.json loader — DESIGN.md §4.12 (T11).
// Plain JS, Node built-ins only. Fails fast and by name on an invalid config.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const CONTROL_PLANE = require('./control-plane');

// Defaults are part of the public run-config contract. Their rationale and validation
// remain here; their values come from contracts/control-plane.json so operator guides,
// tests and runtime code cannot grow independent copies.
const DEFAULTS = CONTROL_PLANE.configDefaults;
const REQUIRED = ['targetRepoPath', 'targetRepoRemote', 'image'];
// §7's concurrency knob has NO ceiling (change-log row `concurrency-uncapped`). The literal 3
// that used to live here was a hedge against the shared subscription window, and the run-level
// park (§4.7) already answers that at any N. Kept as a named export so the suites that pin the
// validation contract have one place to read it from; null means "no upper bound".
const MAX_CONCURRENCY = null;

// ---- per-project network + proxy names (§4.8, §4.12) -------------------------------
// The task network and the proxy sidecar are per project, not per pipeline: two runner
// processes against different projects must not create, restart or destroy each other's
// plumbing. So `network` / `proxyName` have no shared default — a default that collides
// silently is the bug this replaces. When a config names neither, both are DERIVED from
// the project segment of the config's own file name, `run.config.<project>.json`.
//
// Why the file name and nothing else: the same names have to be computed by the `up` at
// run start, by every task container, and by the `down` at run end — in one process or in
// several, before and after a pause/resume. Anything drawn from the pid, the clock or a
// random suffix satisfies "unique" and then orphans the network, because teardown
// computes a different name than setup did.
//
// A bare `run.config.json` has no project segment and keeps the historical shared names
// (the runner's own suites generate exactly that), which is why running two projects at
// once means giving each config a project segment.
const DEFAULT_SLUG = 'pipeline';
const CONFIG_NAME_RE = /^run\.config\.(.+)\.json$/i;
const SLUG_MAX = 40;

// Docker accepts `[a-zA-Z0-9][a-zA-Z0-9_.-]*`, but the proxy name is also the host part
// of every task container's HTTPS_PROXY, so the result has to survive DNS as well: one
// lower-case label of letters, digits and inner hyphens. A name Docker takes and DNS
// mishandles (an underscore, a trailing hyphen, mixed case) fails inside the container,
// where no host-side check is looking.
function slugifySegment(segment) {
  let s = String(segment).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (s.length > SLUG_MAX) s = s.slice(0, SLUG_MAX).replace(/-+$/, '');
  return s;
}

// Sanitising is lossy — "My Project" and "my+project" reduce to the same label, and that
// is another silent collision between two projects. When the segment had to be changed
// at all, pin the original with a short digest of it: still a pure function of the file
// name, still legal, and now distinct per project.
function slugForSegment(segment) {
  const clean = slugifySegment(segment);
  if (clean === String(segment)) return clean;
  const digest = crypto.createHash('sha1').update(String(segment)).digest('hex').slice(0, 8);
  return clean ? `${clean}-${digest}` : `p-${digest}`;
}

// { network, proxyName } for a config path, ignoring what the config says — loadConfig
// applies these only where the config named nothing.
function deriveNames(configPath) {
  const m = CONFIG_NAME_RE.exec(path.basename(configPath));
  const slug = m ? slugForSegment(m[1]) : DEFAULT_SLUG;
  return { network: `${slug}-net`, proxyName: `${slug}-proxy` };
}

function loadConfig(file) {
  const p = path.resolve(file || path.join(__dirname, '..', 'run.config.json'));
  if (!fs.existsSync(p)) throw new Error(`run.config.json not found at ${p}`);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`run.config.json is not valid JSON: ${e.message}`);
  }
  for (const k of REQUIRED) {
    if (!raw[k] || typeof raw[k] !== 'string') throw new Error(`run.config.json: missing required field '${k}'`);
  }
  for (const k of ['wallClockMinutes', 'probeIntervalMinutes', 'proxyPort']) {
    if (raw[k] !== undefined && (typeof raw[k] !== 'number' || raw[k] <= 0)) {
      throw new Error(`run.config.json: '${k}' must be a positive number`);
    }
  }
  // The entrypoint's retry loop does shell integer math on this — enforce it here.
  if (raw.maxAttempts !== undefined && !(Number.isInteger(raw.maxAttempts) && raw.maxAttempts > 0)) {
    throw new Error(`run.config.json: 'maxAttempts' must be a positive whole number`);
  }
  // A cycle count, and the only thing that bounds the pause loop — a zero or fractional
  // cap would either park forever or never pause at all.
  if (raw.maxPauseCycles !== undefined && !(Number.isInteger(raw.maxPauseCycles) && raw.maxPauseCycles > 0)) {
    throw new Error(`run.config.json: 'maxPauseCycles' must be a positive whole number`);
  }
  // The bound on every runner Beads call (§4.1). Milliseconds straight into spawnSync's
  // `timeout`, which rejects a fractional or non-positive value late and obscurely — so
  // reject it here, by name, before a run starts.
  if (raw.bdTimeoutMs !== undefined && !(Number.isInteger(raw.bdTimeoutMs) && raw.bdTimeoutMs > 0)) {
    throw new Error(`run.config.json: 'bdTimeoutMs' must be a positive whole number`);
  }
  // The bound on the dispatch gate's git calls (§4.12), validated exactly as bdTimeoutMs is
  // and for the same reason: it goes straight into spawnSync's `timeout`, which rejects a
  // fractional or non-positive value late and obscurely. `git fetch` against an unreachable
  // host parks indefinitely, and an unbounded gate parks the whole run before it claims
  // anything at all.
  if (raw.gitTimeoutMs !== undefined && !(Number.isInteger(raw.gitTimeoutMs) && raw.gitTimeoutMs > 0)) {
    throw new Error(`run.config.json: 'gitTimeoutMs' must be a positive whole number`);
  }
  // Docker probes, network scripts, GitHub CLI publication and other short-lived host
  // lifecycle calls share one bound. The task container itself is deliberately excluded:
  // its much longer active-time budget is enforced by the independent watchdog.
  if (raw.lifecycleTimeoutMs !== undefined
      && !(Number.isInteger(raw.lifecycleTimeoutMs) && raw.lifecycleTimeoutMs > 0)) {
    throw new Error(`run.config.json: 'lifecycleTimeoutMs' must be a positive whole number`);
  }
  // §7's concurrency knob: how many task containers ONE runner process holds at once.
  // Default 1 — strictly sequential, exactly as before the knob existed. Any whole number
  // from 1 up is accepted: the operator owns the trade (a run is bounded by its slowest task,
  // and every container shares one subscription window, which the run-level park guards).
  if (raw.concurrency !== undefined
      && !(Number.isInteger(raw.concurrency) && raw.concurrency >= 1)) {
    throw new Error(`run.config.json: 'concurrency' must be a whole number of 1 or more`);
  }
  // The live queue feed (§4.12). ZERO IS LEGAL AND IS THE DEFAULT — it means "off" — which is
  // why this is `>= 0` where every other numeric field here is `> 0`. Validating it like its
  // neighbours would reject the one value that expresses today's behaviour, and the config
  // that most wants to say it explicitly is the one being switched back after a bad night.
  if (raw.feedIdleGraceMinutes !== undefined
      && !(Number.isInteger(raw.feedIdleGraceMinutes) && raw.feedIdleGraceMinutes >= 0)) {
    throw new Error(`run.config.json: 'feedIdleGraceMinutes' must be a whole number of 0 or more (0 = the feed is off)`);
  }
  // The poll floor, on the other hand, must be positive: zero would let every idle worker
  // re-read the queue on every pass of its wait loop, which is a synchronous `bd` and
  // `git fetch` per pass — a busy-wait against a database and a git remote.
  if (raw.feedPollSeconds !== undefined
      && !(Number.isInteger(raw.feedPollSeconds) && raw.feedPollSeconds > 0)) {
    throw new Error(`run.config.json: 'feedPollSeconds' must be a positive whole number`);
  }
  // §4.12's third admission rule. A BOOLEAN and nothing else: the gate reads it as `!== true`,
  // so a config saying "true", 1 or null would silently mean false and a run would refuse
  // half-proven suites the operator believed they had admitted — a whole batch not dispatched,
  // discovered in the morning, with the config on screen appearing to say otherwise.
  if (raw.allowHalfProven !== undefined && typeof raw.allowHalfProven !== 'boolean') {
    throw new Error(`run.config.json: 'allowHalfProven' must be true or false`);
  }
  // Host-only environment a headless acceptance run needs — a binary that is not on PATH, a
  // display variable, a licence key path. STRINGS ONLY, and read by NOTHING at run time: this is
  // consumed by `scripts/spec-brief.js` to tell an agent what to export before running the
  // project's verifier by hand, and it is in the run config rather than `pipeline.config.json`
  // precisely because a machine-specific path must not be committed to the target repo. A
  // container gets its dependencies from the image and never reads this.
  if (raw.hostEnv !== undefined) {
    if (!raw.hostEnv || typeof raw.hostEnv !== 'object' || Array.isArray(raw.hostEnv)) {
      throw new Error(`run.config.json: 'hostEnv' must be an object of NAME: value strings`);
    }
    for (const [k, v] of Object.entries(raw.hostEnv)) {
      if (typeof v !== 'string') throw new Error(`run.config.json: hostEnv.${k} must be a string`);
    }
  }
  if (raw.hostShell !== undefined && raw.hostShell !== null
      && (typeof raw.hostShell !== 'string' || !raw.hostShell.trim())) {
    throw new Error(`run.config.json: 'hostShell' must be null or a non-empty executable path`);
  }
  for (const k of ['network', 'proxyName']) {
    if (raw[k] !== undefined && (typeof raw[k] !== 'string' || !raw[k].trim())) {
      throw new Error(`run.config.json: '${k}' must be a non-empty string when present`);
    }
  }
  const cfg = { ...DEFAULTS, ...raw, configPath: p };
  // An explicit name always wins; derivation fills only what the config left out.
  const derived = deriveNames(p);
  if (!cfg.network) cfg.network = derived.network;
  if (!cfg.proxyName) cfg.proxyName = derived.proxyName;
  // Built from whichever name won. Deriving the name but building the URL from anything
  // else would leave every task container proxying to a host that is not there.
  cfg.proxyUrl = `http://${cfg.proxyName}:${cfg.proxyPort}`;
  return cfg;
}

// The subscription token (§6): git-ignored .env.pipeline, or the ambient env.
function loadToken(repoRoot) {
  const f = path.join(repoRoot, '.env.pipeline');
  if (fs.existsSync(f)) {
    const m = fs.readFileSync(f, 'utf8').match(/^\s*CLAUDE_CODE_OAUTH_TOKEN\s*=\s*(.+?)\s*$/m);
    if (m) return m[1].replace(/^["']|["']$/g, '');
  }
  return process.env.CLAUDE_CODE_OAUTH_TOKEN || '';
}

module.exports = { loadConfig, loadToken, deriveNames, DEFAULTS, MAX_CONCURRENCY };
