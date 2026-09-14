// Frozen acceptance test — repo-djf.32: isolate docs-agent side effects.
//
// CRITERION PAIRING
// C1: docs executes in a disposable workspace from the verified implementation and
//     only its allowed Markdown delta reaches the task branch.
// C2: ignored/untracked docs runtime files never reach final verification or publish.
// C3: final verification sees the exact transferred delta from a clean state, while a
//     lock leaked by that verifier rejects docs and restores original evidence.
// C4: non-Markdown, symlink, inspection, docs, and final-verifier failures preserve
//     the verified implementation and its evidence.
// C5: cleanup removes only the disposable docs workspace, never task or host state.
'use strict';

const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ENTRYPOINT = path.join(ROOT, 'pipeline', 'entrypoint.sh');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-djf32-'));
const SHELL = process.env.ACCEPTANCE_BASH || (process.platform === 'win32'
  && fs.existsSync('C:/Program Files/Git/bin/bash.exe') ? 'C:/Program Files/Git/bin/bash.exe' : 'bash');
let failed = 0;
function check(name, ok, detail = '') { console.log(`${ok ? 'ok' : 'FAIL'} - ${name}${ok || !detail ? '' : ` — ${detail}`}`); if (!ok) failed = 1; }
function write(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
function run(cmd, args, cwd, env = {}) { return cp.spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 30000, env: { ...process.env, GIT_CONFIG_COUNT: '0', ...env } }); }
function git(dir, ...args) { const r = run('git', args, dir); return r.status === 0 ? r.stdout.trim() : null; }
function exists(p) { return fs.existsSync(p) || fs.lstatSync(p, { throwIfNoEntry: false }) !== undefined; }

