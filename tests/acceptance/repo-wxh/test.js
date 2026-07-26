// Frozen acceptance test — repo-wxh: record the model that actually ran, not the first
// key of modelUsage (DESIGN.md §4.3, §4.11). Written before implementation, from the
// spec alone; criteria D1–D12. Plain Node, Docker-free.
//
// The fixtures are the load-bearing part. In every multi-key fixture the key that must
// NOT win is listed FIRST, so today's `Object.keys(modelUsage)[0]` cannot pass by
// accident — and D1 puts the alias-matching key second AND gives it fewer outputTokens,
// so an implementation that ignores the alias and always takes the biggest also fails.
// An earlier draft of these criteria let both wrong implementations through.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ENVELOPE_JS = path.join(ROOT, 'pipeline', 'envelope.js');
let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) failed = 1;
}
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

let envelope = null;
try { envelope = require(ENVELOPE_JS); } catch { /* reported next */ }
check('envelope.js is requirable', envelope !== null && typeof envelope.parse === 'function');
const parse = (envelope && envelope.parse) ? envelope.parse : () => null;

const RESULT = 'the change summary text';
// A CLI warning ahead of the envelope, so the bottom-up scan stays exercised.
const log = (modelUsage) => [
  'Warning: this workspace is untrusted',
  JSON.stringify({ is_error: false, result: RESULT, ...(modelUsage ? { modelUsage } : {}) }),
  '',
].join('\n');
const model = (text, alias) => {
  const r = alias === undefined ? parse(text) : parse(text, alias);
  return r ? r.model : null;
};

// ---- D1: the discriminating case ---------------------------------------------------
// Non-matching key first AND larger; alias-matching key second AND smaller.
const D1 = log({
  'claude-haiku-4-5-20251001': { outputTokens: 9000, canonicalModel: 'claude-haiku-4-5' },
  'claude-opus-5': { outputTokens: 40, canonicalModel: 'claude-opus-5' },
});
check('D1 alias picks the matching key even though it is second and smaller',
  model(D1, 'opus') === 'claude-opus-5');
check('D1 without an alias, the greatest outputTokens wins',
  model(D1) === 'claude-haiku-4-5-20251001');

// ---- D2: the canonicalModel clause -------------------------------------------------
// Neither KEY contains "opus"; only the second entry's canonicalModel does.
const D2 = log({
  'model-a-2026': { outputTokens: 9000, canonicalModel: 'claude-haiku-4-5' },
  'model-b-2026': { outputTokens: 5, canonicalModel: 'claude-opus-5' },
});
check('D2 alias matches via canonicalModel when the key name does not contain it',
  model(D2, 'opus') === 'model-b-2026');

// ---- D3: no alias and the empty alias behave identically ---------------------------
const D3 = log({
  'aaa-small': { outputTokens: 5 },
  'zzz-big': { outputTokens: 9000 },
});
check('D3 no alias -> greatest outputTokens (not the first-listed key)',
  model(D3) === 'zzz-big');
check('D3 empty alias behaves exactly as no alias',
  model(D3, '') === 'zzz-big');

// ---- D4: a single-key envelope -----------------------------------------------------
const D4 = log({ 'claude-opus-5': { outputTokens: 3 } });
check('D4 single key, matching alias', model(D4, 'opus') === 'claude-opus-5');
check('D4 single key, non-matching alias', model(D4, 'sonnet') === 'claude-opus-5');
check('D4 single key, no alias', model(D4) === 'claude-opus-5');

// ---- D5: missing outputTokens counts as 0 ------------------------------------------
// The shape the frozen repo-52m fixture uses. Non-winner listed first.
const D5 = log({ 'zzz-nokens': {}, 'aaa-nokens': {} });
check('D5 no outputTokens anywhere -> ascending-name winner', model(D5) === 'aaa-nokens');
const D5b = log({ 'zzz-bad': { outputTokens: 'not-a-number' }, 'aaa-bad': { outputTokens: 0 } });
check('D5 non-numeric outputTokens treated as 0 -> ascending-name winner',
  model(D5b) === 'aaa-bad');

// ---- D6: ties resolve by ascending name --------------------------------------------
const D6 = log({ 'zzz-tie': { outputTokens: 100 }, 'aaa-tie': { outputTokens: 100 } });
check('D6 tie -> ascending-name winner (not the first-listed key)', model(D6) === 'aaa-tie');

// ---- D7: absent data ---------------------------------------------------------------
check('D7 envelope with no modelUsage -> model null', model(log(null)) === null);
check('D7 log with no envelope -> parse returns null',
  parse('just some prose\nno json here\n') === null);

// ---- D8: the flatten CLI -----------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-wxh-'));
function flatten(text, alias) {
  const f = path.join(tmp, `log-${Math.abs(text.length + String(alias).length)}-${alias || 'none'}.txt`);
  fs.writeFileSync(f, text);
  const args = [ENVELOPE_JS, 'flatten', f];
  if (alias !== undefined) args.push(alias);
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
  return { r, after: read(f) };
}
const f1 = flatten(D1, 'opus');
check('D8 flatten exits 0', f1.r.status === 0);
check('D8 flatten prints the chosen model', (f1.r.stdout || '').trim() === 'claude-opus-5');
check('D8 flatten rewrites the file to the result text', f1.after === RESULT);
const f2 = flatten(D1);
check('D8 flatten works with no third argument',
  f2.r.status === 0 && (f2.r.stdout || '').trim() === 'claude-haiku-4-5-20251001');

