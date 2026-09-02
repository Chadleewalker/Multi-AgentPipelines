// Frozen acceptance test — repo-gy3, the [guard] half: emitting the Codex hook command as a
// TOML string and proving a full configuration load must not cost anything that already works.
//
// [guard] Every check in this file is GREEN at the fork point and must stay green. Nothing red
// belongs here: a [guard] file that is red at the fork point is a stale pin and refuses the
// freeze outright (`scripts/freeze-gate.js`, verdict `stale-guard`).
//
// WHICH CRITERION EACH CHECK PROVES. Two criteria have clauses that are statements about what
// did NOT change, and those clauses live here rather than in `test.js`:
//
//   C4, "read-only Bash inspection remains allowed" and "protected Bash ... writes are denied" —
//       in the dialect that already works at the fork point, where `tool_input.command` is a
//       plain command line. The CURRENT Codex dialect, where it is an argv array and
//       `apply_patch` arrives the same way, is red and lives in `test.js` §C4.
//   C4, "legacy bridge payloads remain compatible" — the `hook` / `input` Codex dialect that
//       `tests/acceptance/repo-324/test.js` froze is still refused, and its read-only form is
//       still allowed. This issue changes how the hook is WRITTEN DOWN, not what the bridge
//       understands; it is forbidden to spend the old dialect buying the new spelling.
//   C4, "Claude tests ... pass" — install, status and uninstall for the Claude client, and the
//       Claude tool-call payloads the bridge already refuses and already allows.
//   C4, "every mandatory regression pass", as the invariants those regressions enforce rather
//       than as a run of them — see DEFECT D1 in `test.js`. The one pinned here is the boundary
//       `tests/unit/agent-hooks.test.js` refuses outright: no agent-hook configuration becomes
//       tracked, because this repo is a target of its own pipeline and a tracked hook would
//       fire inside a container that has no agent CLI. This issue emits MORE client
//       configuration than before, so this is the invariant most at risk from it.
//   C5, "existing frozen suites remain untouched", as the part of it that is checkable from
//       inside a permanent guard: the suites this issue's neighbours froze are still present,
//       still non-empty, and still carry the issue id they were frozen for. Byte identity is
//       the freeze gate's job — encoding a merge-base diff of `tests/acceptance/` here would
//       make every LATER task's newly authored suite look like an illegal edit when this guard
//       runs on that task's branch.
//
// The emitted TOML string form, the status gating, the profile load, the current-dialect bridge
// behaviour and the correction of `repo-ak5` and PR #81 are all red at the fork point and live
// in `test.js`.
//
// SELF-CONTAINED ON PURPOSE. The freeze gate runs the guard subset ALONE in a scratch directory
// beside the suite, so this file requires nothing from its own folder and resolves the
// repository by walking up until it finds the tooling, never from the cwd.
//
// IT RUNS NO FROZEN SCRIPT. `scripts/test-*.sh` and `tests/unit/` are frozen paths; a frozen
// suite that shells into one asserts through a file it may never adjust. Every behaviour below
// is stated directly against `scripts/write-protection.js`, `scripts/write-guard-bridge.js`
// and Git.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// The tree this file sits in. Three levels up is the repository when the suite is in place;
// when the gate copies the guard somewhere else, the walk finds it anyway.
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

// `-c safe.directory=*` is not decoration: fixtures and worktrees are routinely owned by a
// different uid than the process inside a container, and git's dubious-ownership guard would
// otherwise refuse every call. A frozen test must not depend on ambient git config.
const GIT_SAFE = ['-c', 'safe.directory=*'];

let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) failed = 1;
}
const show = (v) => JSON.stringify(v);

// A child never inherits the operator's own seams: a real installation on this machine must
// not be able to turn any assertion below green or red.
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

// Fixtures carry read-only files on some hosts and a fixture repository's loose objects are
// read-only on Windows besides. Clear the bits before removing, and never let disposal decide
// a verdict.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-gy3-'));
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

