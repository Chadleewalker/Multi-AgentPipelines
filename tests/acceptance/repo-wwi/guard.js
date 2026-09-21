// Frozen acceptance test — repo-wwi, the [guard] half: structured Codex deny decisions and a
// host-review gate must not cost anything that already works.
//
// [guard] Every check in this file is GREEN at the fork point and must stay green. Nothing red
// belongs here: a [guard] file that is red at the fork point is a stale pin and refuses the
// freeze outright (`scripts/freeze-gate.js`, verdict `stale-guard`).
//
// WHICH CRITERION EACH CHECK PROVES.
//
//   C2, "legacy/Claude behavior remains compatible" — the two dialects that already work at the
//       fork point: the plain-string Claude tool-call shape (`tests/acceptance/repo-gy3/guard.js`
//       and, before it, `repo-324`'s own frozen suite) and the `hook` / `input` legacy Codex
//       shape `repo-324` froze. This issue changes how the CURRENT Codex dialect (`tool_name:
//       "Bash"|"apply_patch"`, `tool_input.command` as an argv array) is ANSWERED — it moves that
//       one answer onto exit 0 plus a structured JSON body — and it is forbidden to spend either
//       working dialect buying that change. Both remain on exit 2 plus a plain-text reason.
//   C5, "all mandatory regressions pass", as the invariant most at risk from more client
//       configuration and a new host record kind: no agent-hook configuration becomes tracked,
//       because this repo is a target of its own pipeline and a tracked hook would fire inside a
//       container with no agent CLI (`tests/unit/agent-hooks.test.js`'s own boundary, restated
//       directly against Git per the same reasoning `tests/acceptance/repo-gy3/guard.js` used).
//   C5, "all mandatory regressions pass", as a fact about the tree rather than a run of the
//       frozen regression command: `scripts/test-ci.sh` still names the suites that cover the
//       hook wiring and the change-log row this issue touches.
//   C5, "existing frozen suites remain untouched", as the part of it that is checkable from
//       inside a permanent guard: the write-protection lineage this issue extends —
//       `repo-324`, `repo-l2w`, `repo-ak5`, `repo-gy3` — is still present, still non-empty, and
//       still names the issue it was frozen for. Byte identity is the freeze gate's job.
//
// SELF-CONTAINED ON PURPOSE, and IT SPAWNS NO CODEX PROCESS AND RUNS NO FROZEN SCRIPT, for the
// same reasons `tests/acceptance/repo-gy3/guard.js` gives — plus one more of this issue's own:
// C4 forbids the deterministic suite from spawning the Codex CLI (interactively or via its
// non-interactive `exec` subcommand) anywhere in
// `tests/acceptance/repo-wwi/`, this file included, so that a host-review claim can never be
// synthesized by the automation that is supposed to be unable to make one. `test.js` §C4 checks
// this file's own text for that, so nothing here may add the very thing being refused.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = (() => {
  const marker = path.join('scripts', 'write-protection.js');
  let dir = path.resolve(__dirname);
  for (;;) {
    if (fs.existsSync(path.join(dir, marker))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(__dirname, '..', '..', '..');
    dir = parent;
  }
})();
const CLI = path.join(REPO, 'scripts', 'write-protection.js');
const BRIDGE = path.join(REPO, 'scripts', 'write-guard-bridge.js');

const GIT_SAFE = ['-c', 'safe.directory=*'];

let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) failed = 1;
}
const show = (v) => JSON.stringify(v);

function envWith(extra) {
  const e = { ...process.env };
  for (const k of ['WRITE_PROTECTION_HOST_STATE_DIR', 'WRITE_PROTECTION_CLAUDE_DIR',
    'WRITE_PROTECTION_CODEX_DIR', 'WRITE_PROTECTION_MANAGED', 'CLAUDE_CONFIG_DIR',
    'SESSION_GUARD_CONFIG_DIR']) delete e[k];
  return { ...e, ...extra };
}

function lastJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { /* fall through to the last line */ }
  const lines = raw.split(/\r?\n/).filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch { /* keep walking back */ }
  }
  return null;
}

