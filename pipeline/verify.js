#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// The verifier — DESIGN.md §4.4, built by T7. Deterministic scaffolding, no LLM.
// Runs inside the task container, mounted read-only at /pipeline (§4.10).
//
// Sequence:
//   1. Read pipeline.config.json FROM THE FORK-POINT COMMIT (git merge-base main HEAD)
//      — never from the working tree, which the coding agent can edit (v1.0.2).
//   2. Tamper check: diff tests/acceptance/ + config.frozenPaths against the fork
//      point; untracked additions count. Any difference → "tampered", tests not run.
//   3. Run `<verifyCommand> tests/acceptance/<ISSUE_ID>/` — the authoritative gate.
//   4. Run buildCommand when present — a REQUIRED gate (§4.4, repo-cl9): acceptance may
//      pass while the production build is broken (Deep End PR #62), so a failed build
//      cannot return success. Read from the frozen config, so a worktree edit to the
//      command (or to a frozen helper it runs) cannot weaken it.
//   5. Run regressionCommand when present — recorded evidence only, never the gate.
//   6. Write /workspace/.run/verify.json (schema: schemas/verify.schema.json).
//
// Exit codes (the entrypoint maps these to its §4.11 codes):
//   0 = acceptance pass AND build pass/absent   1 = acceptance fail OR build fail
//   3 = tampered   4 = config/internal error
'use strict';
const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const WS = process.env.WORKSPACE || '/workspace';
const OUT_DIR = path.join(WS, '.run');
const TAIL = (s, n) => (s || '').slice(-n);

function writeResult(obj, code) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, 'verify.json'), JSON.stringify(obj, null, 2) + '\n');
  process.exit(code);
}
const git = (args) => execSync(`git ${args}`, { cwd: WS, encoding: 'utf8' });

const result = {
  issueId: process.env.ISSUE_ID || '',
  timestamp: new Date().toISOString(),
  acceptance: 'error',
  regressions: 'absent',
  build: 'absent',
};
if (!result.issueId) {
  result.error = 'ISSUE_ID environment variable not set';
  writeResult(result, 4);
}

// The integration branch varies by project (main vs master). Read it from the working
// config only to LOCATE the fork point; everything authoritative still comes from the
// fork-point commit itself, so this cannot be used to weaken verification.
function integrationBranch() {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(WS, 'pipeline.config.json'), 'utf8'));
    if (c.defaultBranch) return c.defaultBranch;
  } catch { /* fall through */ }
  for (const candidate of ['main', 'master']) {
    try {
      execSync(`git rev-parse --verify ${candidate}`, { cwd: WS, stdio: 'ignore' });
      return candidate;
    } catch { /* try the next one */ }
  }
  return 'main';
}

let forkPoint, config;
try {
  forkPoint = git(`merge-base ${integrationBranch()} HEAD`).trim();
  config = JSON.parse(git(`show ${forkPoint}:pipeline.config.json`));
  if (!config.verifyCommand) throw new Error('verifyCommand missing from fork-point pipeline.config.json');
} catch (e) {
  result.error = `cannot load frozen config: ${e.message}`;
  writeResult(result, 4);
}

// --- Tamper check: frozen paths vs fork point, untracked additions included. ---
const frozen = ['tests/acceptance/', ...(config.frozenPaths || [])];
const tampered = new Set();
for (const p of frozen) {
  git(`diff --name-only ${forkPoint} -- "${p}"`).split('\n').filter(Boolean)
    .forEach((f) => tampered.add(f));
  git(`status --porcelain -- "${p}"`).split('\n').filter((l) => l.startsWith('??'))
    .forEach((l) => tampered.add(l.slice(3).trim()));
}
if (tampered.size > 0) {
  result.acceptance = 'tampered';
  result.tamperedPaths = [...tampered].sort();
  writeResult(result, 3);
}

// --- Acceptance run: the authoritative gate. ---
const testDir = `tests/acceptance/${result.issueId}/`;
const acc = spawnSync('sh', ['-c', `${config.verifyCommand} ${testDir}`],
  { cwd: WS, encoding: 'utf8', timeout: 15 * 60 * 1000 });
result.acceptance = acc.status === 0 ? 'pass' : 'fail';
result.acceptanceOutput = TAIL((acc.stdout || '') + (acc.stderr || ''), 4000);

// --- Build run: a REQUIRED gate (§4.4, repo-cl9). Runs from the FROZEN buildCommand,
// so a worktree edit to the command is ignored (a frozen helper it runs is covered by
// the tamper check above). A failed build cannot mask itself behind a passing acceptance
// suite — its output is captured so the next coding attempt sees it. Absent buildCommand
// keeps every legacy target's behaviour unchanged: build stays 'absent'. ---
if (config.buildCommand) {
  const bld = spawnSync('sh', ['-c', config.buildCommand],
    { cwd: WS, encoding: 'utf8', timeout: 15 * 60 * 1000 });
  result.build = bld.status === 0 ? 'pass' : 'fail';
  result.buildOutput = TAIL((bld.stdout || '') + (bld.stderr || ''), 4000);
}

// --- Regression run: evidence only (§4.4) — result never changes the exit code. ---
if (config.regressionCommand) {
  const reg = spawnSync('sh', ['-c', config.regressionCommand],
    { cwd: WS, encoding: 'utf8', timeout: 15 * 60 * 1000 });
  result.regressions = reg.status === 0 ? 'pass' : 'fail';
  result.regressionOutput = TAIL((reg.stdout || '') + (reg.stderr || ''), 2000);
}

// The gate is the CONJUNCTION of the two required checks: acceptance is authoritative,
// and a present build must also pass. Regressions never enter here — evidence only.
writeResult(result, result.acceptance === 'pass' && result.build !== 'fail' ? 0 : 1);
