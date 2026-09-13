// Frozen acceptance [guard] — repo-djf.28: established lifecycle, ledger, and envelope contracts.
// PAIRING (criterion -> tests): C1 -> G7,T1; C2 -> G1,T2,T3,T4,T5,T6;
// C3 -> G2,T2,T3,T4,T5,T6; C4 -> G3,G4,G5,T7,T8,T9;
// C5 -> G1,G2,G6,G7,G8,T1,T2,T3,T4,T5,T6,T7,T8,T9,T10.
// PAIRING (test -> criterion): G1 -> C2,C5; G2 -> C3,C5; G3,G4,G5 -> C4;
// G6 -> C5; G7 -> C1,C5; G8 -> C5.
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-djf28-guard-'));
let removed = false;
try {
  const runner = require(path.join(REPO, 'runner', 'run.js'));
  const effects = [];
  let downs = 0;
  let releases = 0;
  const cleanup = runner.cleanupOwnedLifecycle(
    { targetRepoPath: path.join(root, 'target') }, REPO,
    { error(_trace, message) { effects.push(`error:${message}`); } },
    'accept-djf28-guard/cleanup', {
      ownership: { token: 'opaque-fixture-owner' },
      networkDown() { downs += 1; effects.push('network.down'); return { ok: true }; },
      releaseLock() { releases += 1; effects.push('lock.release'); },
    }
  );
  check('G1 C2/C5 [guard] owned lifecycle cleanup tears down the network then releases the target lock exactly once',
    cleanup && cleanup.ok === true && downs === 1 && releases === 1
      && effects.join(',') === 'network.down,lock.release',
    JSON.stringify({ cleanup, downs, releases, effects }));

  const eventSchema = JSON.parse(fs.readFileSync(path.join(REPO, 'schemas', 'events.schema.json'), 'utf8'));
  const dashboard = require(path.join(REPO, 'scripts', 'dashboard.js'));
  const runSource = fs.readFileSync(path.join(REPO, 'runner', 'run.js'), 'utf8').split(/\r?\n/);
  const taskFinishedSites = runSource.map((line, index) => ({ line, index }))
    .filter((item) => /event:\s*['"]task\.finished['"]/.test(item.line));
  const prefixedSites = taskFinishedSites.filter((site) => runSource
    .slice(Math.max(0, site.index - 20), site.index + 1).join('\n').includes('task finished:'));
  const taskDef = eventSchema.$defs && eventSchema.$defs.events
    && eventSchema.$defs.events['task.finished'];
  check('G2 C3/C5 [guard] the established event-ledger schema and dashboard prefix remain exhaustive at the fork point',
    dashboard.P && String(dashboard.P.taskFinished).startsWith('task finished:')
      && eventSchema.properties.event.enum.includes('task.finished')
      && !!taskDef && taskDef.additionalProperties === false
      && JSON.stringify([...(taskDef.required || [])].sort())
        === JSON.stringify(['beads', 'exitCode', 'outcome'])
      && taskFinishedSites.length > 0 && prefixedSites.length === taskFinishedSites.length,
    JSON.stringify({ prefix: dashboard.P && dashboard.P.taskFinished,
      required: taskDef && taskDef.required,
      sites: taskFinishedSites.map((site) => site.index + 1),
      prefixed: prefixedSites.map((site) => site.index + 1) }));

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
  check('G3 C4 [guard] Claude top-level result envelope parsing keeps its exact result contract',
    !!parsed && parsed.result === CLAUDE_RESULT
      && parsed.model === 'claude-opus-5-20260801' && parsed.aliasMiss === null,
    JSON.stringify(parsed));

  const noAlias = envelope && envelope.parse ? envelope.parse(claudeLog) : null;
  const tiedLog = JSON.stringify({ result: CLAUDE_RESULT, modelUsage: {
    'zzz-model': { outputTokens: 7 }, 'aaa-model': { outputTokens: 7 },
  } });
  const tied = envelope && envelope.parse ? envelope.parse(tiedLog) : null;
  check('G4 C4 [guard] model selection remains alias-first, then token-count with name tie-break',
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
  const claudeRun = path.join(root, 'claude-run');
  const plainRun = path.join(root, 'plain-run');
  const claudeFile = path.join(root, 'docs-claude.log');
  const plainFile = path.join(root, 'docs-plain.log');
  fs.writeFileSync(claudeFile, claudeLog);
  fs.writeFileSync(plainFile, ` \n${PLAIN_RESULT}\n `);
  const commands = [
    runStatus(claudeRun, 'init', 'repo-djf.28-claude-guard'),
    runStatus(claudeRun, 'summary', claudeFile),
    runStatus(plainRun, 'init', 'repo-djf.28-plain-guard'),
    runStatus(plainRun, 'summary', plainFile),
  ];
  check('G5 C4 [guard] code flattening and docs summary keep exact Claude-envelope and plain-stub bytes',
    flattened.status === 0 && read(codeLog) === CLAUDE_RESULT
      && String(flattened.stdout || '').trim() === 'claude-opus-5-20260801'
      && untouched.status === 0 && read(plainLog) === plainBytes
      && String(untouched.stdout || '') === ''
      && commands.every((result) => result.status === 0)
      && read(path.join(claudeRun, 'status.json'))
        === expectedStatus('repo-djf.28-claude-guard', CLAUDE_RESULT)
      && read(path.join(plainRun, 'status.json'))
        === expectedStatus('repo-djf.28-plain-guard', PLAIN_RESULT),
    JSON.stringify({ flatten: flattened.status, model: String(flattened.stdout || '').trim(),
      plain: untouched.status, summaries: commands.map((result) => result.status) }));

  const project = JSON.parse(fs.readFileSync(path.join(REPO, 'pipeline.config.json'), 'utf8'));
  const listed = spawnSync('bash', ['scripts/test-ci.sh', '--list'], {
    cwd: REPO, encoding: 'utf8', windowsHide: true, timeout: 20000,
  });
  const suites = String(listed.stdout || '').split(/\r?\n/).filter(Boolean);
  check('G6 C5 [guard] the required publication profile still names exactly 42 distinct mandatory suites',
    listed.status === 0 && !listed.error
      && project.regressionPolicy === 'required'
      && project.regressionCommand === 'bash scripts/test-ci.sh'
      && suites.length === 42 && new Set(suites).size === 42
      && suites.every((name) => /^test-[A-Za-z0-9._-]+\.sh$/.test(name)
        && fs.existsSync(path.join(REPO, 'scripts', name))),
    JSON.stringify({ status: listed.status, error: listed.error && listed.error.message,
      policy: project.regressionPolicy, command: project.regressionCommand,
      count: suites.length, distinct: new Set(suites).size }));

  const shapes = ['repo-djf.22', 'repo-djf.23', 'repo-djf.24'].map((suite) => ({
    suite,
    guard: fs.existsSync(path.join(REPO, 'tests', 'acceptance', suite, 'guard.js')),
    test: fs.existsSync(path.join(REPO, 'tests', 'acceptance', suite, 'test.js')),
  }));
  check('G7 C1/C5 [guard] all predecessor lane contracts retain their complete two-file frozen shape',
    shapes.every((item) => item.guard && item.test), JSON.stringify(shapes));
} catch (error) {
  check('G1-G7 C1-C5 [guard] fork-point fixture completes', false,
    String(error && error.stack || error));
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  removed = !fs.existsSync(root);
}
check('G8 C5 [guard] the compatibility fixture leaves no owned artifact', removed);
process.exitCode = failed;
