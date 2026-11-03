#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Frozen acceptance test — the two facts a finished task's record carries (verifiedCommit,
// imageId) and the run-log line for a skipped re-verification (DESIGN.md §4.3, §4.12;
// amends change-log row `repo-cl9`).
//
// Drives the REAL runner/run.js runOneTask through its existing seams, the same way
// tests/unit/done-earned.test.js does: Beads through PIPELINE_BD_CMD (a .js stub preloaded
// via NODE_OPTIONS), the container through PIPELINE_EXEC_STUB, the PR through
// PIPELINE_GH_CMD, and — new with this task — `docker image inspect` through
// PIPELINE_DOCKER_CMD. One fixture leaves that seam unset and puts an executable `docker`
// stub first on PATH, to prove the production branch; it runs on Linux only (the task
// container), because the Windows host cannot spawn a script without a shell (EFTYPE), and
// it says so when skipped. No real Docker, gh, bd, model or network is touched.
//
// Criteria served (see the planning draft's coverage table): C1 (run-log half), C6b.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// An inherited RUN_DIR or GIT_* would redirect the stub container's writes or git itself
// into whatever outer task is running this test.
for (const k of Object.keys(process.env)) {
  if (/^GIT_/i.test(k) || /^RUN_DIR$/i.test(k) || /^PIPELINE_/i.test(k)) delete process.env[k];
}

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SKIP_PHRASE = 'final re-verification skipped';
const IMAGE = 'fixture-image:local';
const IMAGE_ID = `sha256:${'0123456789abcdef'.repeat(4)}`;
const IMAGE_ID_2 = `sha256:${'fedcba9876543210'.repeat(4)}`;
let failed = 0;
let count = 0;
function check(label, ok) {
  count += 1;
  if (ok) console.log(`ok - ${label}`);
  else { failed += 1; console.log(`FAIL - ${label}`); }
}
const show = (v) => JSON.stringify(v);
const fwd = (p) => p.split(path.sep).join('/');
const q = (s) => `"${s}"`;
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-runner-facts-'));
const wsRoot = path.join(tmp, 'workspaces');
const runSchema = readJson(path.join(ROOT, 'schemas', 'run.schema.json')) || {};
const rowProps = (((runSchema.properties || {}).tasks || {}).items || {}).properties || {};

// ---- seams --------------------------------------------------------------------------------
// The bd stub reaches every node child through NODE_OPTIONS, so it stands aside unless this
// process really is a bd call (a bd subcommand, never a .js script, in argv[1]).
const bdStub = path.join(tmp, 'bd-stub.js');
fs.writeFileSync(bdStub, [
  "'use strict';",
  '(function () {',
  "  if (/\\.js$/i.test(String(process.argv[1] || ''))) return;",
  "  const sfs = require('fs');",
  "  const a = process.argv.slice(1).map((s) => String(s).replace(/\\\\/g, '/').split('/').pop());",
  "  if (a.includes('show')) {",
  '    sfs.writeSync(1, JSON.stringify([{ id: "app-888", title: "invented fixture task",',
  '      description: "d", acceptance_criteria: "a", design: "DESIGN.md 4.3" }]));',
  "  } else { sfs.writeSync(1, '[]'); }",
  '  process.exit(0);',
  '})();',
  '',
].join('\n'));
const ghStub = path.join(tmp, 'gh-stub.js');
fs.writeFileSync(ghStub, "'use strict';process.stdout.write('https://example.invalid/pr/8\\n');process.exit(0);\n");