function git(cwd, ...args) {
  return spawnSync('git', [...GIT_SAFE, ...args], {
    cwd, encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
  });
}

function rmrf(target) {
  const walk = (p) => {
    let stat;
    try { stat = fs.lstatSync(p); } catch { return; }
    try { fs.chmodSync(p, 0o700); } catch { /* best effort */ }
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      let names = [];
      try { names = fs.readdirSync(p); } catch { names = []; }
      for (const n of names) walk(path.join(p, n));
    }
  };
  walk(target);
  try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  catch { /* disposable */ }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-wwi-'));
const HOST = path.join(tmp, 'host-state');
fs.mkdirSync(HOST, { recursive: true });

function node(script, args, opts = {}) {
  const r = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8', timeout: 120000, windowsHide: true, cwd: opts.cwd || tmp,
    input: opts.input, env: envWith({ WRITE_PROTECTION_HOST_STATE_DIR: HOST, ...(opts.env || {}) }),
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', json: lastJson(r.stdout) };
}

function fixtureGit(dir, args) {
  return spawnSync('git', ['-C', dir, '-c', 'user.email=fixture@example.invalid',
    '-c', 'user.name=Fixture', '-c', 'commit.gpgsign=false', ...args],
  { encoding: 'utf8', timeout: 120000, windowsHide: true });
}

