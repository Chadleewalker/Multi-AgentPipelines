// Frozen acceptance test — repo-7a0: bound the Codex test-author to the snapshotted issue.
// This is the RED half. `guard.js` beside it carries the checks that are already green at the
// fork point and must stay green; between them every criterion is covered in both directions.
//
// CRITERION PAIRING — every check below also names its own criterion in its label.
//
//   C1  a Codex test-author cannot consume the target project's full Beads/memory corpus once
//       the coordinator has snapshotted the issue; an attempted `bd prime` / `bd show` is
//       bounded or refused with a concise explanation.          -> T1 (and the corpus half of T4)
//   C2  the immutable issue criteria and the suite convention remain sufficient for the author
//       to create only tests/acceptance/<issue>/, and the boundary audits still reject any
//       outside edit.                                           -> T2, plus guard.js G1
//   C3  a provider process that exits zero without a terminal completed author result — for
//       Codex, an `item.completed` agent_message record FOLLOWED BY a `turn.completed` record —
//       cannot be treated as a successful author session.        -> T3 (and the outcome half of T4)
//   C4  deterministic no-key tests reproduce the prior 231-memory / no-suite failure and prove
//       bounded completion without weakening Claude compatibility or the RED/GREEN proof.
//                                                               -> T4, plus guard.js G2 and G3
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE FROZEN INTERFACE. The issue names no module or function surface, so this suite fixes one.
// Node built-ins only, synchronous, no container engine, no network and NO PROVIDER KEY: every
// check below runs with CODEX_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY /
// CLAUDE_CODE_OAUTH_TOKEN deleted from this process, which is what "deterministic no-key" in C4
// means.
//
// `runner/author-containment.js` (new) exports:
//
//   REFUSAL_MAX_CHARS
//     An integer in 1..400 — the hard ceiling on EVERYTHING a contained `bd` invocation may
//     emit on both streams together. "Concise explanation" in C1 is this number; it is what
//     makes a 231-memory dump impossible rather than merely discouraged.
//
//   BRIEF_NOTICE
//     A non-empty array of plain lines, at most 600 characters joined, naming Beads/`bd` and the
//     fact that the issue is already snapshotted. The module owns the WORDING; this suite only
//     pins that the wording exists, is bounded, and actually reaches the author's brief (T2).
//
//   prepare(dir, { issueId }) -> { ok: true, dir: <absolute>, names: [...] }
//     Writes a `bd` interception shim into `dir` and returns it. `names` must include at least
//     `bd` and `bd.cmd`, so the shim wins PATH lookup from a POSIX shell and from cmd.exe
//     alike. On a POSIX host the `bd` entry must be executable. `dir` must NOT be inside the
//     author's worktree: anything there would show up in the boundary audit that C2 protects.
//     Every invocation of the shim — `prime`, `show`, `memories`, `list`, `remember`, or no
//     subcommand at all — exits NON-ZERO, emits at most REFUSAL_MAX_CHARS, names the issue id
//     it was prepared for, and emits none of the corpus.
//
//   applyEnv(baseEnv, prepared) -> env
//     A NEW environment object (baseEnv is never mutated) in which:
//       * there is exactly ONE key whose lowercase form is `path`, and it is spelled `PATH`.
//         Windows' `Path` and a caller-supplied `PATH` must be collapsed into one, or the shim's
//         precedence is decided by whichever spelling the child process happens to read;
//       * the first PATH entry is `prepared.dir`;
//       * the host bd overrides `PIPELINE_BD_CMD`, `BD_ARGS_LOG`, `BD_STUB_OUT` and
//         `BD_STUB_EXIT` are absent — an override is a second door into the same corpus;
//       * every OTHER variable in baseEnv survives untouched. Containment closes Beads, not the
//         stage's own environment: `cfg.hostEnv` still carries licence paths and off-PATH
//         binaries that the author needs.
//
// `scripts/spec-brief.js` additionally exports:
//
//   writeBrief(ctx) -> string[]
//     The already-existing pure write-state brief builder, now reachable. Its output must
//     contain every line of `BRIEF_NOTICE` alongside the criteria block, the
//     `tests/acceptance/<suite>/` instruction and the frozen-path warning it already carries.
//     Exporting it is what lets C2's "remain sufficient" be checked without a Beads read.
//
// `scripts/author-tests.js` changes behaviour in two places:
//
//   launchAuthor(built, model, run)
//     For a Codex test-author the launch OPTIONS carry the containment environment above. The
//     ARGV and the stdin prompt are untouched — `runner/agent-provider.js`'s `codexExecArgs` is
//     pinned byte for byte by an already-frozen suite (repo-45g) and by guard.js G3 here, so
//     containment travels in the environment or not at all.
//
//   authorIssue(built, configPath, io, seams)
//     A launch that exits 0 is no longer success by itself. The session is accepted only when
//     the provider's own output carries a TERMINAL COMPLETED result:
//       * Codex launches with `--json`, so its structured JSONL is guaranteed. A terminal
//         result requires BOTH an `item.completed` record whose `item.type` is `agent_message`
//         with string `text`, AND a `turn.completed` record that follows it later in the same
//         stream. No JSONL at all, JSONL without that agent_message, an agent_message with no
//         following `turn.completed`, an agent_message followed by `turn.failed`, or a
//         `turn.completed` that appears before the final agent_message, are all INCOMPLETE.
//       * Claude's author argv requests no structured envelope, so its plain `-p` prose is only
//         ever written to stdout after the process has already completed, and carries no
//         information beyond that — it stays ACCEPTED, which is C4's "without weakening Claude
//         compatibility". But when a Claude run DOES emit its explicit `{"type":"result", ...}`
//         envelope and that envelope has no string `result`, it is a malformed result and the
//         session is INCOMPLETE too.
//     An incomplete session returns
//       { ok: false, outcome: 'agent-incomplete', kind: 'incomplete', exitCode: EXIT_AGENT }
//     and `proveTests` is never called. A complete session behaves exactly as it does today.
//
// SPEC DEFECTS FOUND — reported, not papered over. See the bottom of this file.
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PROVIDER_KEY_NAMES = Object.freeze([
  'CODEX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN',
]);