// The tiny deterministic pipeline seam records every verifier observation. It makes
// "clean" observable: a final verifier rejects seeing a docs-agent runtime artifact.
function installPipeline(pipe) {
  write(path.join(pipe, 'status.js'), `
const fs=require('fs'),p=require('path'),r=process.env.WORKSPACE+'/.run',f=r+'/status.json';
const load=()=>JSON.parse(fs.readFileSync(f)); const save=x=>fs.writeFileSync(f,JSON.stringify(x));
const [,,c,...a]=process.argv; fs.mkdirSync(r,{recursive:true});
if(c==='init'){if(!fs.existsSync(f))save({issueId:a[0],attempts:[]});}
else if(c==='attempts')console.log(load().attempts.length);
else if(c==='append'){const x=load();x.attempts.push({verifierResult:a[0]});save(x);}
else if(c==='set'){const x=load();x[a[0]]=a[1];save(x);}
else if(c==='summary'){const x=load();x.changeSummary=fs.readFileSync(a[0],'utf8').trim();save(x);}
`);
  write(path.join(pipe, 'envelope.js'), 'exports.parse=()=>null;\n');
  write(path.join(pipe, 'verify.js'), `
const fs=require('fs'),p=require('path'); const w=process.env.WORKSPACE, r=p.join(w,'.run');
const n=+(fs.existsSync(p.join(r,'verify-count'))?fs.readFileSync(p.join(r,'verify-count'),'utf8'):0)+1;
fs.writeFileSync(p.join(r,'verify-count'),String(n));
const bad=['runs','locks','observer'].filter(x=>fs.existsSync(p.join(w,x)));
fs.appendFileSync(process.env.OBSERVE,JSON.stringify({n,w,bad,readme:fs.existsSync(p.join(w,'README.md'))?fs.readFileSync(p.join(w,'README.md'),'utf8'):''})+'\\n');
if(n>1 && process.env.FINAL_LEAK==='1') fs.mkdirSync(p.join(w,'locks'),{recursive:true});
const fail=n>1 && (bad.length || process.env.FINAL_FAIL==='1' || (process.env.FINAL_LEAK==='1'));
fs.writeFileSync(p.join(r,'verify.json'),JSON.stringify({acceptance:fail?'fail':'pass',regressions:'pass',marker:n===1?'original':'final'})); process.exit(fail?1:0);
`);
}
function installAgent(file) { write(file, `
const fs=require('fs'),p=require('path'); const prompt=fs.readFileSync(0,'utf8'), w=process.cwd(), mode=process.env.DOCS_MODE||'ok';
if(!prompt.includes('change summary')) { fs.writeFileSync('out.txt','verified implementation\\n'); process.exit(0); }
fs.writeFileSync(process.env.DOCS_PWD,w); if(mode==='fail')process.exit(7);
if(mode==='source')fs.writeFileSync('source.txt','bad\\n');
else if(mode==='symlink')fs.symlinkSync('README.md','docs-link.md');
else if(mode==='inspect') { fs.renameSync('.git','.git-inspection-failed'); }
else { fs.writeFileSync('README.md','docs delta '+mode+'\\n'); fs.mkdirSync('runs',{recursive:true}); fs.mkdirSync('locks',{recursive:true}); fs.writeFileSync('runs/observer.json','runtime'); fs.writeFileSync('locks/docs.lock','runtime'); }
console.log('docs summary');
`); }
function fixture(name, mode, extra = {}) {
  const base = path.join(tmp, name), task = path.join(base, 'task'), pipe = path.join(base, 'pipe');
  fs.mkdirSync(task, { recursive: true });
  git(task, 'init', '-b', 'main'); git(task, 'config', 'user.email', 'a@b.c'); git(task, 'config', 'user.name', 'fixture');
  write(path.join(task, '.gitignore'), 'runs/\nlocks/\nobserver/\n'); write(path.join(task, 'pipeline.config.json'), '{}\n');
  write(path.join(task, '.run', 'issue.md'), 'fixture issue\n'); git(task, 'add', '-A'); git(task, 'commit', '-m', 'base'); git(task, 'checkout', '-b', 'task/djf32');
  installPipeline(pipe); const agent = path.join(base, 'agent.js'); installAgent(agent);
  const observe = path.join(base, 'observed.jsonl'), docsPwd = path.join(base, 'docs-pwd'); const host = path.join(base, 'host-sentinel'); write(host, 'host stays\n');
  const result = run(SHELL, [ENTRYPOINT], task, { WORKSPACE: task, ISSUE_ID: 'repo-djf.32', PIPELINE_DIR: pipe,
    PIPELINE_AGENT_CMD: `node "${agent.replace(/\\\\/g, '/')}"`, DOCS_MODE: mode, OBSERVE: observe, DOCS_PWD: docsPwd, ...extra });
  const observations = fs.existsSync(observe) ? fs.readFileSync(observe, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const status = JSON.parse(fs.readFileSync(path.join(task, '.run', 'status.json'), 'utf8'));
  const evidence = JSON.parse(fs.readFileSync(path.join(task, '.run', 'verify.json'), 'utf8'));
  return { base, task, host, docsPwd: fs.existsSync(docsPwd) ? fs.readFileSync(docsPwd, 'utf8') : '', result, observations, status, evidence,
    head: git(task, 'rev-parse', 'HEAD'), tracked: git(task, 'ls-files'), statusPorcelain: git(task, 'status', '--porcelain') };
}
function preserved(x) { return x.result.status === 0 && x.head && /implementation \(verified/.test(git(x.task, 'log', '-1', '--format=%s') || '') && x.evidence.marker === 'original'; }

try {
  const clean = fixture('clean', 'ok');
  const docsWorkspace = path.resolve(clean.docsPwd || '.');
  check('C1 docs agent runs outside the task workspace in a disposable Git workspace based on verified implementation',
    clean.docsPwd && docsWorkspace !== path.resolve(clean.task) && !fs.existsSync(docsWorkspace), JSON.stringify({ task: clean.task, docs: clean.docsPwd }));
  check('C1 only the allowed Markdown delta is transferred and committed on the publishable task branch',
    clean.result.status === 0 && /Task repo-djf.32: docs/.test(git(clean.task, 'log', '-1', '--format=%s') || '')
      && /^docs delta ok\n$/.test(fs.readFileSync(path.join(clean.task, 'README.md'), 'utf8'))
      && !/runs\/observer|locks\/docs/.test(clean.tracked || ''), clean.tracked);
  check('C2 ignored docs-agent runs, locks, and observer files are absent from final verifier observations and the published branch',
    clean.observations.length >= 2 && clean.observations.at(-1).bad.length === 0
      && !fs.readdirSync(clean.task).some(n => /^(runs|locks|observer)$/.test(n)), JSON.stringify(clean.observations));
  check('C5 cleanup removes only docs workspace while preserving the task workspace and unrelated host sentinel',
    fs.existsSync(clean.task) && fs.readFileSync(clean.host, 'utf8') === 'host stays\n' && !fs.existsSync(docsWorkspace));

  const leak = fixture('leak', 'leak', { FINAL_LEAK: '1' });
  check('C3 final verification runs the exact transferred Markdown delta from clean state and a verifier-created lock rejects docs',
    leak.observations.length >= 2 && leak.observations.at(-1).bad.length === 0 && preserved(leak)
      && !fs.existsSync(path.join(leak.task, 'README.md')) && !exists(path.join(leak.task, 'locks')), JSON.stringify({ observations: leak.observations, evidence: leak.evidence, status: leak.status }));

  for (const mode of ['source', 'symlink', 'inspect', 'fail']) {
    const row = fixture(`reject-${mode}`, mode);
    check(`C4 ${mode} docs failure preserves verified implementation, branch tip, and original evidence exactly`,
      preserved(row) && !fs.existsSync(path.join(row.task, 'README.md')) && row.status.docsPhaseError, JSON.stringify({ status: row.status, evidence: row.evidence, git: row.statusPorcelain }));
  }
  const finalFail = fixture('reject-final', 'ok', { FINAL_FAIL: '1' });
  check('C4 final-verifier failure preserves verified implementation and existing verifier evidence exactly',
    preserved(finalFail) && !fs.existsSync(path.join(finalFail.task, 'README.md')) && finalFail.status.docsPhaseError, JSON.stringify({ status: finalFail.status, evidence: finalFail.evidence }));
} catch (error) { check('C1-C5 harness completes', false, error && error.stack || String(error)); }
finally { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {} }
process.exit(failed);
