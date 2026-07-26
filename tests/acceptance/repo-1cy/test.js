// Frozen acceptance test — repo-1cy: the spec-concern channel, container side
// (DESIGN.md §3.7, §3.3, §3.5, §4.11). Written before implementation, from the spec
// alone; criteria A1–A8 of the approved spec. Plain Node, Docker-free.
//
// Two deliberate choices, both from the planning critics:
//   * A1 asserts the SCHEMA'S KEYWORDS, never "does ajv accept this". Every ajv use in
//     this repo goes through `npx --yes`, which needs the npm registry; the task
//     container reaches Anthropic endpoints only. The real accept/reject pair runs on
//     the host via scripts/test-status-schema.sh, which A2 feeds.
//   * A7/A8 drive entrypoint.sh with a STUB verify.js in a temp PIPELINE_DIR and an
//     explicit minimal environment. The real verify.js re-runs
//     `sh tools/run-acceptance.sh`, so using it here would invoke the acceptance runner
//     from inside the acceptance runner (shadow-01), while inherited WORKSPACE/RUN_DIR
//     would let the nested run overwrite the live task's own status file and fire a real
//     model call through the inherited PIPELINE_AGENT_CMD.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const STATUS_JS = path.join(ROOT, 'pipeline', 'status.js');
let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) failed = 1;
}
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

// ---- A1: schema declares specConcerns with the pinned bounds -----------------------
const schema = (() => { try { return JSON.parse(read(path.join(ROOT, 'schemas', 'status.schema.json'))); } catch { return {}; } })();
const sc = (schema.properties || {}).specConcerns;
check('A1 specConcerns declared', sc !== undefined);
check('A1 type array', !!sc && sc.type === 'array');
check('A1 maxItems 5', !!sc && sc.maxItems === 5);
check('A1 items type string', !!sc && !!sc.items && sc.items.type === 'string');
check('A1 items maxLength 1000', !!sc && !!sc.items && sc.items.maxLength === 1000);
check('A1 optional (absent from required)',
  !Array.isArray(schema.required) || !schema.required.includes('specConcerns'));
check('A1 additionalProperties still false', schema.additionalProperties === false);

// ---- A2: the valid example carries the field so the host validator exercises it ----
const example = (() => { try { return JSON.parse(read(path.join(ROOT, 'schemas', 'examples', 'status.valid.json'))); } catch { return {}; } })();
check('A2 valid example has a specConcerns entry',
  Array.isArray(example.specConcerns) && example.specConcerns.length >= 1
  && typeof example.specConcerns[0] === 'string' && example.specConcerns[0].length > 0);

