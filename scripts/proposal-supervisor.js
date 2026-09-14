#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

const fs = require('fs');
const path = require('path');
const { createProductionSupervisor } = require('../runner/proposal-supervisor');
const kickoff = require('./kickoff');

function parse(argv) {
  const out = { command: argv[0], configPath: null, proposalId: null };
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === '--config') out.configPath = argv[++i];
    else if (argv[i] === '--proposal') out.proposalId = argv[++i];
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!['run', 'resume', 'tick', 'stop', 'status'].includes(out.command) || !out.configPath) {
    throw new Error('usage: node scripts/proposal-supervisor.js <run|resume|tick|stop|status> --config <file> [--proposal <kp-id>]');
  }
  return out;
}

async function main(argv) {
  const args = parse(argv);
  const configPath = path.resolve(args.configPath);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const project = config.targetRepoPath;
  const supervisor = createProductionSupervisor({ repoRoot: path.resolve(__dirname, '..'),
    project, configPath });
  if (args.command === 'run') {
    if (args.proposalId) {
      const record = kickoff.readAll(kickoff.statePathsFor(project))
        .find(item => item.id === args.proposalId);
      if (!record) throw new Error(`no such proposal ${args.proposalId}`);
      await supervisor.submit(record);
    }
    await supervisor.run();
    return;
  }
  if (args.command === 'status') {
    if (!args.proposalId) throw new Error('status requires --proposal <kp-id>');
    console.log(JSON.stringify(await supervisor.status(args.proposalId), null, 2));
    return;
  }
  const result = await supervisor[args.command]();
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) main(process.argv.slice(2)).catch(error => {
  fs.writeSync(2, `proposal-supervisor: ${error.message}\n`); process.exitCode = 2;
});

module.exports = { main };

