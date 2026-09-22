#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'v1-guard-admission-'));
const oldEnv = { ...process.env };
process.env.WRITE_PROTECTION_CLAUDE_DIR = path.join(temp, 'claude');
process.env.WRITE_PROTECTION_CODEX_DIR = path.join(temp, 'codex');
process.env.WRITE_PROTECTION_HOST_STATE_DIR = path.join(temp, 'state');
const installer = require('../../scripts/write-protection');
const { checkInstallation, admitGuard, issueForTests } = require('../../runner/guard-admission');
const freeze = require('../../scripts/freeze-gate');
const { runOneTask } = require('../../runner/run');
const { renderReport } = require('../../runner/report');
let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`PASS  ${name}`); }
  catch (e) { failures += 1; console.log(`FAIL  ${name}: ${e.stack}`); }
}
function git(dir, ...args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
  assert.strictEqual(r.status, 0, `${args.join(' ')}: ${r.stderr || r.error}`);
}
function put(dir, file, body) {
  const dest = path.join(dir, file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, body);
}
function repository(name, protectedRepo = true) {
  const dir = path.join(temp, name);
  fs.mkdirSync(dir);
  git(dir, 'init', '-q');
  put(dir, 'src/product.js', 'module.exports = 1;\n');
  put(dir, 'tools/verify.js', 'process.exit(0);\n');
  put(dir, 'tests/acceptance/_control/test.js', 'process.exit(0);\n');
  if (protectedRepo) put(dir, 'pipeline.config.json', JSON.stringify({
    verifyCommand: 'node tools/verify.js', frozenPaths: ['tools/verify.js'],
  }));
  git(dir, 'add', '.');
  git(dir, '-c', 'user.name=Guard Fixture', '-c', 'user.email=guard@example.invalid', 'commit', '-qm', 'fixture');
  return dir;
}
let target;
let plain;