// Deterministic and key-free (C4). Deleted before anything is required so that no module, shim
// or fixture spawned below can observe a credential or a host bd override.
for (const name of [...PROVIDER_KEY_NAMES,
  'PIPELINE_BD_CMD', 'BD_ARGS_LOG', 'BD_STUB_OUT', 'BD_STUB_EXIT',
  'PIPELINE_TEST_AUTHOR_CMD', 'PIPELINE_TEST_PROBE_CMD']) delete process.env[name];

const AUTHOR = require(path.join(ROOT, 'scripts', 'author-tests.js'));
const SPEC = require(path.join(ROOT, 'scripts', 'spec-brief.js'));
const CONTAINMENT_FILE = path.join(ROOT, 'runner', 'author-containment.js');

const tests = [];
function test(name, body) { tests.push({ name, body }); }

const ISSUE = 'repo-7a0';
const CORPUS_SIZE = 231;               // the observed failure: 231 memories into one author session
const CORPUS_KEY = `repo-legacy-note-${CORPUS_SIZE}`;
const ORIGINAL_PATH = process.env.PATH || process.env.Path || '';

const temps = [];
function tmp(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `repo-7a0-${tag}-`));
  temps.push(dir);
  return dir;
}
function executableTmp(tag) {
  const parent = path.join(ROOT, 'runs', 'acceptance-fixtures');
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, `repo-7a0-${tag}-`));
  temps.push(dir);
  return dir;
}
function cleanup() {
  for (const dir of temps.splice(0)) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
}

function containment() {
  assert(fs.existsSync(CONTAINMENT_FILE), `runner/author-containment.js does not exist: ${CONTAINMENT_FILE}`);
  // eslint-disable-next-line global-require
  return require(CONTAINMENT_FILE);
}

function pathKeys(env) { return Object.keys(env).filter((k) => k.toLowerCase() === 'path'); }
function firstPathEntry(env) {
  const keys = pathKeys(env);
  assert.deepStrictEqual(keys, ['PATH'], `env must carry exactly one path key spelled PATH, got ${JSON.stringify(keys)}`);
  return String(env.PATH).split(path.delimiter)[0];
}

// One shell invocation, because that is how a model actually reaches `bd`: through its Bash
// tool, so PATHEXT on Windows and $PATH on POSIX both do the resolving.
function shell(command, env, cwd) {
  const r = spawnSync(command, { shell: true, encoding: 'utf8', env, cwd, timeout: 120000 });
  return { status: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || ''),
    text: `${String(r.stdout || '')}${String(r.stderr || '')}`, error: r.error || null };
}

// A stand-in for the target project's real `bd`: it answers every subcommand with a 231-memory
// corpus. Placed on PATH BEHIND the containment shim, it is the thing containment has to beat.
function corpusBin(dir) {
  const body = [`# Project memory (${CORPUS_SIZE} memories)`];
  for (let i = 1; i <= CORPUS_SIZE; i += 1) body.push(`- repo-legacy-note-${i}: remembered operational detail ${i}`);
  const corpus = path.join(dir, 'corpus.txt');
  fs.writeFileSync(corpus, `${body.join('\n')}\n`);
  fs.writeFileSync(path.join(dir, 'bd'), `#!/bin/sh\ncat "${corpus.split('\\').join('/')}"\nexit 0\n`);
  try { fs.chmodSync(path.join(dir, 'bd'), 0o755); } catch { /* Windows has no mode bits */ }
  fs.writeFileSync(path.join(dir, 'bd.cmd'), `@echo off\r\ntype "${corpus.split('/').join('\\')}"\r\nexit /b 0\r\n`);
  return dir;
}

function keyFreeEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
  for (const k of pathKeys(env)) delete env[k];
  env.PATH = ORIGINAL_PATH;
  return { ...env, ...extra };
}

function writeBuilt(cfgOverrides = {}, worktree = null) {
  const dir = worktree || tmp('worktree');
  return {
    ok: true, state: 'write', id: ISSUE, requestedId: ISSUE, canonicalId: ISSUE, suiteId: ISSUE,
    branch: 'main', text: 'FIXTURE BRIEF for repo-7a0',
    policy: { verifyCommand: 'sh tools/run-acceptance.sh', frozenPaths: ['tools/run-acceptance.sh'] },
    folder: { dir, exists: true, branch: `freeze-${ISSUE}` },
    cfg: {
      targetRepoPath: ROOT, model: 'fixture-model', testAuthorModel: 'fixture-model',
      testProbeModel: 'fixture-model', wallClockMinutes: 2,
      provider: 'codex', testAuthorProvider: 'codex', testProbeProvider: 'codex',
      reasoningEffort: 'high', testAuthorReasoningEffort: 'high',
      hostEnv: {}, ...cfgOverrides,
    },
  };
}

function captureLaunch(built, model = 'fixture-model') {
  let call = null;
  const run = (command, args, opts) => { call = { command, args, opts }; return { status: 0, stdout: '', stderr: '' }; };
  AUTHOR.launchAuthor(built, model, run);
  assert(call, 'launchAuthor did not invoke the host run seam');
  return call;
}

const CODEX_AUTHOR_ARGS = [
  'exec', '--model', 'fixture-model', '-c', 'model_reasoning_effort="high"',
  '-c', 'shell_environment_policy.ignore_default_excludes=false',
  '-c', 'shell_environment_policy.filters.CODEX_API_KEY="exclude"',
  '--approve-for-me', '--ephemeral', '--ignore-user-config', '--ignore-rules',
  '--strict-config', '--json', '-',
];

function codexJsonl(records) { return `${records.map((r) => JSON.stringify(r)).join('\n')}\n`; }
// The GREEN shape: an item.completed agent_message FOLLOWED BY turn.completed, in that order.
const CODEX_TERMINAL = codexJsonl([
  { type: 'thread.started', thread_id: 'th-fixture' },
  { type: 'item.completed', item: { type: 'agent_message', text: 'Wrote tests/acceptance/repo-7a0/.' } },
  { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } },
]);
// No agent_message reaches item.completed at all — only a started item and a failed turn.
const CODEX_NO_TERMINAL = codexJsonl([
  { type: 'thread.started', thread_id: 'th-fixture' },
  { type: 'item.started', item: { type: 'agent_message' } },
  { type: 'turn.failed', error: { message: 'the stream ended before the turn completed' } },
]);
// The agent_message completes, but the stream ends there — no turn record at all.
const CODEX_MESSAGE_NO_TURN = codexJsonl([
  { type: 'thread.started', thread_id: 'th-fixture' },
  { type: 'item.completed', item: { type: 'agent_message', text: 'Wrote tests/acceptance/repo-7a0/.' } },
]);
// The agent_message completes, but the turn that carried it is reported failed, not completed.
const CODEX_MESSAGE_THEN_FAILED = codexJsonl([
  { type: 'thread.started', thread_id: 'th-fixture' },
  { type: 'item.completed', item: { type: 'agent_message', text: 'Wrote tests/acceptance/repo-7a0/.' } },
  { type: 'turn.failed', error: { message: 'the stream ended before the turn completed' } },
]);
// turn.completed is present, but it precedes the final agent_message rather than following it —
// order matters, so this is still an incomplete stream, not a completed one.
const CODEX_TURN_BEFORE_MESSAGE = codexJsonl([
  { type: 'thread.started', thread_id: 'th-fixture' },
  { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } },
  { type: 'item.completed', item: { type: 'agent_message', text: 'Wrote tests/acceptance/repo-7a0/.' } },
]);

// `authorIssue` with every side effect seamed out except the one under test.
function runAuthorIssue(built, launched, extraSeams = {}) {
  const out = []; const err = []; const proofs = [];
  const seams = {
    auditAuthorTree: () => ({ ok: true }),
    launchAuthor: () => launched,
    proveTests: () => {
      proofs.push(true);
      return { ok: true, attempt: 1, probe: path.join(os.tmpdir(), 'fixture-probe'), container: null,
        evidence: 'gate exit 0', agentOutput: '' };
    },
    ...extraSeams,
  };
  const result = AUTHOR.authorIssue(built, path.join(ROOT, 'run.config.fixture.json'), {
    out: (m) => out.push(String(m)), err: (m) => err.push(String(m)),
  }, seams);
  return { result, out: out.join('\n'), err: err.join('\n'), proofs: proofs.length };
}

