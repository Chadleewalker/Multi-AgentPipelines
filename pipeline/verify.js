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
//   4. Run regressionCommand when present — recorded evidence only, never the gate.
//   5. Write /workspace/.run/verify.json (schema: schemas/verify.schema.json).
//
// Exit codes (the entrypoint maps these to its §4.11 codes):
//   0 = acceptance pass   1 = acceptance fail   3 = tampered   4 = config/internal error
'use strict';
const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// The verdict rule lives in its own file so a test can reach it without running the
// verifier, and so nothing here keeps a second copy of it (change-log row
// `verify-nobuffer`): a killed run is an error, never a failure.
const { classify, MAX_BUFFER, RUN_TIMEOUT_MS } = require('./verify-classify.js');

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
  { cwd: WS, encoding: 'utf8', timeout: RUN_TIMEOUT_MS, maxBuffer: MAX_BUFFER });
const accVerdict = classify(acc);
result.acceptance = accVerdict.verdict;
result.acceptanceOutput = TAIL((acc.stdout || '') + (acc.stderr || ''), 4000);
// A killed run exits 4, the code the entrypoint already routes to its internal-error
// path (§4.11) rather than to the retry loop. Retrying would spend the attempt cap on a
// harness fault and end as "stuck", which is the unactionable overnight failure §3.5
// exists to prevent; and the feedback fed to the next attempt would be a truncated tail
// naming nothing. Stop, and say which of the harness's own limits was hit.
if (accVerdict.verdict === 'error') {
  result.error = `acceptance run produced no verdict: the suite ${accVerdict.why}`;
  writeResult(result, 4);
}

// --- Regression run: evidence only (§4.4) — result never changes the exit code. ---
if (config.regressionCommand) {
  const reg = spawnSync('sh', ['-c', config.regressionCommand],
    { cwd: WS, encoding: 'utf8', timeout: RUN_TIMEOUT_MS, maxBuffer: MAX_BUFFER });
  const regVerdict = classify(reg);
  result.regressions = regVerdict.verdict;
  result.regressionOutput = TAIL((reg.stdout || '') + (reg.stderr || ''), 2000);
  // Evidence, so a killed regression run is recorded and never fatal. It must not read
  // 'fail' (that downgrades a passing task to `partial` — §4.11 — on a harness fault)
  // and must not read 'absent' either, which means "no regressionCommand configured" and
  // would silently upgrade it instead. It gets its own word.
  if (regVerdict.verdict === 'error') {
    result.regressionOutput = `regression run produced no verdict: the suite ${regVerdict.why}\n`
      + result.regressionOutput;
  }
}

writeResult(result, result.acceptance === 'pass' ? 0 : 1);
