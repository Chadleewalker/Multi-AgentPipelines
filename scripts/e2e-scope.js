#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

const ISSUE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function fixtureIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new Error('at least one fixture issue id is required');
  }
  const unique = [];
  for (const raw of ids) {
    const id = String(raw || '');
    if (!ISSUE_ID.test(id)) throw new Error(`unsafe fixture issue id: ${JSON.stringify(id)}`);
    if (!unique.includes(id)) unique.push(id);
  }
  return unique;
}

function patternsFor(ids) {
  return fixtureIds(ids).flatMap((id) => [
    `refs/heads/task/${id}`,
    `refs/heads/task/${id}-r*`,
  ]);
}

function ownsBranch(branch, ids) {
  if (typeof branch !== 'string') return false;
  return fixtureIds(ids).some((id) => {
    const base = `task/${id}`;
    if (branch === base) return true;
    if (!branch.startsWith(`${base}-r`)) return false;
    return /^[1-9][0-9]*$/.test(branch.slice(base.length + 2));
  });
}

function main(argv) {
  const [command, ...args] = argv;
  try {
    if (command === 'patterns') {
      process.stdout.write(`${patternsFor(args).join('\n')}\n`);
      return 0;
    }
    if (command === 'owns') {
      const [branch, ...ids] = args;
      return ownsBranch(branch, ids) ? 0 : 1;
    }
    throw new Error('usage: e2e-scope.js patterns <issue-id...> | owns <branch> <issue-id...>');
  } catch (error) {
    process.stderr.write(`e2e scope: ${error.message}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { fixtureIds, patternsFor, ownsBranch, main };
