#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// FROZEN acceptance suite for repo-3xw — the three facts no reader could reach enter the
// ledger: the queue read with every refusal, each attempt's verifier result and failing check
// names, and each spec concern.
//
// Written before any implementation exists, from the spec alone. Do not edit during a run —
// everything under tests/acceptance/ is diffed against the fork point and any difference ends
// the task `tampered` (DESIGN.md §4.4).
//
// The fixture is the ledger writer's own (tests/acceptance/repo-qzy), driven the same way and
// with the same stand-aside guard on the preloaded bd stub; its run.log expectation is the same
// fifteen lines, because this task adds ledger-only events and no prose.
//
// Section headers name the criterion they serve; every criterion in the issue has one.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
let failed = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) { failed = 1; if (detail) console.log(`       ${String(detail).slice(0, 300)}`); }
  return cond;
}
function read(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }
const scrubbedEnv = () => {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  for (const k of Object.keys(env)) if (/^PIPELINE_/.test(k) || /^BD_/.test(k)) delete env[k];
  return env;
};
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-3xw-'));

let runmod = null; let logmod = null; let queue = null; let sweep = null;
try { runmod = require(path.join(ROOT, 'runner', 'run.js')); } catch { runmod = null; }
try { logmod = require(path.join(ROOT, 'runner', 'log.js')); } catch { logmod = null; }
try { queue = require(path.join(ROOT, 'runner', 'queue.js')); } catch { queue = null; }
try { sweep = require(path.join(ROOT, 'scripts', 'sweep-assertions.js')); } catch { sweep = null; }
check('the runner, the logger, the queue and sweep-assertions are requirable', !!runmod && !!logmod && !!queue && !!sweep);

// ---- A1: failingChecks — the one vocabulary, sorted, de-duplicated, colon form included -----

const SAMPLE = 'ok - a\nFAIL - b broke\r\n  FAIL - decoy\nnot ok 3 - c\nFAIL\tshell style\nFAIL: tests/acceptance/x/t.js\nFAIL: colon\nFAIL - b broke\nPASS d\n';
if (sweep) {
  const fc = typeof sweep.failingChecks === 'function' ? sweep.failingChecks(SAMPLE) : null;
  check('A1 scripts/sweep-assertions.js exports failingChecks', typeof sweep.failingChecks === 'function');
  check('A1 failingChecks returns the sorted, de-duplicated names, colon form and file-level line included, indented decoy and not-ok excluded',
    Array.isArray(fc) && JSON.stringify(fc) === JSON.stringify(['b broke', 'colon', 'shell style', 'tests/acceptance/x/t.js']), JSON.stringify(fc));
  check('A1 failingChecks on text with no failures is []', typeof sweep.failingChecks === 'function' && JSON.stringify(sweep.failingChecks('ok - a\nPASS b\n')) === '[]');
  // countAssertions is byte-identical on the same sample: the colon constant is failingChecks' alone.
  const ca = sweep.countAssertions(SAMPLE);
  check('A1 countAssertions is unchanged by the colon form (its answer on this sample is pinned from the fork point)',
    JSON.stringify(ca) === JSON.stringify({ found: true, count: 1, failed: 2, vocabulary: 'node', counts: { node: 1, shell: 1 } }), JSON.stringify(ca));
  const r = spawnSync('bash', [path.join(ROOT, 'scripts', 'test-sweep-assertions.sh')], { cwd: ROOT, encoding: 'utf8', env: scrubbedEnv() });
  check('A1 scripts/test-sweep-assertions.sh exits 0', r.status === 0);
} else {
  check('A1 sweep-assertions is unavailable', false);
}

// ---- A2: queue.read and task.undispatched through exported helpers ---------------------------