// ── T1 / C1 ──────────────────────────────────────────────────────────────────────────────────
test('T1 C1 a contained Codex test-author cannot reach the Beads/memory corpus: prime, show and memories are refused within a concise bound', () => {
  const CONTAIN = containment();

  assert(Number.isInteger(CONTAIN.REFUSAL_MAX_CHARS) && CONTAIN.REFUSAL_MAX_CHARS > 0
    && CONTAIN.REFUSAL_MAX_CHARS <= 400,
  `REFUSAL_MAX_CHARS must be an integer in 1..400, got ${JSON.stringify(CONTAIN.REFUSAL_MAX_CHARS)}`);

  const shimDir = tmp('shim');
  const prepared = CONTAIN.prepare(shimDir, { issueId: ISSUE });
  assert(prepared && prepared.ok === true, `prepare did not succeed: ${JSON.stringify(prepared)}`);
  assert.strictEqual(path.resolve(prepared.dir), path.resolve(shimDir));
  for (const name of ['bd', 'bd.cmd']) {
    assert(Array.isArray(prepared.names) && prepared.names.includes(name),
      `prepare must report a ${name} shim, got ${JSON.stringify(prepared.names)}`);
    assert(fs.existsSync(path.join(prepared.dir, name)), `prepare did not write ${name} into ${prepared.dir}`);
  }
  if (process.platform !== 'win32') {
    assert((fs.statSync(path.join(prepared.dir, 'bd')).mode & 0o111) !== 0, 'the POSIX bd shim is not executable');
  }

  // The corpus sits on PATH behind the shim. Without containment it is one command away; with
  // containment every door onto it is closed.
  const corpus = corpusBin(tmp('corpus'));
  const base = keyFreeEnv({ PATH: `${corpus}${path.delimiter}${ORIGINAL_PATH}`,
    PIPELINE_BD_CMD: 'node fake-bd.js', REPO_7A0_SENTINEL: 'survives' });
  const frozenBase = JSON.parse(JSON.stringify(base));
  const env = CONTAIN.applyEnv(base, prepared);
  assert.deepStrictEqual(base, frozenBase, 'applyEnv mutated the environment it was handed');
  assert.strictEqual(firstPathEntry(env), prepared.dir);
  for (const name of ['PIPELINE_BD_CMD', 'BD_ARGS_LOG', 'BD_STUB_OUT', 'BD_STUB_EXIT']) {
    assert.strictEqual(env[name], undefined, `applyEnv left the host bd override ${name} in the author environment`);
  }
  assert.strictEqual(env.REPO_7A0_SENTINEL, 'survives', 'applyEnv dropped a variable it was not asked to remove');

  for (const command of ['bd prime', `bd show ${ISSUE}`, 'bd memories', 'bd list --json', 'bd remember "x" --key k', 'bd']) {
    const r = shell(command, env, ROOT);
    assert(r.status !== 0, `\`${command}\` was not refused (exit ${r.status}): ${r.text}`);
    assert(r.text.length <= CONTAIN.REFUSAL_MAX_CHARS,
      `\`${command}\` emitted ${r.text.length} chars, over the ${CONTAIN.REFUSAL_MAX_CHARS} bound`);
    assert(r.text.includes(ISSUE), `\`${command}\` refusal does not name the snapshotted issue: ${r.text}`);
    assert(/brief|snapshot|criteri/i.test(r.text), `\`${command}\` refusal carries no explanation: ${r.text}`);
    assert(!/repo-legacy-note-/.test(r.text), `\`${command}\` leaked corpus content: ${r.text}`);
  }

  // The same containment is what the real Codex author launch receives, and it travels in the
  // environment only: the argv and the stdin prompt are byte-identical to the frozen contract.
  const built = writeBuilt({ hostEnv: { HOST_ONLY: 'kept', PIPELINE_BD_CMD: 'node fake-bd.js' } });
  const call = captureLaunch(built);
  assert.strictEqual(call.command, 'codex');
  assert.deepStrictEqual(call.args, CODEX_AUTHOR_ARGS);
  assert.strictEqual(call.opts.input, `${built.text}\n`);
  assert.strictEqual(call.opts.env.HOST_ONLY, 'kept', 'hostEnv no longer reaches the contained author');
  assert.strictEqual(call.opts.env.PIPELINE_BD_CMD, undefined, 'the author launch still carries a host bd override');
  const launchShim = firstPathEntry(call.opts.env);
  assert(fs.existsSync(launchShim), `the Codex author launch PATH does not begin with an existing shim dir: ${launchShim}`);
  for (const name of ['bd', 'bd.cmd']) {
    assert(fs.existsSync(path.join(launchShim, name)), `the Codex author launch shim dir has no ${name}: ${launchShim}`);
  }
  const inside = path.relative(built.folder.dir, launchShim);
  assert(inside.startsWith('..') || path.isAbsolute(inside),
    `the shim dir sits inside the author worktree and would trip the boundary audit: ${launchShim}`);
  const refused = shell('bd prime', call.opts.env, built.folder.dir);
  assert(refused.status !== 0 && refused.text.length <= CONTAIN.REFUSAL_MAX_CHARS,
    `the launched author environment does not refuse bd prime: exit ${refused.status} / ${refused.text}`);
});

