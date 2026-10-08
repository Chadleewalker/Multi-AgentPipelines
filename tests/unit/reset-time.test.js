// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Offline reset-time regressions, including the real entrypoint with a stub agent.
// Every Git config and Claude config write is redirected into the owned temp fixture.
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { runScript } = require('../../runner/host-shell');
const { resolveReset } = require('../../pipeline/resolveReset');
const { waitPlan, waitForWindow } = require('../../runner/pause');

const ROOT = path.resolve(__dirname, '../..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-time-test-'));
const CFG = { probeIntervalMinutes: 15, maxPauseCycles: 3 };
const LOG = { info() {}, error() {} };
let checks = 0;
function check(name, fn) {
  fn();
  checks += 1;
  console.log(`ok - ${name}`);
}
const message = 'You have hit your session limit; resets 7:20pm (UTC)';
const before = new Date('2026-10-08T19:19:59Z');
const at = new Date('2026-10-08T19:20:00Z');
const after = new Date('2026-10-08T19:20:05Z');
const shellQuote = (s) => `'${s.replace(/'/g, "'\\''")}'`;
const portable = (s) => s.split(path.sep).join('/');

function entrypointCase(name, text, now, priorReset, expectedReset) {
  const ws = path.join(TMP, name);
  fs.mkdirSync(path.join(ws, '.run'), { recursive: true });
  const home = path.join(ws, 'home');
  fs.mkdirSync(home);
  const env = {
    ...process.env,
    HOME: portable(home), USERPROFILE: home,
    GIT_CONFIG_GLOBAL: portable(path.join(home, 'gitconfig')),
    CLAUDE_CONFIG_DIR: portable(home), CLAUDE_CODE_OAUTH_TOKEN: '',
    WORKSPACE: portable(ws), RUN_DIR: portable(path.join(ws, '.run')),
    PIPELINE_DIR: portable(path.join(ROOT, 'pipeline')), ISSUE_ID: 'reset-fixture',
    PIPELINE_MODEL: '', PIPELINE_MAX_ATTEMPTS: '3',
  };
  const git = spawnSync('git', ['init', '-q', ws], { env, encoding: 'utf8', windowsHide: true });
  assert.equal(git.status, 0, git.stderr);
  fs.writeFileSync(path.join(ws, '.run/issue.md'), '# Offline reset fixture\n');
  const prior = {
    issueId: 'reset-fixture',
    attempts: [{ number: 1, verifierResult: 'fail', timestamp: '2026-10-08T18:00:00Z' }],
    memoryNotes: ['keep this note'],
  };
  if (priorReset) prior.rateLimitResetAt = priorReset;
  fs.writeFileSync(path.join(ws, '.run/status.json'), JSON.stringify(prior));
  const agent = path.join(ws, 'agent.js');
  fs.writeFileSync(agent, `process.stdin.resume(); process.stdin.on('end', () => {
    process.stdout.write(${JSON.stringify(text)}); process.exit(1);
  });\n`);
  env.PIPELINE_AGENT_CMD = `${shellQuote(portable(process.execPath))} ${shellQuote(portable(agent))}`;
  const clock = path.join(ws, 'clock.js');
  fs.writeFileSync(clock, `const RealDate = Date; const instant = RealDate.parse(${JSON.stringify(now)});
    global.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [instant])); }
      static now() { return instant; }
    };\n`);
  env.NODE_OPTIONS = `--require ${JSON.stringify(portable(clock))}`;
  const result = runScript(path.join(ROOT, 'pipeline/entrypoint.sh'), [], {
    cwd: ws, env, timeout: 10000, windowsHide: true,
  });
  check(`${name}: rate limit exits 20`, () => assert.equal(result.status, 20, result.stderr));
  const status = JSON.parse(fs.readFileSync(path.join(ws, '.run/status.json'), 'utf8'));
  check(`${name}: reset field matches current message`, () => {
    if (expectedReset === null) assert.equal(Object.hasOwn(status, 'rateLimitResetAt'), false);
    else assert.equal(status.rateLimitResetAt, expectedReset);
  });
  check(`${name}: attempts and notes survive without consuming an attempt`, () => {
    assert.deepEqual(status.attempts, prior.attempts);
    assert.deepEqual(status.memoryNotes, prior.memoryNotes);
  });
  return status;
}

