// Frozen acceptance test — repo-djf.10: the nobody verifier can inspect /workspace.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const entrypoint = fs.readFileSync(path.join(REPO, 'pipeline', 'entrypoint.sh'), 'utf8');
let failed = 0;

function check(name, yes, detail = '') {
  console.log(`${yes ? 'ok' : 'FAIL'} - ${name}${yes || !detail ? '' : ` — ${detail}`}`);
  if (!yes) failed = 1;
}

const fnStart = entrypoint.indexOf('run_verifier() {');
const fnEndMarker = '\n}\n\n# A successful implementation commit';
const fnEnd = entrypoint.indexOf(fnEndMarker, fnStart);
const verifierFn = fnStart >= 0 && fnEnd >= 0
  ? entrypoint.slice(fnStart, fnEnd + 2) : '';

check('C1 run_verifier still delegates ChatGPT verification to nobody',
  /runuser -u nobody -- env/.test(verifierFn));
check('C1 the verifier receives one process-scoped Git config entry for exactly /workspace',
  /GIT_CONFIG_COUNT=1/.test(verifierFn)
    && /GIT_CONFIG_KEY_0=safe\.directory/.test(verifierFn)
    && /GIT_CONFIG_VALUE_0="?\$WS"?/.test(verifierFn), verifierFn);
check('C1 the same invocation removes every Codex credential/cache variable',
  /-u CODEX_API_KEY/.test(verifierFn)
    && /-u OPENAI_API_KEY/.test(verifierFn)
    && /-u CODEX_HOME/.test(verifierFn));
check('C2 verifier trust is neither wildcard nor persisted through git config',
  !/safe\.directory\s*=\s*\*/.test(verifierFn)
    && !/git\s+config\s+--global/.test(verifierFn));

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...opts });
}

// The formal freeze gate runs this suite as root in the pinned Linux task image. Keep the
// source directly runnable on a Windows planning host as well; the structural assertions above
// remain red there until the implementation exists, while the ownership proof runs in the gate.
const linuxRoot = process.platform !== 'win32'
  && typeof process.getuid === 'function' && process.getuid() === 0;
if (linuxRoot) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-owner-'));
  const ws = path.join(root, 'workspace');
  const pipe = path.join(root, 'pipeline');
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(pipe, { recursive: true });
  fs.chmodSync(root, 0o755);
  fs.chmodSync(pipe, 0o755);
  fs.mkdirSync(path.join(ws, '.run'), { recursive: true });
  run('git', ['init', '-q', '-b', 'main'], { cwd: ws });
  run('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: ws });
  run('git', ['config', 'user.name', 'fixture'], { cwd: ws });
  fs.writeFileSync(path.join(ws, 'README.md'), 'fixture\n');
  run('git', ['add', 'README.md'], { cwd: ws });
  run('git', ['commit', '-qm', 'fixture'], { cwd: ws });
  fs.chmodSync(ws, 0o777);
  fs.chmodSync(path.join(ws, '.run'), 0o777);

  const bare = run('runuser', ['-u', 'nobody', '--', 'git', '-C', ws, 'status', '--short']);
  check('C2 the deterministic fixture reproduces Git dubious-ownership without scoped trust',
    bare.status !== 0 && /dubious ownership|safe\.directory/i.test(`${bare.stdout}${bare.stderr}`));

  fs.writeFileSync(path.join(pipe, 'verify.js'), [
    "'use strict';",
    "const fs = require('fs');",
    "const path = require('path');",
    "const { spawnSync } = require('child_process');",
    "const ws = process.env.WORKSPACE;",
    "const child = spawnSync('sh', ['-c', 'test \"$GIT_CONFIG_COUNT\" = 1 && test \"$GIT_CONFIG_KEY_0\" = safe.directory && test \"$GIT_CONFIG_VALUE_0\" = \"$WORKSPACE\" && git status --short && git merge-base HEAD HEAD'], { cwd: ws, encoding: 'utf8', env: process.env });",
    "const result = { uid: process.getuid(), count: process.env.GIT_CONFIG_COUNT, key: process.env.GIT_CONFIG_KEY_0, value: process.env.GIT_CONFIG_VALUE_0, codexKey: process.env.CODEX_API_KEY, openaiKey: process.env.OPENAI_API_KEY, codexHome: process.env.CODEX_HOME, childStatus: child.status, childText: (child.stdout || '') + (child.stderr || '') };",
    "fs.writeFileSync(path.join(ws, '.run', 'ownership-probe.json'), JSON.stringify(result));",
    "process.exit(child.status === 0 ? 0 : 7);",
    '',
  ].join('\n'));

  const q = (value) => `'${String(value).replace(/'/g, `'"'"'`)}'`;
  const driver = path.join(root, 'driver.sh');
  fs.writeFileSync(driver, [
    '#!/bin/sh',
    'set -u',
    `WS=${q(ws)}`,
    `PIPE=${q(pipe)}`,
    'PIPELINE_CHATGPT_AUTH=1',
    'WORKSPACE="$WS"',
    'CODEX_API_KEY=must-not-reach-verifier',
    'OPENAI_API_KEY=must-not-reach-verifier',
    'CODEX_HOME=/must-not-reach-verifier',
    'export WORKSPACE CODEX_API_KEY OPENAI_API_KEY CODEX_HOME',
    verifierFn,
    'run_verifier',
    '',
  ].join('\n'));
  const driven = run('sh', [driver]);
  let proof = {};
  try { proof = JSON.parse(fs.readFileSync(path.join(ws, '.run', 'ownership-probe.json'), 'utf8')); }
  catch { /* assertion below reports the missing evidence */ }

  check('C2 run_verifier lets nobody read the differently owned Git workspace',
    driven.status === 0 && proof.uid === 65534 && proof.childStatus === 0,
    `${driven.status}: ${driven.stdout || ''}${driven.stderr || ''}${JSON.stringify(proof)}`);
  check('C3 the scoped trust and credential removal reach verifier subprocesses',
    proof.count === '1' && proof.key === 'safe.directory' && proof.value === ws
      && proof.codexKey === undefined && proof.openaiKey === undefined
      && proof.codexHome === undefined && /^[0-9a-f]{40}\s*$/m.test(proof.childText || ''),
    JSON.stringify(proof));
  fs.rmSync(root, { recursive: true, force: true });
} else {
  check('C2 Linux ownership fixture is exercised by the formal task-image gate', true);
  check('C3 verifier subprocess inheritance is exercised by the formal task-image gate', true);
}

process.exitCode = failed;