// The docker seam stub records its arguments and answers per DOCKER_MODE. `seq` answers
// IMAGE_ID on its first call and IMAGE_ID_2 on every later one.
const dockerStub = path.join(tmp, 'docker-stub.js');
fs.writeFileSync(dockerStub, [
  "'use strict';",
  "const fs = require('fs');",
  'fs.appendFileSync(process.env.DOCKER_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");',
  "const calls = fs.readFileSync(process.env.DOCKER_LOG, 'utf8').split('\\n').filter(Boolean).length;",
  "const mode = process.env.DOCKER_MODE;",
  `if (mode === 'ok') { process.stdout.write(${JSON.stringify(IMAGE_ID)} + '\\n'); process.exit(0); }`,
  `if (mode === 'seq') { process.stdout.write((calls === 1 ? ${JSON.stringify(IMAGE_ID)} : ${JSON.stringify(IMAGE_ID_2)}) + '\\n'); process.exit(0); }`,
  "if (mode === 'junk') { process.stdout.write('Error: no such object\\n'); process.exit(0); }",
  "if (mode === 'short') { process.stdout.write('sha256:abc\\n'); process.exit(0); }",
  `if (mode === 'noisy') { process.stdout.write('WARNING: something odd\\n' + ${JSON.stringify(IMAGE_ID)} + '\\n'); process.exit(0); }`,
  "process.stderr.write('daemon unreachable\\n'); process.exit(1);",
  '',
].join('\n'));

// The production-path stub: an executable named `docker`, first on PATH (Linux only).
const pathDockerDir = path.join(tmp, 'path-docker-bin');
fs.mkdirSync(pathDockerDir);
fs.writeFileSync(path.join(pathDockerDir, 'docker'), [
  '#!/bin/sh',
  'printf \'%s\\n\' "$*" >> "$DOCKER_LOG"',
  `echo ${IMAGE_ID}`,
  '',
].join('\n'), { mode: 0o755 });

// The stub container. On the call where STUB_EXIT20_FIRST=1 and no counter exists yet, it
// leaves a no-attempt status and exits 20 (a rate limit). Otherwise it commits work, writes
// status.json from a template whose __HEAD__ / __PARENT__ placeholders become the branch
// head / its parent, copies verify.json, and exits STUB_EXIT.
const execStub = path.join(tmp, 'exec-stub.sh');
fs.writeFileSync(execStub, [
  'mkdir -p "$RUN_DIR"',
  'if [ "$STUB_EXIT20_FIRST" = 1 ] && [ ! -f "$STUB_COUNTER" ]; then',
  '  : > "$STUB_COUNTER"',
  '  printf \'{"issueId":"app-888","attempts":[]}\\n\' > "$RUN_DIR/status.json"',
  '  exit 20',
  'fi',
  'echo work > work.txt',
  'git add work.txt',
  'git -c user.email=t@example.invalid -c user.name=t commit -q -m work',
  'HEAD_SHA=$(git rev-parse HEAD)',
  'PARENT_SHA=$(git rev-parse HEAD~1)',
  'sed -e "s/__HEAD__/$HEAD_SHA/g" -e "s/__PARENT__/$PARENT_SHA/g" "$STUB_STATUS_SRC" > "$RUN_DIR/status.json"',
  'cp "$STUB_VERIFY_SRC" "$RUN_DIR/verify.json"',
  'exit "$STUB_EXIT"',
  '',
].join('\n'));

const runmod = require(path.join(ROOT, 'runner', 'run.js'));

const PASS_VERIFY = { issueId: 'app-888', timestamp: '2026-11-03T00:00:00.000Z', acceptance: 'pass', regressions: 'absent', build: 'absent' };

