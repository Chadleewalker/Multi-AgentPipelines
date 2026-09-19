#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

// Host-only, explicit Docker integration; not a frozen acceptance or nested Docker suite.
// Usage: node tests/integration/freeze-native-scratch.js --image sha256:<local-image-id>
// The mandatory freeze-gate suite owns resource, mount and container-cleanup checks.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { runVerify } = require('../../scripts/freeze-gate');

// Serialized into the disposable workspace and executed by Node inside the pinned image.
function verifyFixture() {
  const assert = require('assert/strict');
  const fs = require('fs');
  const path = require('path');
  const { spawnSync } = require('child_process');
  const scratch = fs.mkdtempSync('/tmp/freeze-native-scratch-');
  const run = (command, args = []) => spawnSync(command, args, {
    encoding: 'utf8', timeout: 5000,
  });
  try {
    assert.equal(fs.statSync(scratch).mode & 0o777, 0o700, 'scratch must be private');
    const status = fs.readFileSync('/proc/self/status', 'utf8');
    assert.match(status, /^NoNewPrivs:\s+1$/m, 'kernel must deny new privileges');
    assert.match(status, /^CapEff:\s+0+$/m, 'kernel effective capabilities must be zero');
    assert.deepEqual(fs.readdirSync('/sys/class/net'), ['lo'], 'only loopback may exist');
    assert.equal(process.env.FREEZE_NATIVE_SCRATCH_HOST_SENTINEL, undefined,
      'harmless host environment sentinel must not reach the verifier');
    const rootMount = fs.readFileSync('/proc/self/mountinfo', 'utf8').trim().split('\n')
      .map((line) => line.split(' ')).find((fields) => fields[4] === '/');
    assert.ok(rootMount?.[5].split(',').includes('ro'), 'kernel root mount must be read-only');
    console.log('PASS kernel isolation: no new privileges, no capabilities, loopback only, read-only root, no host sentinel');

    const executable = path.join(scratch, 'executable');
    const nonExecutable = path.join(scratch, 'non-executable');
    const bytes = '#!/bin/sh\nprintf "native-scratch-ok\\n"\n';
    fs.writeFileSync(executable, bytes);
    fs.writeFileSync(nonExecutable, bytes);
    fs.chmodSync(executable, 0o755);
    fs.chmodSync(nonExecutable, 0o644);
    const executed = run(executable);
    const refused = run(nonExecutable);
    const modes = run('sh', ['-c', 'test -x "$1" && test ! -x "$2"',
      'scratch-mode-check', executable, nonExecutable]);
    console.log(`native scratch observations: ${JSON.stringify({
      executable: { status: executed.status, error: executed.error?.code || null },
      nonExecutable: { status: refused.status, error: refused.error?.code || null },
      executablePredicates: modes.status,
    })}`);
    assert.equal(executed.error, undefined, '0755 file must execute directly from /tmp');
    assert.equal(executed.status, 0, executed.stderr);
    assert.equal(executed.stdout, 'native-scratch-ok\n');
    assert.equal(refused.error?.code, 'EACCES', '0644 file must refuse direct execution');
    assert.equal(modes.error, undefined);
    assert.equal(modes.status, 0, 'test -x must distinguish 0755 from 0644 on /tmp');
    console.log('PASS native scratch: direct execution and executable predicates distinguish 0755/0644');
  } finally {
    // This exact path was created above; no shared scratch or repository is removed.
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function main(argv) {
  if (argv.length !== 2 || argv[0] !== '--image' || !/^sha256:[0-9a-f]{64}$/.test(argv[1])) {
    console.error('usage: node tests/integration/freeze-native-scratch.js --image sha256:<local-image-id>');
    return 2;
  }
  const image = argv[1];
  // Inspect the default local daemon without inherited Docker endpoint configuration.
  // Refuse a missing image before production runVerify could try an implicit pull.
  const inspected = spawnSync('docker', ['image', 'inspect', '--format', '{{.Id}}', image], {
    encoding: 'utf8', timeout: 15000,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
  });
  if (inspected.error || inspected.status !== 0 || inspected.stdout.trim() !== image) {
    console.error(`freeze-native-scratch: pinned local image unavailable (${inspected.error?.message || inspected.stderr.trim() || inspected.status})`);
    return 2;
  }
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'freeze-native-scratch-host-'));
  const names = ['FREEZE_GATE_CMD', 'FREEZE_GATE_DOCKER_CMD', 'FREEZE_GATE_DOCKER_IMAGE',
    'FREEZE_NATIVE_SCRATCH_HOST_SENTINEL'];
  const saved = new Map(names.map((name) => [name, process.env[name]]));
  try {
    fs.writeFileSync(path.join(fixture, 'fixture.js'), `(${verifyFixture.toString()})();\n`);
    delete process.env.FREEZE_GATE_CMD;
    delete process.env.FREEZE_GATE_DOCKER_CMD;
    process.env.FREEZE_GATE_DOCKER_IMAGE = image;
    process.env.FREEZE_NATIVE_SCRATCH_HOST_SENTINEL = `harmless-${path.basename(fixture)}`;
    const result = runVerify(fixture, 'node fixture.js', 'native-scratch', 60000);
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    assert.equal(result.error, null, 'production runVerify must complete');
    assert.equal(result.signal, null, 'production runVerify must not be interrupted');
    assert.equal(result.status, 0, 'production runVerify native scratch regression');
    console.log(`PASS freeze-native-scratch through production runVerify (${image})`);
    return 0;
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    const cleanupTarget = path.resolve(fixture);
    assert.equal(path.dirname(cleanupTarget), path.resolve(os.tmpdir()), 'fixture must stay in host temp');
    assert.ok(path.basename(cleanupTarget).startsWith('freeze-native-scratch-host-'));
    fs.rmSync(cleanupTarget, { recursive: true, force: true });
  }
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { main };
