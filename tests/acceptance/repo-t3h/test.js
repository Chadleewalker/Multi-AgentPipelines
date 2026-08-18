// Frozen acceptance test — the per-task cost record `modelTokens` (planning draft
// 2026-08-18, Task 1; design-ref DESIGN.md §4.3, §4.11, change-log row `task-cost`).
// Written before implementation, from the spec alone; criteria C1–C6 map 1:1 to the
// issue's "Done means" list. Plain Node, Docker-free, self-contained: nothing here
// require()s repo code except `runner/report.js` and `runner/run.js`, whose seams are
// the only Docker-free way to reach the manifest task row at all. pipeline/status.js
// and pipeline/envelope.js are exercised as CHILD PROCESSES through runtime COPIES in
// a temp PIPELINE_DIR, beside a stub verify.js — never the real verifier, which would
// re-invoke this very acceptance runner from inside itself and self-nest.
//
// THE RIG (pinned by the spec, because this test also runs inside a live task
// container): the entrypoint child is spawned as `bash pipeline/entrypoint.sh` with a
// REPLACED environment of exactly PATH, HOME, WORKSPACE, PIPELINE_DIR, ISSUE_ID,
// PIPELINE_AGENT_CMD and PIPELINE_MAX_ATTEMPTS — never the inherited environment,
// which inside a container names the live run's own /workspace. bash is probed first
// and its absence aborts loudly (the repo-jur harness-gate shape). Every stub is
// reached through an EXPLICIT INTERPRETER: the agent stub is a .js file invoked as
// `<process.execPath> <stub.js> <spec.json>` through the PIPELINE_AGENT_CMD seam, and
// the verify stubs are .js files the entrypoint already runs as `node "$PIPE/verify.js"`.
// A bare exec of a `#!/bin/sh` file fails with EFTYPE on the Windows reference host.
//
// Criteria:
//   C1  every invocation contributes and repeated invocations accumulate: three
//       invocations (two code attempts + docs) over disjoint model keys, each of the
//       four count keys pinned to a different value; the record holds the exact
//       per-key sums for the code model, the docs model's own figures, and exactly
//       those two keys.
//   C2  capture happens BEFORE flatten destroys the envelope: agent-1.log ends up
//       flattened with `modelUsage` nowhere in it, AND the code-phase model's key
//       carries exactly its fixture value. Disjoint keys are what make this
//       discriminating — a host-side reader of the collected logs would find the docs
//       figures and none of the code ones, so a non-zero TOTAL proves nothing.
//   C3  absence is legal, degenerate input is legal, and the write can never fail a
//       task: five drives (no envelope; empty modelUsage; non-object modelUsage;
//       missing/string/null counts; a status.js wrapper that fails every `tokens`
//       call), plus an inline admitter — never ajv.
//   C4  both schema changes are additive: one property each in status.schema.json and
//       run.schema.json, `required` and `additionalProperties` unmoved in both, the
//       historical shape and the checked-in example still admitted, and the admitter
//       proven able to reject.
//   C5  the manifest and report carry it as evidence and it moves nothing: the runner
//       task row spreads it verbatim when present and omits the key when absent; the
//       report renders the pinned `Tokens:` line immediately after `Model:` and
//       nothing when the record is absent; regeneration is byte-identical; byScrutiny
//       produces an identical order with and without every modelTokens field.
//   C6  accumulation survives a rate-limit relaunch (one workspace, two containers,
//       the first ending at exit 20 AFTER recording) and keys are written sorted
//       (`z-model` introduced before `a-model` must come back a-, then z-).
//
// Every fixture value is invented (issue id `app-777`, invented model ids and
// summaries); the rate-limit epoch is computed from Date.UTC, never hardcoded; every
// parsed file is split on /\r?\n/; all temp dirs live under os.tmpdir() via
// mkdtempSync and are removed in a finally. Nothing depends on chmod, so the same file
// passes on the Windows host and in the Linux container.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const fwd = (p) => p.split(path.sep).join('/');
const q = (p) => `"${fwd(p)}"`;

let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) failed = 1;
}
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const show = (v) => JSON.stringify(v);

// ---- the pinned fixture numbers ---------------------------------------------------
// Each of the four count keys carries a DIFFERENT value, so an implementation that
// records only `outputTokens` — the one field this repo already reads, and therefore
// the likeliest thing to ship — cannot pass by accident.
const CODE_MODEL = 'fixture-code-model';
const DOCS_MODEL = 'fixture-docs-model';
const CODE_1 = { inputTokens: 900, outputTokens: 100, cacheReadInputTokens: 9000, cacheCreationInputTokens: 30 };
const CODE_2 = { inputTokens: 20, outputTokens: 7, cacheReadInputTokens: 200, cacheCreationInputTokens: 3 };
const DOCS_1 = { inputTokens: 5, outputTokens: 11, cacheReadInputTokens: 50, cacheCreationInputTokens: 1 };
const CODE_SUM = { inputTokens: 920, outputTokens: 107, cacheReadInputTokens: 9200, cacheCreationInputTokens: 33 };
const COUNT_KEYS = ['inputTokens', 'outputTokens', 'cacheReadInputTokens', 'cacheCreationInputTokens'];
// A fixed 2020 instant: stable, and obviously not the wall clock.
const RL_EPOCH = Math.floor(Date.UTC(2020, 0, 1, 0, 0, 0) / 1000);