// ---- A3–A5: the writer, driven as a child process in a temp RUN_DIR ----------------
function statusCmd(runDir, args) {
  return spawnSync(process.execPath, [STATUS_JS, ...args],
    { encoding: 'utf8', env: { ...process.env, RUN_DIR: runDir } });
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-1cy-'));
const statusFile = path.join(tmp, 'status.json');
const st = () => { try { return JSON.parse(read(statusFile)); } catch { return {}; } };
const concerns = (o) => (Array.isArray(o.specConcerns) ? o.specConcerns : []);

statusCmd(tmp, ['init', 'test-1cy']);
check('A3 init created status.json', fs.existsSync(statusFile));

// A3: appends in order, creates the array, preserves what was already there.
statusCmd(tmp, ['set', 'changeSummary', 'a summary that must survive']);
const r1 = statusCmd(tmp, ['concern', 'the first concern']);
statusCmd(tmp, ['concern', 'the second concern']);
let s = st();
check('A3 first concern exits 0', r1.status === 0);
check('A3 two concerns append in call order',
  concerns(s).length === 2 && concerns(s)[0] === 'the first concern'
  && concerns(s)[1] === 'the second concern');
check('A3 pre-existing fields preserved',
  s.issueId === 'test-1cy' && s.changeSummary === 'a summary that must survive'
  && Array.isArray(s.attempts));

// A3 (usage errors, per the constraints — same shape as `status.js note`).
const rEmpty = statusCmd(tmp, ['concern', '   ']);
check('A3 whitespace-only text exits non-zero', rEmpty.status !== 0);
check('A3 whitespace-only text changed nothing', concerns(st()).length === 2);
const tmpBare = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-1cy-bare-'));
const rNoFile = statusCmd(tmpBare, ['concern', 'x']);
check('A3 missing status.json exits non-zero', rNoFile.status !== 0);
check('A3 missing status.json creates nothing', !fs.existsSync(path.join(tmpBare, 'status.json')));

// A5: truncation to exactly the first 1000 characters (head kept).
const long = 'a'.repeat(600) + 'b'.repeat(600);
statusCmd(tmp, ['concern', long]);
s = st();
const third = concerns(s)[2];
check('A5 over-long concern stored at exactly 1000 chars', third !== undefined && third.length === 1000);
check('A5 truncation keeps the head', third === 'a'.repeat(600) + 'b'.repeat(400));

// A4: the cap is silent — 6th call exits 0 and the array stays at 5.
statusCmd(tmp, ['concern', 'fourth']);
statusCmd(tmp, ['concern', 'fifth']);
check('A4 filled to 5 concerns', concerns(st()).length === 5);
const rOver = statusCmd(tmp, ['concern', 'sixth-must-be-dropped']);
s = st();
check('A4 6th call exits 0', rOver.status === 0);
check('A4 6th concern dropped, length still 5',
  concerns(s).length === 5 && !concerns(s).includes('sixth-must-be-dropped'));

// ---- shared fixture builder for the two behavioral runs ----------------------------
// A stub agent that records a concern on every invocation, a stub verify.js, a temp
// PIPELINE_DIR holding the real status.js, and a real git repo as the workspace.
function buildRun(tag, verifyBody) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `accept-1cy-${tag}-`));
  const ws = path.join(base, 'ws');
  const home = path.join(base, 'home');
  const pipe = path.join(base, 'pipe');
  fs.mkdirSync(path.join(ws, '.run'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(pipe, { recursive: true });

  for (const f of ['status.js', 'envelope.js']) {
    const src = read(path.join(ROOT, 'pipeline', f));
    if (src !== null) fs.writeFileSync(path.join(pipe, f), src);
  }
  fs.writeFileSync(path.join(pipe, 'verify.js'), verifyBody);

  const git = (args) => spawnSync('git', args, { cwd: ws, encoding: 'utf8', env: { ...process.env, HOME: home } });
  git(['init', '-q']);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'seed']);
  fs.writeFileSync(path.join(ws, '.run', 'issue.md'), `# ${tag}: behavioral fixture\n`);

  // The stub agent raises a concern through the real status.js, exactly as a coding
  // agent would. It runs for BOTH phases, so a passing run leaves two entries — which
  // is why every assertion below is a membership check and never an array length.
  const agentStub = path.join(base, 'agent-stub.sh');
  fs.writeFileSync(agentStub, [
    '#!/bin/sh',
    'cat > /dev/null',
    `node "${path.join(pipe, 'status.js').replace(/\\/g, '/')}" concern "CONCERN-${tag}: the frozen spec contradicts itself"`,
    'echo stub agent done',
    '',
  ].join('\n'));
  fs.chmodSync(agentStub, 0o755);

  return { base, ws, home, pipe, agentStub };
}

function runEntrypoint(fx, extraEnv) {
  return spawnSync('bash', [path.join(ROOT, 'pipeline', 'entrypoint.sh')], {
    encoding: 'utf8',
    timeout: 120000,
    env: {
      PATH: process.env.PATH,
      HOME: fx.home,
      WORKSPACE: fx.ws,
      PIPELINE_DIR: fx.pipe,
      ISSUE_ID: 'test-1cy',
      PIPELINE_AGENT_CMD: `sh ${fx.agentStub}`,
      CLAUDE_CODE_OAUTH_TOKEN: 'dummy-token-never-used',
      ...extraEnv,
    },
  });
}

// ---- A8: the success path, and A6 on the prompts it generates ----------------------
const okFx = buildRun('pass', 'process.exit(0);\n');
const okRun = runEntrypoint(okFx, {});
check('A8 entrypoint exits 0 on the success path', okRun.status === 0);
const okStatus = (() => { try { return JSON.parse(read(path.join(okFx.ws, '.run', 'status.json'))); } catch { return {}; } })();
check('A8 status file carries issueId', okStatus.issueId === 'test-1cy');
check('A8 exactly one attempt, verifierResult pass',
  Array.isArray(okStatus.attempts) && okStatus.attempts.length === 1
  && okStatus.attempts[0].verifierResult === 'pass');
check('A8 changeSummary present', typeof okStatus.changeSummary === 'string' && okStatus.changeSummary.length > 0);
check('A8 the concern is present (membership, not length)',
  concerns(okStatus).some((c) => c.includes('CONCERN-pass')));

// A6: both GENERATED prompts advertise the channel. Asserted on the produced files,
// not on entrypoint.sh source — a shell comment would satisfy the latter while leaving
// the agent never actually told.
const codePrompt = read(path.join(okFx.ws, '.run', 'prompt-1.md'));
const docsPrompt = read(path.join(okFx.ws, '.run', 'prompt-docs.md'));
check('A6 code-phase prompt was generated', codePrompt !== null);
check('A6 docs-phase prompt was generated', docsPrompt !== null);
check('A6 code prompt names the command',
  (codePrompt || '').includes('status.js concern'));