// ── T2 / C2 ──────────────────────────────────────────────────────────────────────────────────
test('T2 C2 the write brief stays self-sufficient under containment — criteria, the one suite path and a bounded Beads notice — and an outside edit is still refused', () => {
  const CONTAIN = containment();

  assert(Array.isArray(CONTAIN.BRIEF_NOTICE) && CONTAIN.BRIEF_NOTICE.length > 0
    && CONTAIN.BRIEF_NOTICE.every((l) => typeof l === 'string'),
  `BRIEF_NOTICE must be a non-empty array of strings, got ${JSON.stringify(CONTAIN.BRIEF_NOTICE)}`);
  const notice = CONTAIN.BRIEF_NOTICE.join('\n');
  assert(notice.length <= 600, `BRIEF_NOTICE is ${notice.length} chars; the notice must stay bounded`);
  assert(/beads|(^|[^a-z])bd([^a-z]|$)/i.test(notice), `BRIEF_NOTICE never names Beads or bd: ${notice}`);
  assert(/snapshot/i.test(notice), `BRIEF_NOTICE never says the issue is already snapshotted: ${notice}`);

  assert.strictEqual(typeof SPEC.writeBrief, 'function',
    'scripts/spec-brief.js does not export writeBrief, so C2 cannot be checked without a Beads read');
  const criteria = '1. First observable outcome.\n2. Second observable outcome.';
  const lines = SPEC.writeBrief({
    cfg: { targetRepoPath: 'C:/target', hostEnv: {}, provider: 'codex', testAuthorProvider: 'codex' },
    configPath: 'run.config.fixture.json',
    id: ISSUE, requestedId: ISSUE, canonicalId: ISSUE, suiteId: ISSUE,
    data: { title: 'Bound the Codex test-author', acceptance_criteria: criteria },
    folder: { dir: 'C:/work/freeze-repo-7a0', exists: true, branch: `freeze-${ISSUE}` },
    branch: 'main',
    policy: { verifyCommand: 'sh tools/run-acceptance.sh', frozenPaths: ['tools/run-acceptance.sh', 'tests/unit/'] },
    example: { name: 'repo-djf.38', files: ['guard.js', 'test.js'] },
    repoRoot: 'C:/Code/Projects/Multi-AgentPipelines',
    state: { state: 'write', local: 'none' },
  });
  assert(Array.isArray(lines), `writeBrief must return an array of lines, got ${typeof lines}`);
  const text = lines.join('\n');
  // Still sufficient: the immutable criteria, the ONE suite it may create, the verifier, and the
  // frozen-path warning. Containment may not be paid for by removing any of these.
  assert(text.includes('1. First observable outcome.') && text.includes('2. Second observable outcome.'), text);
  assert(text.includes(`WRITE THEM TO tests/acceptance/${ISSUE}/`), text);
  assert(text.includes(`sh tools/run-acceptance.sh tests/acceptance/${ISSUE}/`), text);
  assert(/DO NOT TOUCH/.test(text) && /tampered/.test(text), text);
  // And newly sufficient: the author is told, in bounded words, that Beads is closed and why.
  for (const line of CONTAIN.BRIEF_NOTICE) {
    assert(lines.includes(line), `the write brief never carries the containment notice line: ${JSON.stringify(line)}`);
  }

  // The boundary audit still has the last word, including on a Codex session whose provider
  // output WAS a terminal completed result — completion never buys an out-of-scope edit.
  const built = writeBuilt();
  const audits = [];
  const seen = runAuthorIssue(built, { status: 0, stdout: CODEX_TERMINAL, stderr: '' }, {
    auditAuthorTree: () => {
      audits.push(true);
      return audits.length === 1 ? { ok: true }
        : { ok: false, error: `the dedicated test-author worktree has changes outside tests/acceptance/${ISSUE}/: scripts/author-tests.js` };
    },
  });
  assert.strictEqual(seen.result.ok, false, JSON.stringify(seen.result));
  assert.strictEqual(seen.result.outcome, 'boundary-violation', JSON.stringify(seen.result));
  assert.strictEqual(seen.proofs, 0, 'an out-of-scope edit still reached the green proof');
  assert(/scripts\/author-tests\.js/.test(seen.err), seen.err);
});

