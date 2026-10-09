// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Exercise real shell functions and processes, including harness failures that
// print convincing outcome text. Docker is a shell function, never a PATH stub.
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { runScript, scriptArg } = require('../../runner/host-shell');
const ROOT = path.resolve(__dirname, '../..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-'));
const fixture = path.join(TMP, 'checkout with spaces');
fs.mkdirSync(path.join(fixture, 'scripts'), { recursive: true });
fs.mkdirSync(path.join(fixture, 'runner'));
const q = (s) => "'" + s.replace(/'/g, "'\\''") + "'";
const copier = fs.readFileSync(path.join(ROOT, 'scripts/stream-output.js'));
const e2e = fs.readFileSync(path.join(ROOT, 'scripts/e2e.sh'), 'utf8');
const scenario = e2e.slice(e2e.indexOf('run_scenario()'), e2e.indexOf('\necho "########'));
const setup = e2e.slice(e2e.indexOf('# Verification owns'), e2e.indexOf('\ncleanup_remote()'));
assert(scenario.includes('run_scenario()') && setup.includes('cleanup_local()'), 'harness extraction failed');
fs.copyFileSync(path.join(ROOT, 'scripts/pipeline-net.sh'), path.join(fixture, 'scripts/pipeline-net.sh'));
fs.writeFileSync(path.join(fixture, 'scripts/stream-output.js'), copier);
fs.writeFileSync(path.join(fixture, 'runner/run.js'), 'console.log("exit 0 -> done"); console.error("runner progress"); process.exit(Number(process.env.RUNNER_EXIT || 0));\n');
const cfg = path.join(fixture, 'run.config.fixture.json');
fs.writeFileSync(cfg, '{}');
const record = path.join(TMP, 'docker.jsonl');
const recorder = path.join(TMP, 'docker-recorder.js');
fs.writeFileSync(recorder, `
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.HARNESS_RECORD, JSON.stringify(args) + '\\n');
if (args[0] === 'build' && process.env.BUILD_FAIL === '1') process.exit(7);
if (args[0] === 'image' && args[1] === 'rm' && process.env.IMAGE_REMOVE_FAIL === '1') process.exit(6);
if (args.includes('inspect')) process.exit(process.env.RESOURCE_EXISTS === '1' ||
  (args[0] === 'image' && process.env.IMAGE_EXISTS === '1') ? 0 : 1);
process.exit(0);
`);
const functionDocker = 'docker() { "$HARNESS_NODE" "$HARNESS_RECORDER" "$@"; }; export -f docker\n';
let checks = 0;
function check(name, fn) { fn(); checks++; console.log(`ok - ${name}`); }
function shell(body, extra = {}) {
  fs.writeFileSync(record, '');
  const file = path.join(fixture, 'scripts/check.sh');
  fs.writeFileSync(file, `#!/usr/bin/env bash\nset -u\n${functionDocker}${body}\n`);
  const env = { ...process.env };
  for (const key of ['PIPELINE_NET', 'PIPELINE_PROXY', 'PIPELINE_PROXY_PORT', 'PIPELINE_PROXY_IMAGE',
    'RUNNER_EXIT', 'BUILD_FAIL', 'RESOURCE_EXISTS', 'IMAGE_EXISTS']) delete env[key];
  const result = runScript(file, [], { cwd: fixture, timeout: 30000, windowsHide: true,
    env: { ...env, HARNESS_NODE: scriptArg(process.execPath), HARNESS_RECORDER: scriptArg(recorder),
      HARNESS_RECORD: record, ...extra } });
  assert(!result.error, result.error?.message);
  result.calls = fs.readFileSync(record, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  return result;
}
const scenarioBody = `ROOT=${q(scriptArg(fixture))}\nCFG=${q(scriptArg(cfg))}\nS=a; B=b; T=c\nbdq() { return 0; }\n${scenario}\n`;
function runScenario(extra = {}, guarded = false) {
  // These are the actual e2e call sites, with only the scenario arguments replaced.
  const kind = typeof guarded === 'string' ? guarded : 'success';
  const caller = e2e.split('\n').find(line => line.startsWith('OUT=$(run_scenario ') && line.includes(` ${kind}.sh `));
  assert(caller, `e2e ${kind} caller missing`);
  return shell(scenarioBody + (guarded
    ? `STAMP=test\nfail() { echo "FAIL  $1"; }\n${caller}\necho "$OUT"`
    : 'run_scenario a success.sh test'), extra);
}
try {
  const bytes = Buffer.alloc(1024 * 1024, 0x61);
  bytes[17] = 0; bytes[18] = 0xff;
  const copy = spawnSync(process.execPath, [path.join(ROOT, 'scripts/stream-output.js')],
    { input: bytes, timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  check('portable copier exits successfully', () => assert.equal(copy.status, 0));
  check('captured stdout preserves binary bytes and large output', () => assert.deepEqual(copy.stdout, bytes));
  check('stderr progress preserves the same bytes', () => assert.deepEqual(copy.stderr, bytes));
  const closed = spawnSync(process.execPath, ['-e',
    `process.stdout.write = (chunk, callback) => { callback(new Error('planted output failure')); return false; }; require(${JSON.stringify(path.join(ROOT, 'scripts/stream-output.js'))});`],
    { input: 'progress', encoding: 'utf8', timeout: 30000, windowsHide: true });
  check('copier fails explicitly when a destination cannot be written', () => {
    assert.equal(closed.status, 1); assert.match(closed.stderr, /progress copy failed:/);
  });
  const success = runScenario({ PIPELINE_NET: 'owned-net', PIPELINE_PROXY: 'owned-proxy' });
  check('real scenario shell succeeds under captured Git Bash/POSIX output', () => assert.equal(success.status, 0));
  check('scenario stdout contains runner outcome', () => assert.match(success.stdout, /exit 0 -> done/));
  check('scenario stderr carries live runner progress', () => assert.match(success.stderr, /runner progress/));
  check('no device-file error is hidden in successful progress', () => assert.doesNotMatch(success.stderr, /No such device|\/dev\/stderr/));
  const generated = JSON.parse(fs.readFileSync(path.join(fixture, '.e2e.config.json')));
  check('scenario uses owned network and proxy configuration', () => assert.deepEqual(
    [generated.network, generated.proxyName], ['owned-net', 'owned-proxy']));
  const runnerFailure = runScenario({ RUNNER_EXIT: '7' });
  check('scenario propagates runner failure despite plausible success output', () => assert.equal(runnerFailure.status, 7));
  check('runner failure is identified by source', () => assert.match(runnerFailure.stderr, /scenario runner failed \(exit 7\)/));
  const guardedFailure = runScenario({ RUNNER_EXIT: '7' }, true);
  check('actual e2e caller rejects a broken scenario', () => assert.equal(guardedFailure.status, 1));
  check('broken scenario reports harness failure', () => assert.match(guardedFailure.stdout, /FAIL  success scenario harness failed/));
  for (const kind of ['bail', 'tamper']) {
    const broken = runScenario({ RUNNER_EXIT: '7' }, kind);
    check(`${kind} caller also rejects runner launch failure`, () => {
      assert.equal(broken.status, 1); assert.match(broken.stdout, new RegExp(`FAIL  ${kind} scenario harness failed`));
    });
  }
  fs.writeFileSync(path.join(fixture, 'scripts/stream-output.js'), 'process.stdin.resume(); process.stdin.on("end", () => process.exit(9));\n');
  const copyFailure = runScenario();
  check('scenario rejects progress copier failure', () => assert.equal(copyFailure.status, 1));
  check('copier failure is distinct from runner failure', () => assert.match(copyFailure.stderr, /scenario progress copier failed \(exit 9\)/));
  fs.writeFileSync(path.join(fixture, 'scripts/stream-output.js'), copier);
  fs.writeFileSync(cfg, '{broken');
  const configFailure = runScenario();
  check('invalid scenario config fails before launching the runner', () => {
    assert.equal(configFailure.status, 1); assert.doesNotMatch(configFailure.stdout, /exit 0 -> done/);
    assert.match(configFailure.stderr, /scenario config creation failed/);
  });
  fs.writeFileSync(cfg, '{}');
  const netScript = q(scriptArg(path.join(fixture, 'scripts/pipeline-net.sh')));
  const owned = shell(`source ${netScript} up`, {
    PIPELINE_PROXY_IMAGE: 'owned-proxy-test:local', PIPELINE_NET: 'owned-net', PIPELINE_PROXY: 'owned-proxy',
  });
  check('real network script runs through the Docker function recorder', () => assert.equal(owned.status, 0));
  check('proxy build selects only the owned image tag', () => assert.deepEqual(
    owned.calls.find(a => a[0] === 'build').slice(0, 4), ['build', '-q', '-t', 'owned-proxy-test:local']));
  check('proxy container runs the selected image', () => assert(owned.calls.some(a => a.join(' ') === 'run -d --name owned-proxy owned-proxy-test:local')));
  check('owned verification never refers to the shared proxy tag', () => assert(!JSON.stringify(owned.calls).includes('pipeline-proxy:local')));
  const historical = shell(`source ${netScript} up`);
  check('unset override preserves the historical production tag', () => assert.equal(historical.calls.find(a => a[0] === 'build')[3], 'pipeline-proxy:local'));
  const buildFailure = shell(`source ${netScript} up`, { PIPELINE_PROXY_IMAGE: 'owned-proxy-test:local', BUILD_FAIL: '1' });
  check('failed build stops before any container or network mutation', () => {
    assert.equal(buildFailure.status, 1); assert.equal(buildFailure.calls.length, 1);
  });
  const down = shell(`source ${netScript} down`, { PIPELINE_NET: 'owned-net', PIPELINE_PROXY: 'owned-proxy', PIPELINE_PROXY_IMAGE: 'owned-proxy-test:local' });
  check('network teardown removes only its named resources and no image', () => assert.deepEqual(down.calls, [['rm', '-f', 'owned-proxy'], ['network', 'rm', 'owned-net']]));
  const setupBody = `ROOT=${q(scriptArg(fixture))}\nSTAMP=e2e-test\n${setup}\necho "selected=$PIPELINE_PROXY_IMAGE"\n`;
  const auto = shell(setupBody, { IMAGE_EXISTS: '1' });
  check('automatic tag collision stops without removing an existing image', () => {
    assert.equal(auto.status, 1); assert(!auto.calls.some(a => a[0] === 'rm' || a[1] === 'rm'));
  });
  // First inspect sees an absent tag; cleanup sees a built tag. The recorder simulates
  // that state by creating a marker when the body finishes, without touching Docker.
  const cleanupBody = setupBody.replace('\necho "selected=', '\nexport IMAGE_EXISTS=1\necho "selected=');
  const autoCleanup = shell(cleanupBody);
  check('e2e selects an owned tag instead of the shared tag', () => assert.match(autoCleanup.stdout, /selected=pipeline-proxy-e2e-test-\d+:local/));
  check('e2e removes its generated image at exit', () => assert(autoCleanup.calls.some(a => a[0] === 'image' && a[1] === 'rm' && /^pipeline-proxy-e2e-test-/.test(a[2]))));
  const failedCleanup = shell(cleanupBody, { IMAGE_REMOVE_FAIL: '1' });
  check('failed owned-image cleanup fails the suite visibly', () => {
    assert.equal(failedCleanup.status, 1); assert.match(failedCleanup.stderr, /could not remove owned proxy image/);
  });
  const callerOwned = shell(setupBody, { PIPELINE_PROXY_IMAGE: 'caller-owned:local', IMAGE_EXISTS: '1' });
  check('e2e retains an explicitly supplied image tag', () => {
    assert.equal(callerOwned.status, 0); assert(!callerOwned.calls.some(a => a[0] === 'image' && a[1] === 'rm'));
  });
  const occupied = shell(setupBody, { RESOURCE_EXISTS: '1' });
  check('e2e refuses to touch an existing network or proxy', () => {
    assert.equal(occupied.status, 1); assert(!occupied.calls.some(a => a[0] === 'rm' || a[1] === 'rm' || a[0] === 'build'));
  });
  const isolation = fs.readFileSync(path.join(ROOT, 'scripts/test-isolation.sh'), 'utf8');
  const inc = isolation.slice(isolation.indexOf('inc()'), isolation.indexOf('\n# 1.'));
  const isolated = shell(`NET=owned-net; PROXY=owned-proxy; PROXY_PORT=1234\nWSW=workspace; PIPW=pipeline; IMAGE=fixture\n${inc}\ninc true`);
  check('isolation assertions join the owned network', () => assert.equal(isolated.calls[0][isolated.calls[0].indexOf('--network') + 1], 'owned-net'));
  check('isolation assertions reach the owned proxy', () => assert(isolated.calls[0].includes('HTTPS_PROXY=http://owned-proxy:1234') && isolated.calls[0].includes('HTTP_PROXY=http://owned-proxy:1234')));
  console.log(`PASS  ${checks} offline harness checks`);
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