async function drive(name, { status, exit = 0, dockerMode = 'ok', verify = PASS_VERIFY, exit20First = false, dockerOnPath = false }) {
  const dir = path.join(tmp, name);
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
  fs.writeFileSync(statusSrc, JSON.stringify(status) + '\n');
  const verifySrc = path.join(dir, 'verify-src.json');
  fs.writeFileSync(verifySrc, JSON.stringify(verify) + '\n');
  const dockerLog = path.join(dir, 'docker.log');
  fs.writeFileSync(dockerLog, '');

  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  const env = {
    PIPELINE_BD_CMD: process.execPath,
    NODE_OPTIONS: `--require "${fwd(bdStub)}"`,
    PIPELINE_EXEC_STUB: execStub,
    PIPELINE_GH_CMD: `${q(process.execPath)} ${q(fwd(ghStub))}`,
    PIPELINE_DOCKER_CMD: dockerOnPath ? undefined : `${q(process.execPath)} ${q(fwd(dockerStub))}`,
    DOCKER_MODE: dockerMode,
    DOCKER_LOG: fwd(dockerLog),
    STUB_STATUS_SRC: fwd(statusSrc),
    STUB_VERIFY_SRC: fwd(verifySrc),
    STUB_EXIT: String(exit),
    STUB_EXIT20_FIRST: exit20First ? '1' : '0',
    STUB_COUNTER: fwd(path.join(dir, 'exec-counter')),
    PIPELINE_WORKSPACE_ROOT: wsRoot,
    [pathKey]: dockerOnPath ? `${pathDockerDir}${path.delimiter}${process.env[pathKey] || ''}` : process.env[pathKey],
  };
  const saved = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k];
  }

  const lines = [];
  const log = {
    info(t, m) { lines.push(`INFO ${m}`); }, error(t, m) { lines.push(`ERROR ${m}`); },
    runId: 'run-fixture', trace: (id) => `run-fixture/${id}`, taskDir: () => dir, dir,
  };
  const cfg = {
    targetRepoPath: seed, targetRepoRemote: remote, image: IMAGE,
    wallClockMinutes: 60, maxAttempts: 3, probeIntervalMinutes: 15, maxPauseCycles: 96, concurrency: 1,
  };
  const gate = { waits: 0, cycles: 0, exhausted: false, admit: async () => true,
    reportLimit: async () => (exit20First ? { resumed: true } : { resumed: false, exhausted: true }) };
  let row = null;
  try {
    row = await runmod.runOneTask(cfg, { id: 'app-888', title: 'invented fixture task', priority: 1 }, log, 'tok', gate);
  } catch (e) { lines.push(`THREW ${e && e.message}`); }
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }

  // The branch head as the remote holds it: what a reviewer's PR points at.
  let pushedHead = '';
  if (row && row.branch) {
    const r = spawnSync('git', ['--git-dir', remote, 'rev-parse', `refs/heads/${row.branch}`], { encoding: 'utf8' });
    if (r.status === 0) pushedHead = r.stdout.trim();
  }
  const dockerCalls = fs.readFileSync(dockerLog, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return l.split(' '); } });
  if (process.env.DEBUG_DRIVE) console.log(`--- ${name}\n${lines.join('\n')}`);
  return { name, row, lines, pushedHead, dockerCalls };
}

function rowInSchema(r) {
  const extra = r.row ? Object.keys(r.row).filter((k) => !(k in rowProps)) : ['<no row>'];
  check(`${r.name}: every manifest row key is declared in run.schema.json (extra: ${show(extra)})`, extra.length === 0);
}

const ts = '2026-11-03T00:00:00.000Z';
const pass = (extra) => ({ issueId: 'app-888', attempts: [{ number: 1, verifierResult: 'pass', timestamp: ts }], ...extra });
const isInspect = (a) => a.includes('image') && a.includes('inspect') && a.includes(IMAGE) && a.some((s) => s.includes('{{.Id}}'));