async function main() {
  target = repository('target');
  plain = repository('plain', false);
  check('missing installation refuses even a clean protected target', () => {
    const result = admitGuard(target);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.stage, 'installation');
  });
  check('current installed payload and coverage admit a clean target', () => {
    assert.strictEqual(installer.install().doctor.ok, true);
    const result = admitGuard(target);
    assert.strictEqual(result.ok, true, JSON.stringify(result));
    assert.match(result.health.note, /not proof|canar/i);
  });
  check('stale installed policy is detected independently of hook execution', () => {
    const file = path.join(installer.hookRoot('claude'), 'scripts/write-protection-policy.js');
    const original = fs.readFileSync(file);
    try {
      fs.appendFileSync(file, '\n// stale installation\n');
      const result = admitGuard(target);
      assert.strictEqual(result.ok, false);
      assert.ok(result.health.clients.claude.payloadMismatches.includes('scripts/write-protection-policy.js'));
    } finally { fs.writeFileSync(file, original); }
  });
  check('missing client tool coverage refuses even unchanged payload', () => {
    const file = path.join(process.env.WRITE_PROTECTION_CLAUDE_DIR, 'settings.json');
    const original = fs.readFileSync(file);
    try {
      const cfg = JSON.parse(original);
      cfg.hooks.PreToolUse = [];
      fs.writeFileSync(file, JSON.stringify(cfg));
      assert.strictEqual(admitGuard(target).ok, false);
    } finally { fs.writeFileSync(file, original); }
  });
  check('an unprotected Git repository cannot opt out of pipeline admission', () => {
    const result = admitGuard(plain);
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.stage, 'target');
    assert.match(result.reason, /not a protected/);
  });
  check('Git inspection failure remains closed even if policy reports admit', () => {
    const result = admitGuard(target, {}, { doctor: () => ({ ok: true }),
      admit: () => ({ admit: true, protected: true, undecidable: true }) });
    assert.strictEqual(result.ok, false);
    assert.match(result.reason, /could not be inspected/);
  });
  check('doctor exceptions cannot produce an admission', () => {
    assert.strictEqual(checkInstallation({ doctor: () => { throw new Error('fixture'); } }).ok, false);
  });
  check('target inspection exceptions cannot produce an admission', () => {
    assert.strictEqual(admitGuard(target, {}, { doctor: () => ({ ok: true }),
      admit: () => { throw new Error('fixture'); } }).ok, false);
  });
  check('dirty product is refused and preserved byte for byte', () => {
    put(target, 'src/product.js', 'user-owned change\n');
    try {
      const result = admitGuard(target);
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.stage, 'target', JSON.stringify(result));
      assert.ok(result.refusals.some((r) => r.path === 'src/product.js'));
      assert.strictEqual(fs.readFileSync(path.join(target, 'src/product.js'), 'utf8'), 'user-owned change\n');
    } finally { git(target, 'restore', 'src/product.js'); }
  });
  check('only the named issue suite is admitted for freeze', () => {
    put(target, 'tests/acceptance/task-a/test.js', '// current issue');
    assert.strictEqual(admitGuard(target).ok, false);
    const current = admitGuard(target, { issues: ['task-a'] });
    assert.strictEqual(current.ok, true, JSON.stringify(current));
    put(target, 'tests/acceptance/task-b/test.js', '// sibling');
    const result = admitGuard(target, { issues: ['task-a'] });
    assert.strictEqual(result.ok, false);
    assert.ok(result.refusals.some((r) => r.path.includes('task-b/')));
    fs.unlinkSync(path.join(target, 'tests/acceptance/task-b/test.js'));
  });
  check('deleted protection marker still refuses the checkout', () => {
    fs.unlinkSync(path.join(target, 'pipeline.config.json'));
    try {
      const result = admitGuard(target, { issues: ['task-a'] });
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.stage, 'target', JSON.stringify(result));
      assert.ok(result.refusals.some((r) => r.path === 'pipeline.config.json'));
    } finally { git(target, 'restore', 'pipeline.config.json'); }
  });
  check('control fixture and unsafe paths never become authoring exceptions', () => {
    assert.strictEqual(issueForTests('tests/acceptance/task-a/'), 'task-a');
    for (const value of ['tests/acceptance/_control/', 'tests/acceptance/../',
      'tests/acceptance/task-a/nested', '../tests/acceptance/task-a', 'tests/acceptance/']) {
      assert.strictEqual(issueForTests(value), null, value);
    }
  });
  check('freeze refuses before invoking a verifier and passes only the current issue', () => {
    const sentinel = path.join(target, 'verifier-ran');
    put(target, 'tools/verify.js', `require('fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran');`);
    const originalError = console.error;
    const messages = [];
    console.error = (text) => messages.push(text);
    let seen;
    try {
      const code = freeze.main(['--repo', target, '--tests', 'tests/acceptance/task-a/'], {
        guardAdmission: (dir, options) => { seen = { dir, options };
          return { ok: false, stage: 'target', reason: 'fixture refusal' }; },
      });
      assert.strictEqual(code, 2);
      assert.deepStrictEqual(seen, { dir: target, options: { issues: ['task-a'] } });
      assert.strictEqual(fs.existsSync(sentinel), false);
      assert.match(messages.join('\n'), /admission refused/);
    } finally { console.error = originalError; }
  });
  const row = await runOneTask({}, { id: 'no-launch' }, {
    trace: () => 'guard', taskDir: () => temp, info() {}, error() {},
  }, '', { admit: async () => true }, {
    guardInstallation: () => ({ ok: false, stage: 'installation', reason: 'fixture missing installation' }),
  });
  check('runner installation refusal precedes Beads claim and workspace setup', () => {
    assert.strictEqual(row.attempts, 0);
    assert.strictEqual(row.pushed, false);
    assert.match(row.error, /fixture missing installation/);
    const keys = require('../../schemas/run.schema.json').properties.tasks.items.properties;
    assert.ok(Object.keys(row).every((key) => Object.hasOwn(keys, key)), 'refused manifest row violates schema');
  });
  check('report does not mislabel guard-retained commits as an empty branch', () => {
    const report = renderReport({ runId: 'guard-fixture', startedAt: '2026-01-01', finishedAt: '2026-01-01',
      tasks: [{ issueId: 'task-a', outcome: 'failed', branch: 'task/task-a', pushed: false,
        diffLines: 3, error: 'write-guard admission refused: stale installation' }] });
    assert.match(report, /not pushed — see error below/);
    assert.match(report, /stale installation/);
    assert.doesNotMatch(report, /no commits/);
    const empty = renderReport({ runId: 'empty', tasks: [{ issueId: 'empty', outcome: 'failed',
      branch: 'task/empty', pushed: false }] });
    assert.match(empty, /not pushed — no commits/);
  });
}

main().catch((error) => { failures += 1; console.error(error); }).finally(() => {
  process.env = oldEnv;
  fs.rmSync(temp, { recursive: true, force: true });
  process.exitCode = failures ? 1 : 0;
});
