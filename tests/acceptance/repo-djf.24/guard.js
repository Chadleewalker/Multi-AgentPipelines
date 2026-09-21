// Frozen acceptance [guard] — repo-djf.24: existing single-lane ownership stays process-local.
// PAIRING (criterion -> tests): C1 -> T1; C2 -> T1,T2; C3 -> T1,T3;
// C4 -> T1; C5 -> G1,G2,G3,G4,T1,T4.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const REPO = path.resolve(__dirname, '..', '..', '..');
const auth = require(path.join(REPO, 'runner', 'codex-auth.js'));
let failed = 0;
function check(name, yes, detail = '') {
  console.log(`${yes ? 'ok' : 'FAIL'} - ${name}${yes || !detail ? '' : ` — ${detail}`}`);
  if (!yes) failed = 1;
}
function session(token) {
  return JSON.stringify({ auth_mode: 'chatgpt', tokens: { refresh_token: token } });
}
function safe(value, secrets) {
  let text;
  try { text = JSON.stringify(value); } catch { text = String(value); }
  return !secrets.some((secret) => secret && text.includes(secret));
}
function instrumentProcess() {
  const effects = [];
  const restores = [];
  const stdout = process.stdout;
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(stdout, 'write');
  const stdoutWrite = stdout.write;
  Object.defineProperty(stdout, 'write', {
    configurable: true,
    enumerable: stdoutDescriptor ? stdoutDescriptor.enumerable : false,
    get() { return stdoutWrite; },
    set() { effects.push('stdout.write replaced'); },
  });
  restores.push(() => {
    if (stdoutDescriptor) Object.defineProperty(stdout, 'write', stdoutDescriptor);
    else delete stdout.write;
  });

  function observe(object, method, label) {
    if (!object || typeof object[method] !== 'function') return;
    const descriptor = Object.getOwnPropertyDescriptor(object, method);
    const original = object[method];
    Object.defineProperty(object, method, {
      configurable: true,
      enumerable: descriptor ? descriptor.enumerable : false,
      writable: true,
      value(...args) {
        if (/[\\/]runner[\\/]/i.test(String(new Error().stack || ''))) effects.push(label);
        return original.apply(this, args);
      },
    });
    restores.push(() => {
      if (descriptor) Object.defineProperty(object, method, descriptor);
      else delete object[method];
    });
  }
  observe(process.stdin, 'read', 'stdin read');
  observe(process.stdin, 'emit', 'stdin emit');
  for (const [name, stream] of [['stdin', process.stdin], ['stdout', stdout], ['stderr', process.stderr]]) {
    observe(stream, 'pause', `${name} paused`);
    observe(stream, 'unref', `${name} unrefed`);
  }
  const originalSetInterval = global.setInterval;
  global.setInterval = (...args) => {
    if (/[\\/]runner[\\/]/i.test(String(new Error().stack || ''))) {
      effects.push('keepalive interval installed');
    }
    return originalSetInterval(...args);
  };
  restores.push(() => { global.setInterval = originalSetInterval; });
  return {
    effects,
    restore() {
      for (const restore of restores.reverse()) {
        try { restore(); } catch {}
      }
    },
  };
}

async function main() {
  const secrets = ['djf24-guard-before', 'djf24-guard-after'];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-djf24-guard-'));
  let visible = null;
  let effects = [];
  let removed = false;
  try {
    const lane = path.join(root, 'lane');
    fs.mkdirSync(lane, { recursive: true, mode: 0o700 });
    fs.chmodSync(lane, 0o700);
    fs.writeFileSync(path.join(lane, 'auth.json'), session(secrets[0]), { mode: 0o600 });
    fs.chmodSync(path.join(lane, 'auth.json'), 0o600);
    const probe = instrumentProcess();
    try {
      const pre = await auth.preflight({ mode: 'chatgpt', cacheRoot: lane,
        wait: false, timeoutMs: 20, retryMs: 2 });
      const handle = await auth.stageTaskCache({ cacheRoot: lane, taskId: 'guard-owner',
        wait: false, timeoutMs: 20, retryMs: 2 });
      fs.writeFileSync(path.join(handle.hostPath, 'auth.json'), '{ invalid refresh');
      let refreshError = null;
      try { await auth.releaseTaskCache(handle); } catch (error) { refreshError = error; }
      fs.writeFileSync(path.join(handle.hostPath, 'auth.json'), session(secrets[1]));
      await auth.releaseTaskCache(handle);
      visible = { pre, refreshError: refreshError && refreshError.message };
    } finally {
      effects = [...probe.effects];
      probe.restore();
    }
    check('G1 C5 [guard] existing credential ownership neither replaces stdout nor touches process streams or caller keepalive',
      effects.length === 0,
      JSON.stringify({ effects }));

    const project = JSON.parse(fs.readFileSync(path.join(REPO, 'pipeline.config.json'), 'utf8'));
    const regression = String(project.regressionCommand || '').trim().split(/\s+/).pop();
    check('G2 C5 [guard] the required mandatory profile remains the project regression command',
      project.regressionPolicy === 'required' && !!regression
        && fs.existsSync(path.resolve(REPO, regression.replace(/^[\'\"]|[\'\"]$/g, ''))),
      JSON.stringify({ policy: project.regressionPolicy, command: project.regressionCommand }));

    check('G3 C5 [guard] existing ownership errors disclose no credential and leave no lane lock or task handoff',
      safe(visible, secrets)
        && !fs.existsSync(path.join(lane, '.lane.lock'))
        && (!fs.existsSync(path.join(lane, 'tasks'))
          || fs.readdirSync(path.join(lane, 'tasks')).length === 0),
      JSON.stringify({ safe: safe(visible, secrets), lock: fs.existsSync(path.join(lane, '.lane.lock')) }));
  } catch (error) {
    check('G1-G4 C5 [guard] fork-point fixture completes', false,
      String(error && error.stack || error).replace(/djf24-guard-(before|after)/g, '[redacted]'));
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    removed = !fs.existsSync(root);
  }
  check('G4 C5 [guard] the focused ownership fixture removes its private tree', removed);
  process.exitCode = failed;
}
main().catch((error) => {
  console.error(`FAIL - G1-G4 C5 [guard] fixture settles — ${String(error && error.message || error)}`);
  process.exitCode = 1;
});
