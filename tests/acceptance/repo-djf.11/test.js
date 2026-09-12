// Frozen acceptance test — repo-djf.11: harden design-provenance publication before merge.
'use strict';

// Every label is paired to the canonical criterion it proves. C7 is the green guard beside
// this file. This file is deliberately RED at the fork: the publisher does not exist yet.
//
// Frozen interface (needed because the issue tightens a pre-existing repo-zxc implementation):
// `scripts/design-provenance.js` retains `main(argv, out, err)` and its publish CLI. It exports
// `publish` and `verify` for repo-zxc compatibility, validates the positional issue id with
// `runner/preparation-state.js:validateIssueId` before *any* config/source/lock/git/fs/Beads
// boundary, and accepts the repo-zxc config fields targetRepoPath, targetRepoRemote and
// defaultBranch. Production Beads calls honour PIPELINE_BD_CMD, as the existing host adapter
// does. No in-memory recovery seam is accepted by C4/C5 below.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const REPO = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(REPO, 'scripts', 'design-provenance.js');
let failed = 0;
function check(name, yes, detail = '') {
  console.log(`${yes ? 'ok' : 'FAIL'} - ${name}${yes || !detail ? '' : ` — ${detail}`}`);
  if (!yes) failed = 1;
}
function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 8 * 1024 * 1024,
    windowsHide: true, ...options });
}
function git(cwd, ...args) {
  return run('git', ['-c', 'safe.directory=*', ...args], { cwd });
}
function text(result) { return `${result.stdout || ''}${result.stderr || ''}`; }
function head(root) { return String(git(root, 'rev-parse', 'HEAD').stdout || '').trim(); }
function remoteHead(root) { return String(git(root, 'rev-parse', 'refs/heads/main').stdout || '').trim(); }
function commit(root, message) { git(root, 'add', '-A'); git(root, 'commit', '-qm', message); return head(root); }
function changed(root, sha) { return String(git(root, 'show', '--format=', '--name-only', sha).stdout || '').trim().split(/\r?\n/).filter(Boolean); }
function rmrf(root) { try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }); } catch { /* scratch */ } }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-djf11-'));

function fixture(name, hookText = '') {
  const base = path.join(tmp, name); const bare = path.join(base, 'remote.git'); const work = path.join(base, 'work');
  fs.mkdirSync(base, { recursive: true }); git(base, 'init', '-q', '--bare', '-b', 'main', bare);
  git(base, 'init', '-q', '-b', 'main', work); git(work, 'config', 'user.email', 'fixture@example.invalid');
  git(work, 'config', 'user.name', 'fixture'); git(work, 'config', 'commit.gpgsign', 'false');
  // The real repository has docs/design but no tracked empty provenance directory. A safe
  // publisher must create that final component without following a colliding link.
  fs.mkdirSync(path.join(work, 'docs', 'design'), { recursive: true });
  fs.writeFileSync(path.join(work, 'README.md'), 'fixture\n'); commit(work, 'initial');
  git(work, 'remote', 'add', 'origin', bare); git(work, 'push', '-q', 'origin', 'main');
  if (hookText) {
    const hooks = path.join(bare, 'hooks'); fs.mkdirSync(hooks, { recursive: true });
    const hook = path.join(hooks, 'pre-receive'); fs.writeFileSync(hook, hookText); try { fs.chmodSync(hook, 0o755); } catch {}
  }
  const source = path.join(base, 'approved.md'); fs.writeFileSync(source, '# Approved\n\n## Anchor\n');
  const log = path.join(base, 'beads.log'); const bd = path.join(base, 'update');
  // PIPELINE_BD_CMD receives no pre-arguments. Aim it at node and run the CLI from this
  // fixture directory, where the first Beads argv (`update`) is this deterministic program.
  // This exercises runner/bd.js instead of preloading a script that could exit the CLI itself.
  fs.writeFileSync(bd, ["'use strict';", "const fs=require('fs');", "const log=process.env.DJF11_BD_LOG;",
    "if(process.env.DJF11_BD_FAIL==='1') process.exit(9);",
    "fs.appendFileSync(log, process.argv.slice(1).join(' ')+'\\n');", 'process.exit(0);'].join('\n'));
  const config = path.join(base, 'run.json'); fs.writeFileSync(config, JSON.stringify({ targetRepoPath: work,
    targetRepoRemote: 'origin', defaultBranch: 'main', image: 'fixture-image',
    gitTimeoutMs: 30000, bdTimeoutMs: 30000 }, null, 2));
  return { base, bare, work, source, log, bd, config };
}
function cli(f, id, extra = [], env = {}) {
  return run(process.execPath, [CLI, 'publish', id, '--config', f.config, '--source', f.source, '--anchor', 'Anchor', ...extra], {
    cwd: f.base, env: { ...process.env, PIPELINE_BD_CMD: process.execPath,
      DJF11_BD_LOG: f.log, ...env },
  });
}
function logLines(file) { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean) : []; }

