// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
//
// repo-062 review corrections — bounded, deterministic regression coverage for the SIX bounded
// corrections applied after independent review of the accepted repo-062 behaviour. This suite is
// UNFROZEN (tests/integration/), authored per the review instruction, and is run explicitly
// alongside the frozen tests/acceptance/repo-062/ suite and the mandatory profile. Each block
// names the correction it covers:
//
//   1. Bind the documentation delta inspection to actual pinned Git objects: a container-writable
//      refs/replace baseline that masks a prohibited README.md change under an ordinary git diff
//      is still refused because publication reads `git --no-replace-objects diff`.
//   2. Preserve literal Git pathnames: a root-level blob literally named `src\README.md` (no
//      slash) is protected; nested `src/README.md` is allowed — classified from real Git `-z`
//      deltas, never by Windows filesystem path interpretation.
//   3. Carry the verified original intent (constraints, nonGoals, exact docs directive, kickoff
//      hash) into the acceptance-author brief renderer even when the planner omits it; a legacy
//      record with no new metadata leaves the brief unchanged.
//   4. Refuse malformed new intent shapes before scope derivation: a hash-consistent intent of
//      `null`, `constraints` as a string, and `nonGoals: null` fail closed at the host export;
//      valid original values stay lossless; legacy records keep prior behaviour.
//   5. Fail closed on Git execution errors even at status 0: a narrowly injected external Git
//      process fault (ENOBUFS-shaped, status 0, truncated stdout) refuses publication before any
//      push or PR — observed as zero push/PR calls.
//   6. Keep the omission log truthful for unsuccessful work: a failed documentation-prohibited
//      outcome records a NEUTRAL omission line, never the "verified implementation summary is
//      retained" claim reserved for authoritative success.
//
// Self-contained: Node built-ins and real local Git repositories only. No provider key, no real
// Beads binary, no network, no container engine. External model/CLI boundaries are the only
// substitutions. Authored for the canonical Linux gate.
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const docsScope = require(path.join(ROOT, 'runner', 'docs-scope.js'));
const queue = require(path.join(ROOT, 'runner', 'queue.js'));
const publishMod = require(path.join(ROOT, 'runner', 'publish.js'));
const specBrief = require(path.join(ROOT, 'scripts', 'spec-brief.js'));

const DIRECTIVE_ALIAS = docsScope.DIRECTIVE_ALIAS;
const DIRECTIVE_DEMO = docsScope.DIRECTIVE_DEMO;
const { resolveHostShell } = require(path.join(ROOT, 'runner', 'host-shell.js'));
const resolvedShell = resolveHostShell();
assert(resolvedShell.ok, resolvedShell.reason);
const hostShell = resolvedShell.command;

const temps = [];
function tmp(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `repo062ir-${tag}-`));
  temps.push(d);
  return d;
}
function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', timeout: 120000, windowsHide: true, ...options });
}
const git = (dir, ...args) => run('git', ['-c', 'safe.directory=*', '-c', 'commit.gpgsign=false', ...args], { cwd: dir });
function gitInput(dir, args, input = '') {
  const result = run('git', ['-c', 'safe.directory=*', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, input });
  assert(result.status === 0 && !result.error, JSON.stringify({ args, status: result.status, error: String(result.error || ''), stderr: result.stderr }));
  return result.stdout;
}
function addLiteralRootBlob(ws, name) {
  assert(!name.includes('/'), 'fixture must add a literal root filename');
  const blob = gitInput(ws.dir, ['hash-object', '-w', '--stdin'], 'root markdown\n').trim();
  const listing = gitInput(ws.dir, ['ls-tree', '-z', 'HEAD']);
  const tree = gitInput(ws.dir, ['mktree', '-z'], listing + '100644 blob ' + blob + '\t' + name + '\0').trim();
  const parent = gitInput(ws.dir, ['rev-parse', 'HEAD']).trim();
  const head = gitInput(ws.dir, ['commit-tree', tree, '-p', parent, '-m', 'literal root Markdown']).trim();
  gitInput(ws.dir, ['update-ref', 'refs/heads/' + ws.branch, head, parent]);
  assert.strictEqual(gitInput(ws.dir, ['rev-parse', 'HEAD']).trim(), head);
}
const shellQuote = value => "'" + String(value).replace(/\\/g, '/').replace(/'/g, "'\\''") + "'";
function ghFixture(base) {
  const calls = path.join(base, 'gh-calls.jsonl');
  const helper = path.join(base, 'gh-fixture.js');
  fs.writeFileSync(calls, '');
  fs.writeFileSync(helper, 'const fs = require("fs"); fs.appendFileSync(' + JSON.stringify(calls)
    + ', JSON.stringify({branch:process.env.PR_BRANCH,body:process.env.PR_BODY}) + "\\n");'
    + 'fs.writeSync(1,"https://example.test/pr/1\\n");');
  return { command: shellQuote(process.execPath) + ' ' + shellQuote(helper),
    read: () => fs.readFileSync(calls, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)) };
}
const silentLog = () => ({ info() {}, error() {}, event() {} });

