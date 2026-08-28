#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Generate a dispatch receipt for an integration-test fixture.
//
// This is deliberately NOT a substitute for the planning freeze gate. Production suites
// must earn their receipt through scripts/freeze-gate.js. Integration fixtures manufacture
// both sides of the test, however, and need a receipt whose digest follows the SAME shared
// blob-id formula as the real writer and reader. Keeping that construction here prevents six
// shell suites from pasting hashes that silently go stale when their fixture text changes.
'use strict';

const fs = require('fs');
const path = require('path');
const {
  suiteHash, workingTreeEntries, headCommit, isGitRepo, RECEIPT_NAME,
} = require('../runner/suite-hash');
const { RECEIPT_VERSION } = require('./freeze-gate');

const RECEIPT_KEYS = [
  'gateVersion', 'verdict', 'probeSupplied', 'suiteHash', 'gateHead',
  'guards', 'brittleness', 'writtenAt',
];

function existingReceipt(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeFixtureReceipt(repoRoot, issueId, now = () => new Date().toISOString()) {
  const repo = path.resolve(repoRoot);
  const id = String(issueId || '').trim();
  if (!id || /[\\/]/.test(id)) throw new Error('issue id must be one path segment');
  if (!isGitRepo(repo)) throw new Error(`${repo} is not a git repository`);

  const suiteRel = `tests/acceptance/${id}`;
  const suiteDir = path.join(repo, 'tests', 'acceptance', id);
  if (!fs.statSync(suiteDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`fixture suite is not a directory: ${suiteRel}`);
  }

  const hash = suiteHash(workingTreeEntries(repo, suiteRel));
  const file = path.join(suiteDir, RECEIPT_NAME);
  const previous = existingReceipt(file);
  // Preserve the original gateHead/writtenAt after the receipt itself is committed. If
  // those were compared to the new HEAD, every e2e reset would manufacture another receipt
  // commit forever. Everything dispatch or review relies on must still match the production
  // writer's contract; a malformed or half-proven lookalike is replaced.
  if (previous
      && JSON.stringify(Object.keys(previous)) === JSON.stringify(RECEIPT_KEYS)
      && previous.gateVersion === RECEIPT_VERSION
      && previous.verdict === 'red'
      && previous.probeSupplied === true
      && previous.suiteHash === hash
      && typeof previous.gateHead === 'string' && previous.gateHead.length > 0
      && previous.guards === 0
      && previous.brittleness === 0
      && typeof previous.writtenAt === 'string' && previous.writtenAt.length > 0) {
    return { file, receipt: previous };
  }
  const receipt = {
    gateVersion: RECEIPT_VERSION,
    verdict: 'red',
    probeSupplied: true,
    suiteHash: hash,
    gateHead: headCommit(repo),
    guards: 0,
    brittleness: 0,
    writtenAt: now(),
  };
  fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`);
  return { file, receipt };
}

function main(argv) {
  if (argv.length !== 2) {
    console.error('usage: node scripts/write-fixture-receipt.js <fixture-repo> <issue-id>');
    return 2;
  }
  try {
    const result = writeFixtureReceipt(argv[0], argv[1]);
    console.log(`fixture receipt written: ${result.file}`);
    console.log(`  suite hash ${result.receipt.suiteHash}`);
    return 0;
  } catch (e) {
    console.error(`fixture receipt: ${e.message}`);
    return 1;
  }
}

module.exports = { writeFixtureReceipt, RECEIPT_KEYS };
if (require.main === module) process.exit(main(process.argv.slice(2)));