(async () => {
  try {
    // Schema: the two facts are declared on the manifest row, with formats a checker can trust.
    const vcPat = rowProps.verifiedCommit && typeof rowProps.verifiedCommit.pattern === 'string' ? new RegExp(rowProps.verifiedCommit.pattern) : null;
    check('run.schema.json declares verifiedCommit on a task row, as a full 40-hex lowercase sha',
      Boolean(vcPat) && vcPat.test('a'.repeat(40)) && !vcPat.test('a'.repeat(39)) && !vcPat.test('A'.repeat(40)) && !vcPat.test('HEAD'));
    const idPat = rowProps.imageId && typeof rowProps.imageId.pattern === 'string' ? new RegExp(rowProps.imageId.pattern) : null;
    check('run.schema.json declares imageId on a task row, as sha256:<64 hex>',
      Boolean(idPat) && idPat.test(IMAGE_ID) && !idPat.test('sha256:abc') && !idPat.test(IMAGE) && !idPat.test(`x${IMAGE_ID}`));

    // 1. Skipped re-verification: both facts recorded, and the run log says so.
    const skip = await drive('skipped', { status: pass({ finalVerification: 'skipped-unchanged', verifiedCommit: '__HEAD__' }) });
    check(`skipped: outcome done (got ${show(skip.row && skip.row.outcome)})`, Boolean(skip.row) && skip.row.outcome === 'done');
    check(`skipped: the branch was pushed (head ${show(skip.pushedHead)})`, /^[0-9a-f]{40}$/.test(skip.pushedHead));
    check(`skipped: row.verifiedCommit is the pushed branch head (got ${show(skip.row && skip.row.verifiedCommit)})`,
      Boolean(skip.row) && skip.row.verifiedCommit === skip.pushedHead);
    check(`skipped: row.imageId is the inspected id (got ${show(skip.row && skip.row.imageId)})`,
      Boolean(skip.row) && skip.row.imageId === IMAGE_ID);
    check(`skipped: the image id came from \`docker image inspect\` of the configured image with format {{.Id}} (calls ${show(skip.dockerCalls)})`,
      skip.dockerCalls.some(isInspect));
    check(`skipped: the run log says "${SKIP_PHRASE}"`, skip.lines.some((l) => l.includes(SKIP_PHRASE)));
    rowInSchema(skip);

    // 2. Re-verification ran: verifiedCommit still recorded, no skip line.
    const ran = await drive('ran', { status: pass({ finalVerification: 'ran', verifiedCommit: '__HEAD__' }) });
    check(`ran: outcome done (got ${show(ran.row && ran.row.outcome)})`, Boolean(ran.row) && ran.row.outcome === 'done');
    check(`ran: row.verifiedCommit is the pushed branch head (got ${show(ran.row && ran.row.verifiedCommit)})`,
      Boolean(ran.row) && ran.row.verifiedCommit === ran.pushedHead && /^[0-9a-f]{40}$/.test(ran.pushedHead));
    check('ran: the run log does not claim a skip', !ran.lines.some((l) => l.includes(SKIP_PHRASE)));
    rowInSchema(ran);

    // 3. Partial is a success: verifiedCommit is carried (an implementation admitting only
    //    `done` fails here).
    const part = await drive('partial', { status: pass({ finalVerification: 'ran', verifiedCommit: '__HEAD__' }),
      verify: { ...PASS_VERIFY, regressions: 'fail' } });
    check(`partial: outcome partial (got ${show(part.row && part.row.outcome)})`, Boolean(part.row) && part.row.outcome === 'partial');
    check(`partial: row.verifiedCommit is the pushed branch head (got ${show(part.row && part.row.verifiedCommit)})`,
      Boolean(part.row) && part.row.verifiedCommit === part.pushedHead && /^[0-9a-f]{40}$/.test(part.pushedHead));

    // 4. Exit 0 whose success is NOT earned (latest attempt is a fail) ends `failed`; the
    //    gate is the FINAL outcome, never the exit code (an implementation keyed on exit 0
    //    fails here).
    const unearned = await drive('unearned', { status: { issueId: 'app-888', verifiedCommit: '__HEAD__',
      attempts: [{ number: 1, verifierResult: 'fail', timestamp: ts }] } });
    check(`unearned: outcome failed (got ${show(unearned.row && unearned.row.outcome)})`, Boolean(unearned.row) && unearned.row.outcome === 'failed');
    check(`unearned: no verifiedCommit on the row (got ${show(unearned.row && unearned.row.verifiedCommit)})`,
      Boolean(unearned.row) && !('verifiedCommit' in unearned.row));

    // 5. A claimed verifiedCommit that is NOT the branch head is not carried. Evidence only:
    //    the outcome and the PR are unchanged.
    const stale = await drive('not-head', { status: pass({ finalVerification: 'ran', verifiedCommit: '__PARENT__' }) });
    check(`not-head: outcome still done (got ${show(stale.row && stale.row.outcome)})`, Boolean(stale.row) && stale.row.outcome === 'done');
    check(`not-head: no verifiedCommit on the row (got ${show(stale.row && stale.row.verifiedCommit)})`,
      Boolean(stale.row) && !('verifiedCommit' in stale.row));
    check('not-head: a PR was still opened', Boolean(stale.row) && stale.row.prUrl === 'https://example.invalid/pr/8');

    // 6. A stuck task carries no verifiedCommit, whatever status.json says.
    const stuck = await drive('stuck', { exit: 10, status: { issueId: 'app-888', verifiedCommit: '__HEAD__', stuckState: 'bailed',
      attempts: [1, 2, 3].map((n) => ({ number: n, verifierResult: 'fail', timestamp: ts })) } });
    check(`stuck: outcome stuck (got ${show(stuck.row && stuck.row.outcome)})`, Boolean(stuck.row) && stuck.row.outcome === 'stuck');
    check(`stuck: no verifiedCommit on the row (got ${show(stuck.row && stuck.row.verifiedCommit)})`,
      Boolean(stuck.row) && !('verifiedCommit' in stuck.row));

    // 7. A relaunch after a rate limit: the image is read before EACH launch and the row
    //    carries the id read before the LAST one (reading once up front, or after exit, fails).
    const relaunch = await drive('relaunch', { exit20First: true, dockerMode: 'seq',
      status: pass({ finalVerification: 'skipped-unchanged', verifiedCommit: '__HEAD__' }) });
    check(`relaunch: outcome done (got ${show(relaunch.row && relaunch.row.outcome)})`, Boolean(relaunch.row) && relaunch.row.outcome === 'done');
    check(`relaunch: the task was relaunched once (pauses ${show(relaunch.row && relaunch.row.pauses)})`, Boolean(relaunch.row) && relaunch.row.pauses === 1);
    check(`relaunch: the image was inspected once per launch (calls ${show(relaunch.dockerCalls.filter(isInspect).length)})`,
      relaunch.dockerCalls.filter(isInspect).length === 2);
    check(`relaunch: row.imageId is the id read before the last launch (got ${show(relaunch.row && relaunch.row.imageId)})`,
      Boolean(relaunch.row) && relaunch.row.imageId === IMAGE_ID_2);

    // 8. The image inspection failing is not a task failure: no imageId, outcome unchanged.
    const down = await drive('docker-fails', { dockerMode: 'fail', status: pass({ finalVerification: 'skipped-unchanged', verifiedCommit: '__HEAD__' }) });
    check(`docker-fails: outcome still done (got ${show(down.row && down.row.outcome)})`, Boolean(down.row) && down.row.outcome === 'done');
    check(`docker-fails: no imageId on the row (got ${show(down.row && down.row.imageId)})`, Boolean(down.row) && !('imageId' in down.row));
    check('docker-fails: verifiedCommit is still recorded', Boolean(down.row) && down.row.verifiedCommit === down.pushedHead && down.pushedHead !== '');

    // 9. Output that is not exactly one image id is never recorded as one.
    for (const mode of ['junk', 'short', 'noisy']) {
      const j = await drive(`docker-${mode}`, { dockerMode: mode, status: pass({ finalVerification: 'skipped-unchanged', verifiedCommit: '__HEAD__' }) });
      check(`docker-${mode}: outcome still done (got ${show(j.row && j.row.outcome)})`, Boolean(j.row) && j.row.outcome === 'done');
      check(`docker-${mode}: no imageId on the row (got ${show(j.row && j.row.imageId)})`, Boolean(j.row) && !('imageId' in j.row));
    }

    // 10. Production branch: no seam, so the runner spawns `docker` itself.
    if (process.platform === 'win32') {
      console.log('NOTE - production docker path not exercised on Windows (a stub script cannot be spawned without a shell); it runs in the Linux task container');
    } else {
      const prod = await drive('docker-on-path', { dockerOnPath: true, status: pass({ finalVerification: 'skipped-unchanged', verifiedCommit: '__HEAD__' }) });
      check(`docker-on-path: row.imageId comes from the real docker invocation (got ${show(prod.row && prod.row.imageId)})`,
        Boolean(prod.row) && prod.row.imageId === IMAGE_ID);
      check(`docker-on-path: invoked as docker image inspect --format {{.Id}} ${IMAGE} (calls ${show(prod.dockerCalls)})`,
        prod.dockerCalls.some(isInspect));
    }
  } catch (e) {
    check(`harness ran without throwing (${e && e.message})`, false);
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  console.log(`${count - failed}/${count} checks passed`);
  process.exit(failed ? 1 : 0);
})();