check('A6 docs prompt names the command',
  (docsPrompt || '').includes('status.js concern'));
check('A6 code prompt states a concern cannot change the outcome',
  (codePrompt || '').includes('cannot change the outcome'));
check('A6 docs prompt states a concern cannot change the outcome',
  (docsPrompt || '').includes('cannot change the outcome'));

// ---- A7: the evidence-only invariant, on the FAILURE path --------------------------
// A concern must not rescue a failing task. Stub verifier fails, one attempt allowed:
// the outcome must still be the bail (exit 10 + stuckState), unchanged by the concern.
const failVerify = [
  "const fs = require('fs'), path = require('path');",
  "const run = path.join(process.env.WORKSPACE || '/workspace', '.run');",
  "fs.mkdirSync(run, { recursive: true });",
  "fs.writeFileSync(path.join(run, 'verify.json'), JSON.stringify({ result: 'fail', acceptanceOutput: 'stub verifier: forced failure' }) + '\\n');",
  'process.exit(1);',
  '',
].join('\n');
const badFx = buildRun('fail', failVerify);
const badRun = runEntrypoint(badFx, { PIPELINE_MAX_ATTEMPTS: '1' });
check('A7 failing verification still exits 10 with a concern recorded', badRun.status === 10);
const badStatus = (() => { try { return JSON.parse(read(path.join(badFx.ws, '.run', 'status.json'))); } catch { return {}; } })();
check('A7 stuckState still written', typeof badStatus.stuckState === 'string' && badStatus.stuckState.length > 0);
check('A7 the concern was in fact recorded on the failure path',
  concerns(badStatus).some((c) => c.includes('CONCERN-fail')));

// A7: the verifier and the runner are untouched relative to the fork point. An agent
// that can edit what judges it is not being judged (CLAUDE.md hard rule 2).
// `-c safe.directory=*` is not decoration: the workspace is a host-owned bind mount, so
// git's dubious-ownership guard blocks every call unless the ambient config happens to
// have been set. A frozen test must not depend on ambient config.
const GIT_SAFE = ['-c', 'safe.directory=*'];
function mergeBase() {
  for (const ref of ['main', 'origin/main']) {
    const r = spawnSync('git', [...GIT_SAFE, 'merge-base', ref, 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
    if (r.status === 0 && (r.stdout || '').trim()) return r.stdout.trim();
  }
  return null;
}
const base = mergeBase();
check('A7 a fork point could be resolved', base !== null);
if (base) {
  // Content comparison, not `git diff --name-only`: a Windows-origin clone stores CRLF
  // on disk, so every file "differs" from its blob inside a Linux container and the
  // diff reports the whole runner as changed (the same false positive that once made
  // the verifier call a clean checkout tampered). `--ignore-cr-at-eol` does not help —
  // it affects hunk generation, not name listing. Normalising both sides does.
  // Compared against the WORKING TREE on purpose: the entrypoint runs the verifier
  // before it commits, so an agent's edits are still uncommitted at this moment and a
  // base..HEAD comparison would pass no matter what the agent changed.
  const norm = (t) => t.replace(/\r\n/g, '\n');
  const listed = spawnSync('git', [...GIT_SAFE, 'ls-tree', '-r', '--name-only', base, '--', 'pipeline/verify.js', 'runner/'],
    { cwd: ROOT, encoding: 'utf8' });
  const tracked = (listed.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
  check('A7 the fork point lists the verifier and the runner', tracked.length >= 2);
  const changed = tracked.filter((rel) => {
    const shown = spawnSync('git', [...GIT_SAFE, 'show', `${base}:${rel}`], { cwd: ROOT, encoding: 'utf8' });
    if (shown.status !== 0) return true;
    const disk = read(path.join(ROOT, rel));
    return disk === null || norm(disk) !== norm(shown.stdout);
  });
  check(`A7 verifier and runner unchanged since the fork point${changed.length ? ` (changed: ${changed.join(', ')})` : ''}`,
    changed.length === 0);
  // An added file under runner/ is a change the tracked-file walk above cannot see.
  const runnerDir = path.join(ROOT, 'runner');
  const onDisk = (() => { try { return fs.readdirSync(runnerDir).filter((f) => f.endsWith('.js')); } catch { return []; } })();
  const known = new Set(tracked.filter((t) => t.startsWith('runner/')).map((t) => t.slice('runner/'.length)));
  const added = onDisk.filter((f) => !known.has(f));
  check(`A7 no file added under runner/${added.length ? ` (added: ${added.join(', ')})` : ''}`, added.length === 0);
}

process.exit(failed);