// ── T3 / C3 ──────────────────────────────────────────────────────────────────────────────────
test('T3 C3 a provider that exits zero is a successful author session only when an item.completed agent_message is followed by turn.completed, and Claude prose stays acceptable', () => {
  // Deliberately independent of runner/author-containment.js: the terminal-result rule is its
  // own decision, and this check must fail for its own reason rather than for a missing module.
  const incomplete = [
    ['codex JSONL with no completed agent_message', 'codex', CODEX_NO_TERMINAL],
    ['codex with no output at all', 'codex', ''],
    ['codex with bare prose instead of its guaranteed --json stream', 'codex', 'I wrote the tests.\n'],
    ['codex agent_message completed with no turn.completed anywhere in the stream', 'codex', CODEX_MESSAGE_NO_TURN],
    ['codex agent_message completed but the turn that carried it failed', 'codex', CODEX_MESSAGE_THEN_FAILED],
    ['codex turn.completed present but before the final agent_message, not after', 'codex', CODEX_TURN_BEFORE_MESSAGE],
    ['a Claude result envelope carrying no result string', 'claude',
      `${JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true })}\n`],
  ];
  for (const [label, provider, stdout] of incomplete) {
    const built = writeBuilt({ provider, testAuthorProvider: provider, testProbeProvider: provider });
    const seen = runAuthorIssue(built, { status: 0, stdout, stderr: '' });
    assert.strictEqual(seen.result.ok, false, `${label}: ${JSON.stringify(seen.result)}`);
    assert.strictEqual(seen.result.outcome, 'agent-incomplete', `${label}: ${JSON.stringify(seen.result)}`);
    assert.strictEqual(seen.result.kind, 'incomplete', `${label}: ${JSON.stringify(seen.result)}`);
    assert.strictEqual(seen.result.exitCode, AUTHOR.EXIT_AGENT, `${label}: ${JSON.stringify(seen.result)}`);
    assert.notStrictEqual(AUTHOR.EXIT_AGENT, 0);
    assert.strictEqual(seen.proofs, 0, `${label}: an incomplete session reached the green proof`);
    assert(seen.err.trim().length > 0, `${label}: an incomplete session was refused without saying so`);
  }

  const complete = [
    ['codex agent_message completed and followed by turn.completed', 'codex', CODEX_TERMINAL],
    ['Claude prose, which its argv never asked to be structured and which Claude only ever writes after the process completes', 'claude', 'Wrote the suite and stopped.\n'],
    ['a Claude result envelope with its result string', 'claude',
      `${JSON.stringify({ type: 'result', subtype: 'success', result: 'Wrote the suite.' })}\n`],
  ];
  for (const [label, provider, stdout] of complete) {
    const built = writeBuilt({ provider, testAuthorProvider: provider, testProbeProvider: provider });
    const seen = runAuthorIssue(built, { status: 0, stdout, stderr: '' });
    assert.strictEqual(seen.result.ok, true, `${label}: ${JSON.stringify(seen.result)}`);
    assert.strictEqual(seen.result.outcome, 'proven', `${label}: ${JSON.stringify(seen.result)}`);
    assert.strictEqual(seen.proofs, 1, `${label}: the green proof did not run`);
  }

  // A non-zero exit keeps its existing, distinct outcome — the new rule adds a refusal, it does
  // not relabel the one that already existed.
  const built = writeBuilt();
  const failed = runAuthorIssue(built, { status: 9, stdout: CODEX_TERMINAL, stderr: 'codex died' });
  assert.strictEqual(failed.result.outcome, 'agent-failed', JSON.stringify(failed.result));
  assert.strictEqual(failed.proofs, 0);
});

