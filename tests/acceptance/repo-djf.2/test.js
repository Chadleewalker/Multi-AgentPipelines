// Frozen acceptance test — repo-djf.2: coverage-preserving fast full sweep.
// PAIRING: C1 fixture coverage/no copied roster; C2 Git/plan/fail-closed fixture; C3 future
// leaves; C4 output, outcome propagation and dynamic summary; C5 canonical bytes + docs.
// Frozen interface: `node scripts/fast-full-sweep.js --repo <root>`.  The coordinator asks
// <root>/scripts/test-ci.sh --list and test-all.sh --list, runs test-ci.sh once, then invokes
// test-all.sh once with an exact --skip list.  FAST_FULL_SWEEP_LOG is a fixture-only audit log.
'use strict';
const crypto = require('crypto'); const fs = require('fs'); const os = require('os');
const path = require('path'); const { spawnSync } = require('child_process');
const REPO = path.resolve(__dirname, '..', '..', '..');
const COORDINATOR = path.join(REPO, 'scripts', 'fast-full-sweep.js');
let failed = 0;
function check(name, yes, detail = '') { console.log(`${yes ? 'ok' : 'FAIL'} - ${name}${yes || !detail ? '' : ` — ${detail}`}`); if (!yes) failed = 1; }
function run(cmd, args, opts = {}) { return spawnSync(cmd, args, { encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, ...opts }); }
function git(root, ...args) { return run('git', ['-c', 'safe.directory=*', ...args], { cwd: root }); }
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 }); } catch {} }
function write(p, s, mode) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); if (mode) fs.chmodSync(p, mode); }
function shell(s) { return `#!/usr/bin/env bash\nset -u\n${s}\n`; }
function fixture(mode = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-djf2-')); const log = path.join(root, 'audit.log');
  const mandatory = mode.futureMandatory ? ['test-alpha.sh', 'test-future-mandatory.sh'] : ['test-alpha.sh'];
  const full = mode.unreadable ? null : ['test-alpha.sh', ...(mode.futureMandatory ? ['test-future-mandatory.sh'] : []), 'test-docker.sh', ...(mode.futureLeaf ? ['test-future-leaf.sh'] : []), 'e2e.sh'];
  write(path.join(root, 'tracked.txt'), 'clean\n');
  write(path.join(root, 'scripts', 'test-ci.sh'), shell(`if [ "\${1:-}" = --list ]; then printf '%s\\n' ${mandatory.map(x => `'${x}'`).join(' ')}; exit 0; fi\necho mandatory-output; echo ci >> "$FAST_FULL_SWEEP_LOG"\n${mandatory.map(x => `echo mandatory:${x} >> "$FAST_FULL_SWEEP_LOG"`).join('\n')}\n${mode.ciFail ? 'exit 17' : mode.moveHead ? 'git add tracked.txt; git -c user.email=x@y -c user.name=x commit -m moved -q' : mode.mutate ? 'echo dirty >> tracked.txt' : 'exit 0'}`), 0o755);
  const direct = full ? full.map((name) => `matches "${name.replace(/\.sh$/, '')}" "$skip" || { echo direct:${name} >> "$FAST_FULL_SWEEP_LOG"; ${name === 'e2e.sh' ? 'echo "nested:$FAST_FULL_SWEEP_NESTED" >> "$FAST_FULL_SWEEP_LOG"' : ':'} ; }`).join('\n') : '';
  write(path.join(root, 'scripts', 'test-all.sh'), shell(`if [ "\${1:-}" = --list ]; then ${mode.unreadable ? 'exit 23' : `printf '%s\\n' ${full.map(x => `'${x}'`).join(' ')}`}; exit 0; fi\necho extra-output; printf 'all:%s\\n' "$*" >> "$FAST_FULL_SWEEP_LOG"\nskip="\${2:-}"\nmatches() { local name="$1" list="$2" part; IFS=',' read -ra part <<< "$list"; for p in "\${part[@]}"; do [ -n "$p" ] && case "$name" in *"$p"*) return 0 ;; esac; done; return 1; }\n${direct}\n${mode.extraLaunchError ? 'exec /definitely-missing-fast-sweep-child' : `exit ${mode.extraFail ? 19 : 0}`}`), 0o755);
  for (const n of [...mandatory, 'test-docker.sh', 'test-future-leaf.sh', 'test-isolation.sh']) write(path.join(root, 'scripts', n), shell('exit 0'), 0o755);
  write(path.join(root, 'scripts', 'e2e.sh'), shell(mode.missingNested ? 'echo e2e' : 'echo e2e; bash "$(dirname "$0")/test-isolation.sh"'), 0o755);
  git(root, 'init', '-q'); git(root, 'add', '.'); git(root, '-c', 'user.email=fixture@example.invalid', '-c', 'user.name=fixture', 'commit', '-qm', 'seed');
  return { root, log, mandatory, full };
}
function invoke(f) { return fs.existsSync(COORDINATOR) ? run(process.execPath, [COORDINATOR, '--repo', f.root], { cwd: REPO, env: { ...process.env, FAST_FULL_SWEEP_LOG: f.log, FAST_FULL_SWEEP_NESTED: 'test-isolation.sh' } }) : { status: 127, stdout: '', stderr: 'missing coordinator' }; }
function audit(f) { try { return fs.readFileSync(f.log, 'utf8').trim().split(/\r?\n/).filter(Boolean); } catch { return []; } }
function sha(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
const roots = [];
try {
  const normal = fixture(); roots.push(normal.root); const r = invoke(normal); const a = audit(normal);
  const all = a.find(x => x.startsWith('all:')) || ''; const skip = /--skip\s+([^\s]+)/.exec(all);
  check('C1 deterministic Docker-free fixture runs authoritative mandatory aggregate exactly once then one extras sweep', r.status === 0 && a.filter(x => x === 'ci').length === 1 && a.filter(x => x.startsWith('all:')).length === 1, JSON.stringify({ status:r.status, audit:a }));
  const covered = a.filter(v => /^(mandatory|direct|nested):/.test(v)).map(v => v.replace(/^(mandatory|direct|nested):/, ''));
  const expected = ['test-alpha.sh', 'test-docker.sh', 'e2e.sh', 'test-isolation.sh'];
  check('C1 every full-plan suite is covered exactly once after e2e-to-isolation expansion, without a roster copied into the coordinator', r.status === 0 && skip && skip[1].split(',').includes('test-alpha') && expected.every(n => covered.filter(x => x === n).length === 1) && !/test-alpha\.sh[\s,]*test-docker\.sh/.test(fs.existsSync(COORDINATOR) ? fs.readFileSync(COORDINATOR, 'utf8') : ''), JSON.stringify({ all, covered }));
  const cases = [['mandatory nonzero', {ciFail:true}], ['moved commit', {moveHead:true}], ['tracked mutation', {mutate:true}], ['unreadable plan', {unreadable:true}], ['missing e2e isolation witness', {missingNested:true}]];
  for (const [label, setup] of cases) { const f = fixture(setup); roots.push(f.root); const x = invoke(f); check(`C2 ${label} refuses before Docker/live extras`, x.status !== 0 && !audit(f).some(v => v.startsWith('all:')), `${x.stdout}${x.stderr}`); }
  const future = fixture({futureLeaf:true, futureMandatory:true}); roots.push(future.root); const fr = invoke(future); const fa = audit(future).join('\n');
  check('C3 unknown future full-plan leaf automatically enters extras while future mandatory leaf is excluded after aggregate pass', fr.status === 0 && /test-future-leaf/.test(fa) && /test-future-mandatory/.test(fa) && /--skip/.test(fa), fa);
  const bad = fixture({extraFail:true}); roots.push(bad.root); const br = invoke(bad);
  check('C4 child stdout/stderr remain visible and nonzero extra outcome propagates', br.status === 19 && /mandatory-output/.test(br.stdout) && /extra-output/.test(br.stdout), `${br.status}:${br.stdout}${br.stderr}`);
  const launch = fixture({extraLaunchError:true}); roots.push(launch.root); const lr = invoke(launch);
  check('C4 child launch-error outcome propagates without hiding earlier child output', lr.status === 127 && /mandatory-output/.test(lr.stdout) && /extra-output/.test(lr.stdout), `${lr.status}:${lr.stdout}${lr.stderr}`);
  check('C4 summary distinguishes mandatory, direct extras, nested isolation, elapsed time, and dynamic unique full coverage', /mandatory/i.test(r.stdout) && /extra/i.test(r.stdout) && /isolation/i.test(r.stdout) && /elapsed|time/i.test(r.stdout) && /unique|coverage/i.test(r.stdout) && !/\b42\b/.test(r.stdout), r.stdout);
  check('C5 canonical test-ci.sh and test-all.sh retain their fork-point bytes and docs name fast routine plus canonical diagnostic fallback', sha(path.join(REPO,'scripts','test-ci.sh')) === '41784747fe3f71b053bc10f5752c45f3eb956372a2cd3f3d18c8efc2629c0448' && sha(path.join(REPO,'scripts','test-all.sh')) === '1df1b42f958e1d02b3c7d4ba19b5e552f7833f62e294983c460314fb5bfa95b4' && /fast-full-sweep|fast full sweep/i.test(fs.readFileSync(path.join(REPO,'docs','control-plane.md'),'utf8')) && /test-all\.sh/.test(fs.readFileSync(path.join(REPO,'docs','control-plane.md'),'utf8')));
} catch (e) { check('C1-C5 harness executes', false, e.stack || String(e)); }
finally { for (const root of roots) rmrf(root); }
process.exit(failed);
