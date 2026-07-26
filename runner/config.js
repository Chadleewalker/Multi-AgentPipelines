// run.config.json loader — DESIGN.md §4.12 (T11).
// Plain JS, Node built-ins only. Fails fast and by name on an invalid config.
'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  network: 'pipeline-net',
  proxyName: 'pipeline-proxy',
  proxyPort: 3128,
  wallClockMinutes: 240,        // §4.6 default 4 hours of ACTIVE time
  maxAttempts: 3,               // §4.6 verify-attempt cap -> PIPELINE_MAX_ATTEMPTS
  probeIntervalMinutes: 15,     // §4.7 rate-limit probe cadence
  maxPauseCycles: 96,           // §4.7 stop condition: total wait cycles per task (~24h at 15m)
  agentCommand: null,           // optional override -> PIPELINE_AGENT_CMD (§4.3 seam)
  // "opus" is an alias the CLI resolves to the CURRENT latest Opus, so the pipeline
  // follows model releases without edits here. The entrypoint records the RESOLVED
  // id (e.g. claude-opus-5) in the status file, so provenance stays exact even
  // though the request is an alias (§4.3). Pin a concrete id instead when a run must
  // be byte-reproducible against one specific model.
  model: 'opus',
};
const REQUIRED = ['targetRepoPath', 'targetRepoRemote', 'image'];

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
  const cfg = { ...DEFAULTS, ...raw, configPath: p };
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

module.exports = { loadConfig, loadToken, DEFAULTS };