function makeTarget(name) {
  const files = {
    'README.md': '# fixture target\n',
    '.gitignore': 'runs/\n',
    'pipeline.config.json': `${JSON.stringify({
      verifyCommand: 'sh tools/run-acceptance.sh',
      regressionCommand: 'bash scripts/test-ci.sh',
      regressionPolicy: 'required',
      defaultBranch: 'main',
      frozenPaths: ['tools/run-acceptance.sh'],
      dependencies: {},
    }, null, 2)}\n`,
    'runner/run.js': '// product: the runner\n',
    'tools/run-acceptance.sh': '# frozen verifier\n',
    'runs/keep.json': '{"host":"artifact"}\n',
  };
  const dir = path.join(tmp, name);
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  spawnSync('git', ['init', '-q', dir], { encoding: 'utf8', timeout: 120000, windowsHide: true });
  fixtureGit(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  fixtureGit(dir, ['add', '-A', '.']);
  fixtureGit(dir, ['commit', '-q', '-m', 'fixture']);
  return dir;
}

const PATCH_TEXT = [
  '*** Begin Patch',
  '*** Update File: runner/run.js',
  '@@',
  '-// product: the runner',
  '+// product: taken over',
  '*** End Patch',
  '',
].join('\n');

try {
  check('C2 [guard] scripts/write-protection.js is still present', fs.existsSync(CLI));
  check('C2 [guard] scripts/write-guard-bridge.js is still present', fs.existsSync(BRIDGE));

  const PROT = makeTarget('target');
  check('C2 [guard] the fixture checkout was created and committed',
    fs.existsSync(path.join(PROT, 'pipeline.config.json'))
    && fixtureGit(PROT, ['rev-parse', 'HEAD']).status === 0);

  // ---- C5, "existing frozen suites remain untouched" -----------------------------------------
  for (const id of ['repo-324', 'repo-l2w', 'repo-ak5', 'repo-gy3']) {
    for (const name of ['test.js', 'guard.js']) {
      const p = path.join(REPO, 'tests', 'acceptance', id, name);
      let text = null;
      try { text = fs.readFileSync(p, 'utf8'); } catch { text = null; }
      check(`C5 [guard] the existing frozen suite file tests/acceptance/${id}/${name} is still present, non-empty and still names \`${id}\` (size ${text === null ? -1 : text.length})`,
        text !== null && text.length > 0 && text.includes(id));
    }
  }

  // ---- C2, Claude behaviour: install, status and uninstall ------------------------------------
  const CLAUDE = path.join(tmp, 'client-claude');
  const CODEX = path.join(tmp, 'client-codex');
  fs.mkdirSync(CLAUDE, { recursive: true });
  fs.mkdirSync(CODEX, { recursive: true });
  const clientEnv = { WRITE_PROTECTION_CLAUDE_DIR: CLAUDE, WRITE_PROTECTION_CODEX_DIR: CODEX };
  const SETTINGS = path.join(CLAUDE, 'settings.json');

  const UNRELATED_CMD = 'node /opt/somebody-elses/checker.js';
  fs.writeFileSync(SETTINGS, `${JSON.stringify({
    permissions: { allow: ['Bash(ls *)'] },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: UNRELATED_CMD }] }] },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(CODEX, 'config.toml'), '[unrelated]\nkeep_me = "yes"\n');

  const install = node(CLI, ['install'], { env: clientEnv });
  check(`C2 [guard] \`install\` still succeeds for both clients (exit ${install.status}: ${install.stderr.trim().slice(0, 200)})`,
    install.status === 0);

  let settings = null;
  try { settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch { settings = null; }
  const claudeCommands = (((settings && settings.hooks && settings.hooks.PreToolUse) || [])
    .flatMap((g) => (g && g.hooks) || [])).map((h) => String((h && h.command) || ''));
  check(`C2 [guard] install still adds our own Claude PreToolUse entry (got ${show(claudeCommands)})`,
    claudeCommands.some((c) => /write-guard|write-protection/.test(c)));
  check('C2 [guard] the unrelated Claude hook entry is still there, unclobbered',
    claudeCommands.includes(UNRELATED_CMD));

  // ---- C2, the payloads the bridge already answers, unchanged shape and unchanged exit code ---
  const bridge = (payload) => node(BRIDGE, [], { input: JSON.stringify(payload), env: clientEnv });

  const CLAUDE_DENIES = [
    ['Write', { session_id: 'sG', cwd: PROT, tool_name: 'Write', tool_input: { file_path: path.join(PROT, 'runner', 'run.js'), content: 'taken' } }],
    ['Edit', { session_id: 'sG', cwd: PROT, tool_name: 'Edit', tool_input: { file_path: 'runner/run.js', old_string: 'a', new_string: 'b' } }],
    ['MultiEdit', { session_id: 'sG', cwd: PROT, tool_name: 'MultiEdit', tool_input: { file_path: 'runner/run.js' } }],
    ['NotebookEdit', { session_id: 'sG', cwd: PROT, tool_name: 'NotebookEdit', tool_input: { notebook_path: 'runner/run.js' } }],
    ['Bash carried as a plain command STRING', { session_id: 'sG', cwd: PROT, tool_name: 'Bash', tool_input: { command: 'printf taken > runner/run.js' } }],
  ];
  for (const [label, payload] of CLAUDE_DENIES) {
    const r = bridge(payload);
    check(`C2 [guard] the Claude ${label} hook still refuses — exit 2 with a reason on stderr (got ${r.status}, stderr ${show(r.stderr.trim().slice(0, 100))})`,
      r.status === 2 && r.stderr.trim().length > 0);
  }

  const CLAUDE_ALLOWS = [
    ['Read', { session_id: 'sG', cwd: PROT, tool_name: 'Read', tool_input: { file_path: 'runner/run.js' } }],
    ['Write to an ignored host artifact', { session_id: 'sG', cwd: PROT, tool_name: 'Write', tool_input: { file_path: 'runs/latest.json', content: '{}' } }],
    ['Bash `git status` as a plain command STRING', { session_id: 'sG', cwd: PROT, tool_name: 'Bash', tool_input: { command: 'git status' } }],
  ];
  for (const [label, payload] of CLAUDE_ALLOWS) {
    const r = bridge(payload);
    check(`C2 [guard] the Claude ${label} hook still allows — exit 0 (got ${r.status}, stderr ${show(r.stderr.trim().slice(0, 100))})`,
      r.status === 0);
  }

  // ---- C2, the legacy `hook` / `input` Codex dialect remains compatible -----------------------
  const LEGACY_DENIES = [
    ['apply_patch', { session_id: 'sG', cwd: PROT, hook: 'apply_patch', input: { patch: PATCH_TEXT } }],
    ['unified_exec argv redirection', { session_id: 'sG', cwd: PROT, hook: 'unified_exec', input: { command: ['sh', '-c', 'printf taken > runner/run.js'] } }],
  ];
  for (const [label, payload] of LEGACY_DENIES) {
    const r = bridge(payload);
    check(`C2 [guard] the legacy repo-324 Codex \`${label}\` payload is still REFUSED — exit 2, plain text (got ${r.status}, stdout ${show(r.stdout.trim().slice(0, 60))}, stderr ${show(r.stderr.trim().slice(0, 100))})`,
      r.status === 2 && r.stderr.trim().length > 0);
  }

  const LEGACY_ALLOWS = [
    ['unified_exec `git status`', { session_id: 'sG', cwd: PROT, hook: 'unified_exec', input: { command: ['git', 'status'] } }],
  ];
  for (const [label, payload] of LEGACY_ALLOWS) {
    const r = bridge(payload);
    check(`C2 [guard] the legacy repo-324 Codex \`${label}\` read-only payload is still ALLOWED — exit 0 (got ${r.status}, stderr ${show(r.stderr.trim().slice(0, 100))})`,
      r.status === 0);
  }

  // ---- C2, uninstall still takes only what it put there ----------------------------------------
  const gone = node(CLI, ['uninstall'], { env: clientEnv });
  let after = null;
  try { after = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch { after = null; }
  const leftCommands = (((after && after.hooks && after.hooks.PreToolUse) || [])
    .flatMap((g) => (g && g.hooks) || [])).map((h) => String((h && h.command) || ''));
  check(`C2 [guard] \`uninstall\` still succeeds (exit ${gone.status})`, gone.status === 0);
  check(`C2 [guard] uninstall removed our Claude entry and left the unrelated one (got ${show(leftCommands)})`,
    !leftCommands.some((c) => /write-guard|write-protection/.test(c))
    && leftCommands.includes(UNRELATED_CMD));

  // ---- C5, no agent-hook configuration becomes tracked -----------------------------------------
  const tracked = (() => {
    const r = git(REPO, 'ls-files', '-z');
    return r.status === 0 ? String(r.stdout || '').split('\0').filter(Boolean) : null;
  })();
  check('C5 [guard] the tracked file list could be read', Array.isArray(tracked));
  if (Array.isArray(tracked)) {
    const hookFiles = tracked.filter((rel) => /(^|\/)\.(claude|codex)\/hooks\//.test(rel)
      || /(^|\/)\.(claude|codex)\/hooks\.json$/.test(rel));
    check(`C5 [guard] no agent hook file is tracked${hookFiles.length ? ` (found: ${hookFiles.slice(0, 5).join(', ')})` : ''}`,
      hookFiles.length === 0);
    const withHooks = tracked
      .filter((rel) => /(^|\/)\.(claude|codex)\/(settings|config)([.][^/]+)?\.(json|toml)$/.test(rel))
      .filter((rel) => {
        let text = '';
        try { text = fs.readFileSync(path.join(REPO, ...rel.split('/')), 'utf8'); } catch { return false; }
        return /"hooks"\s*:/.test(text) || /^\s*\[\[?hooks[.\]]/m.test(text);
      });
    check(`C5 [guard] no tracked client configuration carries a hooks entry${withHooks.length ? ` (found: ${withHooks.slice(0, 5).join(', ')})` : ''}`,
      withHooks.length === 0);
  }

  // ---- C5, the mandatory roster still names the suites this issue's code depends on -----------
  let roster = null;
  try { roster = fs.readFileSync(path.join(REPO, 'scripts', 'test-ci.sh'), 'utf8'); } catch { roster = null; }
  check('C5 [guard] scripts/test-ci.sh, the mandatory Docker-free publication profile, is still present', roster !== null);
  for (const suite of ['test-agent-hooks.sh', 'test-session-guard.sh', 'test-changelog.sh']) {
    check(`C5 [guard] the mandatory roster still runs ${suite}`, roster !== null && roster.includes(suite));
  }
} catch (e) {
  failed = 1;
  console.log(`FAIL - HARNESS BROKEN: unexpected exception: ${e && e.stack ? e.stack : e}`);
} finally {
  rmrf(tmp);
}
process.exit(failed);
