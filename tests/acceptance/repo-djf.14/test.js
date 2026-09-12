// Frozen acceptance test — repo-djf.14: allow an atomic managed re-freeze of amended suites.
//
// Criterion pairing: C1 is the common-base proof below; C2 is the three-suite fixture and
// dry-run/commit path; C3 is each fail-closed control; C4 is only guard.js.  No check here is
// a guard: this file must be red at the fork point.
'use strict';
const fs = require('fs'); const os = require('os'); const path = require('path');
const { spawnSync } = require('child_process');
const REPO = path.resolve(__dirname, '..', '..', '..');
const prove = require(path.join(REPO, 'scripts', 'prove-tests.js'));
const FREEZE = path.join(REPO, 'scripts', 'freeze.js');
let failed = 0;
function check(name, ok, detail = '') { console.log(`${ok ? 'ok' : 'FAIL'} - ${name}${ok || !detail ? '' : ` — ${detail}`}`); if (!ok) failed = 1; }
function run(cmd, args, o = {}) { return spawnSync(cmd, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024, windowsHide: true, ...o }); }
function git(dir, ...args) { return run('git', ['-c', 'safe.directory=*', ...args], { cwd: dir }); }
function text(r) { return `${r.stdout || ''}${r.stderr || ''}`; }
function head(dir) { return String(git(dir, 'rev-parse', 'HEAD').stdout || '').trim(); }
function write(dir, rel, bytes) { const f = path.join(dir, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, bytes); }
function commit(dir, msg) { git(dir, 'add', '-A'); git(dir, 'commit', '-qm', msg); return head(dir); }
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 }); } catch {} }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-djf14-'));
const IDS = ['repo-djf.14-a', 'repo-djf.14-b', 'repo-djf.14-c'];
function suite(id, generation = 'amended-v2') { return `'use strict';\n// ${id} ${generation}\nconst fs=require('fs'); const path=require('path');\nif(fs.readFileSync(path.join(__dirname,'..','..','..','runner','fixture.js'),'utf8').trim()!=='fixed') process.exit(1);\n`; }
function fixture(name) {
  const root = path.join(tmp, name), bare = path.join(root, 'remote.git'), target = path.join(root, 'target'), author = path.join(root, 'author');
  fs.mkdirSync(root, { recursive: true }); git(root, 'init', '-q', '--bare', '-b', 'main', bare); git(root, 'clone', '-q', bare, target);
  git(target, 'config', 'user.email', 'fixture@example.invalid'); git(target, 'config', 'user.name', 'fixture');
  write(target, 'runner/fixture.js', 'old\n');
  write(target, 'pipeline.config.json', JSON.stringify({ verifyCommand: 'sh tools/run-acceptance.sh', regressionCommand: 'true', regressionPolicy: 'required', defaultBranch: 'main', frozenPaths: ['tools/run-acceptance.sh'] }));
  write(target, 'tools/run-acceptance.sh', '#!/bin/sh\nnode "$1/test.js"\n');
  write(target, 'tests/acceptance/_control/test.js', "'use strict';\n");
  for (const id of IDS.slice(0, 2)) {
    write(target, `tests/acceptance/${id}/test.js`, suite(id, 'frozen-v1'));
    // These must be receipts the dispatch reader accepts.  A malformed stand-in would make C1
    // unreachable: a correct implementation is required to retain malformed receipt bytes.
    write(target, `tests/acceptance/${id}/.freeze-gate.json`, JSON.stringify({ gateVersion: 1, suiteHash: 'a'.repeat(64), verdict: 'red' }));
  }
  commit(target, 'integration'); git(target, 'push', '-q', 'origin', 'main'); git(root, 'clone', '-q', bare, author);
  git(author, 'config', 'user.email', 'fixture@example.invalid'); git(author, 'config', 'user.name', 'fixture');
  for (const id of IDS) write(author, `tests/acceptance/${id}/test.js`, suite(id));
  const config = path.join(root, 'run.json'); fs.writeFileSync(config, JSON.stringify({ targetRepoPath: target, targetRepoRemote: bare, defaultBranch: 'main', image: 'fixture' }));
  return { root, bare, target, author, config, initial: head(target) };
}
function proof(f, id) {
  const built = { id, folder: { dir: f.author }, cfg: { targetRepoPath: f.target, gitTimeoutMs: 30000 }, policy: { frozenPaths: ['tools/run-acceptance.sh'] } };
  const p = prove.prepareProbe(built, 'fixture');
  if (!p.ok) return p;
  write(p.probe, 'runner/fixture.js', 'fixed\n');
  const marker = path.join(p.container, '.pipeline-green-probe.json'); const m = JSON.parse(fs.readFileSync(marker, 'utf8'));
  m.status = 'proven'; m.attempts = 1; m.evidenceHash = '0'.repeat(64); fs.writeFileSync(marker, JSON.stringify(m));
  return { ...p, marker, m };
}
function freeze(f, proofs, dryRun = true) {
  const args = [FREEZE, 'commit', ...IDS, '--config', f.config];
  for (const p of proofs) args.push('--managed-probe', `${p.m.issue}=${p.probe}`);
  if (dryRun) args.push('--dry-run');
  return run(process.execPath, args, {
    cwd: f.root,
    env: {
      ...process.env,
      PIPELINE_TESTING_FREEZE_GATE_SEAM: '1',
      FREEZE_GATE_CMD: 'sh tools/run-acceptance.sh',
    },
  });
}
function sameIndexAndHead(f, before) { return head(f.target) === before && String(git(f.target, 'diff', '--cached', '--name-only').stdout || '').trim() === ''; }

