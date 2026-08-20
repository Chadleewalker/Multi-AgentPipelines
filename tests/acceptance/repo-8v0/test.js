// Frozen acceptance test — the `bd ready` reconciliation (DESIGN.md §3.9, change-log row
// `batch-ready-marker`). Written before implementation, from the spec alone; criteria
// C6–C8 map 1:1 to the issue's "Done means" list. Plain Node, Docker-free: it builds
// throwaway runs roots and a throwaway config directory under the OS temp dir, and drives
// scripts/batch.js as a child through process.execPath. Every project name, path and
// issue id is invented — nothing names a real target project.
//
// This file inlines everything it needs and imports no repo helper (§3.1).
//
// THE FROZEN INTERFACE (on top of the previous task's, which stands unchanged):
//   `show` resolves the run.config.<project>.json named by the marker's `runConfig` from
//     $BATCH_CONFIG_DIR (default: the repo root, never the cwd), reads `targetRepoPath`
//     and optional `bdTimeoutMs` from it by plain JSON parse, and consults the live queue
//     as `<bd> -C <targetRepoPath> ready --json`. `-C <targetRepoPath>` is in the argv on
//     the seam path as well as the host path.
//   The seam is the EXISTING $PIPELINE_BD_CMD, spawned with the bare argv, absolute
//     precedence over any host probe. There is no BATCH_BD_CMD.
//   `bd ready --json` answers with a BARE ARRAY of {id, priority, issue_type, ...}.
//     Entries typed `epic` are excluded before anything is called a stray — bd returns
//     epic parents by design and the runner drops them (runner/queue.js).
//   Reconciled tokens, literal: `ready`, `not-ready`, `stray`, one per issue.
//   Degraded terms, literal: `unreconciled` always printed with exactly one reason —
//     `bd-unavailable` (no bd could be spawned at all), `bd-unreadable` (bd ran but
//     exited non-zero, printed unparseable output, or was killed at the timeout),
//     `run-config-absent` (the marker names a config not present in $BATCH_CONFIG_DIR).
//     A degraded run prints NO reconciled token, and a reconciled run prints NO degraded
//     term.
//   The call is bounded by the run config's bdTimeoutMs (default 60000) and never
//     unbounded. Exit codes are unchanged: 0 on success and on findings.
//   The reader stays pure: it writes nothing, and it never spawns docker.
//
// Deliberately NOT frozen: wording, layout, and the order in which the reconciled
// classes are printed.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'batch.js');

let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) failed = 1;
}
check('C0 scripts/batch.js exists', fs.existsSync(SCRIPT));

// ---- helpers (inlined on purpose) --------------------------------------------------
function mk(d) { fs.mkdirSync(d, { recursive: true }); return d; }
function writeJson(p, o) { mk(path.dirname(p)); fs.writeFileSync(p, JSON.stringify(o, null, 2)); }
function tmpDir(tag) { return mk(fs.mkdtempSync(path.join(os.tmpdir(), `accept-batchrec-${tag}-`))); }
function marker(root, stem, obj) { writeJson(path.join(root, 'batches', `${stem}.json`), obj); }
function fwd(p) { return p.replace(/\\/g, '/'); }   // NODE_OPTIONS eats backslashes
function digest(dir) {
  const h = crypto.createHash('sha1');
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, e.name); const r = `${rel}/${e.name}`;
      if (e.isDirectory()) { h.update(`D:${r}\n`); walk(full, r); }
      else { h.update(`F:${r}\n`); h.update(fs.readFileSync(full)); }
    }
  };
  if (fs.existsSync(dir)) walk(dir, '');
  return h.digest('hex');
}

