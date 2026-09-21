#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

// Coverage-preserving coordinator for the common host sweep. The two shell entry points
// remain authoritative: this file asks them for their plans and never owns a suite roster.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveHostShell } = require('../runner/host-shell');

function fail(message, code = 1) {
  process.stderr.write(`FAIL  fast full sweep: ${message}\n`);
  process.exit(code);
}

function child(shell, root, script, args, capture = false) {
  const result = spawnSync(shell, [path.join(root, 'scripts', script), ...args], {
    cwd: root,
    encoding: capture ? 'utf8' : undefined,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    windowsHide: true,
  });
  if (result.error) {
    process.stderr.write(`FAIL  could not launch ${script}: ${result.error.message}\n`);
    return { ...result, status: 127 };
  }
  return result;
}

function git(root, args) {
  return spawnSync('git', ['-c', 'safe.directory=*', '-C', root, ...args], {
    encoding: 'utf8', windowsHide: true,
  });
}

function cleanTrackedSnapshot(root) {
  const head = git(root, ['rev-parse', '--verify', 'HEAD']);
  if (head.error || head.status !== 0 || !head.stdout.trim()) {
    fail(`cannot read Git HEAD${head.stderr ? `: ${head.stderr.trim()}` : ''}`);
  }
  const state = git(root, ['status', '--porcelain=v1', '--untracked-files=no']);
  if (state.error || state.status !== 0) {
    fail(`cannot inspect tracked Git state${state.stderr ? `: ${state.stderr.trim()}` : ''}`);
  }
  if (state.stdout !== '') fail('tracked Git state is not clean before mandatory execution');
  return head.stdout.trim();
}

function proveUnchanged(root, expectedHead) {
  const head = git(root, ['rev-parse', '--verify', 'HEAD']);
  if (head.error || head.status !== 0 || head.stdout.trim() !== expectedHead) {
    fail('Git HEAD moved during mandatory execution; refusing Docker/live extras');
  }
  const state = git(root, ['status', '--porcelain=v1', '--untracked-files=no']);
  if (state.error || state.status !== 0) {
    fail('tracked Git state became unreadable; refusing Docker/live extras');
  }
  if (state.stdout !== '') fail('tracked Git state changed during mandatory execution; refusing Docker/live extras');
}

const SUITE = /^(?:test-[A-Za-z0-9._-]+|e2e)\.sh$/;
function parsePlan(label, result, allowHeader) {
  // The list output is captured for validation, then replayed so no child output disappears.
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) {
    fail(`${label} plan is unreadable (exit ${result.status})`, result.status || 1);
  }
  const lines = result.stdout.split(/\r?\n/).filter(line => line.trim() !== '');
  let declared = null;
  const suites = [];
  for (const line of lines) {
    const header = /^(\d+) suites, in order:$/.exec(line.trim());
    if (allowHeader && header && declared === null && suites.length === 0) {
      declared = Number(header[1]);
      continue;
    }
    const name = line.trim();
    if (!SUITE.test(name) || path.basename(name) !== name) fail(`${label} plan contains an invalid line: ${JSON.stringify(line)}`);
    suites.push(name);
  }
  if (suites.length === 0) fail(`${label} plan contains no suites`);
  if (declared !== null && declared !== suites.length) fail(`${label} plan count does not match its entries`);
  if (new Set(suites).size !== suites.length) fail(`${label} plan contains duplicate suites`);
  return suites;
}

function provesNestedIsolation(root) {
  let source;
  try { source = fs.readFileSync(path.join(root, 'scripts', 'e2e.sh'), 'utf8'); }
  catch (error) { fail(`cannot read scripts/e2e.sh: ${error.message}`); }
  return source.split(/\r?\n/).some(line => {
    const code = line.trim();
    return code && !code.startsWith('#') &&
      /(^|[;|&]|\b(?:if|then|do|exec)\b)\s*(?:bash|sh)\b[^#]*test-isolation\.sh\b/.test(code);
  });
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--repo') fail('usage: fast-full-sweep.js --repo <git-checkout>', 2);
  const root = path.resolve(args[1]);
  const hostShell = resolveHostShell(null);
  if (!hostShell.ok) fail(hostShell.reason);
  const shell = hostShell.command;
  const started = Date.now();
  const initialHead = cleanTrackedSnapshot(root);

  const mandatoryRun = child(shell, root, 'test-ci.sh', []);
  if (mandatoryRun.status !== 0) {
    fail(`mandatory profile failed (exit ${mandatoryRun.status}); Docker/live extras were not started`, mandatoryRun.status || 1);
  }
  proveUnchanged(root, initialHead);

  const mandatory = parsePlan('mandatory', child(shell, root, 'test-ci.sh', ['--list'], true), false);
  const full = parsePlan('full-sweep', child(shell, root, 'test-all.sh', ['--list'], true), true);
  const fullSet = new Set(full);
  const missing = mandatory.filter(name => !fullSet.has(name));
  if (missing.length) fail(`mandatory suites are missing from the full plan: ${missing.join(', ')}`);
  if (!fullSet.has('e2e.sh')) fail('full plan is missing required e2e.sh');
  if (mandatory.includes('e2e.sh')) fail('e2e.sh cannot be mandatory because its nested coverage would be duplicated');
  if (mandatory.includes('test-isolation.sh')) fail('test-isolation.sh cannot be mandatory because e2e.sh runs it again');
  if (!provesNestedIsolation(root)) fail('scripts/e2e.sh does not contain the required test-isolation.sh execution witness');

  // test-all.sh matches skip values against extension-free suite names.
  const skipNames = [...mandatory, 'test-isolation.sh']
    .filter((name, index, all) => all.indexOf(name) === index)
    .map(name => name.replace(/\.sh$/, ''));
  const directExtras = full.filter(name => !mandatory.includes(name) && name !== 'test-isolation.sh');
  for (const selector of skipNames) {
    const unintended = directExtras.filter(name => name.replace(/\.sh$/, '').includes(selector));
    if (unintended.length) fail(`skip selector ${selector} would also skip: ${unintended.join(', ')}`);
  }

  // Listing and witness inspection are deliberately inside the same immutable window.
  proveUnchanged(root, initialHead);
  const extrasRun = child(shell, root, 'test-all.sh', ['--skip', skipNames.join(','), '--fail-fast']);
  if (extrasRun.status !== 0) process.exit(extrasRun.status || 1);

  const uniqueCoverage = new Set([...full, 'test-isolation.sh']);
  const elapsed = Date.now() - started;
  process.stdout.write('\n== FAST FULL SWEEP SUMMARY ==\n');
  process.stdout.write(`mandatory suites (aggregate test-ci.sh): ${mandatory.length}\n`);
  process.stdout.write(`directly executed extras (test-all.sh): ${directExtras.length}\n`);
  process.stdout.write('nested isolation coverage (e2e.sh -> test-isolation.sh): 1\n');
  process.stdout.write(`full unique-suite coverage: ${uniqueCoverage.size}\n`);
  process.stdout.write(`elapsed time: ${(elapsed / 1000).toFixed(1)}s\n`);
}

main();
