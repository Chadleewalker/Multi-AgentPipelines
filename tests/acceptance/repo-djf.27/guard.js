// Frozen acceptance [guard] — repo-djf.27: existing envelope and fallback bytes survive.
// PAIRING (criterion -> tests): C1 -> T1,T2; C2 -> G1,G2,G3,G4; C3 -> T3;
// C4 -> T2; C5 -> G5,G6,T4.
// PAIRING (test -> criterion): G1,G2,G3,G4 -> C2; G5,G6 -> C5.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const ENVELOPE_JS = path.join(REPO, 'pipeline', 'envelope.js');
const STATUS_JS = path.join(REPO, 'pipeline', 'status.js');
const CLAUDE_RESULT = 'Kept the established Claude summary bytes exactly.';
const PLAIN_RESULT = 'Kept the plain-text stub fallback exactly.';
let failed = 0;

function check(name, yes, detail = '') {
  console.log(`${yes ? 'ok' : 'FAIL'} - ${name}${yes || !detail ? '' : ` — ${detail}`}`);
  if (!yes) failed = 1;
}
function read(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}
function runStatus(runDir, ...args) {
  return spawnSync(process.execPath, [STATUS_JS, ...args], {
    cwd: REPO, encoding: 'utf8', env: { ...process.env, RUN_DIR: runDir },
  });
}
function expectedStatus(issueId, summary) {
  return `${JSON.stringify({ issueId, attempts: [], changeSummary: summary }, null, 2)}\n`;
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-djf27-guard-'));
let removed = false;
try {
  let envelope = null;
  try { envelope = require(ENVELOPE_JS); } catch {}
  const claudeLog = [
    'Ignoring local settings for an untrusted workspace.',
    JSON.stringify({
      is_error: false,
      result: CLAUDE_RESULT,
      modelUsage: {
        'claude-haiku-4-5-20251001': { outputTokens: 9000, canonicalModel: 'claude-haiku-4-5' },
        'claude-opus-5-20260801': { outputTokens: 40, canonicalModel: 'claude-opus-5' },
      },
    }),
    '',
  ].join('\n');
  const parsed = envelope && typeof envelope.parse === 'function'
    ? envelope.parse(claudeLog, 'opus') : null;
  check('G1 C2 [guard] Claude top-level result envelope parsing keeps its exact result contract',
    !!parsed && parsed.result === CLAUDE_RESULT
      && parsed.model === 'claude-opus-5-20260801' && parsed.aliasMiss === null,
    JSON.stringify(parsed));

  const noAlias = envelope && envelope.parse ? envelope.parse(claudeLog) : null;
  const tiedLog = JSON.stringify({ result: CLAUDE_RESULT, modelUsage: {
    'zzz-model': { outputTokens: 7 }, 'aaa-model': { outputTokens: 7 },
  } });
  const tied = envelope && envelope.parse ? envelope.parse(tiedLog) : null;
  check('G2 C2 [guard] model selection remains alias-first, then token-count with name tie-break',
    !!noAlias && noAlias.model === 'claude-haiku-4-5-20251001'
      && !!tied && tied.model === 'aaa-model',
    JSON.stringify({ noAlias, tied }));

  const codeLog = path.join(root, 'agent-code.log');
  fs.writeFileSync(codeLog, claudeLog);
  const flattened = spawnSync(process.execPath,
    [ENVELOPE_JS, 'flatten', codeLog, 'opus'], { cwd: REPO, encoding: 'utf8' });
  const plainLog = path.join(root, 'agent-stub.log');
  const plainBytes = `  ${PLAIN_RESULT}  \r\n`;
  fs.writeFileSync(plainLog, plainBytes);
  const untouched = spawnSync(process.execPath,
    [ENVELOPE_JS, 'flatten', plainLog, 'opus'], { cwd: REPO, encoding: 'utf8' });
  check('G3 C2 [guard] code-phase flattening and envelope-free logs stay byte-compatible',
    flattened.status === 0 && read(codeLog) === CLAUDE_RESULT
      && String(flattened.stdout || '').trim() === 'claude-opus-5-20260801'
      && untouched.status === 0 && read(plainLog) === plainBytes
      && String(untouched.stdout || '') === '',
    JSON.stringify({ flatten: flattened.status, model: String(flattened.stdout || '').trim(),
      flatBytes: read(codeLog), plain: untouched.status, plainUnchanged: read(plainLog) === plainBytes }));

  const claudeRun = path.join(root, 'claude-run');
  const plainRun = path.join(root, 'plain-run');
  const claudeFile = path.join(root, 'docs-claude.log');
  const plainFile = path.join(root, 'docs-plain.log');
  fs.writeFileSync(claudeFile, claudeLog);
  fs.writeFileSync(plainFile, ` \n${PLAIN_RESULT}\n `);
  const commands = [
    runStatus(claudeRun, 'init', 'repo-djf.27-claude-guard'),
    runStatus(claudeRun, 'summary', claudeFile),
    runStatus(plainRun, 'init', 'repo-djf.27-plain-guard'),
    runStatus(plainRun, 'summary', plainFile),
  ];
  check('G4 C2 [guard] status summary keeps exact Claude-envelope and plain-stub artifact bytes',
    commands.every((result) => result.status === 0)
      && read(path.join(claudeRun, 'status.json'))
        === expectedStatus('repo-djf.27-claude-guard', CLAUDE_RESULT)
      && read(path.join(plainRun, 'status.json'))
        === expectedStatus('repo-djf.27-plain-guard', PLAIN_RESULT),
    JSON.stringify(commands.map((result) => ({ status: result.status,
      stderr: String(result.stderr || '').trim().slice(0, 120) }))));

  const sources = ['guard.js', 'test.js'].map((name) => read(path.join(__dirname, name)) || '').join('\n');
  const forbidden = [
    ['scripts', 'test-ci.sh'].join('/'),
    ['scripts', 'test-all.sh'].join('/'),
    ['tools', 'run-acceptance.sh'].join('/'),
    ['scripts', 'fast-full-sweep.js'].join('/'),
  ];
  const foreignAcceptance = /tests[\\/]acceptance[\\/](?!repo-djf\.27(?:[\\/]|['\"]))/;
  check('G5 C5 [guard] both acceptance files are focused and invoke no recursive profile or foreign suite',
    forbidden.every((needle) => !sources.includes(needle)) && !foreignAcceptance.test(sources),
    JSON.stringify({ forbidden: forbidden.filter((needle) => sources.includes(needle)),
      foreignAcceptance: foreignAcceptance.test(sources) }));
} catch (error) {
  check('G1-G5 C2/C5 [guard] focused compatibility fixture completes', false,
    String(error && error.stack || error));
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  removed = !fs.existsSync(root);
}
check('G6 C5 [guard] the compatibility fixture leaves no owned artifact', removed);
process.exitCode = failed;