// The stub stands in for `bd`. It is a .js file preloaded through process.execPath —
// never a #!/bin/sh script, which spawnSync fails with EFTYPE on the Windows host, so a
// shell stub would pass in a container and fail in the host sweep.
function writeStub(dir, name, body) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `'use strict';\nconst fs = require('fs');\nconst argv = process.argv.slice(1);\n`
    + `if (process.env.STUB_LOG) fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(argv) + '\\n');\n`
    + `${body}\n`);
  return p;
}
function runShow(runsRoot, configDir, stubPath, stubLog, args) {
  const env = { ...process.env, BATCH_RUNS_DIR: runsRoot, BATCH_CONFIG_DIR: configDir };
  if (stubLog) env.STUB_LOG = stubLog; else delete env.STUB_LOG;
  if (stubPath === null) delete env.PIPELINE_BD_CMD;
  else if (typeof stubPath === 'string' && stubPath.endsWith('.js')) {
    env.PIPELINE_BD_CMD = process.execPath;
    env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ''} --require "${fwd(stubPath)}"`.trim();
  } else {
    env.PIPELINE_BD_CMD = stubPath;              // a path that cannot be executed
    delete env.NODE_OPTIONS;
  }
  return spawnSync(process.execPath, [SCRIPT, ...(args || ['show'])], { encoding: 'utf8', env });
}
function out(r) { return `${r.stdout || ''}${r.stderr || ''}`; }
function lines(s) { return s.split(/\r?\n/); }
function countLines(s, re) { return lines(s).filter((l) => re.test(l)).length; }
const DEGRADED = /\b(?:bd-unavailable|bd-unreadable|run-config-absent|unreconciled)\b/;

// ---- C6: the queue is read against the marker's own config; epics are not strays ---
{
  const runs = tmpDir('c6-runs');
  const cfg = tmpDir('c6-cfg');
  const bin = tmpDir('c6-bin');
  const repoX = mk(path.join(tmpDir('c6-x'), 'repoX'));
  const repoY = mk(path.join(tmpDir('c6-y'), 'repoY'));
  writeJson(path.join(cfg, 'run.config.projx.json'), { targetRepoPath: repoX, bdTimeoutMs: 20000 });
  writeJson(path.join(cfg, 'run.config.projy.json'), { targetRepoPath: repoY, bdTimeoutMs: 20000 });

  // Both markers carry the SAME three ids, so only the config they name can change the
  // verdict. An implementation that ignores targetRepoPath answers identically for both.
  const ids = ['bat-1', 'bat-2', 'bat-3'];
  const mkM = (rc) => ({
    runConfig: rc, frozenAt: '2026-08-09T00:00:00.000Z',
    issues: ids.map((id) => ({ id, title: `t ${id}` })),
  });
  marker(runs, 'projx-2026-08-09', mkM('run.config.projx.json'));
  marker(runs, 'projy-2026-08-09', mkM('run.config.projy.json'));

  // The stub answers from the -C argument it is given. Under repoX the queue holds two
  // of the batch's ids, an EPIC parent (expected, per PLANNING.md step 8 — never a
  // stray), and one unrelated task (the real stray). Under repoY it holds one id only.
  const log = path.join(bin, 'argv.log');
  const stub = writeStub(bin, 'bdstub.js', `
const i = argv.indexOf('-C');
const target = i >= 0 ? argv[i + 1] : '';
const X = ${JSON.stringify(repoX)};
const answer = target === X
  ? [ {id:'bat-1',priority:1,issue_type:'task'},
      {id:'bat-2',priority:1,issue_type:'task'},
      {id:'epic-9',priority:1,issue_type:'epic'},
      {id:'wander-7',priority:2,issue_type:'task'} ]
  : [ {id:'bat-1',priority:1,issue_type:'task'} ];
process.stdout.write(JSON.stringify(answer));
process.exit(0);`);

  const x = runShow(runs, cfg, stub, log, ['show', 'projx-2026-08-09']);
  const xo = out(x);
  check('C6 show exits 0 when it reconciles', x.status === 0);
  check('C6 exactly one stray is reported — the unrelated task', countLines(xo, /\bstray\b/) === 1);
  check('C6 the stray named is the unrelated task, not the epic',
    (lines(xo).find((l) => /\bstray\b/.test(l)) || '').includes('wander-7'));
  check('C6 an epic parent in the ready queue is never called a stray', !/epic-9/.test(xo));
  check('C6 exactly one batch id is reported not-ready', countLines(xo, /\bnot-ready\b/) === 1);
  check('C6 the not-ready id is the one absent from the queue',
    (lines(xo).find((l) => /\bnot-ready\b/.test(l)) || '').includes('bat-3'));
  check('C6 a reconciled run prints no degraded term', !DEGRADED.test(xo));

  fs.writeFileSync(log, '');
  const y = runShow(runs, cfg, stub, log, ['show', 'projy-2026-08-09']);
  const yo = out(y);
  check('C6 the same ids under a different run config get a different verdict',
    y.status === 0 && countLines(yo, /\bnot-ready\b/) === 2 && countLines(yo, /\bstray\b/) === 0);

  const logged = fs.readFileSync(log, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  check('C6 bd is consulted exactly once', logged.length === 1);
  const argv = logged.length === 1 ? JSON.parse(logged[0]) : [];
  check('C6 the argv carries -C and the targetRepoPath of the config the marker names',
    argv.includes('-C') && argv.includes(repoY));
  check('C6 the argv asks for ready --json', argv.includes('ready') && argv.includes('--json'));
  const WRITES = ['update', 'close', 'create', 'import', 'sync', 'dolt', 'note'];
  check('C6 the call is read-only: no write verb reaches bd (hard rule 1)',
    !argv.some((a) => WRITES.includes(String(a))));
}

// ---- C7: each broken join names itself, and never speaks the reconciled vocabulary --
{
  const runs = tmpDir('c7-runs');
  const cfg = tmpDir('c7-cfg');
  const bin = tmpDir('c7-bin');
  const repo = mk(path.join(tmpDir('c7-r'), 'repo'));
  writeJson(path.join(cfg, 'run.config.good.json'), { targetRepoPath: repo, bdTimeoutMs: 20000 });
  const ids = ['deg-1', 'deg-2'];
  marker(runs, 'good-2026-08-09', {
    runConfig: 'run.config.good.json', frozenAt: '2026-08-09T00:00:00.000Z',
    issues: ids.map((id) => ({ id, title: `t ${id}` })),
  });
  marker(runs, 'missing-2026-08-08', {
    runConfig: 'run.config.nosuchproject.json', frozenAt: '2026-08-08T00:00:00.000Z',
    issues: ids.map((id) => ({ id, title: `t ${id}` })),
  });
  const RECONCILED = /\b(?:ready|not-ready|stray)\b/;
  const idsShown = (s) => ids.every((i) => s.includes(i));

  // (a) the seam names something that cannot be executed at all.
  const a = runShow(runs, cfg, path.join(bin, 'definitely-not-here'), null, ['show', 'good-2026-08-09']);
  const ao = out(a);
  check('C7(a) an unspawnable bd exits 0, lists the ids, and says bd-unavailable',
    a.status === 0 && idsShown(ao) && ao.includes('unreconciled') && ao.includes('bd-unavailable'));
  check('C7(a) it speaks no reconciled token', !RECONCILED.test(ao));

  // (b) bd runs and fails.
  const failStub = writeStub(bin, 'fail.js', `process.stderr.write('bd exploded'); process.exit(4);`);
  const b = runShow(runs, cfg, failStub, null, ['show', 'good-2026-08-09']);
  const bo = out(b);
  check('C7(b) a bd that exits non-zero exits 0, lists the ids, and says bd-unreadable',
    b.status === 0 && idsShown(bo) && bo.includes('unreconciled') && bo.includes('bd-unreadable'));
  check('C7(b) it speaks no reconciled token', !RECONCILED.test(bo));

  // (c) bd runs and prints something that is not the expected array.
  const junkStub = writeStub(bin, 'junk.js', `process.stdout.write('not json at all'); process.exit(0);`);
  const c = runShow(runs, cfg, junkStub, null, ['show', 'good-2026-08-09']);
  const co = out(c);
  check('C7(c) unparseable bd output exits 0, lists the ids, and says bd-unreadable',
    c.status === 0 && idsShown(co) && co.includes('unreconciled') && co.includes('bd-unreadable'));
  check('C7(c) it speaks no reconciled token', !RECONCILED.test(co));

  // (d) the marker names a run config this host does not have.
  const okStub = writeStub(bin, 'ok.js', `process.stdout.write('[]'); process.exit(0);`);
  const d = runShow(runs, cfg, okStub, null, ['show', 'missing-2026-08-08']);
  const dout = out(d);
  check('C7(d) a marker naming an absent run config says run-config-absent, not bd-unavailable',
    d.status === 0 && idsShown(dout) && dout.includes('unreconciled')
    && dout.includes('run-config-absent') && !dout.includes('bd-unavailable'));
  check('C7(d) it speaks no reconciled token', !RECONCILED.test(dout));

  // The other half: a working join must NOT be labelled degraded, or a tool that always
  // says unreconciled passes every fixture above.
  const liveStub = writeStub(bin, 'live.js',
    `process.stdout.write(JSON.stringify([{id:'deg-1',priority:1,issue_type:'task'}])); process.exit(0);`);
  const good = runShow(runs, cfg, liveStub, null, ['show', 'good-2026-08-09']);
  const go = out(good);
  check('C7 a working join prints the reconciled vocabulary and no degraded term',
    good.status === 0 && RECONCILED.test(go) && !DEGRADED.test(go));
}

// ---- C8: the call is bounded, and the previous task's contract still holds ---------
{
  const runs = tmpDir('c8-runs');
  const cfg = tmpDir('c8-cfg');
  const bin = tmpDir('c8-bin');
  const repo = mk(path.join(tmpDir('c8-r'), 'repo'));
  // A short bound, supplied the way the reader is specified to read it.
  writeJson(path.join(cfg, 'run.config.slow.json'), { targetRepoPath: repo, bdTimeoutMs: 1500 });
  marker(runs, 'slow-2026-08-09', {
    runConfig: 'run.config.slow.json', frozenAt: '2026-08-09T00:00:00.000Z',
    issues: [{ id: 'slow-1', title: 't' }],
  });
  const hang = writeStub(bin, 'hang.js', `setInterval(() => {}, 1000);`);
  const t0 = Date.now();
  const r = runShow(runs, cfg, hang, null, ['show', 'slow-2026-08-09']);
  const elapsed = Date.now() - t0;
  const ro = out(r);
  check('C8 a bd that never exits is killed at the bound, not waited on',
    r.status === 0 && elapsed < 30000);
  check('C8 a timed-out bd reports unreconciled bd-unreadable rather than hanging',
    ro.includes('unreconciled') && ro.includes('bd-unreadable'));

  // Still a pure reader, even on the reconciled path.
  const okStub = writeStub(bin, 'ok.js',
    `process.stdout.write(JSON.stringify([{id:'slow-1',priority:1,issue_type:'task'}])); process.exit(0);`);
  const before = digest(runs);
  runShow(runs, cfg, okStub, null, ['show', 'slow-2026-08-09']);
  runShow(runs, cfg, okStub, null, ['pending']);
  check('C8 the runs root is byte-identical after a reconciled show — nothing is written',
    digest(runs) === before);

  // The reader must never reach bd() / bdJson(), which fall back to `docker run`, and
  // must never name docker itself: a pure reader may not start a container.
  const src = fs.existsSync(SCRIPT) ? fs.readFileSync(SCRIPT, 'utf8') : '';
  check('C8 batch.js never mentions docker', src.length > 0 && !/docker/i.test(src));
  check('C8 batch.js does not call bd() or bdJson(), whose fallback is `docker run`',
    src.length > 0 && !/\bbdJson\s*\(/.test(src) && !/[^.\w]bd\s*\(/.test(src));

  // The previous task's contract, re-asserted verbatim against this tree rather than
  // compared with bytes nothing captured.
  const p = tmpDir('c8-prev');
  const m = (stem, frozenAt, id) => marker(p, stem, {
    runConfig: 'run.config.prev.json', frozenAt, issues: [{ id, title: 't' }],
  });
  m('newest-2026-08-09', '2026-08-09T00:00:00.000Z', 'p-1');
  m('zzz-2026-08-06', '2026-08-06T00:00:00.000Z', 'p-2');
  m('mmm-2026-08-06', '2026-08-06T00:00:00.000Z', 'p-3');
  const prev = spawnSync(process.execPath, [SCRIPT, 'pending'],
    { encoding: 'utf8', env: { ...process.env, BATCH_RUNS_DIR: p, BATCH_CONFIG_DIR: cfg } });
  const so = prev.stdout || '';
  check('C8 pending still orders newest first with ties by filename ascending',
    prev.status === 0
    && so.indexOf('newest-2026-08-09') >= 0
    && so.indexOf('newest-2026-08-09') < so.indexOf('mmm-2026-08-06')
    && so.indexOf('mmm-2026-08-06') < so.indexOf('zzz-2026-08-06'));
  const prev2 = spawnSync(process.execPath, [SCRIPT, 'pending'],
    { encoding: 'utf8', env: { ...process.env, BATCH_RUNS_DIR: p, BATCH_CONFIG_DIR: cfg } });
  check('C8 pending is still byte-identical across two invocations',
    (prev2.stdout || '') === so && so.length > 0);
}

console.log(failed ? 'ACCEPTANCE FAILED' : 'ACCEPTANCE PASSED');
process.exit(failed);
