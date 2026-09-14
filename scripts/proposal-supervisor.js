#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

const fs = require('fs');
const path = require('path');
const { loadConfig } = require('../runner/config');
const { createProductionSupervisor, openProjectSupervisor, formatHumanStatus,
  supervisorStateDirFor } = require('../runner/proposal-supervisor');
// Intake, answers, and review decisions remain available through the canonical operator CLIs:
// scripts/kickoff.js, scripts/specify-proposal.js, and scripts/verdict.js.

function parse(argv) {
  const out = { command: argv[0], configPath: null, proposalId: null, json: false };
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === '--config') out.configPath = argv[++i];
    else if (argv[i] === '--proposal') out.proposalId = argv[++i];
    else if (argv[i] === '--json') out.json = true;
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!['start', 'run', 'resume', 'tick', 'stop', 'status'].includes(out.command)
      || !out.configPath) {
    throw new Error('usage: node scripts/proposal-supervisor.js <start|resume|stop|status> --config <file> [--proposal <kp-id>] [--json]');
  }
  return out;
}

async function runLoop(supervisor, once = false, pollMs = 1000) {
  do {
    await supervisor.tick();
    const status = await supervisor.status();
    if (once || status.drained) return status;
    await new Promise(resolve => setTimeout(resolve, pollMs));
  } while (true);
}

async function runOwnedLoop(opened, once = false, pollMs = 1000) {
  try {
    await opened.supervisor.resume();
    return await runLoop(opened.supervisor, once, pollMs);
  } finally {
    await opened.close();
  }
}

async function main(argv) {
  const args = parse(argv);
  const configPath = path.resolve(args.configPath);
  const cfg = loadConfig(configPath);
  const common = { repoRoot: path.resolve(__dirname, '..'), project: cfg.targetRepoPath,
    configPath, stateDir: supervisorStateDirFor(cfg.targetRepoPath),
    proposalId: args.proposalId,
    globalConcurrency: cfg.supervisorGlobalConcurrency,
    stageConcurrency: cfg.supervisorStageConcurrency };
  if (args.command === 'status') {
    const supervisor = createProductionSupervisor(common);
    const status = await supervisor.status(args.proposalId || undefined);
    fs.writeSync(1, `${args.json ? JSON.stringify(status, null, 2) : formatHumanStatus(status)}\n`);
    return status;
  }
  if (args.command === 'stop') {
    const supervisor = createProductionSupervisor(common);
    const result = await supervisor.stop();
    fs.writeSync(1, `${JSON.stringify(result)}\n`); return result;
  }
  const opened = openProjectSupervisor({ ...common,
    reclaim: args.command === 'resume', supervisorId: `proposal-supervisor-${process.pid}` });
  if (!opened.ok) throw new Error(opened.reason || `project supervisor is held by ${opened.holder && opened.holder.id}`);
  if (args.command === 'tick') return runOwnedLoop(opened, true);
  return runOwnedLoop(opened, false);
}

if (require.main === module) main(process.argv.slice(2)).catch(error => {
  fs.writeSync(2, `proposal-supervisor: ${error.message}\n`); process.exitCode = 2;
});

module.exports = { main, runLoop, runOwnedLoop, parse };