// ── T4 / C4 ──────────────────────────────────────────────────────────────────────────────────
test('T4 C4 the 231-memory / no-suite session is reproduced key-free end to end, completes bounded, and leaves Claude and the RED/GREEN proof intact', () => {
  const CONTAIN = containment();
  for (const name of PROVIDER_KEY_NAMES) {
    assert.strictEqual(process.env[name], undefined, `${name} is set; this reproduction must need no provider key`);
  }

  // (a) THE PRIOR FAILURE, reproduced: with the target project's bd on PATH, one `bd prime` in
  // the author session hands the model the whole 231-memory corpus.
  const corpus = corpusBin(executableTmp('corpus'));
  const unbounded = shell('bd prime', keyFreeEnv({ PATH: `${corpus}${path.delimiter}${ORIGINAL_PATH}` }), ROOT);
  assert.strictEqual(unbounded.status, 0, `the corpus fixture is not reachable at all: ${unbounded.text}`);
  assert(unbounded.text.includes(CORPUS_KEY),
    `the corpus fixture did not reproduce ${CORPUS_SIZE} memories: ${unbounded.text.slice(0, 200)}`);
  assert(unbounded.text.length > CONTAIN.REFUSAL_MAX_CHARS * 4, 'the corpus fixture is not large enough to be the failure');

  // (b) A deterministic stand-in for the provider process: it does exactly what the failing
  // session did — reaches for `bd prime` through its shell, writes no suite, and exits ZERO
  // with a JSONL stream that never completed a turn.
  const fixtureDir = tmp('provider');
  const report = path.join(fixtureDir, 'bd-report.json');
  const jsonlFile = path.join(fixtureDir, 'stream.jsonl');
  const providerJs = path.join(fixtureDir, 'fake-provider.js');
  fs.writeFileSync(providerJs, [
    "'use strict';",
    "const fs = require('fs');",
    "const { spawnSync } = require('child_process');",
    "const r = spawnSync('bd prime', { shell: true, encoding: 'utf8', timeout: 120000 });",
    'fs.writeFileSync(process.env.PIPELINE_FIXTURE_REPORT, JSON.stringify({',
    '  status: r.status, text: `${r.stdout || \'\'}${r.stderr || \'\'}`,',
    "  spawnError: r.error ? String(r.error.message) : null }));",
    "process.stdout.write(fs.readFileSync(process.env.PIPELINE_FIXTURE_JSONL, 'utf8'));",
    'process.exit(0);',
  ].join('\n'));

  const worktree = tmp('worktree');
  const hostEnv = {
    PATH: `${corpus}${path.delimiter}${ORIGINAL_PATH}`,
    PIPELINE_FIXTURE_REPORT: report,
    PIPELINE_FIXTURE_JSONL: jsonlFile,
    PIPELINE_BD_CMD: 'node fake-bd.js',
  };
  const calls = [];
  const runSync = (command, args, opts) => {
    calls.push({ command, args, opts });
    const r = spawnSync(process.execPath, [providerJs], {
      encoding: 'utf8', env: opts.env, cwd: opts.cwd, input: opts.input, shell: false, timeout: 180000,
    });
    return { status: r.status, signal: r.signal, stdout: String(r.stdout || ''), stderr: String(r.stderr || ''),
      error: r.error || null };
  };

  fs.writeFileSync(jsonlFile, CODEX_NO_TERMINAL);
  const built = writeBuilt({ hostEnv }, worktree);
  // launchAuthor is deliberately NOT seamed out: the real one is what builds the environment
  // the stand-in provider inherits, so this is the production wiring minus the provider binary.
  const out = []; const err = []; let proofs = 0;
  const result = AUTHOR.authorIssue(built, path.join(ROOT, 'run.config.fixture.json'), {
    out: (m) => out.push(String(m)), err: (m) => err.push(String(m)),
  }, {
    auditAuthorTree: () => ({ ok: true }),
    runSync,
    proveTests: () => { proofs += 1; return { ok: true, attempt: 1, probe: 'fixture', evidence: '', agentOutput: '' }; },
  });

  assert(calls.length >= 1, 'the real launchAuthor never reached the host run seam');
  const launchEnv = calls[calls.length - 1].opts.env;
  const launchShim = firstPathEntry(launchEnv);          // also asserts exactly one PATH key
  assert(fs.existsSync(path.join(launchShim, 'bd')), `the contained launch PATH does not lead with a bd shim: ${launchShim}`);
  assert.strictEqual(launchEnv.PIPELINE_BD_CMD, undefined, 'the contained launch still carried a host bd override');
  assert.strictEqual(launchEnv.PIPELINE_FIXTURE_REPORT, report, 'containment dropped an unrelated hostEnv variable');

  // (c) BOUNDED: the corpus never reached the session.
  assert(fs.existsSync(report), 'the provider stand-in never ran');
  const bd = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.notStrictEqual(bd.status, 0, `bd prime succeeded inside the contained session: ${bd.text}`);
  assert(!bd.text.includes(CORPUS_KEY) && !/repo-legacy-note-/.test(bd.text),
    `the contained session still consumed the corpus: ${bd.text.slice(0, 200)}`);
  assert(bd.text.length <= CONTAIN.REFUSAL_MAX_CHARS,
    `the refusal was ${bd.text.length} chars, over the ${CONTAIN.REFUSAL_MAX_CHARS} bound`);
  assert(bd.text.includes(ISSUE), `the refusal does not name the snapshotted issue: ${bd.text}`);

  // (d) NO SUITE, NOT SUCCESS: exit zero with no completed turn is refused, and no proof runs.
  assert.strictEqual(result.ok, false, JSON.stringify(result));
  assert.strictEqual(result.outcome, 'agent-incomplete', JSON.stringify(result));
  assert.strictEqual(result.exitCode, AUTHOR.EXIT_AGENT, JSON.stringify(result));
  assert.strictEqual(proofs, 0, 'a session that wrote no suite still reached the green proof');
  assert.strictEqual(fs.existsSync(path.join(worktree, 'tests', 'acceptance', ISSUE)), false);
  assert(err.join('\n').trim().length > 0, 'the incomplete session was refused silently');

  // (e) BOUNDED COMPLETION: the same contained wiring, with a terminal result, still proves.
  fs.writeFileSync(jsonlFile, CODEX_TERMINAL);
  let proofs2 = 0; const out2 = [];
  const good = AUTHOR.authorIssue(built, path.join(ROOT, 'run.config.fixture.json'), {
    out: (m) => out2.push(String(m)), err: () => {},
  }, {
    auditAuthorTree: () => ({ ok: true }),
    runSync,
    proveTests: () => { proofs2 += 1; return { ok: true, attempt: 2, probe: 'fixture-probe', evidence: 'gate exit 0', agentOutput: '' }; },
  });
  assert.strictEqual(good.ok, true, JSON.stringify(good));
  assert.strictEqual(good.outcome, 'proven', JSON.stringify(good));
  assert.strictEqual(proofs2, 1, 'the RED/GREEN proof no longer runs on a complete session');
  assert(/freeze\.js commit/.test(out2.join('\n')), out2.join('\n'));
  const secondBd = JSON.parse(fs.readFileSync(report, 'utf8'));
  assert.notStrictEqual(secondBd.status, 0, 'containment lapsed on the completing session');

  // (f) CLAUDE COMPATIBILITY: the Claude author launch is the historical one, argv for argv,
  // and its Bash denial of bd is still what closes Beads on that provider.
  const claude = writeBuilt({ provider: 'claude', testAuthorProvider: 'claude', testProbeProvider: 'claude' }, worktree);
  const claudeCall = captureLaunch(claude);
  assert.strictEqual(claudeCall.command, 'claude');
  assert.deepStrictEqual(claudeCall.args, [
    '-p', '--model', 'fixture-model',
    '--restricted', '--permission-mode', 'acceptEdits',
    '--tools', AUTHOR.AUTHOR_TOOLS,
    '--allowedTools', `Read,Edit,Write,Glob,Grep,Bash(sh tools/run-acceptance.sh tests/acceptance/${ISSUE}/)`,
    '--disallowedTools', AUTHOR.DENIED_TOOLS,
    '--no-session-persistence',
  ]);
  assert.strictEqual(claudeCall.opts.input, `${claude.text}\n`);
  assert(AUTHOR.DENIED_TOOLS.split(',').includes('Bash(bd *)')
    && AUTHOR.DENIED_TOOLS.split(',').includes('Bash(bd*)'), AUTHOR.DENIED_TOOLS);
});

