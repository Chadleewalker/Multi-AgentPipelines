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
  probeIntervalMinutes: 15,     // §4.7 rate-limit probe cadence
  agentCommand: null,           // optional override -> PIPELINE_AGENT_CMD (§4.3 seam)
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
