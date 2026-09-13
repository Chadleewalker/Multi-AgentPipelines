// Frozen acceptance test — repo-djf.27: final Codex docs summary, never raw JSONL.
// PAIRING (criterion -> tests): C1 -> T1,T2; C2 -> G1,G2,G3,G4; C3 -> T3;
// C4 -> T2; C5 -> G5,G6,T4.
// PAIRING (test -> criterion): T1 -> C1; T2 -> C1,C4; T3 -> C3; T4 -> C5.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const STATUS_JS = path.join(REPO, 'pipeline', 'status.js');
const FINAL = 'Implemented deterministic Codex summary extraction. Publication now carries only this concise result.';
const NOISE = {
  chatter: 'CODEX-CLI-CHATTER-djf27',
  tailChatter: 'Codex session finished successfully.',
  command: 'COMMAND-EVENT-djf27',
  path: 'C:/private/customer/djf27-secrets.txt',
  usage: 987654321,
  interim: 'INTERMEDIATE-AGENT-MESSAGE-djf27',
};
let failed = 0;

function check(name, yes, detail = '') {
  console.log(`${yes ? 'ok' : 'FAIL'} - ${name}${yes || !detail ? '' : ` — ${detail}`}`);
  if (!yes) failed = 1;
}
function read(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}
function parseJson(file) {
  try { return JSON.parse(read(file)); } catch { return null; }
}
function runStatus(runDir, ...args) {
  return spawnSync(process.execPath, [STATUS_JS, ...args], {
    cwd: REPO, encoding: 'utf8', env: { ...process.env, RUN_DIR: runDir },
  });
}
function section(text, start, end) {
  const a = String(text).indexOf(start);
  const b = a < 0 ? -1 : String(text).indexOf(end, a + start.length);
  return a >= 0 && b >= 0 ? String(text).slice(a + start.length, b).trim() : null;
}
function publication(status) {
  const report = require(path.join(REPO, 'runner', 'report.js'));
  const publish = require(path.join(REPO, 'runner', 'publish.js'));
  const manifest = {
    runId: 'accept-djf27-publication',
    startedAt: '2026-09-13T12:00:00.000Z',
    finishedAt: '2026-09-13T12:00:01.000Z',
    targetRepo: 'fixture/repo',
    tasks: [{
      issueId: 'repo-djf.27', title: 'Codex summary fixture', outcome: 'done',
      branch: 'task/repo-djf.27', pushed: true, attempts: 1, diffLines: 4,
      changeSummary: status.changeSummary,
      verification: { acceptance: 'pass', regressions: 'pass', evidence: 'focused fixture' },
    }],
  };
  const prInput = {
    issueMarkdown: '# Fixture spec', status,
    verify: { acceptance: 'pass', regressions: 'pass' },
    outcome: { status: 'done' }, branch: 'task/repo-djf.27', runId: manifest.runId,
  };
  return {
    manifest, prInput,
    reportA: report.renderReport(manifest), reportB: report.renderReport(manifest),
    bodyA: publish.buildPrBody(prInput), bodyB: publish.buildPrBody(prInput),
  };
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-djf27-test-'));
let removed = false;
try {
  const runDir = path.join(root, 'completed-run');
  const docsLog = path.join(root, 'docs-codex.jsonl');
  const records = [
    NOISE.chatter,
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-djf27', model: 'gpt-5.6-terra' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({ type: 'item.started', item: { id: 'cmd-1', type: 'command_execution',
      command: `rg token ${NOISE.path}` } }),
    JSON.stringify({ type: 'item.completed', item: { id: 'cmd-1', type: 'command_execution',
      command: `rg token ${NOISE.path}`, aggregated_output: NOISE.command, exit_code: 0 } }),
    JSON.stringify({ type: 'item.completed', item: { id: 'msg-1', type: 'agent_message',
      text: NOISE.interim } }),
    JSON.stringify({ type: 'item.completed', item: { id: 'cmd-2', type: 'command_execution',
      command: 'git status --short', aggregated_output: `${NOISE.path}\n`, exit_code: 0 } }),
    JSON.stringify({ type: 'item.completed', item: { id: 'msg-final', type: 'agent_message', text: FINAL } }),
    JSON.stringify({ type: 'turn.completed', usage: {
      input_tokens: NOISE.usage, cached_input_tokens: 222, output_tokens: 33,
    } }),
    NOISE.tailChatter,
    '',
  ];
  fs.writeFileSync(docsLog, records.join('\n'));
  const init = runStatus(runDir, 'init', 'repo-djf.27');
  const summarized = runStatus(runDir, 'summary', docsLog);
  const statusFile = path.join(runDir, 'status.json');
  const statusBytes = read(statusFile) || '';
  const status = parseJson(statusFile);
  const noiseValues = Object.values(NOISE);
  check('T1 C1 completed realistic Codex JSONL yields only the final completed agent_message',
    init.status === 0 && summarized.status === 0 && !!status
      && status.changeSummary === FINAL
      && noiseValues.every((value) => !status.changeSummary.includes(value))
      && !status.changeSummary.includes('turn.completed')
      && !status.changeSummary.includes('input_tokens'),
    JSON.stringify({ init: init.status, summary: summarized.status,
      exactFinal: !!status && status.changeSummary === FINAL,
      actualLength: status && typeof status.changeSummary === 'string' ? status.changeSummary.length : null,
      leakedMarkers: status && typeof status.changeSummary === 'string'
        ? noiseValues.filter((value) => status.changeSummary.includes(value)) : [] }));

  const pub = status ? publication(status) : null;
  const reportSummary = pub && section(pub.reportA, '**What changed**', '**Verification evidence**');
  const bodySummary = pub && section(pub.bodyA, '## Change summary', '## Verification evidence');
  const surfaces = pub ? [statusBytes, pub.reportA, pub.bodyA] : [];
  check('T2 C1/C4 status artifact, report section, and PR-body input carry one exact deterministic concise summary',
    !!pub && status.changeSummary === FINAL && pub.prInput.status.changeSummary === FINAL
      && reportSummary === FINAL && bodySummary === FINAL
      && pub.reportA === pub.reportB && pub.bodyA === pub.bodyB
      && surfaces.every((surface) => noiseValues.every((value) => !surface.includes(value)))
      && surfaces.every((surface) => !surface.includes('turn.completed') && !surface.includes('input_tokens')),
    JSON.stringify({ statusExact: !!status && status.changeSummary === FINAL,
      reportExact: reportSummary === FINAL, bodyExact: bodySummary === FINAL,
      deterministicReport: !!pub && pub.reportA === pub.reportB,
      deterministicBody: !!pub && pub.bodyA === pub.bodyB }));

  const invalid = [
    {
      name: 'malformed', secret: 'MALFORMED-SECRET-djf27',
      text: '{"type":"item.completed","item":{"type":"agent_message","text":"MALFORMED-SECRET-djf27"',
    },
    {
      name: 'partial', secret: 'PARTIAL-SECRET-djf27',
      text: [
        JSON.stringify({ type: 'thread.started', thread_id: 'partial-djf27' }),
        JSON.stringify({ type: 'turn.started' }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'PARTIAL-SECRET-djf27' } }),
      ].join('\n') + '\n',
    },
    { name: 'empty', secret: 'EMPTY-SECRET-djf27', text: '' },
    {
      name: 'rate-limit-only', secret: 'RATE-LIMIT-SECRET-djf27',
      text: [
        JSON.stringify({ type: 'thread.started', thread_id: 'limited-djf27' }),
        JSON.stringify({ type: 'turn.failed', error: { type: 'rate_limit_error',
          message: 'RATE-LIMIT-SECRET-djf27', request_id: 'private-request-djf27', retry_after: 30 } }),
      ].join('\n') + '\n',
    },
  ];
  const invalidResults = [];
  for (const fixture of invalid) {
    const dir = path.join(root, `invalid-${fixture.name}`);
    const file = path.join(root, `${fixture.name}.log`);
    fs.writeFileSync(file, fixture.text);
    const initialized = runStatus(dir, 'init', `repo-djf.27-${fixture.name}`);
    const result = runStatus(dir, 'summary', file);
    const bytes = read(path.join(dir, 'status.json')) || '';
    const value = parseJson(path.join(dir, 'status.json'));
    const rendered = value ? publication(value) : null;
    const publicBytes = rendered ? `${rendered.reportA}\n${rendered.bodyA}` : '';
    invalidResults.push({
      name: fixture.name,
      ok: initialized.status === 0 && result.status === 0 && !!value
        && !Object.prototype.hasOwnProperty.call(value, 'changeSummary')
        && !bytes.includes(fixture.secret) && !publicBytes.includes(fixture.secret)
        && !bytes.includes('private-request-djf27') && !publicBytes.includes('private-request-djf27'),
      initialized: initialized.status, status: result.status,
      hasSummary: !!value && Object.prototype.hasOwnProperty.call(value, 'changeSummary'),
      leaked: bytes.includes(fixture.secret) || publicBytes.includes(fixture.secret),
    });
  }
  check('T3 C3 malformed, partial, empty, and rate-limit-only structured logs fail closed without disclosure',
    invalidResults.every((result) => result.ok),
    JSON.stringify(invalidResults));
} catch (error) {
  check('T1-T3 C1/C3/C4 focused Codex publication fixture completes', false,
    String(error && error.stack || error));
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
  removed = !fs.existsSync(root);
}
check('T4 C5 the focused Codex fixture leaves no owned artifact', removed);
process.exitCode = failed;