function checkCounts(label, got, want) {
  const ok = got && typeof got === 'object' && !Array.isArray(got);
  check(`${label}: the per-model value is an object (got ${show(got)})`, Boolean(ok));
  if (!ok) return;
  for (const k of COUNT_KEYS) {
    check(`${label}: ${k} is exactly ${want[k]} (got ${show(got[k])})`, got[k] === want[k]);
  }
  check(`${label}: the value carries exactly the four pinned count keys (got ${show(Object.keys(got).sort())})`,
    show(Object.keys(got).slice().sort()) === show(COUNT_KEYS.slice().sort()));
}

// ---- harness gate: bash must exist, or the exec path fails silently ---------------
const probe = spawnSync('bash', ['-c', 'echo repo-t3h-bash-probe'], { encoding: 'utf8', timeout: 60000 });
const bashOk = Boolean(!probe.error && probe.status === 0 && (probe.stdout || '').includes('repo-t3h-bash-probe'));
check('harness: bash is available to run pipeline/entrypoint.sh', bashOk);
if (!bashOk) {
  console.log('FAIL - HARNESS BROKEN: no usable bash on PATH, so the entrypoint rig cannot');
  console.log('       run at all. Refusing to report feature failures that would really be');
  console.log(`       harness failures. error=${probe.error || ''} exit=${probe.status} stderr=${(probe.stderr || '').trim()}`);
  process.exit(1);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-t3h-'));
function harnessAbort(msg) {
  console.log(`FAIL - HARNESS BROKEN: ${msg}`);
  throw new Error('harness-abort');
}

// ---- the inline admitter (repo-1cy / repo-teq precedent: never ajv) ---------------
// Driven by each schema AS READ FROM DISK. Deliberately partial — it enforces
// required, additionalProperties, enums and scalar types, which is exactly what an
// additive change can break — and its four negative probes below are what prove it is
// a real check rather than a function that returns true.
function admit(obj, sch) {
  if (!sch || typeof sch !== 'object') return true;
  if (sch.properties || sch.type === 'object') {
    if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) return false;
    const props = sch.properties || {};
    for (const k of sch.required || []) if (!(k in obj)) return false;
    if (sch.additionalProperties === false) {
      for (const k of Object.keys(obj)) if (!Object.prototype.hasOwnProperty.call(props, k)) return false;
    }
    for (const k of Object.keys(obj)) {
      if (Object.prototype.hasOwnProperty.call(props, k) && !admit(obj[k], props[k])) return false;
    }
    return true;
  }
  if (sch.items || sch.type === 'array') {
    if (!Array.isArray(obj)) return false;
    for (const it of obj) if (sch.items && !admit(it, sch.items)) return false;
    return true;
  }
  if (Array.isArray(sch.enum)) return sch.enum.includes(obj);
  if (sch.type === 'string') return typeof obj === 'string';
  if (sch.type === 'integer') return Number.isInteger(obj);
  if (sch.type === 'number') return typeof obj === 'number' && Number.isFinite(obj);
  if (sch.type === 'boolean') return typeof obj === 'boolean';
  return true;   // union or unconstrained types are not this test's business
}

