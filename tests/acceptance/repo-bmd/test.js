// Frozen acceptance test — the `phase` field in status.json (planning draft
// 2026-08-10, Task 1; design-ref DESIGN.md §5, change-log row `live-dashboard`).
// Written before implementation, from the spec alone; criteria C1–C5 map 1:1 to the
// issue's "Done means" list. Plain Node, Docker-free, self-contained: nothing here
// require()s repo code — pipeline/entrypoint.sh and pipeline/status.js are exercised
// as CHILD PROCESSES, and the rig's temp PIPELINE_DIR holds runtime COPIES of the
// real status.js + envelope.js plus a stub verify.js (never the real verifier, which
// would re-invoke this very acceptance runner from inside itself and self-nest).
//
// THE RIG (pinned by the spec, because this test also runs inside a live task
// container): the entrypoint child is spawned as `bash pipeline/entrypoint.sh` with
// a REPLACED environment of exactly PATH, HOME, WORKSPACE, PIPELINE_DIR, ISSUE_ID,
// PIPELINE_AGENT_CMD and PIPELINE_MAX_ATTEMPTS — never the inherited environment,
// which inside a container names the live run's own /workspace. bash is probed first
// and its absence aborts loudly (the repo-jur harness-gate shape). The agent stubs
// are shell scripts reached through the PIPELINE_AGENT_CMD seam (the entrypoint runs
// them via `sh -c`, so a shell stub is correct here); the verify stubs are node
// scripts, because the entrypoint runs `node "$PIPE/verify.js"` directly.
//
// Criteria:
//   C1  phase written at each boundary, observed from INSIDE the phase: the agent
//       stub snapshots status.json during the code and docs invocations, the verify
//       stub snapshots it before exiting; run exits 0; snapshots read code / verify /
//       docs; final file reads docs; the captured code prompt still opens with the
//       pinned header and carries the phase write nowhere in it.
//   C2  every exit path carries the last phase reached: fail (cap 1) → 10/verify,
//       tamper (verify exits 3) → 11/verify, rate limit → 20/code, docs-fail →
//       0 + docsPhaseError with docs; every observed value in code|verify|docs.
//   C3  a relaunch overwrites a stale phase: same workspace, run 1 fail (cap 1) ends
//       verify with 1 attempt, run 2 rate-limit (cap 3) ends code, attempts still 1.
//   C4  `set phase` is allowlisted (`set phaze` still exits 2); the schema gains
//       properties.phase with enum exactly ["code","verify","docs"] while required
//       and additionalProperties stay untouched; the inline admitter survives its
//       four enumerated probes.
//   C5  phase writes cannot fail a task: a wrapper status.js records every
//       invocation, fails `set phase …` non-zero and delegates the rest to the real
//       script; the task still reaches its normal exit AND at least one `set phase`
//       call was observed (zero observed today, so this is red before implementation).
//
// Every fixture value is invented (issue id `app-777`, invented summaries); the
// rate-limit epoch is computed from Date.UTC, never hardcoded; every parsed file is
// split on /\r?\n/; all temp dirs live under os.tmpdir() via mkdtempSync and are
// removed in a finally. No stub is spawned without an interpreter (sh for .sh,
// process.execPath via the entrypoint's own `node` calls for .js) and nothing here
// depends on chmod, so the same file passes on the Windows host and in the
// Linux container.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const fwd = (p) => p.split(path.sep).join('/');

let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) failed = 1;
}
const fmt = (v) => (v === undefined ? 'undefined — phase missing from snapshot' : JSON.stringify(v));
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