if (queue && logmod) {
  const root = path.join(TMP, 'a2');
  const log = logmod.startRun(root, 'unit-facts');
  const q = {
    ok: true,
    issues: [{ id: 'q-1', title: 'one', issue_type: 'task' }, { id: 'q-2', title: 'two', issue_type: 'bug' }],
    skipped: [{ id: 'e-1', title: 'epic', issue_type: 'epic' }],
    undispatchable: [{ issue: { id: 'u-1', title: 'u', issue_type: 'task' }, reason: 'no freeze receipt at tests/acceptance/u-1/', refusal: 'no-receipt' }],
  };
  let threw = null;
  try {
    if (typeof queue.logQueueRead !== 'function' || typeof queue.logUndispatched !== 'function') throw new Error('helpers not exported');
    queue.logQueueRead(log, q);
    queue.logUndispatched(log, q.undispatchable[0]);
  } catch (e) { threw = e; }
  check('A2 runner/queue.js exports logQueueRead(log, q) and logUndispatched(log, u)', threw === null, threw && threw.message);
  const runLog = (read(path.join(log.dir, 'run.log')) || '').split(/\r?\n/).filter(Boolean);
  const events = (read(path.join(log.dir, 'events.jsonl')) || '').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
  const qr = events.find((e) => e.event === 'queue.read');
  const qrLine = runLog.find((l) => / \[[^\]]*\] ready queue: /.test(l)) || '';
  check('A2 queue.read is emitted once, paired with the ready-queue prose line in the same call',
    !!qr && events.filter((e) => e.event === 'queue.read').length === 1 && typeof qr.msg === 'string' && qr.msg.startsWith('ready queue: ')
    && qrLine.startsWith(qr.ts), JSON.stringify(qr));
  check('A2 queue.read data carries ids only: ready ids, skipped {id,type}, refused {id, reason, refusal}',
    !!qr && JSON.stringify(qr.data.ready) === JSON.stringify(['q-1', 'q-2'])
    && JSON.stringify(qr.data.skipped) === JSON.stringify([{ id: 'e-1', type: 'epic' }])
    && Array.isArray(qr.data.refused) && qr.data.refused.length === 1 && qr.data.refused[0].id === 'u-1'
    && /no freeze receipt/.test(qr.data.refused[0].reason) && qr.data.refused[0].refusal === 'no-receipt'
    && Object.keys(qr.data.refused[0]).every((k) => ['id', 'reason', 'refusal'].includes(k)),
    JSON.stringify(qr && qr.data));
  const ud = events.find((e) => e.event === 'task.undispatched');
  const udLine = runLog.find((l) => / ERROR \[[^\]]*\] not dispatched: /.test(l)) || '';
  check('A2 task.undispatched is paired with the not-dispatched ERROR line, with id, reason and kind',
    !!ud && ud.level === 'ERROR' && typeof ud.msg === 'string' && ud.msg.startsWith('not dispatched: ') && udLine.startsWith(ud.ts)
    && ud.data.id === 'u-1' && /no freeze receipt/.test(ud.data.reason) && ud.data.refusal === 'no-receipt' && ud.issueId === 'u-1',
    JSON.stringify(ud));
  const runSrc = read(path.join(ROOT, 'runner', 'run.js')) || '';
  check('A2 runner/run.js main() calls both helpers (structural — main() is behind the preflight)',
    /logQueueRead\(/.test(runSrc) && /logUndispatched\(/.test(runSrc));
} else {
  check('A2 the runner modules are unavailable', false);
}

// ---- the fixture run (the ledger writer's, unchanged) ------------------------------------------

const EXPECTED_LOG = [
  'INFO [unit-events/preflight] run started (config: fixture)',
  'INFO [unit-events/led-1] starting task (priority 1): ledger task',
  'INFO [unit-events/led-1] integration branch: main',
  'INFO [unit-events/led-1] memory: no notes recorded yet — container gets the empty marker',
  'INFO [unit-events/led-1] workspace ready: <WS> on task/led-1 (fork point <SHA>)',
  'INFO [unit-events/led-1] exec stub exited 20',
  'INFO [unit-events/led-1] rate limit hit (pause 1) — parking the task; issue stays in_progress',
  'INFO [unit-events/led-1] relaunching in a fresh container against the same workspace (attempt counter carries over)',
  'INFO [unit-events/led-1] exec stub exited 0',
  'INFO [unit-events/led-1] task resumed across 1 usage-window pause(s)',
  'INFO [unit-events/led-1] branch task/led-1: no commits (nothing to push)',
  'INFO [unit-events/led-1] no commits on the branch — nothing to push, no PR',
  'INFO [unit-events/led-1] task finished: exit 0 -> done (issue closed)',
  'ERROR [unit-events/led-2] refused: the run-level rate-limit pause cap has fired; nothing launched, issue stays open',
  'INFO [unit-events/preflight] run finished; artifacts in <DIR>',
];
const LINE = /^(\S+) (INFO|ERROR) \[([^\]]+)\] (.*)$/;
const mask = (msg) => msg
  .replace(/workspace ready: .* on task\//, 'workspace ready: <WS> on task/')
  .replace(/\(fork point [0-9a-f]{8}\)/, '(fork point <SHA>)')
  .replace(/artifacts in .*$/, 'artifacts in <DIR>');

async function runFixture() {
  const tmp = fs.mkdtempSync(path.join(TMP, 'fx-'));
  const remote = path.join(tmp, 'remote.git');
  const seed = path.join(tmp, 'seed');
  const g = (cwd, args) => spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd, encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'f', GIT_AUTHOR_EMAIL: 'f@test.local', GIT_COMMITTER_NAME: 'f', GIT_COMMITTER_EMAIL: 'f@test.local' },
  });
  fs.mkdirSync(seed, { recursive: true });
  g(tmp, ['init', '-q', '--bare', '-b', 'main', remote]);
  g(tmp, ['init', '-q', '-b', 'main', seed]);
  fs.writeFileSync(path.join(seed, 'README.md'), 'seed\n');
  fs.writeFileSync(path.join(seed, 'pipeline.config.json'), JSON.stringify({
    verifyCommand: 'sh tools/run-acceptance.sh', defaultBranch: 'main', frozenPaths: [], dependencies: {},
  }, null, 2));
  g(seed, ['add', '-A']); g(seed, ['commit', '-q', '-m', 'seed']);
  g(seed, ['remote', 'add', 'origin', remote]); g(seed, ['push', '-q', 'origin', 'main']);

  const bdStub = path.join(tmp, 'bd-stub.js');
  fs.writeFileSync(bdStub, [
    "'use strict';",
    "if (/\\.js$/i.test(String(process.argv[1] || '').replace(/\\\\/g, '/').split('/').pop())) { /* stand aside */ } else {",
    "  const sfs = require('fs');",
    "  const a = process.argv.slice(1).map((s) => String(s).replace(/\\\\/g, '/').split('/').pop());",
    "  if (a.includes('show')) {",
    '    sfs.writeSync(1, JSON.stringify([{ id: process.env.BD_ISSUE_ID, title: "t", description: "d", acceptance_criteria: "a", design: "DESIGN.md 4.7" }]));',
    "  } else { sfs.writeSync(1, '[]'); }",
    '  process.exit(0);',
    '}',
    '',
  ].join('\n'));
  const execStub = path.join(tmp, 'exec-stub.sh');
  fs.writeFileSync(execStub, [
    '#!/bin/sh',
    'mkdir -p "$RUN_DIR"',
    'STATE="$RUN_DIR/.stub-calls"',
    'N=0; [ -f "$STATE" ] && N=$(cat "$STATE"); N=$((N+1)); echo "$N" > "$STATE"',
    'if [ "$N" -eq 1 ]; then',
    '  printf \'{"issueId":"%s","attempts":[],"rateLimitResetAt":"2026-01-01T00:00:00.000Z"}\\n\' "$ISSUE_ID" > "$RUN_DIR/status.json"',
    '  exit 20',
    'fi',
    'cat > "$RUN_DIR/status.json" <<EOF',
    '{"issueId":"$ISSUE_ID","phase":"docs","attempts":[',
    ' {"number":1,"verifierResult":"fail","timestamp":"2026-01-01T00:00:01.000Z","feedback":"ok - a\\nFAIL - b broke\\nFAIL: tests/acceptance/x/t.js\\n"},',
    ' {"number":2,"verifierResult":"fail","timestamp":"2026-01-01T00:00:02.000Z","feedback":"FAIL - b broke\\n"},',
    ' {"number":3,"verifierResult":"pass","timestamp":"2026-01-01T00:00:03.000Z"}',
    '],"specConcerns":["first concern","second concern"],"changeSummary":"did the thing"}',
    'EOF',
    'printf \'{"issueId":"%s","timestamp":"2026-01-01T00:00:03.000Z","acceptance":"pass","regressions":"pass","acceptanceOutput":"ok - a\\nok - b\\n"}\\n\' "$ISSUE_ID" > "$RUN_DIR/verify.json"',
    'exit 0',
    '',
  ].join('\n'));
  const ghStub = path.join(tmp, 'gh-stub.js');
  fs.writeFileSync(ghStub, "'use strict';process.exit(0);\n");

  const saved = {};
  const set = (k, v) => { saved[k] = process.env[k]; process.env[k] = v; };
  set('PIPELINE_BD_CMD', process.execPath);
  set('NODE_OPTIONS', `--require "${bdStub.split(path.sep).join('/')}"`);
  set('BD_ISSUE_ID', 'led-1');
  set('PIPELINE_EXEC_STUB', execStub);
  set('PIPELINE_GH_CMD', `${process.execPath} "${ghStub.split(path.sep).join('/')}"`);
  const log = logmod.startRun(path.join(tmp, 'runs-root'), 'unit-events');
  const gate = { waits: 0, cycles: 0, exhausted: false, admit: async (id) => id !== 'led-2',
    reportLimit: async () => ({ resumed: true, cycles: 1, joined: false, exhausted: false }) };
  const cfg = { targetRepoPath: seed, targetRepoRemote: remote, image: 'unused:local',
    wallClockMinutes: 60, maxAttempts: 3, probeIntervalMinutes: 15, maxPauseCycles: 96, concurrency: 1 };
  let threw = null;
  try {
    log.info(log.trace('preflight'), 'run started (config: fixture)');
    await runmod.runOneTask(cfg, { id: 'led-1', title: 'ledger task', priority: 1 }, log, 'tok', gate);
    await runmod.runOneTask(cfg, { id: 'led-2', title: 'refused task', priority: 2 }, log, 'tok', gate);
    log.info(log.trace('preflight'), `run finished; artifacts in ${log.dir}`);
  } catch (e) { threw = e; } finally {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
  return { log, threw, dir: log.dir };
}