// C1 — invalid identifiers fail before config/source reads, locks, Git, filesystem or Beads.
const invalid = ['', '../escape', 'CON', 'repo.', 'repo ', 'a'.repeat(129)];
for (const id of invalid) {
  const r = run(process.execPath, [CLI, 'publish', id, '--config', path.join(tmp, 'DO-NOT-READ.json'),
    '--source', path.join(tmp, 'DO-NOT-READ.md')], { cwd: REPO, env: { ...process.env, PIPELINE_BD_CMD: path.join(tmp, 'DO-NOT-RUN') } });
  check(`C1 invalid issue id ${JSON.stringify(id)} is refused before every boundary`,
    r.status !== 0 && /issue id|portable identifier|reserved/i.test(text(r)) && !/DO-NOT-READ/.test(text(r)), text(r));
}

// C2/C3/C6 — confinement, immutable repo-zxc shape, exact one-path commit and scoped Git trust.
const secure = fixture('secure');
const beforeSecure = head(secure.work);
const good = cli(secure, 'repo-djf.11');
const secureCommit = head(secure.work);
check('C1 valid dotted issue id publishes successfully', good.status === 0 && secureCommit !== beforeSecure, text(good));
check('C2 success stages and commits exactly one canonical provenance file',
  changed(secure.work, secureCommit).join(',') === 'docs/design/provenance/repo-djf.11.md'
    && fs.lstatSync(path.join(secure.work, 'docs', 'design', 'provenance')).isDirectory());
check('C3 production Git uses scoped trust for exactly the canonical target, never wildcard/persistent trust', (() => {
  if (!fs.existsSync(CLI)) return false;
  const source = fs.readFileSync(CLI, 'utf8');
  return /safe\.directory/.test(source) && !/safe\.directory=\*/.test(source)
    && !/config\s+--global\s+.*safe\.directory/.test(source) && !/config\s+--system\s+.*safe\.directory/.test(source);
})());
check('C6 repo-zxc publish/verify interface and canonical-target locking remain part of the production publisher', (() => {
  try { const p = require(CLI); return 'main publish verify'.split(' ').every((k) => typeof p[k] === 'function')
      && /expectedHead|expected-head/.test(fs.readFileSync(CLI, 'utf8')) && /lock/.test(fs.readFileSync(CLI, 'utf8')); } catch { return false; }
})());

for (const kind of ['component-symlink', 'untracked-file', 'case-collision']) {
  const f = fixture(`destination-${kind}`); const dest = path.join(f.work, 'docs', 'design', 'provenance');
  let symlinkReady = true;
  if (kind === 'component-symlink') {
    fs.rmSync(dest, { recursive: true, force: true }); fs.mkdirSync(path.join(f.base, 'outside'));
    try { fs.symlinkSync(path.join(f.base, 'outside'), dest, 'dir'); }
    catch { symlinkReady = false; }
  }
  if (kind !== 'component-symlink') fs.mkdirSync(dest);
  if (kind === 'untracked-file') fs.writeFileSync(path.join(dest, 'repo-djf.11.md'), 'do not overwrite\n');
  if (kind === 'case-collision') fs.writeFileSync(path.join(dest, 'REPO-DJF.11.md'), 'case collision\n');
  const before = { h: head(f.work), status: String(git(f.work, 'status', '--porcelain').stdout), outside: fs.existsSync(path.join(f.base, 'outside')) ? fs.readdirSync(path.join(f.base, 'outside')).join(',') : '' };
  const r = cli(f, 'repo-djf.11');
  const afterOutside = fs.existsSync(path.join(f.base, 'outside')) ? fs.readdirSync(path.join(f.base, 'outside')).join(',') : '';
  check(`C2 ${kind} is refused without changing inside or outside bytes`, !symlinkReady
    // Windows without Developer Mode cannot create a symlink. The formal Linux task-image
    // gate takes the real branch; keeping this planning-host branch explicit avoids a harness
    // crash that would hide the other red proof.
    || (r.status !== 0 && head(f.work) === before.h
      && String(git(f.work, 'status', '--porcelain').stdout) === before.status && afterOutside === before.outside), text(r));
}

// C4 — actual working/bare repositories, real commit, two fresh CLI processes and a real
// failed Git push. Temporarily pointing the configured remote at an unavailable repository is
// portable into the hardened verifier image, where repository hooks are intentionally disabled.
const push = fixture('push-retry');
git(push.work, 'remote', 'set-url', 'origin', path.join(push.base, 'unavailable.git'));
const first = cli(push, 'repo-djf.11'); const committedOnce = head(push.work);
check('C4 a real push failure occurs after one real local provenance commit and before Beads',
  first.status !== 0 && committedOnce !== remoteHead(push.bare) && changed(push.work, committedOnce).join(',') === 'docs/design/provenance/repo-djf.11.md'
    && !fs.existsSync(push.log), text(first));
git(push.work, 'remote', 'set-url', 'origin', push.bare);
const second = cli(push, 'repo-djf.11');
check('C4 a second fresh CLI process reuses that one commit, publishes it remotely, then updates exactly the original issue',
  second.status === 0 && head(push.work) === committedOnce && remoteHead(push.bare) === committedOnce
    && logLines(push.log).length === 1 && /update repo-djf\.11 --design design-ref: docs\/design\/provenance\/repo-djf\.11\.md/.test(logLines(push.log)[0]), text(second));

