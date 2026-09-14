// Frozen acceptance test — repo-djf.33: trust only the detached Codex docs checkout.
//
// CRITERION PAIRING
// C1: production-shaped managed ChatGPT docs runs in exactly the disposable detached
//     worktree with CODEX_API_KEY and OPENAI_API_KEY absent.
// C2: that invocation-local trust cannot authorize another path, the task checkout,
//     or wildcard/persistent host trust.
// C3: its summary and Markdown delta publish, while source, symlink, agent, and final-
//     verifier failures retain the verified implementation and verifier evidence exactly.
// C4: this suite supplies the fork-point trust-refusal regression; guard.js serves the
//     retained mandatory managed-auth, publication-isolation, and credential-hygiene checks.
'use strict';

const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const ENTRYPOINT = path.join(ROOT, 'pipeline', 'entrypoint.sh');
const SHELL = process.env.ACCEPTANCE_BASH || (process.platform === 'win32'
  && fs.existsSync('C:/Program Files/Git/bin/bash.exe') ? 'C:/Program Files/Git/bin/bash.exe' : 'bash');
// The hardened Docker verifier intentionally does not execute generated programs from /tmp.
// Keep the disposable fixture under this repository's ignored runs/ surface instead; it is
// still outside the frozen suite and is removed in finally below.
const fixtureRoot = path.join(ROOT, 'runs');
fs.mkdirSync(fixtureRoot, { recursive: true });
const tmp = fs.mkdtempSync(path.join(fixtureRoot, 'accept-djf33-'));
let failed = 0;
function check(name, yes, detail = '') { console.log(`${yes ? 'ok' : 'FAIL'} - ${name}${yes ? '' : ` — ${detail}`}`); if (!yes) failed = 1; }
function write(file, text, mode) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); if (mode) fs.chmodSync(file, mode); }
function run(cmd, args, cwd, env = {}) { return cp.spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 120000, env }); }
function git(dir, ...args) { const r = run('git', args, dir, { ...process.env, GIT_CONFIG_COUNT: '0' }); return r.status === 0 ? r.stdout.trim() : null; }
function json(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function quote(v) { return `'${String(v).replace(/'/g, "'\\''")}'`; }

function pipeline(pipe) {
  for (const f of ['status.js', 'envelope.js']) fs.copyFileSync(path.join(ROOT, 'pipeline', f), path.join(pipe, f));
  write(path.join(pipe, 'verify.js'), `
const fs=require('fs'),p=require('path'),w=process.env.WORKSPACE,r=p.join(w,'.run');
const n=+(fs.existsSync(p.join(r,'n'))?fs.readFileSync(p.join(r,'n'),'utf8'):0)+1;fs.writeFileSync(p.join(r,'n'),String(n));
if(n>1&&process.env.FINAL_FAIL==='1'){fs.mkdirSync(p.join(w,'locks'),{recursive:true});fs.writeFileSync(p.join(w,'locks','final'),'x');process.exit(1)}
fs.writeFileSync(p.join(r,'verify.json'),JSON.stringify({acceptance:'pass',marker:n===1?'original':'final'}));
`);
}
function shims(bin, trace) {
  const real = name => run(SHELL, ['-lc', `command -v ${name}`], tmp, process.env).stdout.trim();
  const pass = name => write(path.join(bin, name), `#!/bin/sh\ncase "$*" in *'.codex'*|*'pipeline-auth-host'*) exit 0;; esac\nexec ${quote(real(name))} "$@"\n`, 0o755);
  for (const name of ['mkdir', 'cp', 'chmod', 'chown', 'mv']) pass(name);
  write(path.join(bin, 'runuser'), `#!/bin/sh
printf '%s\\n' "$*" >> ${quote(trace)}
while [ "$1" != "--" ] && [ "$#" -gt 0 ]; do shift; done
shift
exec "$@"
`, 0o755);
  write(path.join(bin, 'codex'), `#!/usr/bin/env node
const fs=require('fs'),p=require('path');const a=process.argv.slice(2), prompt=fs.readFileSync(0,'utf8');
const has=(x)=>a.includes(x), docs=prompt.includes('change summary'), exact=p.basename(process.cwd())==='worktree'&&p.basename(p.dirname(process.cwd())).startsWith('pipeline-docs.');
fs.appendFileSync(process.env.CODEX_TRACE,JSON.stringify({cwd:process.cwd(),args:a,docs,api:Object.hasOwn(process.env,'CODEX_API_KEY'),openai:Object.hasOwn(process.env,'OPENAI_API_KEY'),home:process.env.CODEX_HOME})+'\\n');
if(docs&&(!has('--skip-git-repo-check')||!exact)){process.stderr.write('Not inside a trusted directory and --skip-git-repo-check was not specified\\n');process.exit(1)}
if(docs){const m=process.env.DOCS_MODE;if(m==='fail')process.exit(7);if(m==='source')fs.writeFileSync('source.txt','bad\\n');else if(m==='symlink')fs.symlinkSync('README.md','docs-link.md');else fs.writeFileSync('README.md','trusted docs delta\\n');}
process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:docs?'Trusted docs summary.':'implementation'}})+'\\n'+JSON.stringify({type:'turn.completed'})+'\\n');
`, 0o755);
}
function fixture(name, mode, extra = {}) {
  const base=path.join(tmp,name), task=path.join(base,'task'), pipe=path.join(base,'pipe'), bin=path.join(base,'bin');
  fs.mkdirSync(path.join(task,'.run'),{recursive:true});fs.mkdirSync(pipe,{recursive:true});fs.mkdirSync(bin,{recursive:true});
  git(task,'init','-b','main');git(task,'config','user.email','fixture@example.invalid');git(task,'config','user.name','fixture');
  write(path.join(task,'.gitignore'),'locks/\n');write(path.join(task,'.run','issue.md'),'fixture\n');write(path.join(task,'README.md'),'base\n');git(task,'add','-A');git(task,'commit','-m','base');git(task,'checkout','-b','task/djf33');
  pipeline(pipe);const trace=path.join(base,'runuser.log'), codexTrace=path.join(base,'codex.jsonl');shims(bin,trace);
  const fixtureBin=run(SHELL,['-lc',`cygpath -u ${quote(bin)}`],base,process.env).stdout.trim() || bin;
  const env={...process.env,FIXTURE_BIN:fixtureBin,WORKSPACE:task,PIPELINE_DIR:pipe,ISSUE_ID:'repo-djf.33',PIPELINE_PROVIDER:'codex',PIPELINE_CHATGPT_AUTH:'1',PIPELINE_MAX_ATTEMPTS:'1',DOCS_MODE:mode,CODEX_TRACE:codexTrace,...extra};
  delete env.CODEX_API_KEY;delete env.OPENAI_API_KEY;delete env.PIPELINE_AGENT_CMD;delete env.PIPELINE_TESTING_NESTED_ENTRYPOINT;
  const result=run(SHELL,['-c','PATH="$FIXTURE_BIN:$PATH"; export PATH; exec "$1"','bash',ENTRYPOINT],task,env); const traces=fs.existsSync(codexTrace)?fs.readFileSync(codexTrace,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
  const status=json(path.join(task,'.run','status.json')), evidence=json(path.join(task,'.run','verify.json'));
  return {base,task,result,traces,status,evidence,runuser:fs.existsSync(trace)?fs.readFileSync(trace,'utf8'):'',head:git(task,'rev-parse','HEAD')};
}
function preserved(x) { return x.result.status===0 && x.evidence && x.evidence.marker==='original' && !fs.existsSync(path.join(x.task,'README.md')) ? false : x.result.status===0 && x.evidence && x.evidence.marker==='original'; }

try {
  // The mock authorizes only the disposable pipeline-docs/*/worktree shape. At the fork
  // point no flag reaches it, reproducing the actual Codex refusal.
  const clean=fixture('clean','ok');
  const docs=clean.traces.find(x=>x.docs);
  check('C1 managed ChatGPT Codex docs runs from the exact detached worktree without either API-key variable',
    clean.result.status===0 && docs && docs.cwd!==path.resolve(clean.task) && /[\\/]worktree$/.test(docs.cwd)
      && !docs.api && !docs.openai && /\.codex$/.test(docs.home||'') && !/pipeline-auth-host/.test(docs.home||'')
      && docs.args.includes('--skip-git-repo-check'),JSON.stringify({docs,result:clean.result}));
  check('C1 docs worktree is detached, disposable, and cleanup leaves no path behind',
    docs && !fs.existsSync(docs.cwd) && !fs.existsSync(path.dirname(docs.cwd)),JSON.stringify(docs));
  check('C2 the successful trust flag is invocation-local: no persistent or wildcard Codex/Git trust is written',
    clean.result.status===0 && !fs.existsSync(path.join(clean.task,'.codex'))
      && !/safe\.directory.*\*/.test(fs.readFileSync(ENTRYPOINT,'utf8')) && !/config.*skip-git-repo-check/.test(fs.readFileSync(ENTRYPOINT,'utf8')));
  check('C3 successful trusted docs creates the PR summary and transfers only Markdown to the task branch',
    clean.result.status===0 && clean.status && clean.status.changeSummary==='Trusted docs summary.'
      && fs.readFileSync(path.join(clean.task,'README.md'),'utf8')==='trusted docs delta\n' && /Task repo-djf\.33: docs/.test(git(clean.task,'log','-1','--format=%s')||''));

  const refusal=run(SHELL,['-lc',`printf 'change summary' | ${quote(path.join(clean.base,'bin','codex'))} exec`],clean.task,{...process.env,CODEX_TRACE:path.join(clean.base,'negative.jsonl')});
  const wrongPath=run(SHELL,['-lc',`printf 'change summary' | ${quote(path.join(clean.base,'bin','codex'))} exec --skip-git-repo-check`],clean.task,{...process.env,CODEX_TRACE:path.join(clean.base,'wrong-path.jsonl')});
  check('C2 negative control reproduces the real no-flag Codex trust refusal at the fork point',
    refusal.status!==0 && /Not inside a trusted directory and --skip-git-repo-check was not specified/.test(refusal.stderr),refusal.stderr);
  check('C2 even an explicit trust flag cannot authorize the publishable task workspace or another path',
    wrongPath.status!==0 && /Not inside a trusted directory/.test(wrongPath.stderr),wrongPath.stderr);
  for (const mode of ['source','symlink','fail']) {
    const row=fixture(`reject-${mode}`,mode); const original=row.evidence&&row.evidence.marker==='original';
    check(`C3 ${mode} docs rejection preserves verified implementation and original verifier evidence exactly`,
      row.result.status===0 && original && fs.readFileSync(path.join(row.task,'README.md'),'utf8')==='base\n' && row.status&&row.status.docsPhaseError,JSON.stringify(row.status));
  }
  const final=fixture('reject-final','ok',{FINAL_FAIL:'1'});
  check('C3 final-verifier failure preserves verified implementation and original verifier evidence exactly',
    final.result.status===0 && final.evidence&&final.evidence.marker==='original' && fs.readFileSync(path.join(final.task,'README.md'),'utf8')==='base\n' && final.status&&final.status.docsPhaseError,JSON.stringify(final.status));
} catch (e) { check('C1-C4 fixture completes',false,e&&e.stack||String(e)); }
finally { if (!process.env.ACCEPTANCE_KEEP_TMP) try { fs.rmSync(tmp,{recursive:true,force:true,maxRetries:3}); } catch {} }
process.exitCode=failed;