// C1/C2: A and B already have receipts; C is new.  All three proofs are made from the same
// committed integration tree, independently, while their amended executable test bytes live
// only in the author worktree.
const happy = fixture('happy'); const proofs = IDS.map(id => proof(happy, id));
check('C1 independent managed proofs from one HEAD have one base identity despite two valid existing receipts',
  proofs.every(p => p.ok) && new Set(proofs.map(p => p.m.baseManifestHash)).size === 1,
  proofs.map(p => p.ok ? `${p.m.issue}:${p.m.baseManifestHash}` : p.error).join(' | '));
const dry = freeze(happy, proofs, true);
check('C2 two amended frozen suites plus one new suite pass one atomic managed freeze dry run',
  dry.status === 0 && /3 suite\(s\) gated and would be frozen/.test(text(dry)) && head(happy.target) === happy.initial, text(dry));
const landed = freeze(happy, proofs, false); const landedHead = head(happy.target);
const changed = String(git(happy.target, 'show', '--format=', '--name-only', landedHead).stdout || '').trim().split(/\r?\n/).filter(Boolean).sort();
check('C2 the same independently proven batch commits atomically with all suites and receipts',
  landed.status === 0 && landedHead !== happy.initial && IDS.every(id => changed.includes(`tests/acceptance/${id}/test.js`) && changed.includes(`tests/acceptance/${id}/.freeze-gate.json`)), text(landed));

// C3 controls: each one must be rejected before freeze staging.  The base-identity assertion is
// intentionally repeated by these fresh fixtures so a later implementation cannot make the
// happy path pass by simply ignoring every protected byte or marker.
function control(label, alter, expected) { const f = fixture(label); const ps = IDS.map(id => proof(f, id)); alter(f, ps); const before = head(f.target); const r = freeze(f, ps); check(`C3 ${label} fails closed before staging`, r.status !== 0 && expected.test(text(r)) && sameIndexAndHead(f, before), text(r)); }
control('a real protected-path difference', (f) => write(f.target, 'tools/run-acceptance.sh', '#!/bin/sh\nexit 0\n'), /protected|moved|unsafe|admissible/i);
control('a stale integration HEAD', (f) => { write(f.target, 'README.md', 'moved\n'); commit(f.target, 'move'); }, /stale|current HEAD|moved/i);
control('an altered proved suite byte', (_f, ps) => fs.appendFileSync(path.join(ps[0].probe, 'tests', 'acceptance', IDS[0], 'test.js'), '// tampered\n'), /changed a protected path|protected byte/i);
control('a forged proof marker', (_f, ps) => { const m = JSON.parse(fs.readFileSync(ps[0].marker, 'utf8')); m.cleanupToken = 'f'.repeat(64); fs.writeFileSync(ps[0].marker, JSON.stringify(m)); }, /malformed|unsafe|ownership marker/i);
control('an unrelated receipt mutation', (f) => write(f.target, `tests/acceptance/${IDS[1]}/.freeze-gate.json`, '{ forged'), /protected|moved|unsafe/i);

rmrf(tmp); process.exit(failed);