async function main() {
  check('future same-day UTC reset remains exact', () =>
    assert.equal(resolveReset(message, before), '2026-10-08T19:20:00.000Z'));
  for (const [name, now] of [['at the boundary', at], ['five seconds after', after],
    ['several minutes after', new Date('2026-10-08T19:25:00Z')]]) {
    check(`${name}: no invented next-day reset`, () => assert.equal(resolveReset(message, now), null));
    check(`${name}: fallback waits only the configured probe interval`, () =>
      assert.deepEqual(waitPlan({ rateLimitResetAt: resolveReset(message, now) }, CFG, now.getTime()),
        { kind: 'probe', ms: 15 * 60000 }));
  }
  check('midnight without a date uses probing instead of guessing tomorrow', () =>
    assert.equal(resolveReset('session limit; resets 12am (UTC)', new Date('2026-10-08T23:59:00Z')), null));
  check('future midnight hour on the current day parses as zero', () =>
    assert.equal(resolveReset('resets 12:05 am (utc)', new Date('2026-10-08T00:01:00Z')),
      '2026-10-08T00:05:00.000Z'));
  check('noon remains noon', () =>
    assert.equal(resolveReset('resets 12pm (UTC)', new Date('2026-10-08T11:59:00Z')),
      '2026-10-08T12:00:00.000Z'));
  for (const text of ['', 'resets 7:20pm', 'resets 7:20pm (EST)', 'resets 13pm (UTC)',
    'resets 0am (UTC)', 'resets 7:60pm (UTC)']) {
    check(`unusable reset ${JSON.stringify(text)} falls back to probing`, () =>
      assert.equal(resolveReset(text, before), null));
  }
  entrypointCase('future', message, before.toISOString(), '2099-01-01T00:00:00Z',
    '2026-10-08T19:20:00.000Z');
  const stale = entrypointCase('elapsed-with-old-reset', message, after.toISOString(),
    '2026-10-09T19:20:00.000Z', null);
  check('old saved reset cannot override the probe fallback on relaunch', () =>
    assert.deepEqual(waitPlan(stale, CFG, after.getTime()), { kind: 'probe', ms: 15 * 60000 }));
  entrypointCase('unqualified-with-old-reset', 'session limit; resets 7:20pm',
    after.toISOString(), '2099-01-01T00:00:00Z', null);
  entrypointCase('json-429-with-old-reset', '{"api_error_status":429}',
    after.toISOString(), '2099-01-01T00:00:00Z', null);
  entrypointCase('legacy-epoch-wins', 'usage limit reached|1791487800; resets 7:20pm (UTC)',
    after.toISOString(), '2099-01-01T00:00:00Z', new Date(1791487800 * 1000).toISOString());
  const midnight = entrypointCase('midnight', 'session limit; resets 12am (UTC)',
    '2026-10-08T23:59:00Z', null, null);
  let probes = 0;
  const waits = [];
  const result = await waitForWindow(CFG, midnight, LOG, 'test', {
    now: () => Date.parse('2026-10-08T23:59:00Z'),
    sleepFn: async (ms) => { waits.push(ms); },
    probeFn: () => ({ open: ++probes === 2 }),
  });
  check('a midnight reset resumes when probing observes the open window', () => {
    assert.deepEqual(result, { resumed: true, pauses: 2 });
    assert.deepEqual(waits, [15 * 60000, 15 * 60000]);
  });
  console.log(`reset-time: all ${checks} checks passed`);
}

main().catch((error) => {
  console.error(`FAIL - ${error.stack}`);
  process.exitCode = 1;
}).finally(() => fs.rmSync(TMP, { recursive: true, force: true }));
