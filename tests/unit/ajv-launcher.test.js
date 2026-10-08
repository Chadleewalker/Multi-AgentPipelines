// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Exercise the real AJV shell blocks with offline launchers. Docker and the e2e
// runner are never invoked; schema validation itself is checked by the host suites.
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runScript } = require('../../runner/host-shell');
const ROOT = path.resolve(__dirname, '../..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ajv-launcher-'));
const fixture = path.join(TMP, 'directory with spaces');
fs.mkdirSync(path.join(fixture, 'schemas/examples'), { recursive: true });
fs.mkdirSync(path.join(fixture, 'output with spaces'));
for (let n = 1; n <= 8; n++) fs.writeFileSync(path.join(fixture, `output with spaces/scenario ${n}.json`), '{}');
fs.writeFileSync(path.join(fixture, 'output with spaces/e13-docsbuild.json'), '{}');
const portable = (value) => value.split(path.sep).join('/');
let checks = 0;
function check(name, fn) { fn(); checks++; console.log(`PASS  ${name}`); }
const endpoints = [
  ['test-status-schema.sh', '# Schema covers'],
  ['test-entrypoint.sh', '# 4.3:'],
  ['test-verifier.sh', '# The verifier is deterministic'],
  ['test-report.sh', '# 2. Scrutiny'],
  ['e2e.sh', 'grep -q "TAMPERED"'],
];
const stub = path.join(TMP, 'launcher.js');
fs.writeFileSync(stub, `
  const fs = require('fs');
  const [launcher, ...args] = process.argv.slice(2);
  fs.appendFileSync(process.env.ARGV_LOG, JSON.stringify({launcher, args}) + '\\n');
  const negative = args.includes('test') && args.includes('--invalid');
  if (process.env.MODE === 'launch-failure') {
    console.error('fixture launcher failed before validation'); process.exit(1);
  }
  if (negative && process.env.MODE === 'unexpected-valid') {
    console.error('fixture data unexpectedly valid'); process.exit(1);
  }
  if (process.env.MODE === 'missing-data' || process.env.MODE === 'bad-schema') {
    console.error('fixture could not load data or compile schema'); process.exit(2);
  }
  // The old validate-negative idiom accepts any nonzero result. A real rejection
  // still returns 1; the explicit test --invalid operation instead confirms it with 0.
  const data = args[args.indexOf('-d') + 1] || '';
  if (!negative && data.endsWith('status.invalid.json')) {
    console.error('fixture data rejected by schema'); process.exit(1);
  }
  process.exit(0);
`);

function exercise(name, marker, mode = 'success', fallback = false) {
  const source = fs.readFileSync(path.join(ROOT, 'scripts', name), 'utf8');
  const start = source.indexOf('AJV=(');
  const end = source.indexOf(marker, start);
  assert.ok(start >= 0 && end > start, `${name}: AJV block not found`);
  const wrapper = path.join(TMP, 'fixture.sh');
  const argv = path.join(TMP, 'argv.jsonl');
  fs.writeFileSync(argv, '');
  fs.writeFileSync(wrapper, `#!/usr/bin/env bash
set -u
ROOT="$FIXTURE"
SCHEMA="$ROOT/schemas/status schema.json"
OUT="$ROOT/output with spaces"
MAN="$ROOT/run manifest.json"
STAMP="stamp with spaces"
FAIL=0
pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; FAIL=1; }
npx() { "$NODE_EXE" "$LAUNCHER_JS" npx "$@"; }
npx.cmd() { "$NODE_EXE" "$LAUNCHER_JS" npx.cmd "$@"; }
${fallback ? 'command() { if [ "$1" = "-v" ] && [ "$2" = "npx" ]; then return 1; fi; builtin command "$@"; }' : ''}
${source.slice(start, end)}
exit "$FAIL"
`);
  const r = runScript(wrapper, [], {
    cwd: fixture, timeout: 15000, windowsHide: true,
    env: { ...process.env, NODE_OPTIONS: '', FIXTURE: portable(fixture),
      NODE_EXE: portable(process.execPath), LAUNCHER_JS: portable(stub),
      ARGV_LOG: portable(argv), MODE: mode },
  });
  const lines = fs.readFileSync(argv, 'utf8').trim();
  return { ...r, output: String(r.stdout || '') + String(r.stderr || ''),
    calls: lines ? lines.split('\n').map((line) => JSON.parse(line)) : [] };
}

try {
  for (const [name, marker] of endpoints) {
    const ok = exercise(name, marker);
    check(`${name}: schema block succeeds with the working launcher`, () => assert.equal(ok.status, 0, ok.output));
    check(`${name}: prefers npx when both launchers exist`, () => {
      assert.ok(ok.calls.length > 0);
      assert.ok(ok.calls.every((call) => call.launcher === 'npx'));
    });
    check(`${name}: spaced schema and data paths remain single arguments`, () => {
      for (const call of ok.calls) {
        assert.ok(call.args[call.args.indexOf('-s') + 1].startsWith(portable(fixture) + '/'));
        assert.ok(call.args[call.args.indexOf('-d') + 1].startsWith(portable(fixture) + '/'));
      }
    });
    const failed = exercise(name, marker, 'launch-failure');
    check(`${name}: launcher failure fails the schema block`, () => assert.notEqual(failed.status, 0));
    check(`${name}: launcher diagnostic remains visible`, () =>
      assert.ok(failed.output.includes('fixture launcher failed before validation')));
    if (name === 'test-status-schema.sh') {
      check('launcher failure cannot pass the invalid-example assertion', () =>
        assert.ok(!failed.output.includes('PASS  invalid example fails validation')));
      check('negative check explicitly asks AJV to confirm invalid data', () =>
        assert.ok(ok.calls.some((call) => call.args.includes('test') && call.args.includes('--invalid'))));
    }
  }
  const fallback = exercise(...endpoints[0], 'success', true);
  check('npx.cmd fallback remains available when npx is missing', () => {
    assert.equal(fallback.status, 0, fallback.output);
    assert.ok(fallback.calls.length > 0 && fallback.calls.every((call) => call.launcher === 'npx.cmd'));
  });
  for (const mode of ['unexpected-valid', 'missing-data', 'bad-schema']) {
    const bad = exercise(...endpoints[0], mode);
    check(`${mode}: negative assertion cannot produce PASS`, () => {
      assert.notEqual(bad.status, 0);
      assert.ok(!bad.output.includes('PASS  invalid example fails validation'));
    });
  }
  console.log(`ajv-launcher: all ${checks} checks passed`);
} catch (error) {
  console.error(`FAIL - ${error.stack}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}