// ---- harness gate: bash must exist, or the exec path fails silently ---------------
const probe = spawnSync('bash', ['-c', 'echo repo-bmd-bash-probe'], { encoding: 'utf8', timeout: 60000 });
const bashOk = Boolean(!probe.error && probe.status === 0 && (probe.stdout || '').includes('repo-bmd-bash-probe'));
check('harness: bash is available to run pipeline/entrypoint.sh', bashOk);
if (!bashOk) {
  console.log('FAIL - HARNESS BROKEN: no usable bash on PATH, so the entrypoint rig cannot');
  console.log('       run at all. Refusing to report feature failures that would really be');
  console.log(`       harness failures. error=${probe.error || ''} exit=${probe.status} stderr=${(probe.stderr || '').trim()}`);
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-bmd-'));

function harnessAbort(msg) {
  console.log(`FAIL - HARNESS BROKEN: ${msg}`);
  throw new Error('harness-abort');
}

try {
  const REAL_STATUS = fs.readFileSync(path.join(ROOT, 'pipeline', 'status.js'), 'utf8');
  const REAL_ENVELOPE = fs.readFileSync(path.join(ROOT, 'pipeline', 'envelope.js'), 'utf8');
  const VOCAB = ['code', 'verify', 'docs'];
  const observedPhases = [];
  const notePhase = (o) => { if (o && o.phase !== undefined) observedPhases.push(o.phase); };

  // ---- verify stubs (node scripts — the entrypoint runs `node $PIPE/verify.js`) ----
  const VERIFY_OK = 'process.exit(0);\n';
  const VERIFY_SNAP_OK = [
    '// C1 verify stub: snapshot status.json from INSIDE the verify phase, then pass.',
    "const fs = require('fs');",
    "const path = require('path');",
    "const run = path.join(process.cwd(), '.run');",
    "try { fs.copyFileSync(path.join(run, 'status.json'), path.join(run, 'snap-verify.json')); } catch {}",
    'process.exit(0);',
    '',
  ].join('\n');
  const VERIFY_FAIL = [
    '// fail stub: a red verification with invented acceptance output, then exit 1.',
    "const fs = require('fs');",
    "const path = require('path');",
    "fs.writeFileSync(path.join(process.cwd(), '.run', 'verify.json'),",
    "  JSON.stringify({ acceptanceOutput: 'invented: fixture acceptance tests are red' }));",
    'process.exit(1);',
    '',
  ].join('\n');
  const VERIFY_TAMPER = '// tamper stub: the verifier detected a frozen-path diff.\nprocess.exit(3);\n';

  // ---- C5 wrapper: record every status.js call, fail `set phase`, delegate rest ----
  const WRAPPER_SRC = [
    "'use strict';",
    '// C5 wrapper (fixture): records every invocation to calls.log, exits non-zero',
    '// for `set phase ...`, and delegates everything else to the real status.js',
    '// copied beside it. Proves phase writes are both observed and non-fatal.',
    "const fs = require('fs');",
    "const path = require('path');",
    "const { spawnSync } = require('child_process');",
    'const args = process.argv.slice(2);',
    "fs.appendFileSync(path.join(__dirname, 'calls.log'), JSON.stringify(args) + '\\n');",
    "if (args[0] === 'set' && args[1] === 'phase') {",
    "  console.error('wrapper: refusing set phase (fixture)');",
    '  process.exit(7);',
    '}',
    "const r = spawnSync(process.execPath, [path.join(__dirname, 'status-real.js')].concat(args), { stdio: 'inherit' });",
    'process.exit(r.status === null ? 1 : r.status);',
    '',
  ].join('\n');

  // ---- agent stubs (shell — reached through the PIPELINE_AGENT_CMD `sh -c` seam) ---
  const stubsDir = path.join(tmp, 'stubs');
  fs.mkdirSync(stubsDir, { recursive: true });
  const writeStub = (name, lines) => {
    const p = path.join(stubsDir, name);
    fs.writeFileSync(p, lines.join('\n') + '\n');
    return p;
  };
  // Computed, never hardcoded: a fixed 2020 instant, so the fixture is stable and
  // obviously not the wall clock.
  const RL_EPOCH = Math.floor(Date.UTC(2020, 0, 1, 0, 0, 0) / 1000);
  // The docs prompt is distinguished by its pinned "change summary" wording, exactly
  // as the repo's own entrypoint suite stubs do.
  const agentSnap = writeStub('agent-snap.sh', [
    '# C1 agent stub: snapshot status.json from INSIDE each agent phase (cwd is the workspace).',
    'PROMPT=$(cat)',
    'case "$PROMPT" in',
    '  *"change summary"*)',
    '    cp .run/status.json .run/snap-docs.json',
    "    printf 'Invented docs summary for the fixture task.'",
    '    ;;',
    '  *)',
    '    cp .run/status.json .run/snap-code.json',
    '    echo ok > out.txt',
    '    ;;',
    'esac',
  ]);
  const agentOk = writeStub('agent-ok.sh', [
    '# plain success stub: code phase does invented work, docs phase prints a summary.',
    'PROMPT=$(cat)',
    'case "$PROMPT" in',
    '  *"change summary"*)',
    "    printf 'Invented docs summary for the fixture task.'",
    '    ;;',
    '  *)',
    '    echo ok > out.txt',
    '    ;;',
    'esac',
  ]);
  const agentFail = writeStub('agent-fail.sh', [
    '# fail stub: the agent "works" but verification (stub) will stay red.',
    'cat > /dev/null',
    'echo "invented partial work" >> notes.txt',
  ]);
  const agentRateLimit = writeStub('agent-ratelimit.sh', [
    '# rate-limit stub: the pinned usage-limit shape with a computed epoch.',
    'cat > /dev/null',
    `echo "Claude AI usage limit reached|${RL_EPOCH}"`,
    'exit 1',
  ]);
  const agentDocsFail = writeStub('agent-docsfail.sh', [
    '# docs-fail stub: code phase succeeds, docs phase errors (success must stand).',
    'PROMPT=$(cat)',
    'case "$PROMPT" in',
    '  *"change summary"*) exit 1 ;;',
    '  *) echo ok > out.txt ;;',
    'esac',
  ]);

  // ---- rig builders ----------------------------------------------------------------
  function makeWorkspace(name) {
    const ws = path.join(tmp, name, 'ws');
    const home = path.join(tmp, name, 'home');
    fs.mkdirSync(path.join(ws, '.run'), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    const git = (...a) => spawnSync('git', a,
      { cwd: ws, encoding: 'utf8', timeout: 60000, env: { ...process.env, HOME: home } });
    const i = git('init', '-q');
    const c = git('-c', 'user.email=t@example.invalid', '-c', 'user.name=t',
      'commit', '-q', '--allow-empty', '-m', 'seed');
    if (!i || i.status !== 0 || !c || c.status !== 0) {
      harnessAbort(`git could not build the '${name}' fixture workspace ` +
        `(init exit=${i && i.status}, commit exit=${c && c.status}, ` +
        `stderr=${(((c && c.stderr) || '') + ((i && i.stderr) || '')).trim().slice(0, 200)})`);
    }
    fs.writeFileSync(path.join(ws, '.run', 'issue.md'),
      '# app-777: invented fixture task\n\nCreate out.txt. (Fixture text; no real project is named here.)\n');
    return { ws, home };
  }
  function makePipe(name, verifySrc, opts = {}) {
    const pipe = path.join(tmp, name, 'pipe');
    fs.mkdirSync(pipe, { recursive: true });
    fs.writeFileSync(path.join(pipe, 'envelope.js'), REAL_ENVELOPE);
    fs.writeFileSync(path.join(pipe, 'verify.js'), verifySrc);
    if (opts.wrapPhase) {
      fs.writeFileSync(path.join(pipe, 'status-real.js'), REAL_STATUS);
      fs.writeFileSync(path.join(pipe, 'status.js'), WRAPPER_SRC);
    } else {
      fs.writeFileSync(path.join(pipe, 'status.js'), REAL_STATUS);
    }
    return pipe;
  }
  // The pinned rig: a REPLACED environment of exactly these seven variables.
  function runEp({ ws, home, pipe, agentStub, maxAttempts = 3 }) {
    return spawnSync('bash', [path.join(ROOT, 'pipeline', 'entrypoint.sh')], {
      encoding: 'utf8',
      timeout: 120000,
      env: {
        PATH: process.env.PATH,
        HOME: fwd(home),
        WORKSPACE: fwd(ws),
        PIPELINE_DIR: fwd(pipe),
        ISSUE_ID: 'app-777',
        PIPELINE_AGENT_CMD: `sh ${fwd(agentStub)}`,
        PIPELINE_MAX_ATTEMPTS: String(maxAttempts),
      },
    });
  }

  // ==== C1: the phase is written at each boundary, observed from inside ============
  const c1 = makeWorkspace('c1');
  const c1pipe = makePipe('c1', VERIFY_SNAP_OK);
  const r1 = runEp({ ...c1, pipe: c1pipe, agentStub: agentSnap });
  check(`C1 rig run exits 0 (got ${r1.status}${r1.status === 0 ? '' : `; stderr: ${(r1.stderr || '').trim().slice(0, 200)}`})`,
    r1.status === 0);
  const snapCode = readJson(path.join(c1.ws, '.run', 'snap-code.json'));
  const snapVerify = readJson(path.join(c1.ws, '.run', 'snap-verify.json'));
  const snapDocs = readJson(path.join(c1.ws, '.run', 'snap-docs.json'));
  check('C1 rig: all three in-phase snapshots were taken (code, verify, docs stubs all ran)',
    Boolean(snapCode && snapVerify && snapDocs));
  check(`C1 snapshot taken inside the code phase reads phase "code" (got ${fmt(snapCode && snapCode.phase)})`,
    Boolean(snapCode) && snapCode.phase === 'code');
  check(`C1 snapshot taken inside the verify phase reads phase "verify" (got ${fmt(snapVerify && snapVerify.phase)})`,
    Boolean(snapVerify) && snapVerify.phase === 'verify');
  check(`C1 snapshot taken inside the docs phase reads phase "docs" (got ${fmt(snapDocs && snapDocs.phase)})`,
    Boolean(snapDocs) && snapDocs.phase === 'docs');
  const st1 = readJson(path.join(c1.ws, '.run', 'status.json'));
  check(`C1 final status.json reads phase "docs" (got ${fmt(st1 && st1.phase)})`,
    Boolean(st1) && st1.phase === 'docs');
  const prompt1 = readText(path.join(c1.ws, '.run', 'prompt-1.md'));
  const prompt1First = prompt1 === null ? '' : prompt1.split(/\r?\n/)[0] || '';
  check('C1 the code-phase prompt was captured (prompt-1.md exists)', prompt1 !== null);
  check(`C1 code prompt first line still begins with the pinned "You are implementing one task" header (got ${JSON.stringify(prompt1First.slice(0, 40))})`,
    prompt1First.startsWith('You are implementing one task'));
  check('C1 the phase write is nowhere in the captured prompt (no "set phase" text landed inside the redirect)',
    prompt1 !== null && !prompt1.includes('set phase'));
  notePhase(snapCode); notePhase(snapVerify); notePhase(snapDocs); notePhase(st1);

  // ==== C2: every exit path carries the last phase reached =========================
  // fail (cap 1) -> exit 10, phase "verify"
  const c2f = makeWorkspace('c2-fail');
  const r2f = runEp({ ...c2f, pipe: makePipe('c2-fail', VERIFY_FAIL), agentStub: agentFail, maxAttempts: 1 });
  const st2f = readJson(path.join(c2f.ws, '.run', 'status.json'));
  check(`C2 fail drive (cap 1) exits 10 (got ${r2f.status})`, r2f.status === 10);
  check(`C2 fail drive carries phase "verify" — the last boundary reached (got ${fmt(st2f && st2f.phase)})`,
    Boolean(st2f) && st2f.phase === 'verify');
  notePhase(st2f);
  // tamper (verify stub exits 3) -> exit 11, phase "verify"
  const c2t = makeWorkspace('c2-tamper');
  const r2t = runEp({ ...c2t, pipe: makePipe('c2-tamper', VERIFY_TAMPER), agentStub: agentOk });
  const st2t = readJson(path.join(c2t.ws, '.run', 'status.json'));
  check(`C2 tamper drive exits 11 (got ${r2t.status})`, r2t.status === 11);
  check(`C2 tamper drive carries phase "verify" (got ${fmt(st2t && st2t.phase)})`,
    Boolean(st2t) && st2t.phase === 'verify');
  notePhase(st2t);
  // rate limit -> exit 20, phase "code"
  const c2r = makeWorkspace('c2-ratelimit');
  const r2r = runEp({ ...c2r, pipe: makePipe('c2-ratelimit', VERIFY_FAIL), agentStub: agentRateLimit });
  const st2r = readJson(path.join(c2r.ws, '.run', 'status.json'));
  check(`C2 rate-limit drive exits 20 (got ${r2r.status})`, r2r.status === 20);
  check(`C2 rate-limit drive carries phase "code" (got ${fmt(st2r && st2r.phase)})`,
    Boolean(st2r) && st2r.phase === 'code');
  notePhase(st2r);
  // docs-fail -> exit 0 with docsPhaseError, phase "docs"
  const c2d = makeWorkspace('c2-docsfail');
  const r2d = runEp({ ...c2d, pipe: makePipe('c2-docsfail', VERIFY_OK), agentStub: agentDocsFail });
  const st2d = readJson(path.join(c2d.ws, '.run', 'status.json'));
  check(`C2 docs-fail drive exits 0 (got ${r2d.status})`, r2d.status === 0);
  check('C2 docs-fail drive sets docsPhaseError (success stands)',
    Boolean(st2d) && typeof st2d.docsPhaseError === 'string' && st2d.docsPhaseError.length > 0);
  check(`C2 docs-fail drive carries phase "docs" — written before the docs invocation, not after it (got ${fmt(st2d && st2d.phase)})`,
    Boolean(st2d) && st2d.phase === 'docs');
  notePhase(st2d);
  // the vocabulary is closed
  check(`C2 every observed phase value is one of exactly code|verify|docs (observed: ${JSON.stringify(observedPhases)})`,
    observedPhases.every((v) => VOCAB.includes(v)));

  // ==== C3: a relaunch overwrites a stale phase ====================================
  const c3 = makeWorkspace('c3');
  const r3a = runEp({ ...c3, pipe: makePipe('c3-run1', VERIFY_FAIL), agentStub: agentFail, maxAttempts: 1 });
  const st3a = readJson(path.join(c3.ws, '.run', 'status.json'));
  check(`C3 run 1 (fail, cap 1) exits 10 (got ${r3a.status})`, r3a.status === 10);
  check(`C3 run 1 recorded exactly 1 attempt (got ${st3a && Array.isArray(st3a.attempts) ? st3a.attempts.length : 'no status.json'})`,
    Boolean(st3a) && Array.isArray(st3a.attempts) && st3a.attempts.length === 1);
  check(`C3 run 1 ends with phase "verify" (got ${fmt(st3a && st3a.phase)})`,
    Boolean(st3a) && st3a.phase === 'verify');
  const r3b = runEp({ ...c3, pipe: makePipe('c3-run2', VERIFY_FAIL), agentStub: agentRateLimit, maxAttempts: 3 });
  const st3b = readJson(path.join(c3.ws, '.run', 'status.json'));
  check(`C3 run 2 (rate-limit, cap 3) exits 20 (got ${r3b.status})`, r3b.status === 20);
  check(`C3 run 2 overwrites the stale phase: status.json now reads "code" (got ${fmt(st3b && st3b.phase)})`,
    Boolean(st3b) && st3b.phase === 'code');
  check(`C3 run 2 leaves attempts.length still 1 — an interruption is not an attempt (got ${st3b && Array.isArray(st3b.attempts) ? st3b.attempts.length : 'no status.json'})`,
    Boolean(st3b) && Array.isArray(st3b.attempts) && st3b.attempts.length === 1);
  notePhase(st3a); notePhase(st3b);

  // ==== C4: the key is allowlisted and the schema stays additive ===================
  const c4rd = path.join(tmp, 'c4-run');
  fs.mkdirSync(c4rd, { recursive: true });
  const statusCmd = (args) => spawnSync(process.execPath,
    [path.join(ROOT, 'pipeline', 'status.js'), ...args],
    { encoding: 'utf8', timeout: 60000, env: { ...process.env, RUN_DIR: c4rd } });
  const rInit = statusCmd(['init', 'x']);
  check(`C4 'init x' against a temp RUN_DIR exits 0 (got ${rInit.status})`, rInit.status === 0);
  const rSet = statusCmd(['set', 'phase', 'code']);
  check(`C4 'set phase code' exits 0 — the key is allowlisted (set phase exited ${rSet.status})`, rSet.status === 0);
  const c4st = readJson(path.join(c4rd, 'status.json'));
  check(`C4 status.json then parses with .phase === "code" (got ${fmt(c4st && c4st.phase)})`,
    Boolean(c4st) && c4st.phase === 'code');
  const rTypo = statusCmd(['set', 'phaze', 'code']);
  check(`C4 'set phaze code' still exits 2 — the allowlist is exact (got ${rTypo.status})`, rTypo.status === 2);
  const schema = readJson(path.join(ROOT, 'schemas', 'status.schema.json'));
  check('C4 schemas/status.schema.json parses as JSON', Boolean(schema));
  const phaseProp = schema && schema.properties && schema.properties.phase;
  check(`C4 schema properties.phase exists with enum exactly ["code","verify","docs"] (got ${JSON.stringify(phaseProp && phaseProp.enum)})`,
    Boolean(phaseProp) && JSON.stringify(phaseProp.enum) === JSON.stringify(VOCAB));
  check(`C4 schema required is still exactly ["issueId","attempts"] — phase is optional (got ${JSON.stringify(schema && schema.required)})`,
    Boolean(schema) && JSON.stringify(schema.required) === JSON.stringify(['issueId', 'attempts']));
  check('C4 schema additionalProperties is still false',
    Boolean(schema) && schema.additionalProperties === false);
  // The inline admitter: driven by the schema AS READ FROM DISK, and proven able to
  // fail by the four enumerated probes (an admitter that ignores the enum, or one
  // that rejects everything, fails at least one of them).
  function admit(obj, sch) {
    if (!sch || typeof obj !== 'object' || obj === null || Array.isArray(obj)) return false;
    const props = sch.properties || {};
    for (const k of sch.required || []) if (!(k in obj)) return false;
    if (sch.additionalProperties === false) {
      for (const k of Object.keys(obj)) if (!Object.prototype.hasOwnProperty.call(props, k)) return false;
    }
    for (const k of Object.keys(obj)) {
      const p = props[k];
      if (p && Array.isArray(p.enum) && !p.enum.includes(obj[k])) return false;
    }
    return true;
  }
  const oldShaped = { issueId: 'x', attempts: [] };
  check('C4 admitter admits an old-shaped status file without phase (old artifacts stay valid)',
    admit(oldShaped, schema) === true);
  check('C4 admitter admits the same file with phase "docs"',
    admit({ ...oldShaped, phase: 'docs' }, schema) === true);
  check('C4 admitter rejects phase "review" — the enum is real',
    admit({ ...oldShaped, phase: 'review' }, schema) === false);
  check('C4 admitter rejects an unknown key — additionalProperties is real',
    admit({ ...oldShaped, zzInventedKey: 1 }, schema) === false);

  // ==== C5: phase writes cannot fail a task ========================================
  const c5 = makeWorkspace('c5');
  const c5pipe = makePipe('c5', VERIFY_OK, { wrapPhase: true });
  const r5 = runEp({ ...c5, pipe: c5pipe, agentStub: agentOk });
  const callLines = (readText(path.join(c5pipe, 'calls.log')) || '').split(/\r?\n/).filter(Boolean);
  const calls = callLines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  check('C5 rig: the recording wrapper observed status.js invocations (init seen, delegation works)',
    calls.some((a) => a[0] === 'init'));
  const st5 = readJson(path.join(c5.ws, '.run', 'status.json'));
  check('C5 rig: a pass attempt was recorded through the wrapper',
    Boolean(st5) && Array.isArray(st5.attempts) && st5.attempts.length === 1 && st5.attempts[0].verifierResult === 'pass');
  check(`C5 task still reaches its normal exit 0 while every 'set phase' write fails (got ${r5.status})`,
    r5.status === 0);
  const phaseCalls = calls.filter((a) => a[0] === 'set' && a[1] === 'phase');
  check(`C5 at least one 'set phase' invocation was observed during the run (observed ${phaseCalls.length})`,
    phaseCalls.length >= 1);
} catch (e) {
  failed = 1;
  if (!(e && e.message === 'harness-abort')) {
    console.log(`FAIL - HARNESS BROKEN: unexpected exception: ${e && e.stack ? e.stack : e}`);
  }
} finally {
  // Cleanup is never a verdict: best effort, and a second pass clears the read-only
  // bits git leaves on object files (Windows unlink refuses them).
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    try {
      (function unhide(d) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          try { fs.chmodSync(p, 0o700); } catch { /* keep going */ }
          if (e.isDirectory()) unhide(p);
        }
      })(tmp);
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch { /* leftover temp is not a test result */ }
  }
}
process.exit(failed);