(async () => {
  const fixture = (runmod && logmod) ? await runFixture() : null;
  check('the fixture run completes without throwing', !!fixture && fixture.threw === null, fixture && fixture.threw && fixture.threw.stack);
  const runLog = fixture ? (read(path.join(fixture.dir, 'run.log')) || '') : '';
  const logLines = runLog.split(/\r?\n/).filter(Boolean);
  const events = fixture ? (read(path.join(fixture.dir, 'events.jsonl')) || '').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } }) : [];

  // ---- A3: attempt.finished, once per attempt, after the loop --------------------------------
  const att = events.filter((e) => e.event === 'attempt.finished');
  check('A3 exactly three attempt.finished events for a [fail, fail, pass] task, despite the relaunch collecting the status twice',
    att.length === 3 && att.every((e) => e.msg === null && e.level === 'INFO' && e.issueId === 'led-1'), JSON.stringify(att.map((e) => e.data)));
  const nums = att.map((e) => e.data && e.data.number);
  check('A3 ...numbered 1, 2, 3 in order with the verifier results', JSON.stringify(nums) === '[1,2,3]'
    && att.map((e) => e.data.verifierResult).join(',') === 'fail,fail,pass');
  check('A3 attempt 1\'s failing checks come from its feedback through failingChecks (file-level colon line included)',
    !!att[0] && JSON.stringify(att[0].data.failingChecks) === JSON.stringify(['b broke', 'tests/acceptance/x/t.js']), JSON.stringify(att[0] && att[0].data));
  check('A3 attempt 2\'s failing checks', !!att[1] && JSON.stringify(att[1].data.failingChecks) === JSON.stringify(['b broke']));
  check('A3 the passing final attempt has no feedback, so its checks come from verify.acceptanceOutput: [] not null',
    !!att[2] && JSON.stringify(att[2].data.failingChecks) === '[]', JSON.stringify(att[2] && att[2].data));
  const lastProse = events.map((e, i) => (e.event === 'task.finished' ? i : -1)).filter((i) => i >= 0).pop();
  const firstAtt = events.findIndex((e) => e.event === 'attempt.finished');
  check('A3 the attempt events are emitted after the relaunch loop, not per collection',
    firstAtt > events.findIndex((e) => e.event === 'task.relaunched') && lastProse !== undefined);

  // ---- A4: concern.raised, one per entry, verbatim ----------------------------------------------
  const con = events.filter((e) => e.event === 'concern.raised');
  check('A4 exactly one concern.raised per specConcerns entry, verbatim, for led-1 and none for the refused task',
    con.length === 2 && con.map((e) => e.data.text).join('|') === 'first concern|second concern'
    && con.every((e) => e.issueId === 'led-1' && e.msg === null), JSON.stringify(con.map((e) => e.data)));

  // ---- A5: the schema names the four, the validator rejects objects in ready, run.log unchanged --
  const schema = readJson(path.join(ROOT, 'schemas', 'events.schema.json'));
  const defs = (schema && schema.$defs && schema.$defs.events) || {};
  const enumOf = (schema && schema.properties && schema.properties.event && schema.properties.event.enum) || [];
  check('A5 the schema enumerates and describes queue.read, task.undispatched, attempt.finished and concern.raised',
    ['queue.read', 'task.undispatched', 'attempt.finished', 'concern.raised'].every((n) => enumOf.includes(n) && defs[n] && defs[n].properties));
  function validate(e) {
    if (!schema || !e || typeof e !== 'object') return false;
    for (const k of schema.required) if (!(k in e)) return false;
    for (const k of Object.keys(e)) if (!(k in schema.properties)) return false;
    if (!enumOf.includes(e.event)) return false;
    const d = defs[e.event]; if (!d || !d.properties) return e.event === 'log' && Object.keys(e.data || {}).length === 0;
    for (const k of Object.keys(e.data || {})) if (!(k in d.properties)) return false;
    for (const k of (d.required || [])) if (!(k in (e.data || {}))) return false;
    if (e.event === 'queue.read') {
      const items = d.properties.ready && d.properties.ready.items;
      const readyOk = Array.isArray(e.data.ready) && e.data.ready.every((x) => typeof x === 'string');
      if (!items || items.type !== 'string' || !readyOk) return false;
    }
    return true;
  }
  check('A5 the validator accepts every fixture line', events.length > 0 && events.every(validate));
  const qrSample = { ts: 't', level: 'INFO', runId: 'r', issueId: null, trace: 'r/preflight', event: 'queue.read', msg: 'ready queue: x', data: { ready: [{ id: 'q-1' }], skipped: [], refused: [] } };
  check('A5 ...and rejects a queue.read whose ready holds objects', !validate(qrSample));
  const masked = logLines.map((l) => { const m = LINE.exec(l); return m ? `${m[2]} [${m[3]}] ${mask(m[4])}` : l; });
  check('A5 run.log is byte-identical to the ledger writer\'s recorded expectation, every line',
    JSON.stringify(masked) === JSON.stringify(EXPECTED_LOG), masked.join('\n').slice(0, 400));

  // ---- A6: the documents ---------------------------------------------------------------------
  check('A6 docs/change-log.md has a row for repo-3xw', /\|\s*repo-3xw\s*\|/.test(read(path.join(ROOT, 'docs', 'change-log.md')) || ''));
  check('A6 docs/pipeline-diagram.md names the ledger-only facts', /attempt\.finished/.test(read(path.join(ROOT, 'docs', 'pipeline-diagram.md')) || ''));
  check('A6 tests/unit/events.test.js covers failingChecks', /failingChecks/.test(read(path.join(ROOT, 'tests', 'unit', 'events.test.js')) || ''));
  const r = spawnSync('bash', [path.join(ROOT, 'scripts', 'test-events.sh')], { cwd: ROOT, encoding: 'utf8', env: scrubbedEnv() });
  check('A6 scripts/test-events.sh exits 0', r.status === 0, (r.stdout || '').split('\n').filter((l) => /FAIL/.test(l)).slice(0, 3).join(' | '));

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* temp */ }
  process.exit(failed);
})().catch((e) => { console.log(`FAIL - the suite itself threw: ${e && e.stack}`); process.exit(1); });