(async () => {
  let failed = 0;
  for (const item of tests) {
    try { await item.body(); console.log(`[test] PASS ${item.name}`); }
    catch (error) { failed += 1; console.error(`[test] FAIL ${item.name}: ${error.stack || error.message}`); }
  }
  cleanup();
  if (failed) { console.error(`[test] FAIL ${failed}/${tests.length} focused checks`); process.exitCode = 1; }
  else console.log(`[test] PASS ${tests.length}/${tests.length} focused checks`);
})().catch((error) => {
  cleanup();
  console.error(`[test] FAIL harness: ${error.stack || error.message}`);
  process.exitCode = 1;
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// SPEC DEFECTS FOUND
//
// D1 (C1) "bounded OR refused" is a disjunction with no tie-break, and the two are not the same
//    posture: a bounded `bd show` still hands the model issue text the coordinator deliberately
//    snapshotted, while a refusal hands it nothing. This suite reads the criterion at its
//    stronger end — every `bd` invocation is REFUSED, and the refusal itself is what is bounded
//    by REFUSAL_MAX_CHARS. A "bounded" implementation that truncated a corpus dump to 400
//    characters would satisfy the letter of C1 and still leak project memory; nothing in the
//    issue rules that out, so the suite does.
//
// D2 (C1/C4) Neither criterion says which SIDE owns containment, and the choice is already made
//    for us elsewhere: the frozen repo-45g suite pins the Codex author argv exactly, so any
//    `-c`-flag or sandbox-flag approach breaks an existing freeze. C1 reads as if the
//    implementer were free; they are not. Containment is environment-side here, and guard.js G3
//    pins that argv so the constraint is visible at the fork point rather than discovered on a
//    later run.
//
// D3 (C3) "a terminal completed author result" is undefined for Claude, whose author argv
//    requests no structured envelope at all — applying the rule literally to both providers
//    would fail every Claude session that ever ran and collide head-on with C4's "without
//    weakening Claude compatibility". The suite resolves it by provider: for Codex, which
//    always launches with `--json`, "terminal completed" means an `item.completed` agent_message
//    record FOLLOWED BY a `turn.completed` record later in the same stream — an agent_message
//    with no subsequent turn record, one followed by `turn.failed`, or a `turn.completed` that
//    precedes the final agent_message, are all read as an incomplete stream, not a completed
//    one. For Claude, plain `-p` prose is only ever written to stdout after the process has
//    already completed, so it carries no equivalent ordering to police and stays HONOURED
//    rather than required; but an explicit `{"type":"result", ...}` envelope that Claude does
//    choose to emit is held to the same completeness standard as Codex's — a result object with
//    no string `result` is malformed and INCOMPLETE regardless of the zero exit. That reading is
//    an interpretation, not something the issue states.
//
// D4 (C4) "the prior 231-memory/no-suite failure" is named as though it were on record, but no
//    artifact in this repository carries that run. The reproduction here is therefore a
//    reconstruction from the two observable facts in the criterion — a 231-entry corpus reaching
//    one author session, and that session ending with no suite and a zero exit — rather than a
//    replay of captured evidence. If a real transcript exists it should be attached to the
//    issue; a reconstruction can only prove the shape of the failure, not its identity.
