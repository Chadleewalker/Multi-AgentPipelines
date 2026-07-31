// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// run.config.json loader — DESIGN.md §4.12 (T11).
// Plain JS, Node built-ins only. Fails fast and by name on an invalid config.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  proxyPort: 3128,
  wallClockMinutes: 240,        // §4.6 default 4 hours of ACTIVE time
  maxAttempts: 3,               // §4.6 verify-attempt cap -> PIPELINE_MAX_ATTEMPTS
  probeIntervalMinutes: 15,     // §4.7 rate-limit probe cadence
  maxPauseCycles: 96,           // §4.7/§7 stop condition: total wait cycles per RUN (~24h at 15m)
  agentCommand: null,           // optional override -> PIPELINE_AGENT_CMD (§4.3 seam)
  bdTimeoutMs: 60000,           // §4.1 bound on every runner `bd` call (runner/bd.js)
  concurrency: 1,               // §7 how many task containers ONE runner works at once
  // "opus" is an alias the CLI resolves to the CURRENT latest Opus, so the pipeline
  // follows model releases without edits here. The entrypoint records the RESOLVED
  // id (e.g. claude-opus-5) in the status file, so provenance stays exact even
  // though the request is an alias (§4.3). Pin a concrete id instead when a run must
  // be byte-reproducible against one specific model.
  model: 'opus',
};
const REQUIRED = ['targetRepoPath', 'targetRepoRemote', 'image'];
// The ceiling on §7's concurrency knob. See loadConfig for why it is a literal.
const MAX_CONCURRENCY = 3;

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
  // §7's concurrency knob: how many task containers ONE runner process holds at once.
  // Default 1 — strictly sequential, exactly as before the knob existed. The ceiling is a
  // literal here because §7 states only a hedged range; a run is bounded by the slowest
  // task in the batch, not by how many it holds, so more depth buys progressively less
  // while multiplying the load on one subscription window.
  if (raw.concurrency !== undefined
      && !(Number.isInteger(raw.concurrency) && raw.concurrency >= 1 && raw.concurrency <= MAX_CONCURRENCY)) {
    throw new Error(`run.config.json: 'concurrency' must be a whole number from 1 to ${MAX_CONCURRENCY}`);
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
