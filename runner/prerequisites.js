// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Deterministic host prerequisites for planning-side batch preparation. These checks run
// before preparation allocates a manifest, takes the target lock, reads Beads, creates a
// worktree or launches an author/probe worker. Keep the probes synchronous and delegated to
// the existing host adapters so the whole gate remains Docker-free under injected seams.
'use strict';

const preflight = require('./preflight');
const hostShell = require('./host-shell');
const config = require('./config');
const { providerFor, credentialNameFor } = require('./agent-provider');
const { runSync, failureText } = require('./process');

const PREREQUISITES = ['docker-daemon', 'required-image', 'host-shell', 'model-auth'];
const PREREQUISITE_TIMEOUT_MS = 10000;

function probeBound(cfg) {
  const requested = cfg && cfg.lifecycleTimeoutMs;
  return Number.isInteger(requested) && requested > 0
    ? Math.min(requested, PREREQUISITE_TIMEOUT_MS)
    : PREREQUISITE_TIMEOUT_MS;
}

function outputOf(result) {
  if (!result) return 'the probe returned no result';
  if (result.timedOut) return 'the probe timed out: ' + failureText(result);
  return String(result.stderr || result.stdout || ('probe exited ' + result.status)).trim();
}

function refusal(prerequisite, reason, remedy, checked) {
  return { ok: false, prerequisite, reason, remedy, checked: [...checked] };
}

function stageProviders(cfg) {
  return [...new Set([
    providerFor(cfg, 'test-author'),
    providerFor(cfg, 'test-probe'),
  ])];
}

function codexLoginStatus(cfg, bound, deps) {
  if (typeof deps.codexAuthStatus === 'function') return deps.codexAuthStatus(cfg, bound);
  const execute = deps.runSync || runSync;
  return execute('codex', ['login', 'status'], {
    cfg, kind: 'lifecycle', timeoutMs: bound, label: 'Codex saved-login status probe',
  });
}

function modelAuth(cfg, repoRoot, bound, deps) {
  for (const provider of stageProviders(cfg)) {
    if (provider === 'claude') {
      const token = (deps.loadToken || config.loadToken)(repoRoot);
      if (typeof token !== 'string' || !token.trim()) {
        return {
          ok: false,
          reason: 'no non-blank Claude authentication token was found',
          remedy: 'Set CLAUDE_CODE_OAUTH_TOKEN in .env.pipeline or the environment, then retry the same batch.',
        };
      }
      continue;
    }

    const loadCredential = deps.loadProviderCredential || config.loadProviderCredential;
    if (loadCredential(repoRoot, provider)) continue;
    const status = codexLoginStatus(cfg, bound, deps);
    if (!status || status.status !== 0 || status.timedOut) {
      return {
        ok: false,
        reason: status && status.timedOut
          ? 'the bounded Codex saved-login status probe timed out'
          : 'no usable Codex saved ChatGPT login was found (' + outputOf(status) + ')',
        remedy: 'Run codex login on the host for a saved ChatGPT session, or set '
          + credentialNameFor(provider)
          + ' in .env.pipeline or the environment, then retry the same batch.',
      };
    }
  }
  return { ok: true };
}

function checkPrerequisites(cfg, repoRoot, deps = {}) {
  const checked = [];
  const bound = probeBound(cfg);
  const probeCfg = { ...cfg, lifecycleTimeoutMs: bound };

  checked.push('docker-daemon');
  const daemon = (deps.dockerAvailable || preflight.dockerAvailable)(probeCfg);
  if (!daemon || daemon.status !== 0 || daemon.timedOut) {
    return refusal('docker-daemon', outputOf(daemon),
      'Start Docker Desktop and wait until the Docker daemon is running, then retry the same batch.', checked);
  }

  checked.push('required-image');
  const image = (deps.imageExists || preflight.imageExists)(cfg.image, probeCfg);
  if (!image || image.status !== 0 || image.timedOut) {
    return refusal('required-image', outputOf(image),
      "Build the configured Docker image '" + cfg.image + "' during planning, then retry the same batch.", checked);
  }

  checked.push('host-shell');
  const shell = (deps.resolveHostShell || hostShell.resolveHostShell)(cfg.hostShell, { timeoutMs: bound });
  if (!shell || !shell.ok) {
    return refusal('host-shell', (shell && shell.reason) || 'the configured host shell probe failed',
      "Install or correct the configured hostShell '" + cfg.hostShell
        + "' so it can launch the host Node toolchain, then retry the same batch.", checked);
  }

  checked.push('model-auth');
  const auth = modelAuth(cfg, repoRoot, bound, deps);
  if (!auth.ok) return refusal('model-auth', auth.reason, auth.remedy, checked);

  return { ok: true, checked };
}

module.exports = {
  PREREQUISITES,
  PREREQUISITE_TIMEOUT_MS,
  checkPrerequisites,
  probeBound,
};