try {
  const REAL_STATUS = fs.readFileSync(path.join(ROOT, 'pipeline', 'status.js'), 'utf8');
  const REAL_ENVELOPE = fs.readFileSync(path.join(ROOT, 'pipeline', 'envelope.js'), 'utf8');

  // ---- stub sources ---------------------------------------------------------------
  const AGENT_STUB = [
    "'use strict';",
    '// Fixture agent stub. Reached through the PIPELINE_AGENT_CMD seam as',
    '// `<node> <this file> <spec.json>` — an explicit interpreter, always.',
    '// The spec file says what to emit for each invocation; a per-spec .state file',
    '// carries the code-invocation counter across the entrypoint retry loop AND across',
    '// a relaunch, exactly as a real CLI would be called again.',
    "const fs = require('fs');",
    "const path = require('path');",
    'const specPath = process.argv[2];',
    "const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));",
    "let prompt = '';",
    "try { prompt = fs.readFileSync(0, 'utf8'); } catch { prompt = ''; }",
    "// The docs prompt is distinguished by its pinned 'change summary' wording, exactly",
    "// as the repo's own entrypoint suite stubs do.",
    "const isDocs = prompt.indexOf('change summary') !== -1;",
    "const statePath = specPath + '.state';",
    'let n = 0;',
    "try { n = JSON.parse(fs.readFileSync(statePath, 'utf8')).n; } catch { n = 0; }",
    'let entry;',
    'if (isDocs) {',
    '  entry = spec.docs;',
    '} else {',
    '  n += 1;',
    '  fs.writeFileSync(statePath, JSON.stringify({ n: n }));',
    '  entry = spec.code[n - 1] !== undefined ? spec.code[n - 1] : spec.code[spec.code.length - 1];',
    "  fs.writeFileSync(path.join(process.cwd(), 'out.txt'), 'invented fixture work ' + n + '\\n');",
    '}',
    "if (!entry) { process.stdout.write('invented plain output'); process.exit(0); }",
    "if (entry.kind === 'ratelimit') {",
    "  process.stdout.write('Claude AI usage limit reached|' + entry.epoch + '\\n');",
    '  process.exit(1);',
    '}',
    "if (entry.kind === 'plain') {",
    "  process.stdout.write(entry.result || 'invented plain output');",
    '  process.exit(0);',
    '}',
    '// A noise line first, exactly as the CLI prints one, so the bottom-up envelope',
    '// scan is exercised rather than assumed.',
    "process.stdout.write('warning: invented CLI noise line the reader must skip\\n');",
    "const env = { type: 'result', result: entry.result || 'invented result text' };",
    "if (!entry.omitUsage) env.modelUsage = entry.modelUsage;",
    "process.stdout.write(JSON.stringify(env) + '\\n');",
    'process.exit(0);',
    '',
  ].join('\n');

  const VERIFY_OK = 'process.exit(0);\n';
  const VERIFY_FAIL_ONCE = [
    '// Fails the first call, passes every later one, so one drive produces two code',
    '// invocations plus the docs invocation.',
    "const fs = require('fs');",
    "const path = require('path');",
    "const marker = path.join(__dirname, 'verify-count.json');",
    'let n = 0;',
    "try { n = JSON.parse(fs.readFileSync(marker, 'utf8')).n; } catch { n = 0; }",
    'n += 1;',
    'fs.writeFileSync(marker, JSON.stringify({ n: n }));',
    'if (n === 1) {',
    "  fs.writeFileSync(path.join(process.cwd(), '.run', 'verify.json'),",
    "    JSON.stringify({ acceptanceOutput: 'invented: fixture acceptance tests are red on attempt 1' }));",
    '  process.exit(1);',
    '}',
    'process.exit(0);',
    '',
  ].join('\n');
  const VERIFY_FAIL = [
    "const fs = require('fs');",
    "const path = require('path');",
    "fs.writeFileSync(path.join(process.cwd(), '.run', 'verify.json'),",
    "  JSON.stringify({ acceptanceOutput: 'invented: fixture acceptance tests are red' }));",
    'process.exit(1);',
    '',
  ].join('\n');

  // C3(e): records every status.js call, fails `tokens`, delegates everything else.
  const WRAPPER_SRC = [
    "'use strict';",
    "const fs = require('fs');",
    "const path = require('path');",
    "const { spawnSync } = require('child_process');",
    'const args = process.argv.slice(2);',
    "fs.appendFileSync(path.join(__dirname, 'calls.log'), JSON.stringify(args) + '\\n');",
    "if (args[0] === 'tokens') {",
    "  console.error('wrapper: refusing tokens (fixture)');",
    '  process.exit(7);',
    '}',
    "const r = spawnSync(process.execPath, [path.join(__dirname, 'status-real.js')].concat(args), { stdio: 'inherit' });",
    'process.exit(r.status === null ? 1 : r.status);',
    '',
  ].join('\n');

  // ---- rig builders ----------------------------------------------------------------
  const stubJs = path.join(tmp, 'agent-stub.js');
  fs.writeFileSync(stubJs, AGENT_STUB);

  function writeSpec(name, spec) {
    const p = path.join(tmp, `spec-${name}.json`);
    fs.writeFileSync(p, JSON.stringify(spec, null, 2));
    return p;
  }
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
        `(init exit=${i && i.status}, commit exit=${c && c.status})`);
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
    if (opts.wrapTokens) {
      fs.writeFileSync(path.join(pipe, 'status-real.js'), REAL_STATUS);
      fs.writeFileSync(path.join(pipe, 'status.js'), WRAPPER_SRC);
    } else {
      fs.writeFileSync(path.join(pipe, 'status.js'), REAL_STATUS);
    }
    return pipe;
  }
  // The pinned rig: a REPLACED environment of exactly these seven variables.
  function runEp({ ws, home, pipe, specPath, maxAttempts = 3 }) {
    return spawnSync('bash', [path.join(ROOT, 'pipeline', 'entrypoint.sh')], {
      encoding: 'utf8',
      timeout: 180000,
      env: {
        PATH: process.env.PATH,
        HOME: fwd(home),
        WORKSPACE: fwd(ws),
        PIPELINE_DIR: fwd(pipe),
        ISSUE_ID: 'app-777',
        PIPELINE_AGENT_CMD: `${q(process.execPath)} ${q(stubJs)} ${q(specPath)}`,
        PIPELINE_MAX_ATTEMPTS: String(maxAttempts),
      },
    });
  }
  // One drive, end to end: build the workspace, the pipe and the spec, run, read back.
  function drive(name, { code, docs, verify = VERIFY_OK, maxAttempts = 3, opts = {} }) {
    const w = makeWorkspace(name);
    const pipe = makePipe(name, verify, opts);
    const specPath = writeSpec(name, { code, docs });
    const r = runEp({ ...w, pipe, specPath, maxAttempts });
    return { ...w, pipe, specPath, r, status: readJson(path.join(w.ws, '.run', 'status.json')) };
  }
  const envelope = (modelUsage, result) => ({ kind: 'envelope', modelUsage, result: result || 'invented result text' });
  const plain = (result) => ({ kind: 'plain', result: result || 'invented plain output' });

  // ==== C1: every invocation contributes, and repeated invocations accumulate =======
  {
    const d = drive('c1', {
      code: [envelope({ [CODE_MODEL]: CODE_1 }), envelope({ [CODE_MODEL]: CODE_2 })],
      docs: envelope({ [DOCS_MODEL]: DOCS_1 }, 'Invented docs summary for the fixture task.'),
      verify: VERIFY_FAIL_ONCE,
    });
    check(`C1 rig run exits 0 (got ${d.r.status}; stderr: ${(d.r.stderr || '').trim().slice(0, 200)})`, d.r.status === 0);
    check(`C1 rig: exactly two verify attempts were recorded — two code invocations happened (got ${d.status && Array.isArray(d.status.attempts) ? d.status.attempts.length : 'no status.json'})`,
      Boolean(d.status) && Array.isArray(d.status.attempts) && d.status.attempts.length === 2);
    const mt = d.status && d.status.modelTokens;
    check(`C1 status.json carries a modelTokens object (got ${show(mt)})`,
      Boolean(mt) && typeof mt === 'object' && !Array.isArray(mt));
    check(`C1 modelTokens holds exactly the two fixture model keys (got ${show(mt && Object.keys(mt))})`,
      Boolean(mt) && show(Object.keys(mt).slice().sort()) === show([CODE_MODEL, DOCS_MODEL].slice().sort()));
    checkCounts('C1 code-phase model accumulates across both code invocations', mt && mt[CODE_MODEL], CODE_SUM);
    checkCounts('C1 docs-phase model carries its own figures alone', mt && mt[DOCS_MODEL], DOCS_1);
  }

  // ==== C2: capture happens before flatten destroys the envelope ====================
  {
    const d = drive('c2', {
      code: [envelope({ [CODE_MODEL]: CODE_1 }, 'Invented code result the flatten step must leave behind.')],
      docs: envelope({ [DOCS_MODEL]: DOCS_1 }, 'Invented docs summary for the fixture task.'),
    });
    check(`C2 rig run exits 0 (got ${d.r.status}; stderr: ${(d.r.stderr || '').trim().slice(0, 200)})`, d.r.status === 0);
    const log1 = readText(path.join(d.ws, '.run', 'agent-1.log'));
    check('C2 agent-1.log exists', log1 !== null);
    check(`C2 agent-1.log was flattened — the string "modelUsage" is nowhere in it (existing contract, unregressed)`,
      log1 !== null && !log1.includes('modelUsage'));
    check('C2 agent-1.log carries the plain result text the envelope wrapped',
      log1 !== null && log1.includes('Invented code result the flatten step must leave behind.'));
    const mt = d.status && d.status.modelTokens;
    check(`C2 the CODE-phase model's key is present — capture happened before the flatten (got ${show(mt && Object.keys(mt))})`,
      Boolean(mt) && Object.prototype.hasOwnProperty.call(mt, CODE_MODEL));
    checkCounts('C2 the code-phase model carries exactly its fixture value', mt && mt[CODE_MODEL], CODE_1);
  }

  // ==== C3: absence is legal, degenerate input is legal, the write cannot fail ======
  const statusSchema = readJson(path.join(ROOT, 'schemas', 'status.schema.json'));
  check('C3/C4 schemas/status.schema.json parses as JSON', Boolean(statusSchema));
  {
    // (a) no envelope at all
    const a = drive('c3a', { code: [plain()], docs: plain('Invented docs summary.') });
    check(`C3a a run with no envelope exits 0 (got ${a.r.status})`, a.r.status === 0);
    check(`C3a modelTokens is ABSENT — not {}, not null (got ${show(a.status && a.status.modelTokens)}, key present: ${Boolean(a.status) && Object.prototype.hasOwnProperty.call(a.status, 'modelTokens')})`,
      Boolean(a.status) && !Object.prototype.hasOwnProperty.call(a.status, 'modelTokens'));
    check('C3a the resulting status.json is admitted by the schema as read from disk',
      Boolean(a.status) && admit(a.status, statusSchema) === true);

    // (b) modelUsage present but empty
    const b = drive('c3b', { code: [envelope({})], docs: envelope({}) });
    check(`C3b an empty modelUsage table leaves modelTokens absent (got ${show(b.status && b.status.modelTokens)})`,
      Boolean(b.status) && !Object.prototype.hasOwnProperty.call(b.status, 'modelTokens'));

    // (c) modelUsage present but not an object
    const c = drive('c3c', { code: [envelope('not-an-object')], docs: envelope('not-an-object') });
    check(`C3c a non-object modelUsage leaves modelTokens absent (got ${show(c.status && c.status.modelTokens)})`,
      Boolean(c.status) && !Object.prototype.hasOwnProperty.call(c.status, 'modelTokens'));

    // (d) missing, string and null counts — the NaN trap
    const GOOD = { inputTokens: 10, outputTokens: 10, cacheReadInputTokens: 10, cacheCreationInputTokens: 10 };
    const GARBAGE = { inputTokens: '12', outputTokens: null, cacheCreationInputTokens: {} };
    const d = drive('c3d', {
      code: [envelope({ 'fixture-degenerate-model': GOOD }), envelope({ 'fixture-degenerate-model': GARBAGE })],
      docs: plain('Invented docs summary.'),
      verify: VERIFY_FAIL_ONCE,
    });
    check(`C3d the degenerate-count run exits 0 (got ${d.r.status})`, d.r.status === 0);
    const dmt = d.status && d.status.modelTokens;
    checkCounts('C3d a garbage envelope adds zero and leaves the earlier accumulation intact',
      dmt && dmt['fixture-degenerate-model'], GOOD);
    const dText = readText(path.join(d.ws, '.run', 'status.json')) || '';
    const dValues = dmt ? Object.values(dmt).flatMap((v) => Object.values(v || {})) : [];
    check(`C3d every recorded count is a finite number (got ${show(dValues)})`,
      dValues.length > 0 && dValues.every((n) => typeof n === 'number' && Number.isFinite(n)));
    check('C3d no null was serialised where a count belongs',
      !/"(inputTokens|outputTokens|cacheReadInputTokens|cacheCreationInputTokens)"\s*:\s*null/.test(dText));

    // (e) a status.js that fails every `tokens` call must not fail the task
    const e = drive('c3e', {
      code: [envelope({ [CODE_MODEL]: CODE_1 })],
      docs: envelope({ [DOCS_MODEL]: DOCS_1 }, 'Invented docs summary.'),
      opts: { wrapTokens: true },
    });
    const callLines = (readText(path.join(e.pipe, 'calls.log')) || '').split(/\r?\n/).filter(Boolean);
    const calls = callLines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    check('C3e rig: the recording wrapper observed status.js invocations (init seen, delegation works)',
      calls.some((x) => x[0] === 'init'));
    check(`C3e the task still reaches exit 0 while every 'tokens' call fails (got ${e.r.status})`, e.r.status === 0);
    const tokenCalls = calls.filter((x) => x[0] === 'tokens');
    check(`C3e at least one 'tokens' invocation was observed during the run (observed ${tokenCalls.length})`,
      tokenCalls.length >= 1);
  }

  // ==== C4: both schema changes are additive =======================================
  {
    const runSchema = readJson(path.join(ROOT, 'schemas', 'run.schema.json'));
    check('C4 schemas/run.schema.json parses as JSON', Boolean(runSchema));
    const sProps = (statusSchema && statusSchema.properties) || {};
    const rowSchema = runSchema && runSchema.properties && runSchema.properties.tasks
      && runSchema.properties.tasks.items;
    const rProps = (rowSchema && rowSchema.properties) || {};
    check('C4 status.schema.json gains properties.modelTokens',
      Object.prototype.hasOwnProperty.call(sProps, 'modelTokens'));
    check('C4 run.schema.json gains modelTokens on the task row',
      Object.prototype.hasOwnProperty.call(rProps, 'modelTokens'));
    check(`C4 status.schema.json required is still exactly ["issueId","attempts"] (got ${show(statusSchema && statusSchema.required)})`,
      Boolean(statusSchema) && show(statusSchema.required) === show(['issueId', 'attempts']));
    check('C4 status.schema.json additionalProperties is still false',
      Boolean(statusSchema) && statusSchema.additionalProperties === false);
    check(`C4 the run task row's required is still exactly ["issueId","outcome"] (got ${show(rowSchema && rowSchema.required)})`,
      Boolean(rowSchema) && show(rowSchema.required) === show(['issueId', 'outcome']));
    check('C4 the run task row\'s additionalProperties is still false',
      Boolean(rowSchema) && rowSchema.additionalProperties === false);

    const historical = { issueId: 'app-777', attempts: [], model: 'fixture-code-model' };
    const withRecord = { ...historical, modelTokens: { [CODE_MODEL]: CODE_1 } };
    check('C4 admitter admits a historical status object carrying no modelTokens',
      admit(historical, statusSchema) === true);
    check('C4 admitter admits the checked-in schemas/examples/status.valid.json',
      admit(readJson(path.join(ROOT, 'schemas', 'examples', 'status.valid.json')), statusSchema) === true);
    check('C4 admitter admits the same status object WITH a well-formed modelTokens record',
      admit(withRecord, statusSchema) === true);
    check('C4 admitter rejects an unknown status key — additionalProperties is real',
      admit({ ...historical, zzInventedKey: 1 }, statusSchema) === false);
    const row = { issueId: 'app-777', outcome: 'done', modelTokens: { [CODE_MODEL]: CODE_1 } };
    check('C4 admitter admits a manifest task row carrying modelTokens',
      admit(row, rowSchema) === true);
    check('C4 admitter rejects an unknown task-row key — additionalProperties is real',
      admit({ ...row, zzInventedKey: 1 }, rowSchema) === false);
  }

  // ==== C5: the manifest and report carry it as evidence, and it moves nothing ======
  let c5manifest = null;
  {
    let report = null;
    try { report = require(path.join(ROOT, 'runner', 'report.js')); } catch { report = null; }
    check('C5 runner/report.js is requirable and exports renderReport + byScrutiny',
      Boolean(report) && typeof report.renderReport === 'function' && typeof report.byScrutiny === 'function');
    if (report && typeof report.renderReport === 'function') {
      const base = {
        runId: 'run-fixture', startedAt: '2020-01-01T00:00:00.000Z', finishedAt: '2020-01-01T01:00:00.000Z',
        tasks: [{
          issueId: 'app-777', title: 'invented fixture task', outcome: 'done', attempts: 1,
          model: CODE_MODEL, modelTokens: { [CODE_MODEL]: CODE_SUM, [DOCS_MODEL]: DOCS_1 },
        }],
      };
      const lines = report.renderReport(base).split(/\r?\n/);
      // Totals summed across every model in the record: 920+5 in, 107+11 out, 9200+50 cached.
      const WANT = `- Tokens: ${920 + 5} in / ${107 + 11} out / ${9200 + 50} cached`;
      const iModel = lines.indexOf(`- Model: ${CODE_MODEL}`);
      const iTokens = lines.indexOf(WANT);
      check(`C5 the report still renders the Model fact line (index ${iModel})`, iModel !== -1);
      check(`C5 the report renders the pinned line ${show(WANT)} (index ${iTokens})`, iTokens !== -1);
      check(`C5 the Tokens line sits immediately after the Model line (model ${iModel}, tokens ${iTokens})`,
        iModel !== -1 && iTokens === iModel + 1);
      const bare = { ...base, tasks: [{ ...base.tasks[0] }] };
      delete bare.tasks[0].modelTokens;
      check('C5 a task with no record renders no Tokens line at all',
        !/^- Tokens:/m.test(report.renderReport(bare)));
      check('C5 regeneration from one manifest is byte-identical',
        report.renderReport(base) === report.renderReport(base));

      // byScrutiny must be blind to the record: same order with and without it.
      const many = [
        { issueId: 'app-a', outcome: 'done', attempts: 1, diffLines: 5, modelTokens: { m: CODE_1 } },
        { issueId: 'app-b', outcome: 'done', attempts: 3, diffLines: 900, modelTokens: { m: CODE_2 } },
        { issueId: 'app-c', outcome: 'stuck', attempts: 3, diffLines: 1, modelTokens: { m: DOCS_1 } },
        { issueId: 'app-d', outcome: 'tampered', attempts: 1, diffLines: 0, modelTokens: { m: CODE_SUM } },
        { issueId: 'app-e', outcome: 'partial', attempts: 2, diffLines: 40, modelTokens: { m: CODE_1 } },
      ];
      const stripped = many.map((t) => { const c = { ...t }; delete c.modelTokens; return c; });
      const orderWith = [...many].sort(report.byScrutiny).map((t) => t.issueId).join(',');
      const orderWithout = [...stripped].sort(report.byScrutiny).map((t) => t.issueId).join(',');
      check(`C5 byScrutiny produces an identical order with and without every modelTokens field (${orderWith} vs ${orderWithout})`,
        orderWith === orderWithout);
    }

    // The manifest half: drive runOneTask through its seams (no Docker), once with a
    // container status file carrying the record and once without.
    const runJs = path.join(ROOT, 'runner', 'run.js');
    const keyProbe = spawnSync(process.execPath,
      ['-e', 'const m = require(process.argv[1]); process.stdout.write(JSON.stringify(Object.keys(m||{})));', runJs],
      { encoding: 'utf8', timeout: 60000 });
    let runKeys = null;
    try { runKeys = JSON.parse(keyProbe.stdout || 'null'); } catch { runKeys = null; }
    check('C5 runner/run.js exports runOneTask', Array.isArray(runKeys) && runKeys.includes('runOneTask'));
    let runmod = null;
    if (keyProbe.status === 0) { try { runmod = require(runJs); } catch { runmod = null; } }

    async function rowFor(name, statusObj) {
      const dir = path.join(tmp, `c5-${name}`);
      const remote = path.join(dir, 'remote.git');
      const seed = path.join(dir, 'seed');
      fs.mkdirSync(seed, { recursive: true });
      const g = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 60000 });
      spawnSync('git', ['init', '-q', '--bare', '-b', 'main', remote], { encoding: 'utf8', timeout: 60000 });
      g(seed, ['init', '-q', '-b', 'main', seed]);
      fs.writeFileSync(path.join(seed, 'README.md'), 'seed\n');
      fs.writeFileSync(path.join(seed, 'pipeline.config.json'), JSON.stringify({
        verifyCommand: 'sh tools/run-acceptance.sh', defaultBranch: 'main', frozenPaths: [], dependencies: {},
      }, null, 2));
      g(seed, ['add', '-A']);
      g(seed, ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', 'seed']);
      g(seed, ['remote', 'add', 'origin', remote]);
      g(seed, ['push', '-q', 'origin', 'main']);

      const statusSrc = path.join(dir, 'status-src.json');
      fs.writeFileSync(statusSrc, JSON.stringify(statusObj, null, 2) + '\n');
      const verifySrc = path.join(dir, 'verify-src.json');
      fs.writeFileSync(verifySrc, JSON.stringify({ acceptance: 'pass', regressions: 'absent' }) + '\n');
      // `bash <stub>` is the seam's own pinned invocation — an explicit interpreter.
      const execStub = path.join(dir, 'exec-stub.sh');
      fs.writeFileSync(execStub, [
        'mkdir -p "$RUN_DIR"',
        'cp "$STUB_STATUS_SRC" "$RUN_DIR/status.json"',
        'cp "$STUB_VERIFY_SRC" "$RUN_DIR/verify.json"',
        'exit 0',
        '',
      ].join('\n'));
      const bdStub = path.join(dir, 'bd-stub.js');
      fs.writeFileSync(bdStub, [
        "'use strict';",
        "const sfs = require('fs');",
        'const a = process.argv.slice(1).map(String);',
        "const sub = a.map((s) => s.replace(/\\\\/g, '/').split('/').pop());",
        "if (sub.includes('show')) {",
        '  sfs.writeSync(1, JSON.stringify([{ id: process.env.BD_ISSUE_ID, title: "invented fixture task",',
        '    description: "d", acceptance_criteria: "a", design: "DESIGN.md 4.11" }]));',
        "} else { sfs.writeSync(1, '[]'); }",
        'process.exit(0);',
        '',
      ].join('\n'));
      const ghStub = path.join(dir, 'gh-stub.js');
      fs.writeFileSync(ghStub, "'use strict';process.exit(0);\n");

      const saved = {
        bd: process.env.PIPELINE_BD_CMD, node: process.env.NODE_OPTIONS,
        exec: process.env.PIPELINE_EXEC_STUB, gh: process.env.PIPELINE_GH_CMD,
        id: process.env.BD_ISSUE_ID, ss: process.env.STUB_STATUS_SRC, vs: process.env.STUB_VERIFY_SRC,
      };
      process.env.PIPELINE_BD_CMD = process.execPath;
      process.env.NODE_OPTIONS = `--require "${fwd(bdStub)}"`;
      process.env.BD_ISSUE_ID = 'app-777';
      process.env.PIPELINE_EXEC_STUB = execStub;
      process.env.PIPELINE_GH_CMD = `${q(process.execPath)} ${q(ghStub)}`;
      process.env.STUB_STATUS_SRC = fwd(statusSrc);
      process.env.STUB_VERIFY_SRC = fwd(verifySrc);

      const log = {
        info() {}, error() {},
        runId: 'run-fixture', trace: (id) => `run-fixture/${id}`, taskDir: () => dir, dir,
      };
      const cfg = {
        targetRepoPath: seed, targetRepoRemote: remote, image: 'unused:local',
        wallClockMinutes: 60, maxAttempts: 3, probeIntervalMinutes: 15,
        maxPauseCycles: 96, concurrency: 1,
      };
      const gate = { waits: 0, cycles: 0, exhausted: false, admit: async () => true, reportLimit: async () => ({ resumed: false, exhausted: true }) };
      let row = null;
      try { row = await runmod.runOneTask(cfg, { id: 'app-777', title: 'invented fixture task', priority: 1 }, log, 'tok', gate); } catch { row = null; }
      for (const [k, v] of [['PIPELINE_BD_CMD', saved.bd], ['NODE_OPTIONS', saved.node],
        ['PIPELINE_EXEC_STUB', saved.exec], ['PIPELINE_GH_CMD', saved.gh], ['BD_ISSUE_ID', saved.id],
        ['STUB_STATUS_SRC', saved.ss], ['STUB_VERIFY_SRC', saved.vs]]) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
      return row;
    }

    c5manifest = async function c5manifestDrive() {
      if (!runmod || typeof runmod.runOneTask !== 'function') {
        check('C5 runOneTask is drivable through its seams', false);
        return;
      }
      // Keys deliberately out of alphabetical order in the source file: the manifest
      // copies VERBATIM, so what the container sorted is what the row must show.
      const record = { [CODE_MODEL]: CODE_SUM, [DOCS_MODEL]: DOCS_1 };
      const withRow = await rowFor('with', { issueId: 'app-777', attempts: [{ number: 1, verifierResult: 'pass', timestamp: '2020-01-01T00:00:00.000Z' }], model: CODE_MODEL, modelTokens: record });
      check('C5 runOneTask returned a task row for the drive carrying a record', Boolean(withRow));
      check(`C5 the task row carries modelTokens VERBATIM, key order included (got ${show(withRow && withRow.modelTokens)})`,
        Boolean(withRow) && show(withRow.modelTokens) === show(record));
      const withoutRow = await rowFor('without', { issueId: 'app-777', attempts: [{ number: 1, verifierResult: 'pass', timestamp: '2020-01-01T00:00:00.000Z' }], model: CODE_MODEL });
      check('C5 runOneTask returned a task row for the drive carrying no record', Boolean(withoutRow));
      check(`C5 the task row OMITS the modelTokens key entirely when the status file has none (key present: ${Boolean(withoutRow) && Object.prototype.hasOwnProperty.call(withoutRow, 'modelTokens')})`,
        Boolean(withoutRow) && !Object.prototype.hasOwnProperty.call(withoutRow, 'modelTokens'));
    };
  }

  // ==== C6: accumulation survives a relaunch, and key order is sorted ==============
  // One workspace, two containers. Run 1: a good envelope, a failed verify, then a
  // rate-limit exit 20 — so a record exists in status.json when the container dies.
  // Run 2: a second envelope and a clean finish.
  const c6 = (async function c6() {
    const w = makeWorkspace('c6');
    const Z_1 = { inputTokens: 700, outputTokens: 60, cacheReadInputTokens: 7000, cacheCreationInputTokens: 7 };
    const A_1 = { inputTokens: 4, outputTokens: 3, cacheReadInputTokens: 40, cacheCreationInputTokens: 2 };
    const A_2 = { inputTokens: 6, outputTokens: 5, cacheReadInputTokens: 60, cacheCreationInputTokens: 8 };
    const A_SUM = { inputTokens: 10, outputTokens: 8, cacheReadInputTokens: 100, cacheCreationInputTokens: 10 };
    // `z-model` deliberately FIRST in the envelope: encounter order is z, a.
    const spec1 = writeSpec('c6-run1', {
      code: [envelope({ 'z-model': Z_1, 'a-model': A_1 }), { kind: 'ratelimit', epoch: RL_EPOCH }],
      docs: plain('Invented docs summary.'),
    });
    const pipe1 = makePipe('c6-run1', VERIFY_FAIL);
    const r1 = runEp({ ...w, pipe: pipe1, specPath: spec1, maxAttempts: 3 });
    const st1 = readJson(path.join(w.ws, '.run', 'status.json'));
    check(`C6 run 1 ends at the rate-limit exit 20 (got ${r1.status}; stderr: ${(r1.stderr || '').trim().slice(0, 200)})`,
      r1.status === 20);
    check(`C6 run 1 recorded the pre-pause figures before the container died (got ${show(st1 && st1.modelTokens)})`,
      Boolean(st1) && Boolean(st1.modelTokens) && Object.prototype.hasOwnProperty.call(st1.modelTokens, 'z-model'));

    const spec2 = writeSpec('c6-run2', {
      code: [envelope({ 'a-model': A_2 })],
      docs: plain('Invented docs summary.'),
    });
    const pipe2 = makePipe('c6-run2', VERIFY_OK);
    const r2 = runEp({ ...w, pipe: pipe2, specPath: spec2, maxAttempts: 3 });
    const st2 = readJson(path.join(w.ws, '.run', 'status.json'));
    check(`C6 run 2 completes at exit 0 (got ${r2.status}; stderr: ${(r2.stderr || '').trim().slice(0, 200)})`,
      r2.status === 0);
    const mt = st2 && st2.modelTokens;
    checkCounts('C6 the pre-pause z-model figures survived the relaunch untouched', mt && mt['z-model'], Z_1);
    checkCounts('C6 the a-model figures accumulated ACROSS the two containers', mt && mt['a-model'], A_SUM);
    check(`C6 keys are written SORTED — a-model before z-model, though z was encountered first (got ${show(mt && Object.keys(mt))})`,
      Boolean(mt) && show(Object.keys(mt)) === show(['a-model', 'z-model']));
    // The manifest copies verbatim, so a sorted status file yields a sorted row.
    const text = readText(path.join(w.ws, '.run', 'status.json')) || '';
    check('C6 the sorted order is in the SERIALISED bytes, not just in an in-memory view',
      text.indexOf('"a-model"') !== -1 && text.indexOf('"a-model"') < text.indexOf('"z-model"'));
  });

  // The two asynchronous blocks run last; everything above is synchronous.
  (async () => {
    try {
      if (c5manifest) await c5manifest();
      await c6();
    } catch (e) {
      failed = 1;
      console.log(`FAIL - HARNESS BROKEN: unexpected exception in the async drives: ${e && e.stack ? e.stack : e}`);
    } finally {
      cleanup();
      process.exit(failed);
    }
  })();
} catch (e) {
  failed = 1;
  if (!(e && e.message === 'harness-abort')) {
    console.log(`FAIL - HARNESS BROKEN: unexpected exception: ${e && e.stack ? e.stack : e}`);
  }
  cleanup();
  process.exit(failed);
}

// Cleanup is never a verdict: best effort, and a second pass clears the read-only bits
// git leaves on object files (Windows unlink refuses them).
function cleanup() {
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
