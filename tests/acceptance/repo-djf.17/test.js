// Frozen acceptance test — repo-djf.17: safe explicit re-author after a failed proof.
//
// C1: `re-author <batch> <issue>` selects exactly one completed unproven author-proof attempt,
//     from the actual issue worktree, without a synthetic `spec-brief` write state or main edits.
// C2: before the sole new ordinary worker launch it archives the old suite and diagnostics under
//     host preparation evidence; runWorker, not the coordinator, writes one PID generation.
// C3: guard.js proves retry, acknowledgement, proof-only and write-protection regressions green.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const REPO = path.resolve(__dirname, '..', '..', '..');
let prepare = null; let state = null;
try { prepare = require(path.join(REPO, 'scripts', 'prepare-batch.js')); } catch {}
try { state = require(path.join(REPO, 'runner', 'preparation-state.js')); } catch {}
let failed = 0;
function check(name, yes, detail = '') {
  console.log(`${yes ? 'ok' : 'FAIL'} - ${name}${yes ? '' : ` — ${detail}`}`);
  if (!yes) failed = 1;
}
function below(root, candidate) {
  const a = path.resolve(root); const b = path.resolve(candidate);
  return b !== a && b.startsWith(`${a}${path.sep}`);
}
function files(root, output = []) {
  let entries = []; try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return output; }
  for (const entry of entries) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) files(file, output); else output.push(file);
  }
  return output;
}
function nonce(char) { return char.repeat(32); }

