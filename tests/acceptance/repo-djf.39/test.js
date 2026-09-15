// Acceptance suite — repo-djf.39: traversable and outcome-honest docs workspace.
'use strict';

const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ENTRYPOINT = path.join(ROOT, 'pipeline', 'entrypoint.sh');
const SHELL = process.env.ACCEPTANCE_BASH || (process.platform === 'win32'
  && fs.existsSync('C:/Program Files/Git/bin/bash.exe')
  ? 'C:/Program Files/Git/bin/bash.exe' : 'bash');
const IMPLEMENTATION_SUMMARY = 'Implemented the verified conveyor repair.';
const DOCS_SUMMARY = 'Documented the verified conveyor repair.';
const PERMISSION_REMEDY = 'Please authorize restoring traverse permission on the docs workspace.';
const DOCS_ERROR = 'docs identity could not enter its disposable workspace';
let failed = 0;

function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok' : 'FAIL'} - ${name}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failed = 1;
}
function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
function run(cmd, args, cwd, env = {}, timeout = 45000) {
  return cp.spawnSync(cmd, args, {
    cwd, encoding: 'utf8', timeout,
    env: { ...process.env, GIT_CONFIG_COUNT: '0', ...env },
  });
}
function git(dir, ...args) {
  const r = run('git', args, dir);
  return r.status === 0 ? String(r.stdout || '').trim() : null;
}
function quote(value) { return `'${String(value).replace(/'/g, `'\\''`)}'`; }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }

// The docs failure is evidence about a successful implementation, not a new task outcome.
// It must nevertheless be first-class in every artifact a reviewer actually reads.
const runSchema = readJson(path.join(ROOT, 'schemas', 'run.schema.json'));
const taskProperties = runSchema && runSchema.properties && runSchema.properties.tasks
  && runSchema.properties.tasks.items && runSchema.properties.tasks.items.properties;
check('C1 run manifest admits optional per-task docsPhaseError evidence',
  taskProperties && taskProperties.docsPhaseError
    && taskProperties.docsPhaseError.type === 'string'
    && !(runSchema.properties.tasks.items.required || []).includes('docsPhaseError'),
  JSON.stringify(taskProperties && taskProperties.docsPhaseError));

const { renderReport } = require(path.join(ROOT, 'runner', 'report.js'));
const { buildPrBody, PR_ELIGIBLE_OUTCOMES } = require(path.join(ROOT, 'runner', 'publish.js'));
const statusWithDocsFailure = {
  changeSummary: IMPLEMENTATION_SUMMARY,
  docsPhaseError: DOCS_ERROR,
  attempts: [{ number: 1, verifierResult: 'pass', timestamp: '2026-09-15T00:00:00.000Z' }],
};
const body = buildPrBody({
  issueMarkdown: '# fixture', status: statusWithDocsFailure,
  verify: { acceptance: 'pass', regressions: 'pass' },
  outcome: { status: 'done' }, branch: 'task/repo-djf.39', runId: 'run-djf39',
});
const taskRow = {
  issueId: 'repo-djf.39', title: 'fixture', outcome: 'done',
  changeSummary: IMPLEMENTATION_SUMMARY, docsPhaseError: DOCS_ERROR,
  verification: { acceptance: 'pass', regressions: 'pass' }, attemptNotes: [],
};
const report = renderReport({
  runId: 'run-djf39', startedAt: '2026-09-15T00:00:00.000Z',
  finishedAt: '2026-09-15T00:01:00.000Z', tasks: [taskRow],
});
check('C1 PR body prominently qualifies done with the exact docs failure and keeps the implementation summary',
  body.includes(DOCS_ERROR) && body.includes(IMPLEMENTATION_SUMMARY)
    && /doc(?:s|umentation).{0,40}(?:fail|error|warning)/is.test(body),
  body.slice(0, 600));
check('C1 run report prominently qualifies done with the exact docs failure and keeps the implementation summary',
  report.includes(DOCS_ERROR) && report.includes(IMPLEMENTATION_SUMMARY)
    && /doc(?:s|umentation).{0,40}(?:fail|error|warning)/is.test(report),
  report.slice(0, 800));
check('C1 verified done remains publishable while its docs failure is explicit evidence',
  PR_ELIGIBLE_OUTCOMES.has('done'));

const runSource = fs.readFileSync(path.join(ROOT, 'runner', 'run.js'), 'utf8');
const rowStart = runSource.indexOf('const row = {');
const rowEnd = rowStart < 0 ? -1 : runSource.indexOf('\n  };', rowStart);
const rowSource = rowStart >= 0 && rowEnd > rowStart ? runSource.slice(rowStart, rowEnd) : '';
check('C1 host copies status.docsPhaseError explicitly onto the durable task row',
  /status[^\n]*docsPhaseError|docsPhaseError[^\n]*status/.test(rowSource),
  rowSource.slice(0, 900));

const entrypointSource = fs.readFileSync(ENTRYPOINT, 'utf8');
const docsStart = entrypointSource.indexOf('# ---- docs phase');
const docsEnd = docsStart < 0 ? -1 : entrypointSource.indexOf('exit 0 ;;', docsStart);
const docsSource = docsStart >= 0 && docsEnd > docsStart
  ? entrypointSource.slice(docsStart, docsEnd) : '';
const activeDocsLines = docsSource.split(/\r?\n/).map(line => line.trim())
  .filter(line => line && !line.startsWith('#'));
const unsafePermissionLines = activeDocsLines.filter(line => /\b(?:chmod|chown)\b/.test(line)
  && /(?:\/tmp(?:\/|\s|["'])|\$WS\b|\/workspace\b|pipeline-auth-host|\.codex)/.test(line));
check('C2 docs permission preparation never broadens /tmp, the task checkout, or authentication storage',
  unsafePermissionLines.length === 0, unsafePermissionLines.join(' | '));
check('C2 cleanup remains pinned to the exact allocated root/worktree relationship',
  /\[\s*"\$DOCS_ROOT"\s*!=\s*"\/"\s*\]/.test(entrypointSource)
    && /\[\s*"\$DOCS_WORKTREE"\s*=\s*"\$DOCS_ROOT\/worktree"\s*\]/.test(entrypointSource),
  'exact cleanup identity guards absent');

function installPipeline(pipe) {
  fs.mkdirSync(pipe, { recursive: true });
  for (const file of ['status.js', 'envelope.js']) {
    fs.copyFileSync(path.join(ROOT, 'pipeline', file), path.join(pipe, file));
  }
  write(path.join(pipe, 'verify.js'), `
'use strict';
const fs=require('fs'),p=require('path');
const w=process.env.WORKSPACE,r=p.join(w,'.run'),c=p.join(r,'verify-count');
const n=+(fs.existsSync(c)?fs.readFileSync(c,'utf8'):0)+1;
fs.writeFileSync(c,String(n));
const pass=fs.existsSync(p.join(w,'out.txt'));
fs.writeFileSync(p.join(r,'verify.json'),JSON.stringify({acceptance:pass?'pass':'fail',regressions:'pass',marker:n===1?'implementation':'final'}));
process.exit(pass?0:1);
`);
}

function installAgent(file) {
  write(file, `
'use strict';
const fs=require('fs'),p=require('path');
const prompt=fs.readFileSync(0,'utf8'),docs=prompt.includes('Verification for task');
const emit=text=>{process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}})+'\\n');process.stdout.write(JSON.stringify({type:'turn.completed'})+'\\n');};
if(!docs){fs.writeFileSync('out.txt','verified implementation\\n');emit(${JSON.stringify(IMPLEMENTATION_SUMMARY)});process.exit(0);}
const observation={uid:typeof process.getuid==='function'?process.getuid():null,cwd:process.cwd(),mode:process.env.DOCS_MODE};
try{observation.gitFile=fs.readFileSync('.git','utf8').slice(0,80);fs.accessSync('.',fs.constants.R_OK|fs.constants.W_OK);}catch(e){observation.error=e.code||e.message;}
fs.appendFileSync(process.env.DOCS_OBSERVE,JSON.stringify(observation)+'\\n');
if(process.env.DOCS_MODE==='fail')process.exit(7);
if(process.env.DOCS_MODE==='edit'){fs.writeFileSync('README.md','accepted docs delta\\n');emit(${JSON.stringify(DOCS_SUMMARY)});process.exit(0);}
emit(${JSON.stringify(PERMISSION_REMEDY)});
`);
}

function fixture(root, name, mode, unprivileged) {
  const base = path.join(root, name), task = path.join(base, 'task');
  const pipe = path.join(base, 'pipe'), agent = path.join(base, 'agent.js');
  const observe = path.join(base, 'docs-observe.jsonl'), hostSentinel = path.join(base, 'host-sentinel');
  fs.mkdirSync(task, { recursive: true });
  installPipeline(pipe); installAgent(agent); write(hostSentinel, 'untouched\n');
  write(path.join(task, '.gitignore'), '.run/\n');
  write(path.join(task, '.run', 'issue.md'), '# repo-djf.39 fixture\n');
  git(task, 'init', '-b', 'main'); git(task, 'config', 'user.email', 'fixture@example.invalid');
  git(task, 'config', 'user.name', 'fixture'); git(task, 'add', '-A'); git(task, 'commit', '-m', 'base');
  git(task, 'checkout', '-b', `task/${name}`);
  let agentCommand = `${quote(process.execPath)} ${quote(agent)}`;
  let nodeUid = null;
  if (unprivileged) {
    const id = run('id', ['-u', 'node'], base);
    nodeUid = id.status === 0 ? Number(String(id.stdout).trim()) : null;
    const owned = run('chown', ['-R', 'node:node', base], base);
    if (id.status !== 0 || owned.status !== 0) return { setupError: `node/chown unavailable: ${id.stderr || owned.stderr}` };
    agentCommand = `runuser -u node --preserve-environment -- ${agentCommand}`;
  }
  const result = run(SHELL, [ENTRYPOINT], task, {
    WORKSPACE: task, ISSUE_ID: 'repo-djf.39', PIPELINE_DIR: pipe,
    PIPELINE_PROVIDER: 'codex', PIPELINE_AGENT_CMD: agentCommand,
    PIPELINE_TESTING_NESTED_ENTRYPOINT: '1', PIPELINE_MAX_ATTEMPTS: '1',
    DOCS_MODE: mode, DOCS_OBSERVE: observe,
  }, 90000);
  const status = readJson(path.join(task, '.run', 'status.json'));
  const verify = readJson(path.join(task, '.run', 'verify.json'));
  const observations = fs.existsSync(observe)
    ? fs.readFileSync(observe, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse) : [];
  return {
    base, task, hostSentinel, result, status, verify, observations, nodeUid,
    headSubject: git(task, 'log', '-1', '--format=%s'),
  };
}

if (process.platform !== 'linux' || (typeof process.getuid === 'function' && process.getuid() !== 0)) {
  console.log('ok - C3-C5 Linux identity fixtures deferred to the Docker freeze gate');
} else {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-djf39-'));
  try {
    const edit = fixture(tmp, 'unprivileged-edit', 'edit', true);
    const editObs = edit.observations && edit.observations[0];
    const docsWorkspace = editObs && editObs.cwd;
    check('C3 the configured unprivileged docs agent enters, reads, and writes the disposable worktree',
      !edit.setupError && edit.result.status === 0 && editObs && !editObs.error
        && editObs.uid === edit.nodeUid && editObs.gitFile
        && fs.readFileSync(path.join(edit.task, 'README.md'), 'utf8') === 'accepted docs delta\n',
      JSON.stringify({ setupError: edit.setupError, result: edit.result,
        observation: editObs, status: edit.status }));
    check('C3 accepted docs replace the seeded implementation summary only after final verification',
      edit.status && edit.status.changeSummary === DOCS_SUMMARY
        && edit.verify && edit.verify.marker === 'final'
        && /Task repo-djf\.39: docs/.test(edit.headSubject || ''),
      JSON.stringify({ status: edit.status, verify: edit.verify, subject: edit.headSubject }));
    check('C2 cleanup removes only the disposable docs workspace and preserves unrelated/task state',
      docsWorkspace && !fs.existsSync(docsWorkspace) && fs.existsSync(edit.task)
        && fs.readFileSync(edit.hostSentinel, 'utf8') === 'untouched\n', docsWorkspace || 'docs agent did not start');

    const remedy = fixture(tmp, 'zero-exit-remedy', 'remedy', false);
    check('C4 zero-exit permission-remedy prose with no accepted docs delta cannot replace implementation summary',
      remedy.result.status === 0 && remedy.status
        && remedy.status.changeSummary === IMPLEMENTATION_SUMMARY
        && remedy.status.changeSummary !== PERMISSION_REMEDY,
      JSON.stringify({ status: remedy.status, stderr: String(remedy.result.stderr || '').slice(-400) }));

    const docsFail = fixture(tmp, 'docs-agent-fail', 'fail', false);
    check('C4 docs failure is explicit and preserves verified implementation summary and evidence',
      docsFail.result.status === 0 && docsFail.status && docsFail.status.docsPhaseError
        && docsFail.status.changeSummary === IMPLEMENTATION_SUMMARY
        && docsFail.verify && docsFail.verify.marker === 'implementation'
        && /implementation \(verified/.test(docsFail.headSubject || ''),
      JSON.stringify({ status: docsFail.status, verify: docsFail.verify,
        subject: docsFail.headSubject, stderr: String(docsFail.result.stderr || '').slice(-400) }));
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
  }
}

process.exit(failed);