const extra = fixture('push-extra');
git(extra.work, 'remote', 'set-url', 'origin', path.join(extra.base, 'unavailable.git'));
const extraFirst = cli(extra, 'repo-djf.11'); const extraProvenance = head(extra.work);
git(extra.work, 'remote', 'set-url', 'origin', extra.bare);
fs.writeFileSync(path.join(extra.work, 'unrelated.txt'), 'must not publish\n'); const extraHead = commit(extra.work, 'unrelated local work');
const extraRetry = cli(extra, 'repo-djf.11');
check('C4 retry refuses an unrelated local commit above the stranded provenance commit',
  extraFirst.status !== 0 && extraRetry.status !== 0 && head(extra.work) === extraHead
    && remoteHead(extra.bare) !== extraProvenance && remoteHead(extra.bare) !== extraHead
    && !fs.existsSync(extra.log), text(extraRetry));

const mixed = fixture('push-mixed-commit');
const mixedRemote = remoteHead(mixed.bare);
const mixedDest = path.join(mixed.work, 'docs', 'design', 'provenance');
fs.mkdirSync(mixedDest);
fs.copyFileSync(mixed.source, path.join(mixedDest, 'repo-djf.11.md'));
fs.writeFileSync(path.join(mixed.work, 'unrelated.txt'), 'must never ride with provenance\n');
const mixedCommit = commit(mixed.work, 'unsafe mixed provenance commit');
const mixedRetry = cli(mixed, 'repo-djf.11');
check('C4 recovery refuses a provenance commit that contains any unrelated path',
  mixedRetry.status !== 0 && head(mixed.work) === mixedCommit
    && remoteHead(mixed.bare) === mixedRemote && !fs.existsSync(mixed.log), text(mixedRetry));

const diverged = fixture('push-diverged');
git(diverged.work, 'remote', 'set-url', 'origin', path.join(diverged.base, 'unavailable.git'));
const divergedFirst = cli(diverged, 'repo-djf.11'); const strandedCommit = head(diverged.work);
git(diverged.work, 'remote', 'set-url', 'origin', diverged.bare);
const peer = path.join(diverged.base, 'peer');
git(diverged.base, 'clone', '-q', diverged.bare, peer);
git(peer, 'config', 'user.email', 'peer@example.invalid'); git(peer, 'config', 'user.name', 'peer');
fs.writeFileSync(path.join(peer, 'peer.txt'), 'remote moved\n'); const peerCommit = commit(peer, 'move remote');
git(peer, 'push', '-q', 'origin', 'main');
const divergedRetry = cli(diverged, 'repo-djf.11');
check('C4 remote divergence refuses without force-push, duplicate commit, Beads update, or lost local evidence',
  divergedFirst.status !== 0 && divergedRetry.status !== 0 && head(diverged.work) === strandedCommit
    && remoteHead(diverged.bare) === peerCommit && !fs.existsSync(diverged.log), text(divergedRetry));

const ambiguous = fixture('push-ambiguous');
const prePush = path.join(ambiguous.work, '.git', 'hooks', 'pre-push');
fs.writeFileSync(prePush, '#!/bin/sh\ngit push --no-verify origin HEAD:refs/heads/main >/dev/null 2>&1\nexit 1\n');
try { fs.chmodSync(prePush, 0o755); } catch {}
const ambiguousResult = cli(ambiguous, 'repo-djf.11'); const ambiguousCommit = head(ambiguous.work);
check('C4 a nonzero push whose commit actually reached the remote is resolved from the remote before Beads',
  ambiguousResult.status === 0 && remoteHead(ambiguous.bare) === ambiguousCommit
    && logLines(ambiguous.log).length === 1, text(ambiguousResult));

// C5 — push succeeds but Beads fails. A later process may repair only after proving exact remote
// reachability; a divergent remote is a refusal, never a force-push, duplicate commit or update.
const boundary = fixture('beads-boundary');
const boundaryBefore = head(boundary.work);
const pushed = cli(boundary, 'repo-djf.11', [], { DJF11_BD_FAIL: '1' }); const pushedCommit = head(boundary.work);
check('C5 actual push-success/Beads-failure leaves the exact evidence on remote and no Beads update',
  pushed.status !== 0 && pushedCommit !== boundaryBefore && remoteHead(boundary.bare) === pushedCommit
    && changed(boundary.work, pushedCommit).join(',') === 'docs/design/provenance/repo-djf.11.md'
    && !fs.existsSync(boundary.log), text(pushed));
const recovered = cli(boundary, 'repo-djf.11');
check('C5 a second CLI process proves remote reachability before repairing Beads without a duplicate commit',
  recovered.status === 0 && head(boundary.work) === pushedCommit && remoteHead(boundary.bare) === pushedCommit
    && logLines(boundary.log).length === 1 && /repo-djf\.11/.test(logLines(boundary.log)[0]), text(recovered));

rmrf(tmp);
process.exitCode = failed;