async function main() {
  check('C1-C2 prepare-batch exports the re-author command surface',
    !!prepare && typeof prepare.parseArgs === 'function' && typeof prepare.execute === 'function');
  if (!prepare || !state) return;
  const parsed = prepare.parseArgs(['re-author', 'djf17-proof-failure', 'repo-djf.17']);
  check('C1 explicit `re-author <batch> <issue>` is a valid, single-issue command',
    !parsed.error && parsed.mode === 're-author' && parsed.batch === 'djf17-proof-failure'
      && Array.isArray(parsed.issues) && parsed.issues.length === 1 && parsed.issues[0] === 'repo-djf.17',
    JSON.stringify(parsed));
  if (parsed.error) return;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-djf17-'));
  const hostEvidence = path.join(tmp, 'host-preparation-evidence');
  const target = path.join(tmp, 'target-main');
  const worktree = path.join(tmp, 'issue-worktree');
  const suite = path.join(worktree, 'tests', 'acceptance', 'repo-djf.17', 'test.js');
  const diagnostics = path.join(worktree, 'author-proof-diagnostics.txt');
  fs.mkdirSync(path.dirname(suite), { recursive: true }); fs.mkdirSync(target, { recursive: true });
  const suiteBytes = '// failed suite bytes must survive re-authoring\n';
  const diagnosticBytes = 'green probe failed: fixture was under-scoped\n';
  fs.writeFileSync(suite, suiteBytes); fs.writeFileSync(diagnostics, diagnosticBytes);
  const mainSentinel = path.join(target, 'main-must-not-change.txt'); fs.writeFileSync(mainSentinel, 'unchanged');
  const old = nonce('a'); const fresh = nonce('b'); let startedWrites = 0; let launches = 0; let seenItem = null;
  const cfg = { targetRepoPath: target, allowHalfProven: false };
  const built = {
    ok: true, id: 'repo-djf.17', state: 'freeze', text: 'existing suite means ordinary path is proof-only', cfg,
    branch: 'freeze-repo-djf.17', folder: { dir: worktree, branch: 'freeze-repo-djf.17', exists: true },
    criteria: { source: 'structured', sha256: 'c'.repeat(64), text: '1. re-author safely' },
    issue: { id: 'repo-djf.17', title: 'fixture', dependencies: [] },
  };
  const fakeState = {
    preparationRoot: () => hostEvidence, validateBatchId: state.validateBatchId, validateIssueId: state.validateIssueId,
    canonicalHash: () => 'same-config', redactConfig: (v) => v,
    readManifest: () => ({ batchId: parsed.batch, runConfig: 'fixture.json', concurrency: 1, configHash: 'same-config',
      integrationBranch: 'main', integrationHead: 'd'.repeat(40), issues: [{ id: 'repo-djf.17' }], config: cfg }),
    readEvents: () => [], createManifest: () => { throw new Error('re-author must not create a new batch'); },
    appendEvent: () => {},
    readWorkerRecords: () => [{ started: { nonce: old, phase: 'author-proof', generation: 1 },
      result: { outcome: 'unproven', data: { evidence: diagnosticBytes, diagnostics } } }],
    createWorkerNonce: () => fresh,
    writeWorkerStarted: (_root, _batch, _id, record) => { startedWrites += 1; return record; },
    writeWorkerResult: () => {}, deriveState: () => ({ ok: true, issues: [] }),
  };
  const errors = []; const out = [];
  const code = await prepare.execute(parsed, { out: (v) => out.push(String(v)), err: (v) => errors.push(String(v)) }, {
    state: fakeState, preparationRoot: () => hostEvidence, loadConfig: () => cfg,
    admitEntry: () => ({ ok: true, mode: 'standalone' }), acquire: () => ({ ok: true, ownership: {} }), release() {},
    inspectIntegration: () => ({ ok: true, branch: 'main', head: 'd'.repeat(40) }), runSync: () => ({ status: 0, stdout: 'd'.repeat(40) }),
    readyQueue: () => ({ ok: true, issues: [] }), buildBrief: () => built, ensureWorktree: () => ({ ok: true }),
    resolveDesign: () => ({ ok: true, commit: 'd'.repeat(40), reasons: [], refs: [] }),
    markPreparationUncertain() {}, clearPreparationUncertain() {}, listPreparationUncertain: () => [],
    runWorker: (_root, _batch, item) => { launches += 1; seenItem = item;
      // This is the ordinary runWorker state write; coordinator preallocation would make it two.
      fakeState.writeWorkerStarted(_root, _batch, item.id, { nonce: fresh, pid: 4242, phase: item.action });
      return Promise.resolve({ id: item.id, ok: true, outcome: 'unproven' }); },
  });
  const archived = files(hostEvidence).filter((file) => !file.includes(`${path.sep}.`)).map((file) => {
    try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
  });
  const archiveHasSuite = archived.some((value) => value.includes(suiteBytes.trim()));
  const archiveHasDiagnostics = archived.some((value) => value.includes(diagnosticBytes.trim()));
  const archiveOutsideTarget = files(hostEvidence).every((file) => below(hostEvidence, file) && !below(target, file));
  check('C1 selects only the completed unproven author-proof attempt and re-authors from its issue worktree',
    code === 0 && launches === 1 && seenItem && seenItem.action === 'author-proof'
      && seenItem.built && seenItem.built.folder && path.resolve(seenItem.built.folder.dir) === path.resolve(worktree),
    JSON.stringify({ code, launches, action: seenItem && seenItem.action, errors, out }));
  check('C1 does not require a synthetic write brief or edit the integration main checkout',
    built.state === 'freeze' && fs.readFileSync(mainSentinel, 'utf8') === 'unchanged', JSON.stringify({ state: built.state }));
  check('C2 archives failed suite bytes and diagnostics before launch under host preparation evidence outside the target repository',
    archiveOutsideTarget && archiveHasSuite && archiveHasDiagnostics, JSON.stringify(files(hostEvidence)));
  check('C2 runWorker alone creates exactly one new PID-bearing worker generation; coordinator preallocates none',
    launches === 1 && startedWrites === 1, JSON.stringify({ launches, startedWrites }));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
main().then(() => { process.exitCode = failed; }).catch((error) => {
  check('C1-C2 fixture completes', false, error.stack || String(error)); process.exitCode = 1;
});
