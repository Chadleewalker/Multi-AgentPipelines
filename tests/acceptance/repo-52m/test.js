// Frozen acceptance test — clean contract artifacts from agent CLI noise
// (DESIGN.md §4.3, §4.11, §4.5). Written before implementation; criteria E1–E6 of
// the approved spec. Plain Node, Docker-free. The behavioral run (E4) uses a stub
// verify.js — NEVER the real verifier, which would re-invoke the acceptance runner
// from inside it and self-nest. Every spawned status.js sets RUN_DIR explicitly.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) failed = 1;
}
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

const CLEAN = 'Implements the change cleanly across the entrypoint and helpers.';
const WARNING = 'Ignoring 18 permissions.allow entries: this workspace has not been trusted.';
const ENVELOPE = JSON.stringify({ is_error: false, result: CLEAN, modelUsage: { 'claude-opus-5': {} } });

// ---- E1: envelope.parse ----
let envelope = null;
try { envelope = require(path.join(ROOT, 'pipeline', 'envelope.js')); } catch { /* fails below */ }
check('E1 pipeline/envelope.js is requirable', envelope !== null);
check('E1 parse is exported', envelope !== null && typeof envelope.parse === 'function');
if (envelope && typeof envelope.parse === 'function') {
  const r1 = envelope.parse(`${WARNING}\n${ENVELOPE}\n`);
  check('E1 warning+envelope -> result extracted', r1 !== null && r1.result === CLEAN);
  check('E1 warning+envelope -> model extracted', r1 !== null && r1.model === 'claude-opus-5');
  const r2 = envelope.parse(`${ENVELOPE}\n`);
  check('E1 envelope alone -> same result', r2 !== null && r2.result === CLEAN && r2.model === 'claude-opus-5');
  check('E1 no JSON line -> null', envelope.parse('just some prose\nand more prose\n') === null);
  check('E1 non-string result -> null', envelope.parse('{"result": 42}\n') === null);
}

// ---- E2: envelope.js flatten CLI ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-noise-'));
const ENV_JS = path.join(ROOT, 'pipeline', 'envelope.js');
function flatten(file) {
  return spawnSync(process.execPath, [ENV_JS, 'flatten', file], { encoding: 'utf8' });
}
const f1 = path.join(tmp, 'log1.txt');
fs.writeFileSync(f1, `${WARNING}\n${ENVELOPE}\n`);
const r1 = flatten(f1);
check('E2 flatten exits 0', r1.status === 0);
check('E2 flatten rewrites file to the result', read(f1) !== null && read(f1).trim() === CLEAN);
check('E2 flatten prints the model', (r1.stdout || '').trim() === 'claude-opus-5');
const f2 = path.join(tmp, 'log2.txt');
const PLAIN = 'plain text output, no envelope here\n';
fs.writeFileSync(f2, PLAIN);
const r2 = flatten(f2);
check('E2 plain text: exit 0, file untouched, nothing printed',
  r2.status === 0 && read(f2) === PLAIN && (r2.stdout || '').trim() === '');

// ---- E3 + E6: status.js summary (explicit RUN_DIR on every spawn) ----
const STATUS_JS = path.join(ROOT, 'pipeline', 'status.js');
function statusCmd(runDir, args) {
  return spawnSync(process.execPath, [STATUS_JS, ...args],
    { encoding: 'utf8', env: { ...process.env, RUN_DIR: runDir } });
}
const rd = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-noise-rd-'));
statusCmd(rd, ['init', 'test-noise']);
const st = () => JSON.parse(read(path.join(rd, 'status.json')));

const envFile = path.join(tmp, 'docs-env.txt');
fs.writeFileSync(envFile, `${WARNING}\n${ENVELOPE}\n`);
statusCmd(rd, ['summary', envFile]);
check('E3 envelope file -> changeSummary is exactly the result', st().changeSummary === CLEAN);

const txtFile = path.join(tmp, 'docs-txt.txt');
fs.writeFileSync(txtFile, '  A short plain summary.  \n');
statusCmd(rd, ['summary', txtFile]);
check('E3 plain-text file -> trimmed text', st().changeSummary === 'A short plain summary.');

const longFile = path.join(tmp, 'docs-long.txt');
fs.writeFileSync(longFile, 'x'.repeat(1000) + 'y'.repeat(2000));
statusCmd(rd, ['summary', longFile]);
check('E3 3000 chars -> last 2000 kept', st().changeSummary === 'y'.repeat(2000));

const emptyFile = path.join(tmp, 'docs-empty.txt');
fs.writeFileSync(emptyFile, '');
const before = st().changeSummary;
const rEmpty = statusCmd(rd, ['summary', emptyFile]);
check('E3 empty file -> exit 0, changeSummary unchanged',
  rEmpty.status === 0 && st().changeSummary === before);

