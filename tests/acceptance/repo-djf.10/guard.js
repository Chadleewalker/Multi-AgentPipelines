// [guard] Frozen acceptance guard — repo-djf.10: verification stays isolated and authoritative.
'use strict';

const fs = require('fs');
const path = require('path');
const REPO = path.resolve(__dirname, '..', '..', '..');
let failed = 0;

function check(name, yes, detail = '') {
  console.log(`${yes ? 'ok' : 'FAIL'} - ${name}${yes || !detail ? '' : ` — ${detail}`}`);
  if (!yes) failed = 1;
}

const entrypoint = fs.readFileSync(path.join(REPO, 'pipeline', 'entrypoint.sh'), 'utf8');
const verify = fs.readFileSync(path.join(REPO, 'pipeline', 'verify.js'), 'utf8');
const publish = fs.readFileSync(path.join(REPO, 'runner', 'publish.js'), 'utf8');
const container = fs.readFileSync(path.join(REPO, 'runner', 'container.js'), 'utf8');

check('C3 [guard] frozen-path tamper detection still precedes acceptance execution',
  verify.indexOf('const tampered = new Set()') >= 0
    && verify.indexOf('const tampered = new Set()') < verify.indexOf('// --- Acceptance run'));
check('C3 [guard] acceptance and regression commands still come from frozen config',
  /config\.verifyCommand/.test(verify) && /config\.regressionCommand/.test(verify)
    && /git\(`show \$\{forkPoint\}:pipeline\.config\.json`\)/.test(verify));
check('C3 [guard] verifier evidence still determines the entrypoint result',
  /run_verifier\s*\n\s*VRC=\$\?/.test(entrypoint)
    && /writeResult\(result, result\.acceptance === 'pass' \? 0 : 1\)/.test(verify));
check('C4 [guard] Codex automatic review and node-user execution are unchanged',
  /--approve-for-me/.test(entrypoint)
    && /runuser -u node --preserve-environment -- env CODEX_HOME=/.test(entrypoint));
check('C4 [guard] Claude retains its historical command',
  entrypoint.includes('AGENT_DEFAULT="claude -p --dangerously-skip-permissions${MODEL_ARG}"'));
check('C4 [guard] task isolation retains the watchdog and forbids host escape options',
  /createDeadlineWatchdog/.test(container)
    && !/['"]--privileged['"]|['"]--cap-add['"]|['"]--pid=host['"]|docker\.sock/.test(container));
check('C4 [guard] publication still requires exact mandatory regression evidence',
  /required regression gate did not pass/.test(publish)
    && /verify\.regressions !== 'pass'/.test(publish));

process.exitCode = failed;