// A throwaway pipeline-first checkout, never this one. Same shape the frozen `repo-324` and
// `repo-ak5` suites judge, because it is the same guard being asked.
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
  check('C4 [guard] scripts/write-protection.js is still present', fs.existsSync(CLI));
  check('C4 [guard] scripts/write-guard-bridge.js is still present', fs.existsSync(BRIDGE));

  const PROT = makeTarget('target');
  check('C4 [guard] the fixture checkout was created and committed',
    fs.existsSync(path.join(PROT, 'pipeline.config.json'))
    && fixtureGit(PROT, ['rev-parse', 'HEAD']).status === 0);

  // ---- C5, "existing frozen suites remain untouched" ----------------------------------------
  // Presence and substance only. What this guard can honestly say is that the neighbouring
  // frozen suites are still here, with content in them, still carrying the issue id they were
  // frozen for; the freeze gate is what proves their bytes did not move, and it proves it for
  // the run that is actually freezing.
  for (const id of ['repo-324', 'repo-l2w', 'repo-ak5']) {
    for (const name of ['test.js', 'guard.js']) {
      const p = path.join(REPO, 'tests', 'acceptance', id, name);
      let text = null;
      try { text = fs.readFileSync(p, 'utf8'); } catch { text = null; }
      check(`C5 [guard] the existing frozen suite file tests/acceptance/${id}/${name} is still present, non-empty and still names \`${id}\` (size ${text === null ? -1 : text.length})`,
        text !== null && text.length > 0 && text.includes(id));
    }
  }

  // ---- C4, Claude behaviour: install, status and uninstall -----------------------------------
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
  check(`C4 [guard] \`install\` still succeeds for both clients (exit ${install.status}: ${install.stderr.trim().slice(0, 200)})`,
    install.status === 0);

  const status = node(CLI, ['status', '--json'], { env: clientEnv });
  const claude = (status.json && status.json.clients && status.json.clients.claude) || {};
  check(`C4 [guard] Claude is still \`enforced\` after a clean install (got ${show(claude.state)})`,
    claude.state === 'enforced');
  check(`C4 [guard] status still refuses to call enforcement complete while local hooks are mutable (got ${show(status.json && status.json.enforcementComplete)})`,
    Boolean(status.json) && status.json.enforcementComplete === false);

  let settings = null;
  try { settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch { settings = null; }
  const claudeCommands = (((settings && settings.hooks && settings.hooks.PreToolUse) || [])
    .flatMap((g) => (g && g.hooks) || [])).map((h) => String((h && h.command) || ''));
  check(`C4 [guard] install still adds our own Claude PreToolUse entry (got ${show(claudeCommands)})`,
    claudeCommands.some((c) => /write-guard|write-protection/.test(c)));
  check('C4 [guard] the unrelated Claude hook entry is still there, unclobbered',
    claudeCommands.includes(UNRELATED_CMD));
  check('C4 [guard] the unrelated Claude permissions block still survives install',
    Boolean(settings) && settings.permissions && Array.isArray(settings.permissions.allow)
    && settings.permissions.allow.includes('Bash(ls *)'));

  // Claude's own nested-handler shape, judged the way `write-protection.js` judges it: whole-name
  // match against the group's own matcher. Claude already writes its command as a JSON STRING;
  // this issue moves Codex onto the same footing in TOML, and the Claude side must not move.
  const covers = (matcher, tool) => {
    const raw = String(matcher === undefined || matcher === null ? '' : matcher).trim();
    if (!raw || raw === '*') return true;
    try { return new RegExp(`^(?:${raw})$`).test(tool); } catch { return false; }
  };
  const ourGroups = ((settings && settings.hooks && settings.hooks.PreToolUse) || [])
    .filter((g) => g && Array.isArray(g.hooks)
      && g.hooks.some((h) => /write-guard|write-protection/.test(String((h && h.command) || ''))));
  for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash']) {
    check(`C4 [guard] the installed Claude matcher still covers \`${tool}\``,
      ourGroups.some((g) => covers(g.matcher, tool)));
  }
  check('C4 [guard] the Claude entry is still a nested handler carrying `type: "command"` and a command written as a STRING, which is the footing Codex is being moved onto',
    ourGroups.some((g) => (g.hooks || []).some((h) => h && h.type === 'command'
      && typeof h.command === 'string'
      && /write-guard|write-protection/.test(h.command))));

  // ---- C4, Claude behaviour: the payloads the bridge already answers --------------------------
  const bridge = (payload) => node(BRIDGE, [], { input: JSON.stringify(payload), env: clientEnv });

  const CLAUDE_DENIES = [
    ['Write', { session_id: 'sG', cwd: PROT, tool_name: 'Write', tool_input: { file_path: path.join(PROT, 'runner', 'run.js'), content: 'taken' } }],
    ['Edit', { session_id: 'sG', cwd: PROT, tool_name: 'Edit', tool_input: { file_path: 'runner/run.js', old_string: 'a', new_string: 'b' } }],
    ['MultiEdit', { session_id: 'sG', cwd: PROT, tool_name: 'MultiEdit', tool_input: { file_path: 'runner/run.js' } }],
    ['NotebookEdit', { session_id: 'sG', cwd: PROT, tool_name: 'NotebookEdit', tool_input: { notebook_path: 'runner/run.js' } }],
  ];
  for (const [label, payload] of CLAUDE_DENIES) {
    const r = bridge(payload);
    check(`C4 [guard] the Claude ${label} hook still refuses — exit 2 with a reason on stderr (got ${r.status}, stderr ${show(r.stderr.trim().slice(0, 100))})`,
      r.status === 2 && r.stderr.trim().length > 0);
  }

  const CLAUDE_ALLOWS = [
    ['Read', { session_id: 'sG', cwd: PROT, tool_name: 'Read', tool_input: { file_path: 'runner/run.js' } }],
    ['Grep', { session_id: 'sG', cwd: PROT, tool_name: 'Grep', tool_input: { pattern: 'product' } }],
    ['Write to an ignored host artifact', { session_id: 'sG', cwd: PROT, tool_name: 'Write', tool_input: { file_path: 'runs/latest.json', content: '{}' } }],
  ];
  for (const [label, payload] of CLAUDE_ALLOWS) {
    const r = bridge(payload);
    check(`C4 [guard] the Claude ${label} hook still allows — exit 0 (got ${r.status}, stderr ${show(r.stderr.trim().slice(0, 100))})`,
      r.status === 0);
  }

  // ---- C4, protected Bash writes denied and read-only Bash inspection allowed -----------------
  // In the dialect that already works: `tool_name: "Bash"` with `tool_input.command` as a plain
  // command line. The criterion says these REMAIN so, and this is where "remain" is held.
  const BASH_DENIES = [
    ['a redirection into a protected product file', 'printf taken > runner/run.js'],
    ['an in-place stream edit of a protected product file', "sed -i 's/product/taken/' runner/run.js"],
  ];
  for (const [label, command] of BASH_DENIES) {
    const r = bridge({ session_id: 'sG', cwd: PROT, tool_name: 'Bash', tool_input: { command } });
    check(`C4 [guard] a protected Bash write — ${label}, as a command STRING — is still DENIED, exit 2 with a reason (got ${r.status}, stderr ${show(r.stderr.trim().slice(0, 100))})`,
      r.status === 2 && r.stderr.trim().length > 0);
  }

  const BASH_ALLOWS = [
    ['`git status`', 'git status'],
    ['`cat README.md`', 'cat README.md'],
  ];
  for (const [label, command] of BASH_ALLOWS) {
    const r = bridge({ session_id: 'sG', cwd: PROT, tool_name: 'Bash', tool_input: { command } });
    check(`C4 [guard] read-only Bash inspection — ${label}, as a command STRING — is still ALLOWED, exit 0 (got ${r.status}, stderr ${show(r.stderr.trim().slice(0, 100))})`,
      r.status === 0);
  }

  // ---- C4, legacy bridge payloads remain compatible --------------------------------------------
  // `tests/acceptance/repo-324/test.js` freezes the `hook` / `input` dialect. C4 requires it to
  // keep working alongside the current one, so a repair that REPLACED the dialect instead of
  // adding to it is caught here rather than by a frozen suite it may not edit.
  const LEGACY_DENIES = [
    ['apply_patch', { session_id: 'sG', cwd: PROT, hook: 'apply_patch', input: { patch: PATCH_TEXT } }],
    ['unified_exec argv redirection', { session_id: 'sG', cwd: PROT, hook: 'unified_exec', input: { command: ['sh', '-c', 'printf taken > runner/run.js'] } }],
    ['unified_exec in-place stream edit', { session_id: 'sG', cwd: PROT, hook: 'unified_exec', input: { command: ['bash', '-lc', "sed -i 's/product/taken/' runner/run.js"] } }],
  ];
  for (const [label, payload] of LEGACY_DENIES) {
    const r = bridge(payload);
    check(`C4 [guard] the legacy repo-324 Codex \`${label}\` payload is still REFUSED — exit 2 (got ${r.status}, stderr ${show(r.stderr.trim().slice(0, 100))})`,
      r.status === 2 && r.stderr.trim().length > 0);
  }

  const LEGACY_ALLOWS = [
    ['unified_exec `git status`', { session_id: 'sG', cwd: PROT, hook: 'unified_exec', input: { command: ['git', 'status'] } }],
    ['unified_exec `cat README.md`', { session_id: 'sG', cwd: PROT, hook: 'unified_exec', input: { command: ['cat', 'README.md'] } }],
  ];
  for (const [label, payload] of LEGACY_ALLOWS) {
    const r = bridge(payload);
    check(`C4 [guard] the legacy repo-324 Codex \`${label}\` read-only payload is still ALLOWED — exit 0 (got ${r.status}, stderr ${show(r.stderr.trim().slice(0, 100))})`,
      r.status === 0);
  }

  // ---- C4, uninstall still takes only what it put there ------------------------------------------
  const gone = node(CLI, ['uninstall'], { env: clientEnv });
  let after = null;
  try { after = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch { after = null; }
  const leftCommands = (((after && after.hooks && after.hooks.PreToolUse) || [])
    .flatMap((g) => (g && g.hooks) || [])).map((h) => String((h && h.command) || ''));
  check(`C4 [guard] \`uninstall\` still succeeds (exit ${gone.status})`, gone.status === 0);
  check(`C4 [guard] uninstall removed our Claude entry and left the unrelated one (got ${show(leftCommands)})`,
    !leftCommands.some((c) => /write-guard|write-protection/.test(c))
    && leftCommands.includes(UNRELATED_CMD));
  check('C4 [guard] and the unrelated Claude permissions block is still there',
    Boolean(after) && after.permissions && Array.isArray(after.permissions.allow)
    && after.permissions.allow.includes('Bash(ls *)'));
  check('C4 [guard] the unrelated Codex configuration also survived install and uninstall',
    fs.readFileSync(path.join(CODEX, 'config.toml'), 'utf8').includes('keep_me = "yes"'));

  // ---- C4, no agent-hook configuration becomes tracked ---------------------------------------------
  // The boundary `tests/unit/agent-hooks.test.js` enforces, restated directly against Git rather
  // than run through the frozen script that drives it. This repo is a target of its own
  // pipeline: a tracked hook configuration would be cloned into a container with no agent CLI
  // and fire on every session.
  const tracked = (() => {
    const r = git(REPO, 'ls-files', '-z');
    return r.status === 0 ? String(r.stdout || '').split('\0').filter(Boolean) : null;
  })();
  check('C4 [guard] the tracked file list could be read', Array.isArray(tracked));
  if (Array.isArray(tracked)) {
    const hookFiles = tracked.filter((rel) => /(^|\/)\.(claude|codex)\/hooks\//.test(rel)
      || /(^|\/)\.(claude|codex)\/hooks\.json$/.test(rel));
    check(`C4 [guard] no agent hook file is tracked${hookFiles.length ? ` (found: ${hookFiles.slice(0, 5).join(', ')})` : ''}`,
      hookFiles.length === 0);
    const withHooks = tracked
      .filter((rel) => /(^|\/)\.(claude|codex)\/(settings|config)([.][^/]+)?\.(json|toml)$/.test(rel))
      .filter((rel) => {
        let text = '';
        try { text = fs.readFileSync(path.join(REPO, ...rel.split('/')), 'utf8'); } catch { return false; }
        return /"hooks"\s*:/.test(text) || /^\s*\[\[?hooks[.\]]/m.test(text);
      });
    check(`C4 [guard] no tracked client configuration carries a hooks entry${withHooks.length ? ` (found: ${withHooks.slice(0, 5).join(', ')})` : ''}`,
      withHooks.length === 0);
  }
} catch (e) {
  failed = 1;
  console.log(`FAIL - HARNESS BROKEN: unexpected exception: ${e && e.stack ? e.stack : e}`);
} finally {
  rmrf(tmp);
}
process.exit(failed);
