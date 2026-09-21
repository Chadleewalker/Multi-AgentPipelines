// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// One bounded result contract for synchronous host lifecycle commands.
//
// The runner has two intentionally separate knobs:
//   * gitTimeoutMs bounds Git transport and repository queries;
//   * lifecycleTimeoutMs bounds Docker, GitHub CLI, and host-shell commands.
// Beads keeps its own bdTimeoutMs and serialized access contract in runner/bd.js.
'use strict';

const { spawnSync } = require('child_process');

const TIMEOUT_STATUS = 124;
const DEFAULT_GIT_TIMEOUT_MS = 60000;
const DEFAULT_LIFECYCLE_TIMEOUT_MS = 120000;
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function timeoutFor(cfg, kind = 'lifecycle', explicit) {
  if (explicit !== undefined) {
    return positiveInteger(explicit,
      kind === 'git' ? DEFAULT_GIT_TIMEOUT_MS : DEFAULT_LIFECYCLE_TIMEOUT_MS);
  }
  if (kind === 'git') {
    return positiveInteger(cfg && cfg.gitTimeoutMs, DEFAULT_GIT_TIMEOUT_MS);
  }
  return positiveInteger(cfg && cfg.lifecycleTimeoutMs, DEFAULT_LIFECYCLE_TIMEOUT_MS);
}

function configKeyFor(kind) {
  return kind === 'git' ? 'gitTimeoutMs' : 'lifecycleTimeoutMs';
}

function normalizeSpawnResult(result, details = {}) {
  const r = result || {};
  const timeout = positiveInteger(details.timeoutMs, DEFAULT_LIFECYCLE_TIMEOUT_MS);
  const label = details.label || 'host command';
  const configKey = details.configKey || 'lifecycleTimeoutMs';
  const errorText = r.error && String(r.error.message || '');
  const hitBound = !!(r.error && (r.error.code === 'ETIMEDOUT' || /ETIMEDOUT/i.test(errorText)));
  if (!hitBound) return r;

  const note = `${label} timed out after ${timeout}ms (run.config.json ${configKey}) and was killed`;
  const existing = String(r.stderr || '').trim();
  return {
    ...r,
    status: TIMEOUT_STATUS,
    timedOut: true,
    stdout: r.stdout || '',
    stderr: existing ? `${existing}\n${note}` : note,
  };
}

function runSync(command, args, options = {}) {
  const {
    cfg,
    kind = 'lifecycle',
    label = String(command || 'host command'),
    timeoutMs: explicitTimeout,
    spawnSync: run = spawnSync,
    maxBuffer = DEFAULT_MAX_BUFFER,
    ...extra
  } = options;
  const timeoutMs = timeoutFor(cfg, kind, explicitTimeout);
  const result = run(command, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    maxBuffer,
    windowsHide: true,
    ...extra,
  });
  return normalizeSpawnResult(result, {
    timeoutMs,
    label,
    configKey: configKeyFor(kind),
  });
}

function failureText(result, fallback = 'host command failed') {
  const detail = String((result && (result.stderr || result.stdout)) || '').trim();
  if (detail) return detail;
  if (result && result.error) return String(result.error.message || result.error);
  if (result && result.status !== undefined) return `${fallback} (status ${result.status})`;
  return fallback;
}

module.exports = {
  runSync,
  timeoutFor,
  normalizeSpawnResult,
  failureText,
  TIMEOUT_STATUS,
  DEFAULT_GIT_TIMEOUT_MS,
  DEFAULT_LIFECYCLE_TIMEOUT_MS,
  DEFAULT_MAX_BUFFER,
};