const tests = [];
const test = (name, body) => tests.push({ name, body });

// A real repo with a bare remote, a committed fork point, and a task branch whose delta `mutate`
// produces. Returns the shape runner/publish.js consumes as `ws`.
function makeWorkspace(base, remote, seedFiles, mutate) {
  const dir = path.join(base, `ws-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'fixture@example.invalid');
  git(dir, 'config', 'user.name', 'repo-062 review fixture');
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'config', 'core.fileMode', 'true');
  for (const [rel, content] of Object.entries(seedFiles)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'fork point');
  const forkPoint = String(git(dir, 'rev-parse', 'HEAD').stdout || '').trim();
  git(dir, 'remote', 'add', 'origin', remote);
  git(dir, 'push', '-q', 'origin', 'main');
  const branch = `task/${path.basename(dir)}`;
  git(dir, 'checkout', '-q', '-b', branch);
  mutate(dir);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'task change');
  return { dir, forkPoint, branch, defaultBranch: 'main', regressionPolicy: null, memoryCount: 0 };
}
function makeRemote(base) {
  const remote = path.join(base, 'remote.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  return remote;
}

// Drive the real publication consumer with a preserve scope, counting real PR CLI calls through
// the gh seam. Returns { out, gh, onRemote }.
function publishPreserve(ws, cfg, publish = publishMod.publish) {
  const savedGh = process.env.PIPELINE_GH_CMD;
  const gh = ghFixture(tmp('gh'));
  process.env.PIPELINE_GH_CMD = gh.command;
  try {
    const out = publish(cfg, {
      ws, outcome: { status: 'done' }, hasCommits: true,
      issueMarkdown: '# scoped', status: { changeSummary: 'impl' },
      verify: { acceptance: 'pass', regressions: 'pass' },
      issue: { id: 'bd-scoped', title: 'scoped' }, runId: 'run-1', secrets: ['tok'],
      scope: { documentation: 'preserve', directive: DIRECTIVE_ALIAS },
    }, silentLog(), 'tr');
    return { out, gh: gh.read() };
  } finally {
    if (savedGh === undefined) delete process.env.PIPELINE_GH_CMD; else process.env.PIPELINE_GH_CMD = savedGh;
  }
}

// ── Correction 2: literal Git pathnames ─────────────────────────────────────────────────────
test('correction 2: a root-level blob literally named `src\\README.md` is protected, nested `src/README.md` is allowed, classified from real Git -z deltas', () => {
  // Pure classifier over a hand-built but real `-z` name-status record: an addition of the
  // backslash-bearing ROOT file and of a nested docs file, from ACTUAL Git bytes below.
  const base = tmp('c2');
  const remote = makeRemote(base);

  // Build the invalid-on-Windows filename directly in a real Git tree; never ask the host
  // filesystem or index to interpret its literal backslash. Keep every existing tree entry.
  const backslashName = 'src\\README.md';
  const ws = makeWorkspace(base, remote, { 'keep.txt': 'x\n' }, (d) => {
    fs.mkdirSync(path.join(d, 'src'), { recursive: true });
    fs.writeFileSync(path.join(d, 'src', 'README.md'), 'nested src readme (allowed)\n');
  });
  addLiteralRootBlob(ws, backslashName);
  const z = gitInput(ws.dir, ['diff', '--name-status', '-M', '-z', ws.forkPoint, 'HEAD']);
  assert(z.split('\0').includes(backslashName), 'actual Git delta omitted the literal root filename');
  const hits = docsScope.protectedMarkdownPaths(z);
  assert(hits.includes(backslashName),
    `the backslash-bearing root Markdown blob was not protected: ${JSON.stringify({ z, hits })}`);
  assert(!hits.includes('src/README.md'),
    `nested src/README.md was wrongly protected: ${JSON.stringify(hits)}`);

  // The classifier itself, exercised directly on both forms.
  assert(docsScope.isProtectedMarkdown('src\\README.md'), 'root backslash Markdown must be protected');
  assert(!docsScope.isProtectedMarkdown('src/README.md'), 'nested src/README.md must be allowed');
  assert(docsScope.isProtectedMarkdown('NOTES.MD'), 'uppercase root .md must be protected');
  assert(docsScope.isProtectedMarkdown('docs/deep/guide.md'), 'docs/**.md must be protected');

  // And through the real publication backstop: adding the protected backslash file under a
  // preserve scope refuses; adding only the allowed nested file publishes.
  const cfg = { targetRepoPath: base, gitTimeoutMs: 60000, defaultBranch: 'main', hostShell };
  const wsBackslash = ws;
  const refused = publishPreserve(wsBackslash, cfg);
  assert(refused.out && refused.out.ok === false && refused.out.pushed === false && !refused.out.prUrl,
    `the protected backslash-named blob was not refused: ${JSON.stringify(refused.out)}`);
  assert.strictEqual(refused.gh.length, 0, 'a PR was opened despite the refusal');

  const wsNested = makeWorkspace(base, remote, { 'keep.txt': 'x\n' },
    (d) => { fs.mkdirSync(path.join(d, 'src'), { recursive: true }); fs.writeFileSync(path.join(d, 'src', 'README.md'), 'nested\n'); });
  const allowed = publishPreserve(wsNested, cfg);
  assert(allowed.out && allowed.out.ok === true && allowed.out.pushed === true && allowed.out.prUrl,
    `an allowed nested src/README.md was wrongly refused: ${JSON.stringify(allowed.out)}`);
  assert.strictEqual(allowed.gh.length, 1, 'the positive control did not reach the GH seam');
});

// ── Correction 1: bind the delta inspection to actual pinned Git objects ─────────────────────
test('correction 1: a refs/replace baseline that masks a prohibited README.md change under an ordinary diff is still refused because publication reads --no-replace-objects', () => {
  const base = tmp('c1');
  const remote = makeRemote(base);
  const cfg = { targetRepoPath: base, gitTimeoutMs: 60000, defaultBranch: 'main', hostShell };

  // Fork point A carries README.md='baseline'; the task branch changes it to 'changed' (a
  // prohibited protected-surface modification under a preserve scope).
  const ws = makeWorkspace(base, remote, { 'README.md': 'baseline\n', 'src/app.js': 'code\n' },
    (d) => fs.writeFileSync(path.join(d, 'README.md'), 'changed\n'));

  // Build a replacement for the fork point whose TREE equals HEAD's tree, then install it as a
  // refs/replace object. `git diff A HEAD` now resolves A -> A' (same tree as HEAD) and reports
  // NOTHING; the prohibited README.md change is masked.
  const headTree = String(git(ws.dir, 'rev-parse', 'HEAD^{tree}').stdout || '').trim();
  const replacement = String(git(ws.dir, 'commit-tree', headTree, '-m', 'replacement baseline').stdout || '').trim();
  assert(/^[0-9a-f]{40}$/.test(replacement), `did not build a replacement commit: ${replacement}`);
  const replaced = git(ws.dir, 'replace', ws.forkPoint, replacement);
  assert.strictEqual(replaced.status, 0, `git replace failed: ${replaced.stderr}`);

  // Prove the scenario is real: the ordinary diff is EMPTY (masked), while --no-replace-objects
  // still shows the prohibited README.md modification against the real pinned baseline.
  const ordinary = String(git(ws.dir, 'diff', '--name-status', '-M', '-z', ws.forkPoint, 'HEAD').stdout || '');
  const pinned = String(git(ws.dir, '--no-replace-objects', 'diff', '--name-status', '-M', '-z', ws.forkPoint, 'HEAD').stdout || '');
  assert.strictEqual(docsScope.protectedMarkdownPaths(ordinary).length, 0,
    `the replace object did not mask the ordinary diff: ${JSON.stringify(ordinary)}`);
  assert(docsScope.protectedMarkdownPaths(pinned).includes('README.md'),
    `--no-replace-objects did not retain the real README.md change: ${JSON.stringify(pinned)}`);

  // The real publication consumer refuses: zero push, no PR, workspace retained.
  const res = publishPreserve(ws, cfg);
  assert(res.out && res.out.ok === false && res.out.pushed === false && !res.out.prUrl,
    `publication did not refuse a replace-masked protected change: ${JSON.stringify(res.out)}`);
  assert.strictEqual(res.gh.length, 0, 'a PR was opened despite the refusal');
  const onRemote = run('git', ['--git-dir', remote, 'rev-parse', '--verify', `refs/heads/${ws.branch}`]);
  assert.notStrictEqual(onRemote.status, 0, 'the refused branch reached the remote');
  assert(fs.existsSync(ws.dir), 'the recoverable workspace was discarded');
});

// ── Correction 5: fail closed on Git execution errors even at status 0 ───────────────────────
test('correction 5: a Git inspection that returns a non-timeout error (ENOBUFS-shaped) alongside status 0 and truncated stdout refuses publication before any push or PR', () => {
  const base = tmp('c5');
  const remote = makeRemote(base);
  const cfg = { targetRepoPath: base, gitTimeoutMs: 60000, defaultBranch: 'main', hostShell };
  // A product-only delta: absent the fix, an errored-but-status-0 diff parses to no protected
  // hits and the branch publishes. The fix must refuse on the error itself.
  const ws = makeWorkspace(base, remote, { 'README.md': 'r\n', 'src/app.js': 'code\n' },
    (d) => fs.appendFileSync(path.join(d, 'src/app.js'), 'more\n'));

  const cp = require('child_process');
  const realSpawn = cp.spawnSync;
  const procPath = require.resolve(path.join(ROOT, 'runner', 'process.js'));
  const pubPath = require.resolve(path.join(ROOT, 'runner', 'publish.js'));
  // Narrowly inject the fault at the external Git process boundary: only the docs-scope delta
  // inspection returns { status: 0, error: ENOBUFS, truncated stdout }; every other git call
  // delegates to the real spawnSync. Fresh-require process.js and publish.js so they capture the
  // patched spawnSync (both destructure it at module load).
  cp.spawnSync = (command, args, options) => {
    if (command === 'git' && Array.isArray(args)
        && args.includes('--no-replace-objects') && args.includes('diff')) {
      const err = new Error('spawnSync git ENOBUFS');
      err.code = 'ENOBUFS';
      return { pid: 0, status: 0, signal: null, stdout: '', stderr: '', error: err, output: ['', '', ''] };
    }
    return realSpawn(command, args, options);
  };
  let res;
  try {
    delete require.cache[procPath];
    delete require.cache[pubPath];
    const faultedPublish = require(pubPath);
    res = publishPreserve(ws, cfg, faultedPublish.publish);
  } finally {
    cp.spawnSync = realSpawn;
    delete require.cache[procPath];
    delete require.cache[pubPath];
    require(pubPath); // restore the shared instance for the rest of the suite
  }
  assert(res.out && res.out.ok === false && res.out.pushed === false && !res.out.prUrl,
    `an errored-but-status-0 Git inspection did not fail closed: ${JSON.stringify(res.out)}`);
  assert.strictEqual(res.gh.length, 0, 'a PR was opened despite the failed inspection');
  const onRemote = run('git', ['--git-dir', remote, 'rev-parse', '--verify', `refs/heads/${ws.branch}`]);
  assert.notStrictEqual(onRemote.status, 0, 'the branch reached the remote after a failed inspection');
});

// ── Correction 4: refuse malformed new intent shapes before scope derivation ─────────────────
function canonicalIntent(overrides) {
  return JSON.stringify({
    version: docsScope.INTENT_VERSION, title: 't', description: 'd',
    constraints: [DIRECTIVE_ALIAS], examples: [], nonGoals: [], priority: 2, relations: [], origin: null,
    ...overrides,
  });
}
test('correction 4: the shared reader accepts a canonical scoped intent losslessly and refuses null / string-constraints / null-nonGoals shapes that are JSON-parseable and hash-consistent', async () => {
  // Valid, lossless.
  const good = canonicalIntent({ constraints: [DIRECTIVE_ALIAS, 'keep the API stable'], nonGoals: ['no new deps'] });
  const okMeta = { intent: good, kickoffHash: docsScope.hashOf(good), scope: docsScope.deriveScope(JSON.parse(good)) };
  const okParsed = docsScope.readScopeMetadata(okMeta);
  assert.strictEqual(okParsed.format, 'scoped', `a valid scoped intent was not accepted: ${JSON.stringify(okParsed)}`);
  assert.strictEqual(okParsed.scope.documentation, 'preserve');
  assert.deepStrictEqual(okParsed.intentObj.constraints, [DIRECTIVE_ALIAS, 'keep the API stable']);
  assert.deepStrictEqual(okParsed.intentObj.nonGoals, ['no new deps']);

  // Malformed shapes that pass JSON.parse AND hash equality but are NOT a canonical kickoff
  // intent — each must fail closed at the structural gate, not derive a scope.
  const malformed = {
    'null intent': 'null',
    'constraints as a string': canonicalIntent({ constraints: 'pipeline:docs=preserve' }),
    'nonGoals: null': canonicalIntent({ nonGoals: null }),
    'wrong version': canonicalIntent({ version: 'kickoff-intake/2' }),
    'array intent': '[]',
    'empty title': canonicalIntent({ title: '' }),
    'missing canonical fields': JSON.stringify({ version: docsScope.INTENT_VERSION, title: 't', constraints: [], nonGoals: [] }),
    'invalid description': canonicalIntent({ description: 7 }),
    'invalid priority': canonicalIntent({ priority: 99 }),
    'invalid relation': canonicalIntent({ relations: [{ kind: 'blocks' }] }),
    'invalid origin': canonicalIntent({ origin: { kind: 'review' } }),
    'unknown field': canonicalIntent({ unexpected: true }),
    'missing examples': canonicalIntent({ examples: undefined }),
  };
  for (const [label, intent] of Object.entries(malformed)) {
    const meta = { intent, kickoffHash: docsScope.hashOf(intent), scope: { documentation: 'normal', directive: null } };
    const parsed = docsScope.readScopeMetadata(meta);
    assert.strictEqual(parsed.format, 'invalid', `${label}: was not refused (got ${JSON.stringify(parsed)})`);
  }

  // A legacy record with no new metadata keeps prior behaviour.
  assert.strictEqual(docsScope.readScopeMetadata({}).format, 'legacy');
  assert.strictEqual(docsScope.readScopeMetadata({ kickoffHash: 'sha256:x', specHash: 'y' }).format, 'legacy',
    'kickoffHash/specHash must not be treated as new-format markers');

  // The production host export refuses the same malformed shapes through the real Beads seam.
  await withBd(({ store }) => {
    const cfg = { targetRepoPath: path.dirname(store), bdTimeoutMs: 30000 };
    const d = JSON.parse(fs.readFileSync(store, 'utf8'));
    const push = (id, meta) => d.records.push({ id, title: 't', description: 'b', acceptance_criteria: 'a',
      design: 'design-ref: DESIGN.md#architecture', priority: 2, external_ref: `kickoff-spec:${id}`, metadata: meta, status: 'open' });
    push('bd-good', okMeta);
    for (const [label, intent] of Object.entries(malformed)) {
      push(`bd-${label.replace(/\W+/g, '-')}`,
        { intent, kickoffHash: docsScope.hashOf(intent), scope: { documentation: 'normal', directive: null } });
    }
    push('bd-legacy', {});
    fs.writeFileSync(store, JSON.stringify(d));

    const ok = queue.exportIssue(cfg, 'bd-good');
    assert(ok.ok === true && ok.scope && ok.scope.documentation === 'preserve',
      `the valid scoped issue did not export with its snapshot: ${JSON.stringify(ok)}`);
    for (const label of Object.keys(malformed)) {
      const out = queue.exportIssue(cfg, `bd-${label.replace(/\W+/g, '-')}`);
      assert(out && out.ok === false, `${label}: host export did not fail closed: ${JSON.stringify(out)}`);
    }
    const legacy = queue.exportIssue(cfg, 'bd-legacy');
    assert(legacy.ok === true && (!legacy.scope || legacy.scope.documentation !== 'preserve'),
      `a legacy issue was mishandled: ${JSON.stringify(legacy)}`);
  });
});

// ── Correction 3: carry the verified original intent into the author brief renderer ──────────
test('correction 3: real writeBrief and author-launch input retain original intent; malformed preparation refuses and legacy remains unchanged', async () => {
  const intent = canonicalIntent({ constraints: [DIRECTIVE_ALIAS, 'Keep the public input contract stable.'],
    nonGoals: ['Do not introduce new runtime dependencies.'] });
  const kickoffHash = docsScope.hashOf(intent);
  const data = { id: 'bd-x', title: 't', acceptance_criteria: '1. Planner omitted original intent.',
    metadata: { intent, kickoffHash, scope: docsScope.deriveScope(JSON.parse(intent)) } };
  const ctx = { cfg: { targetRepoPath: '/fixture', provider: 'claude', testAuthorProvider: 'claude', hostShell },
    id: data.id, suiteId: data.id, data, folder: { dir: '/fixture-author', branch: 'author', exists: true },
    branch: 'main', policy: { verifyCommand: 'node verify.js', frozenPaths: [] }, example: null,
    repoRoot: ROOT, state: { state: 'write', local: null } };
  const text = specBrief.writeBrief(ctx).join('\n');
  const author = require(path.join(ROOT, 'scripts', 'author-tests.js'));
  const calls = [];
  author.launchAuthor({ ...ctx, text }, 'claude-opus-4-8', (command, args, options) => {
    calls.push({ command, args, input: options.input });
    return { status: 0, stdout: '', stderr: '' };
  });
  assert.strictEqual(calls.length, 1, 'external model boundary was not reached exactly once');
  assert.strictEqual(calls[0].input, text + '\n');
  for (const value of [kickoffHash, DIRECTIVE_ALIAS, 'Keep the public input contract stable.',
    'Do not introduce new runtime dependencies.', 'Planner omitted original intent.']) {
    assert(calls[0].input.includes(value), 'author input lost ' + JSON.stringify(value));
  }
  const denied = calls[0].args[calls[0].args.indexOf('--disallowedTools') + 1];
  assert(denied.includes('Bash(bd *)') && denied.includes('Bash(git push*)'), 'author containment changed');
  const legacy = { ...data, metadata: {} };
  const absent = { ...data }; delete absent.metadata;
  assert.deepStrictEqual(specBrief.writeBrief({ ...ctx, data: legacy }), specBrief.writeBrief({ ...ctx, data: absent }));
  const invalid = { ...data, metadata: { intent: 'null', kickoffHash: docsScope.hashOf('null'), scope: { documentation: 'normal', directive: null } } };
  assert.throws(() => specBrief.writeBrief({ ...ctx, data: invalid }), /invalid kickoff metadata/);
  await withBd(({ store }) => {
    const base = tmp('invalid-brief');
    const { remote, seed } = seedRunRepo(base, invalid.id);
    fs.writeFileSync(store, JSON.stringify({ records: [invalid] }));
    const config = path.join(base, 'config.json');
    fs.writeFileSync(config, JSON.stringify({ targetRepoPath: seed, targetRepoRemote: remote,
      image: 'unused:local', hostShell }));
    const built = specBrief.buildBrief({ id: invalid.id, config });
    assert.strictEqual(built.ok, false, 'malformed metadata produced an author-ready brief');
    assert.strictEqual(built.kind, 'issue');
    assert(/canonical kickoff intent/.test(built.error), built.error);
  });
});

// ── Correction 6: keep the omission log truthful for unsuccessful work ────────────────────────
// A compact real runOneTask: a scoped (preserve) issue seeded into the stateful bd store, a real
// clone, and a PIPELINE_EXEC_STUB standing in for the container. The stub's exit code decides the
// outcome; the omission line the host writes must match the outcome.
const runmod = require(path.join(ROOT, 'runner', 'run.js'));
const logmod = require(path.join(ROOT, 'runner', 'log.js'));

// The stateful external bd adapter (basename-dispatched, fs.writeSync stdout) — the repo's
// standard Docker-free Beads seam.
const BD_STUB = String.raw`
'use strict';
const _b = String(process.argv[1] || '').replace(/\\/g, '/').split('/').pop();
if (/\.js$/i.test(_b)) { /* another node child: stand aside */ } else {
  const fs = require('fs');
  const store = process.env.BD_STORE;
  const load = () => { try { return JSON.parse(fs.readFileSync(store, 'utf8')); } catch { return { records: [] }; } };
  const args = process.argv.slice(1);
  const emit = (o) => { fs.writeSync(1, JSON.stringify(o)); };
  if (_b === 'show') { const d = load(); emit(d.records.filter((r) => r.id === args[1])); process.exit(0); }
  if (_b === 'search') { const d = load(); emit(d.records); process.exit(0); }
  emit([]); process.exit(0);
}
`;
// Async on purpose: the environment must stay aimed for the WHOLE awaited body (a synchronous
// try/finally would restore it before an async runOneTask ever spawned bd).
async function withBd(fn) {
  const dir = tmp('bd');
  const stub = path.join(dir, 'bd-stub.js');
  const store = path.join(dir, 'store.json');
  fs.writeFileSync(stub, BD_STUB);
  fs.writeFileSync(store, JSON.stringify({ records: [] }));
  const saved = { PIPELINE_BD_CMD: process.env.PIPELINE_BD_CMD, NODE_OPTIONS: process.env.NODE_OPTIONS, BD_STORE: process.env.BD_STORE };
  process.env.PIPELINE_BD_CMD = process.execPath;
  process.env.NODE_OPTIONS = `--require "${stub.split(path.sep).join('/')}"`;
  process.env.BD_STORE = store;
  try { return await fn({ store, dir }); }
  finally { for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
}

function seedRunRepo(base, issueId) {
  const remote = path.join(base, 'remote.git');
  const seed = path.join(base, 'seed');
  fs.mkdirSync(seed, { recursive: true });
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'config', 'user.email', 'f@test.local');
  git(seed, 'config', 'user.name', 'f');
  git(seed, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(seed, 'pipeline.config.json'), `${JSON.stringify({ verifyCommand: 'sh tools/run-acceptance.sh', defaultBranch: 'main', frozenPaths: [], dependencies: {} }, null, 2)}\n`);
  fs.writeFileSync(path.join(seed, 'README.md'), 'seed\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'seed');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-q', 'origin', 'main');
  return { remote, seed };
}

// Drive runOneTask for a preserve-scoped issue with an exec stub of the given exit code. Returns
// the run log text and manifest row.
async function runScopedOutcome(tag, stubBody) {
  return withBd(async ({ store }) => {
    const base = tmp(`run-${tag}`);
    const issueId = `bd-${tag}`;
    const intent = canonicalIntent({ constraints: [DIRECTIVE_ALIAS], nonGoals: [] });
    const d = JSON.parse(fs.readFileSync(store, 'utf8'));
    d.records.push({ id: issueId, title: 'scoped', description: 'b', acceptance_criteria: 'a',
      design: 'design-ref: DESIGN.md#architecture', priority: 2, external_ref: `kickoff-spec:${issueId}`,
      metadata: { intent, kickoffHash: docsScope.hashOf(intent), scope: docsScope.deriveScope(JSON.parse(intent)) }, status: 'open' });
    fs.writeFileSync(store, JSON.stringify(d));

    const { remote, seed } = seedRunRepo(base, issueId);
    const stub = path.join(base, 'exec-stub.sh');
    fs.writeFileSync(stub, stubBody);
    const saved = {};
    const set = (k, v) => { saved[k] = process.env[k]; process.env[k] = v; };
    set('PIPELINE_EXEC_STUB', stub);
    const gh = ghFixture(base);
    set('PIPELINE_GH_CMD', gh.command);
    const savedKeep = process.env.PIPELINE_KEEP_WORKSPACE; delete process.env.PIPELINE_KEEP_WORKSPACE;
    const log = logmod.startRun(path.join(base, 'runs-root'), `ir-${tag}`);
    const cfg = { targetRepoPath: seed, targetRepoRemote: remote, image: 'unused:local',
      wallClockMinutes: 60, maxAttempts: 1, concurrency: 1, gitTimeoutMs: 60000, bdTimeoutMs: 30000, lifecycleTimeoutMs: 120000, hostShell };
    const gate = { admit: async () => true, reportLimit: async () => ({ resumed: false }) };
    let row = null; let threw = null;
    try { row = await runmod.runOneTask(cfg, { id: issueId, title: 'scoped', priority: 1 }, log, 'tok', gate); }
    catch (e) { threw = e; }
    finally {
      for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
      if (savedKeep === undefined) delete process.env.PIPELINE_KEEP_WORKSPACE; else process.env.PIPELINE_KEEP_WORKSPACE = savedKeep;
    }
    const logText = fs.existsSync(log.logFile) ? fs.readFileSync(log.logFile, 'utf8') : '';
    return { row, threw, logText, gh: gh.read() };
  });
}

test('correction 6: a FAILED documentation-prohibited outcome records a neutral omission line, never the verified-success claim; a verified success keeps the retained claim', async () => {
  // Failed: the container exits 1 and writes a status file but no acceptance pass.
  const failStub = [
    '#!/bin/sh',
    'mkdir -p "$RUN_DIR"',
    'printf \'{"changeSummary":"partial work","attempts":[{"number":1,"verifierResult":"fail"}]}\' > "$RUN_DIR/status.json"',
    'printf \'{"acceptance":"fail","regressions":"fail"}\' > "$RUN_DIR/verify.json"',
    'exit 1',
    '',
  ].join('\n');
  const failed = await runScopedOutcome('fail', failStub);
  assert.strictEqual(failed.threw, null, `runOneTask threw: ${failed.threw && failed.threw.stack}`);
  assert(failed.row && failed.row.outcome === 'failed', `expected a failed outcome: ${JSON.stringify(failed.row)}`);
  assert.strictEqual(failed.gh.length, 0, 'failed control reached PR creation');
  const omissionLines = failed.logText.split(/\r?\n/).filter((l) => /document/i.test(l) && /(omit|skip|preserv|prohibit)/i.test(l));
  assert(omissionLines.length >= 1, `no documentation-omission line was recorded on failure: ${JSON.stringify(omissionLines)}`);
  assert(!omissionLines.some((l) => /verified implementation summary is retained/i.test(l)),
    `a failed outcome falsely claimed the verified implementation summary is retained: ${JSON.stringify(omissionLines)}`);
  // The omission line stays free of error/publication vocabulary (still a scope decision, not a defect).
  assert(omissionLines.some((l) => l.length <= 300 && !/(error|failed|failure|publish|refus|reject)/i.test(l)),
    `the neutral omission line carried defect vocabulary: ${JSON.stringify(omissionLines)}`);

  // Verified success: the container exits 0 with a valid passing artifact set and the exact
  // change summary — the retained claim is legitimate here.
  const TS = '2026-09-19T00:00:00Z';
  const passStub = [
    '#!/bin/sh',
    'mkdir -p "$RUN_DIR"',
    'printf \'verified\\n\' > "$WORKSPACE/feature.txt"',
    '( cd "$WORKSPACE" && git add -A && git -c user.email=f@t -c user.name=f commit -qm impl )',
    `printf '{"issueId":"%s","changeSummary":"the verified implementation summary","attempts":[{"number":1,"verifierResult":"pass","timestamp":"${TS}"}]}' "$ISSUE_ID" > "$RUN_DIR/status.json"`,
    `printf '{"issueId":"%s","timestamp":"${TS}","acceptance":"pass","regressions":"pass"}' "$ISSUE_ID" > "$RUN_DIR/verify.json"`,
    'exit 0',
    '',
  ].join('\n');
  const ok = await runScopedOutcome('pass', passStub);
  assert.strictEqual(ok.threw, null, `runOneTask threw: ${ok.threw && ok.threw.stack}`);
  assert(ok.row && ok.row.outcome === 'done', 'positive control never reached done: ' + JSON.stringify(ok.row));
  assert.strictEqual(ok.row.error, undefined, JSON.stringify(ok.row));
  assert.strictEqual(ok.row.recoveryWorkspace, undefined, JSON.stringify(ok.row));
  assert.strictEqual(ok.row.pushed, true);
  assert.strictEqual(ok.row.prUrl, 'https://example.test/pr/1');
  assert.strictEqual(ok.gh.length, 1, 'positive control must reach exactly one substituted PR call');
  assert.strictEqual(ok.row.changeSummary, 'the verified implementation summary');
  const retained = ok.logText.split(/\r?\n/).filter(l => /verified implementation summary is retained/i.test(l));
  assert(retained.length >= 1, 'successful control dropped the retained-summary claim');
});

(async () => {
  let failed = 0;
  for (const item of tests) {
    try { await item.body(); console.log(`ok - ${item.name}`); }
    catch (error) { failed = 1; console.log(`FAIL - ${item.name} — ${error && error.message ? error.message : error}`); }
  }
  for (const dir of temps.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* disposable */ }
  }
  process.exit(failed);
})().catch((error) => {
  console.log(`FAIL - harness — ${error && error.stack ? error.stack : error}`);
  process.exit(1);
});