const rdMissing = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-noise-miss-'));
const rMiss = statusCmd(rdMissing, ['summary', envFile]);
check('E3 no status.json -> exit non-zero', rMiss.status !== 0);

statusCmd(rd, ['note', 'a note after summary']);
const stFinal = st();
check('E6 note still appends after summary',
  Array.isArray(stFinal.memoryNotes) && stFinal.memoryNotes.includes('a note after summary'));
check('E6 changeSummary unchanged by note', stFinal.changeSummary === before);

// ---- E5: source-line assertions on the two agent invocations ----
const epSrc = read(path.join(ROOT, 'pipeline', 'entrypoint.sh')) || '';
const nonComment = epSrc.split('\n').filter((l) => !/^\s*#/.test(l));
const docsLine = nonComment.find((l) => l.includes('docs-out.txt') && l.includes('sh -c'));
const codeLine = nonComment.find((l) => l.includes('agent-$N.log') && l.includes('sh -c'));
check('E5 docs invocation line exists', docsLine !== undefined);
check('E5 docs invocation does NOT merge stderr (no 2>&1)',
  docsLine !== undefined && !docsLine.includes('2>&1'));
check('E5 code invocation still merges stderr (2>&1)',
  codeLine !== undefined && codeLine.includes('2>&1'));

// ---- E4: behavioral run of the entrypoint ----
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-noise-e4-'));
const ws = path.join(base, 'ws');
const home = path.join(base, 'home');
const pipe = path.join(base, 'pipe');
fs.mkdirSync(path.join(ws, '.run'), { recursive: true });
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(pipe, { recursive: true });

// Temp PIPELINE_DIR: the real status.js + envelope.js, a stub verify.js (exit 0).
for (const f of ['status.js', 'envelope.js']) {
  const src = read(path.join(ROOT, 'pipeline', f));
  if (src !== null) fs.writeFileSync(path.join(pipe, f), src);
}
fs.writeFileSync(path.join(pipe, 'verify.js'), 'process.exit(0);\n');

// Workspace: a real git repo with one commit and the issue export.
const git = (args) => spawnSync('git', args, { cwd: ws, encoding: 'utf8', env: { ...process.env, HOME: home } });
git(['init', '-q']);
git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'seed']);
fs.writeFileSync(path.join(ws, '.run', 'issue.md'), '# test-noise: behavioral fixture\n');

// Pre-existing Claude config the seed must not clobber.
fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ existingKey: true }) + '\n');

// Agent stub: warning + envelope on stdout, a marker on stderr. Runs for both phases.
const agentStub = path.join(base, 'agent-stub.sh');
fs.writeFileSync(agentStub, [
  '#!/bin/sh',
  'cat > /dev/null',
  `echo '${WARNING}'`,
  `echo '${ENVELOPE.replace(/'/g, "'\\''")}'`,
  'echo STDERR-MARKER-e4 >&2',
  '',
].join('\n'));
fs.chmodSync(agentStub, 0o755);

const DUMMY_TOKEN = 'dummy-token-must-never-appear-abc123';
const run = spawnSync('bash', [path.join(ROOT, 'pipeline', 'entrypoint.sh')], {
  encoding: 'utf8',
  timeout: 120000,
  env: {
    PATH: process.env.PATH,
    HOME: home,
    WORKSPACE: ws,
    PIPELINE_DIR: pipe,
    ISSUE_ID: 'test-noise',
    PIPELINE_AGENT_CMD: `sh ${agentStub}`,
    CLAUDE_CODE_OAUTH_TOKEN: DUMMY_TOKEN,
  },
});
check('E4 entrypoint exits 0', run.status === 0);
const e4status = (() => { try { return JSON.parse(read(path.join(ws, '.run', 'status.json'))); } catch { return {}; } })();
check('E4 changeSummary is exactly the clean result (no warning text)',
  e4status.changeSummary === CLEAN);
const docsErr = read(path.join(ws, '.run', 'docs-err.txt'));
const docsOut = read(path.join(ws, '.run', 'docs-out.txt')) || '';
check('E4 docs-err.txt exists with the stderr marker',
  docsErr !== null && docsErr.includes('STDERR-MARKER-e4'));
check('E4 docs-out.txt does not contain the stderr marker', !docsOut.includes('STDERR-MARKER-e4'));
const claudeJsonRaw = read(path.join(home, '.claude.json')) || '';
const claudeJson = (() => { try { return JSON.parse(claudeJsonRaw); } catch { return {}; } })();
check('E4 existing .claude.json key survives the seed', claudeJson.existingKey === true);
const projects = claudeJson.projects || {};
check('E4 workspace marked trusted in .claude.json',
  Object.values(projects).some((p) => p && p.hasTrustDialogAccepted === true));
check('E4 token never lands in .claude.json', !claudeJsonRaw.includes(DUMMY_TOKEN));

process.exit(failed);
