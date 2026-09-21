// repo-du4 [guard]: every test in this file must be GREEN at the fork point.
// Pairing (canonical issue criteria, in brief order):
// C1 141 eligible Markdown files reach enumeration -> test.js T1; G1 fixture controls.
// C2 exactly 256 admitted, 257 refused before checkout/planner/Beads -> T2; G2 refusal.
// C3 producer and consumer share one 256-file constant -> T3,T4; G1 seam controls.
// C4 other five ceilings unchanged -> G3,G4,G5,G6,G7.
// C5 only this new acceptance suite; existing suites unchanged -> G8.
// C6 control-plane guide and change log describe 256 files -> T5,T6.
// Kickoff constraints: no truncation -> T1,T2; filtering/slugging/dedup -> G7.
// SPEC DEFECT: repo-djf.60/guard.js G4 requires refusal at 129 files. Its frozen
// expectation conflicts with C1/C2. We preserve it under C5, not silently repair it.
// Helpers adapt the tested local-Git/config seams from repo-djf.60; that suite is
// executable, not an importable helper library. G1 proves both positive and negative
// controls. This file also exports helpers for test.js, but runs guards only as main.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '../../..');
const MODULE = path.join(ROOT, 'scripts/specify-proposal.js');
const specify = require(MODULE);
const COMMIT = 'a'.repeat(40);
const temps = [];
const hash = s => `sha256:${crypto.createHash('sha256').update(s).digest('hex')}`;
const jsonBytes = refs => Buffer.byteLength(JSON.stringify(refs));
function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'safe.directory=*', ...args], {
    cwd, encoding: 'utf8', timeout: 60000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
  });
  assert(!r.error && r.status === 0, `HARNESS Git ${args[0]}: ${r.error || r.stderr}`);
  return r.stdout;
}
function filesFor(n, headings = true) {
  return Object.fromEntries(Array.from({ length: n }, (_, i) =>
    [`docs/f${String(i).padStart(3, '0')}.md`, headings ? `# Heading ${i}\n` : 'body only\n']));
}
function refsFor(n) {
  return Array.from({ length: n }, (_, i) => `docs/f${String(i).padStart(3, '0')}.md#heading-${i}`);
}
function realRepo(files) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'du4-'));
  temps.push(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'acceptance fixture');
  git(repo, 'config', 'user.email', 'fixture@example.invalid');
  git(repo, 'config', 'core.autocrlf', 'false');
  git(repo, 'config', 'core.hooksPath', path.join(repo, 'no-hooks'));
  for (const [rel, text] of Object.entries(files)) {
    const dest = path.join(repo, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, text);
  }
  git(repo, 'add', '-A');
  git(repo, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  const commit = git(repo, 'rev-parse', 'HEAD').trim();
  assert(/^[a-f0-9]{40}$/.test(commit), 'HARNESS invalid fixture commit');
  return { repo, commit };
}
function adapters(repo = ROOT, run, api = specify) {
  return api.productionAdapters({ configPath: 'unused-fixture.json' }, {
    loadConfig: () => ({ codexAuth: 'chatgpt', targetRepoPath: repo }),
    kickoffApi: { statePathsFor: () => ({ state: path.join(os.tmpdir(), 'unused-du4-state') }) },
    bdJson: () => { throw new Error('HARNESS unexpected real Beads adapter'); },
    resolveBranch: () => ({ ok: true, branch: 'HEAD' }),
    ...(run ? { run } : {}),
  });
}
// Deterministic Git protocol double for exact byte boundaries that exceed portable
// filesystem path lengths. It checks actual maxBuffer options, never reimplements
// discovery, slugging or candidate validation. G1 calibrates it against real Git.
function synthetic(files, tree, api = specify) {
  const calls = [];
  const run = (cmd, args, opts) => {
    assert.strictEqual(cmd, 'git', 'HARNESS unexpected command');
    calls.push({ args, maxBuffer: opts.maxBuffer });
    let stdout;
    if (args[0] === 'ls-tree') stdout = tree === undefined
      ? Object.keys(files).sort().join('\0') + '\0' : tree;
    else if (args[0] === 'show') {
      const file = args[1].slice(args[1].indexOf(':') + 1);
      if (!Object.hasOwn(files, file)) return { status: 128, stdout: '', stderr: 'missing blob' };
      stdout = files[file];
    } else throw new Error(`HARNESS unsupported Git operation ${args[0]}`);
    if (Buffer.byteLength(stdout) > opts.maxBuffer) {
      return { status: null, stdout: '', error: Object.assign(new Error('buffer overflow'), { code: 'ENOBUFS' }) };
    }
    return { status: 0, stdout, stderr: '' };
  };
  return { discover: adapters(ROOT, run, api).deriveDesignReferenceCandidates, calls };
}
// Exercise REAL execute/consumer validation; only external effects and durable input
// reads are in-memory spies. Every forbidden effect is recorded before it can occur.
async function execute(discover, commit = COMMIT, api = specify) {
  const effects = [];
  let received;
  const intent = JSON.stringify({ version: 'kickoff-intake/1', title: 'fixture', description: '',
    constraints: [], examples: [], nonGoals: [], priority: 2, relations: [], origin: null });
  const id = 'kp-0123456789abcdef';
  const record = { version: 'kickoff-intake/1', id, target: ROOT, intent,
    hash: hash(intent), createdAt: '2026-09-21T00:00:00.000Z' };
  const result = await api.execute({ proposalId: id }, {}, {
    readKickoff: async () => record, readReceipt: async () => null,
    readQuestion: async () => null, readAnswer: async () => null,
    resolveIntegration: async () => ({ branch: 'main', commit }),
    deriveDesignReferenceCandidates: discover,
    createReadOnlyCheckout: async () => { effects.push('checkout'); return { path: ROOT, commit, readOnly: true }; },
    cleanupCheckout: async () => { effects.push('cleanup'); },
    launchCodex: async plan => {
      effects.push('planner'); received = plan.designReferenceCandidates;
      return JSON.stringify({ status: 'ready', spec: 'Fixture specification.',
        acceptanceCriteria: ['fixture passes'], designReferences: [received.at(-1)], difficulty: 'medium' });
    },
    validateDesignReference: async () => ({ ok: true }),
    beadsFind: async () => { effects.push('beadsFind'); return null; },
    beadsCreate: async () => { effects.push('beadsCreate'); return { id: 'fixture-1' }; },
    writeReceipt: async () => { effects.push('receipt'); },
    now: () => record.createdAt, crash: async () => {},
  });
  return { result, effects, received };
}
async function admitted(discover, expected, commit = COMMIT, api = specify) {
  const out = await execute(discover, commit, api);
  assert.strictEqual(out.result.status, 'ready', JSON.stringify(out.result));
  assert.deepStrictEqual(out.received, expected, 'planner must receive every candidate in order');
  assert.deepStrictEqual(out.effects, ['checkout', 'planner', 'cleanup', 'beadsFind', 'beadsCreate', 'receipt']);
}
async function refused(discover, commit = COMMIT, api = specify) {
  const out = await execute(discover, commit, api);
  assert.strictEqual(out.result.status, 'refused', JSON.stringify(out.result));
  assert.match(out.result.reason, /design-reference candidate discovery/, 'must refuse for discovery, not broken kickoff');
  assert.deepStrictEqual(out.effects, [], `overflow caused effects: ${out.effects}`);
}
function jsonFixture(bytes) {
  const refs = Array.from({ length: 130 }, (_, i) => `a.md#h${i}-` + 'z'.repeat(991 - String(i).length));
  const remaining = bytes - jsonBytes(refs) - 3;
  refs.push('a.md#last-' + 'z'.repeat(remaining - 10));
  assert.strictEqual(jsonBytes(refs), bytes, 'HARNESS exact JSON length');
  assert(refs.every(r => Buffer.byteLength(r) <= 1024), 'HARNESS per-reference isolation');
  return { refs, files: { 'a.md': refs.map(r => `# ${r.split('#')[1]}\n`).join('') } };
}
function describesCapacity(text) {
  return text.split(/\n\s*\n|\n(?=\|)/).some(unit =>
    /\b256(?:\s+(?:eligible\s+)?Markdown\s+files?\b|[- ]files?\b)/i.test(unit) && /Markdown/i.test(unit)
      && /design[- ]reference|design.{0,30}discovery/i.test(unit)
      && /capacit|ceil|limit|bound|up to|at most|enumerat|admit/i.test(unit));
}
async function run(tests) {
  let failed = 0;
  for (const [name, body] of tests) {
    try { await body(); console.log(`ok - ${name}`); }
    catch (e) { failed++; console.log(`FAIL - ${name} -- ${e.stack || e}`); }
  }
  for (const repo of temps) {
    assert(path.dirname(repo) === os.tmpdir() && path.basename(repo).startsWith('du4-'), 'HARNESS unsafe cleanup');
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  console.log(`${tests.length - failed}/${tests.length} checks passed`);
  process.exitCode = failed ? 1 : 0;
}
const tests = [
  ['G1 C1,C2,C3,C6 [guard] fixture positive/negative controls', async () => {
    const files = filesFor(2);
    const world = realRepo(files);
    const real = adapters(world.repo).deriveDesignReferenceCandidates;
    const fake = synthetic(files);
    assert.deepStrictEqual(await real(world.commit), refsFor(2));
    assert.deepStrictEqual(await fake.discover(COMMIT), await real(world.commit));
    await admitted(real, refsFor(2), world.commit);
    await refused(synthetic({}).discover);
    await refused(synthetic({}, 'missing.md\0').discover);
    await refused(async () => ['a.md#a', 'a.md#a']);
    await refused(real, 'b'.repeat(40));
    assert(describesCapacity('Design-reference discovery admits up to 256 eligible Markdown files.'));
    assert(!describesCapacity('Design-reference discovery admits up to 128 eligible Markdown files.'));
    assert(!describesCapacity('256 candidates; 128 Markdown files.'));
  }],
  ['G2 C2 [guard] 257 files fail before checkout, planner or Beads, even without headings', async () => {
    const files = filesFor(257, false);
    files['docs/f000.md'] = '# Heading 0\n';
    const world = realRepo(files);
    await refused(adapters(world.repo).deriveDesignReferenceCandidates, world.commit);
  }],
  ['G3 C4 [guard] tree buffer stays 262144 bytes inclusive', async () => {
    const tree = 'a.md\0' + 'x'.repeat(262144 - 6) + '\0';
    assert.strictEqual(Buffer.byteLength(tree), 262144);
    const yes = synthetic({ 'a.md': '# a\n' }, tree);
    await admitted(yes.discover, ['a.md#a']);
    assert.strictEqual(yes.calls[0].maxBuffer, 262144);
    await refused(synthetic({ 'a.md': '# a\n' }, tree + 'x').discover);
  }],
  ['G4 C4 [guard] per-file buffer stays 1048576 UTF-8 bytes inclusive', async () => {
    const text = '# a\n' + '\u2603'.repeat(349524);
    assert.strictEqual(Buffer.byteLength(text), 1048576);
    assert(text.length < 1048576);
    const yes = synthetic({ 'a.md': text });
    await admitted(yes.discover, ['a.md#a']);
    assert.strictEqual(yes.calls.find(c => c.args[0] === 'show').maxBuffer, 1048576);
    await refused(synthetic({ 'a.md': text + 'x' }).discover);
  }],
  ['G5 C4 [guard] producer and consumer keep 1024 candidates inclusive', async () => {
    for (const n of [1024, 1025]) {
      const refs = Array.from({ length: n }, (_, i) => `a.md#h${i}`);
      const fixture = synthetic({ 'a.md': refs.map(r => `# ${r.split('#')[1]}\n`).join('') });
      if (n === 1024) { await admitted(fixture.discover, refs); await admitted(async () => refs, refs); }
      else { await refused(fixture.discover); await refused(async () => refs); }
    }
  }],
  ['G6 C4 [guard] producer and consumer keep 131072 serialized-array bytes inclusive', async () => {
    for (const size of [131072, 131073]) {
      const f = jsonFixture(size);
      if (size === 131072) {
        await admitted(synthetic(f.files).discover, f.refs); await admitted(async () => f.refs, f.refs);
      } else { await refused(synthetic(f.files).discover); await refused(async () => f.refs); }
    }
  }],
  ['G7 C4,kickoff [guard] 1024-byte references, safe paths, heading slugs and dedup stay intact', async () => {
    const edge = 'a.md#' + 'x'.repeat(1019);
    const tooLong = edge + 'x';
    const files = { 'a.md': `# Hello, World!\n# Hello, World!\n# !!!\n#nospace\n####### seven\n###### Six ##\n# ${edge.slice(5)}\n# ${tooLong.slice(5)}\n`,
      '../unsafe.md': '# bad\n', 'space name.md': '# bad\n', '.hidden.md': '# bad\n', 'plain.txt': '# bad\n',
      'Z.MD': '# Upper\n' };
    await admitted(synthetic(files).discover, ['Z.MD#upper', 'a.md#hello-world', 'a.md#six', edge]);
    await admitted(async () => [edge], [edge]);
    await refused(async () => [tooLong]);
  }],
  ['G8 C5 [guard] all prior acceptance files unchanged; no other suite added', async () => {
    // Fixed author fork, not mutable main or HEAD (which could hide later modifications).
    const base = '7cff56922cf01dc07d589cc6e86234bce9bef234';
    const prior = git(ROOT, 'ls-tree', '-r', '--name-only', '-z', base, '--', 'tests/acceptance/').split('\0').filter(Boolean);
    assert(prior.length > 0, 'HARNESS fork acceptance inventory unavailable');
    const norm = s => s.replace(/\r\n/g, '\n');
    for (const rel of prior) {
      assert.strictEqual(norm(fs.readFileSync(path.join(ROOT, rel), 'utf8')),
        norm(git(ROOT, 'show', `${base}:${rel}`)), `existing frozen acceptance changed: ${rel}`);
    }
    const allowed = new Set(prior);
    function walk(dir) {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, ent.name);
        const rel = path.relative(ROOT, abs).split(path.sep).join('/');
        if (rel === 'tests/acceptance/repo-du4' || /^tests\/acceptance\/\.freeze-gate-guards-/.test(rel)) continue;
        if (ent.isDirectory()) walk(abs); else assert(allowed.has(rel), `new acceptance outside repo-du4: ${rel}`);
      }
    }
    walk(path.join(ROOT, 'tests/acceptance'));
  }],
];
module.exports = { ROOT, MODULE, specify, COMMIT, git, filesFor, refsFor, realRepo,
  adapters, synthetic, execute, admitted, refused, describesCapacity, run };
if (require.main === module) run(tests).catch(e => { console.error('HARNESS BROKEN', e); process.exitCode = 1; });
