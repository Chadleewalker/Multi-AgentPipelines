// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

// Host-side backstop independent of model hook delivery. There is deliberately no
// environment or target-config switch to waive this gate. Tests inject dependencies
// through the JS API; the production CLI always uses the real checks.
const policy = require('../scripts/write-protection-policy');
const installation = require('../scripts/write-protection');

function checkInstallation(deps = {}) {
  try {
    const health = (deps.doctor || installation.doctor)();
    if (!health || health.ok !== true) {
      return { ok: false, stage: 'installation', reason: health?.reason || 'guard installation health is unavailable', health };
    }
    return { ok: true, stage: 'installation', health };
  } catch (error) {
    return { ok: false, stage: 'installation', reason: `guard installation check failed: ${error.message}` };
  }
}

function admitGuard(target, options = {}, deps = {}) {
  const installed = checkInstallation(deps);
  if (!installed.ok) return installed;
  try {
    const admitted = (deps.admit || policy.admit)(target, { issues: options.issues || [] });
    if (!admitted || admitted.admit !== true || admitted.undecidable || admitted.protected !== true) {
      const refused = (admitted?.refusals || []).map((entry) => `${entry.state} ${entry.path}`);
      const reason = admitted?.undecidable ? 'target protection could not be inspected'
        : admitted?.protected !== true ? 'target is not a protected Git checkout with pipeline.config.json'
          : refused.length ? `protected target changes: ${refused.join(', ')}` : 'target protection admission refused';
      return { ok: false, stage: 'target', reason, target: admitted?.target || target, refusals: admitted?.refusals || [] };
    }
    return { ok: true, stage: 'target', target: admitted.target, health: installed.health };
  } catch (error) {
    return { ok: false, stage: 'target', reason: `target protection check failed: ${error.message}`, target };
  }
}

function issueForTests(tests) {
  const match = /^tests\/acceptance\/([A-Za-z0-9_][A-Za-z0-9._-]*)\/?$/.exec(String(tests).replace(/\\/g, '/'));
  // The control fixture is frozen infrastructure, never this task's authoring scope.
  return match && match[1] !== '_control' && !['.', '..'].includes(match[1]) ? match[1] : null;
}

function refusalMessage(result) {
  const repair = result.stage === 'installation'
    ? 'Run node scripts/write-protection.js doctor --json and repair the reported installation before retrying.'
    : 'Review the named checkout and protected paths before retrying; no files were reset, stashed or overwritten.';
  return `write-guard admission refused: ${result.reason}. ${repair}`;
}

module.exports = { checkInstallation, admitGuard, issueForTests, refusalMessage };
