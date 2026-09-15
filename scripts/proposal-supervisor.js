#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadConfig } = require('../runner/config');
const { probeBound } = require('../runner/prerequisites');
const { createProductionSupervisor, openProjectSupervisor, formatHumanStatus,
  supervisorStateDirFor } = require('../runner/proposal-supervisor');
// Intake, answers, and review decisions remain available through the canonical operator CLIs:
// scripts/kickoff.js, scripts/specify-proposal.js, and scripts/verdict.js.

// Which commands can launch the specification planner. `status` and `stop` are read-only
// and terminal respectively, so neither acquires a Codex dependency it never uses — and
// this is supervisor admission, not the generic preparation prerequisite roster: a
// preparation-only all-Claude workflow must not start requiring Codex merely because the
// same run config could also drive the conveyor.
const SPECIFICATION_COMMANDS = new Set(['start', 'run', 'resume', 'tick']);

// The specification lane is Codex-only and authenticated by a SAVED ChatGPT session.
// Neither CODEX_API_KEY nor OPENAI_API_KEY is a fallback for it — both are stripped from
// the probe, so a host that happens to carry one cannot make an unauthenticated lane look
// ready — and a Claude credential is not a fallback either: it is left alone because it
// belongs to the implementation lane this run also needs, not because it could stand in.
// Bounded like every other host lifecycle probe, and run before this process opens
// supervisor ownership or mutates durable intake state, so a missing login is refused
// while nothing has been claimed rather than after a proposal is already in flight.
function checkSpecificationAuth(cfg, deps = {}) {
  const env = { ...(deps.env || process.env) };
  delete env.CODEX_API_KEY;
  delete env.OPENAI_API_KEY;
  const execute = deps.spawnSync || spawnSync;
  const result = execute('codex', ['login', 'status'], {
    env, encoding: 'utf8', shell: false, timeout: probeBound(cfg),
    killSignal: 'SIGKILL', windowsHide: true,
  });
  if (!result || result.status !== 0) {
    const detail = String((result && (result.stderr || result.stdout)) || '').trim();
    const model = (cfg && cfg.specificationModel) || '(unresolved)';
    throw new Error(`specification lane (${model}): no usable Codex saved ChatGPT login`
      + `${detail ? ` (${detail})` : ''}`
      + ' — run codex login on the host for a saved ChatGPT session, then retry');
  }
  return { ok: true, specificationModel: cfg && cfg.specificationModel };
}

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

async function main(argv, io = {}, deps = {}) {
  const writeOut = io.out || (text => fs.writeSync(1, String(text)));
  const args = parse(argv);
  const configPath = path.resolve(args.configPath);
  const cfg = (deps.loadConfig || loadConfig)(configPath);
  // Every actually-selected model lane is admitted before anything durable happens. The
  // implementation and author/probe lanes are gated by runner/preflight.js and
  // runner/prerequisites.js when their work starts; the specification lane is this
  // process's own, so it is checked HERE — after the config resolves the model it would
  // launch, and before ownership, state directories, locks, worktrees or Docker.
  if (SPECIFICATION_COMMANDS.has(args.command)) {
    (deps.checkSpecificationAuth || checkSpecificationAuth)(cfg);
  }
  const common = { repoRoot: path.resolve(__dirname, '..'), project: cfg.targetRepoPath,
    configPath, stateDir: supervisorStateDirFor(cfg.targetRepoPath),
    proposalId: args.proposalId,
    globalConcurrency: cfg.supervisorGlobalConcurrency,
    stageConcurrency: cfg.supervisorStageConcurrency };
  const makeSupervisor = deps.createProductionSupervisor || createProductionSupervisor;
  if (args.command === 'status') {
    const supervisor = makeSupervisor(common);
    const status = await supervisor.status(args.proposalId || undefined);
    writeOut(`${args.json ? JSON.stringify(status, null, 2) : formatHumanStatus(status)}\n`);
    return status;
  }
  if (args.command === 'stop') {
    const supervisor = makeSupervisor(common);
    const result = await supervisor.stop();
    writeOut(`${JSON.stringify(result)}\n`); return result;
  }
  const opened = (deps.openProjectSupervisor || openProjectSupervisor)({ ...common,
    reclaim: args.command === 'resume', supervisorId: `proposal-supervisor-${process.pid}` });
  if (!opened.ok) throw new Error(opened.reason || `project supervisor is held by ${opened.holder && opened.holder.id}`);
  if (args.command === 'tick') return runOwnedLoop(opened, true);
  return runOwnedLoop(opened, false);
}

if (require.main === module) main(process.argv.slice(2)).catch(error => {
  fs.writeSync(2, `proposal-supervisor: ${error.message}\n`); process.exitCode = 2;
});

module.exports = { main, runLoop, runOwnedLoop, parse, checkSpecificationAuth,
  SPECIFICATION_COMMANDS };