const plain = 'no envelope here\njust text\n';
const f3 = flatten(plain, 'opus');
check('D8 envelope-free file left byte-identical', f3.after === plain);
check('D8 envelope-free file prints nothing, exits 0',
  f3.r.status === 0 && (f3.r.stdout || '').trim() === '');

// ---- D9: the miss diagnostic -------------------------------------------------------
const miss = flatten(D1, 'sonnet');
const missErr = miss.r.stderr || '';
check('D9 miss exits 0', miss.r.status === 0);
check('D9 stdout still carries the rule-3 choice',
  (miss.r.stdout || '').trim() === 'claude-haiku-4-5-20251001');
check('D9 stderr names the expected alias', missErr.includes('sonnet'));
check('D9 stderr names the keys actually seen',
  missErr.includes('claude-haiku-4-5-20251001') && missErr.includes('claude-opus-5'));

// D3/D4 completion: the diagnostic must NOT fire when there is no alias, when the alias
// is empty, or when rule 2 resolves a single key against a non-matching alias.
check('D3 no diagnostic without an alias', (flatten(D3).r.stderr || '').trim() === '');
check('D3 no diagnostic for an empty alias', (flatten(D3, '').r.stderr || '').trim() === '');
check('D4 no diagnostic when a single key resolves a non-matching alias',
  (flatten(D4, 'sonnet').r.stderr || '').trim() === '');

// ---- D10: backward compatibility, actually executed --------------------------------
// The verifier runs only THIS directory and this repo declares no regressionCommand, so
// nothing else would catch a regression in one-argument parse. Safe to shell out: that
// file is plain Node, not `node --test`, so there is no NODE_TEST_CONTEXT self-nesting.
const compat = spawnSync(process.execPath, [path.join(ROOT, 'tests', 'acceptance', 'repo-52m', 'test.js')],
  { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
check('D10 the frozen repo-52m suite still passes', compat.status === 0);

// ---- D11 / D12: end to end through the entrypoint ----------------------------------
function buildRun(tag, envelopeText) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `accept-wxh-${tag}-`));
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
  // Stub verifier: the real one re-runs `sh tools/run-acceptance.sh`, which would invoke
  // the acceptance runner from inside the acceptance runner (shadow-01).
  fs.writeFileSync(path.join(pipe, 'verify.js'), 'process.exit(0);\n');
  const git = (args) => spawnSync('git', args, { cwd: ws, encoding: 'utf8', env: { ...process.env, HOME: home } });
  git(['init', '-q']);
  git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'seed']);
  fs.writeFileSync(path.join(ws, '.run', 'issue.md'), `# ${tag}: model-id fixture\n`);
  const agentStub = path.join(base, 'agent-stub.sh');
  fs.writeFileSync(agentStub, [
    '#!/bin/sh',
    'cat > /dev/null',
    `cat <<'ENVELOPE_EOF'`,
    envelopeText.trimEnd(),
    'ENVELOPE_EOF',
    '',
  ].join('\n'));
  fs.chmodSync(agentStub, 0o755);
  return { ws, home, pipe, agentStub };
}
function runEntrypoint(fx, pinned) {
  const env = {
    PATH: process.env.PATH,
    HOME: fx.home,
    WORKSPACE: fx.ws,
    PIPELINE_DIR: fx.pipe,
    ISSUE_ID: 'test-wxh',
    PIPELINE_AGENT_CMD: `sh ${fx.agentStub}`,
    CLAUDE_CODE_OAUTH_TOKEN: 'dummy-token-never-used',
  };
  if (pinned !== undefined) env.PIPELINE_MODEL = pinned;
  const r = spawnSync('bash', [path.join(ROOT, 'pipeline', 'entrypoint.sh')],
    { encoding: 'utf8', timeout: 120000, env });
  let status = {};
  try { status = JSON.parse(read(path.join(fx.ws, '.run', 'status.json'))); } catch { /* {} */ }
  return { r, status };
}

// D11: pinned to the SMALLER-token key — the alias must win over the token count.
const pinned = runEntrypoint(buildRun('pinned', D1), 'opus');
check('D11 pinned run exits 0', pinned.r.status === 0);
check('D11 status records the alias-matching key, not the bigger one',
  pinned.status.model === 'claude-opus-5');

// D12a: PIPELINE_MODEL unset. `set -u` is on in the entrypoint, so an unguarded
// pass-through aborts here — the case a pinned-only test never reaches.
const unpinned = runEntrypoint(buildRun('unpinned', D1), undefined);
check('D12 unpinned run still exits 0 (set -u guard)', unpinned.r.status === 0);
check('D12 unpinned run records the rule-3 key',
  unpinned.status.model === 'claude-haiku-4-5-20251001');

// D12b: alias matches nothing — the diagnostic must reach the ENTRYPOINT's own stderr,
// which proves the `2>/dev/null` on the flatten call was removed.
const missed = runEntrypoint(buildRun('missed', D1), 'sonnet');
check('D12 missed-alias run exits 0', missed.r.status === 0);
check('D12 the diagnostic reaches the entrypoint stderr',
  (missed.r.stderr || '').includes('sonnet'));
check('D12 missed-alias run still records the rule-3 key',
  missed.status.model === 'claude-haiku-4-5-20251001');

process.exit(failed);
