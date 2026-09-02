// Frozen acceptance test — repo-l2w: wire the Codex guard through the CURRENT PreToolUse
// hooks. This is the RED half; `guard.js` beside it carries the checks that are already green
// at the fork point and must stay that way.
//
// The Beads issue is canonical, not the planning draft that produced it. Plain Node,
// Docker-free, node built-ins plus `git` — a task container has both and neither a Docker
// daemon nor a network.
//
// ── PAIRING ───────────────────────────────────────────────────────────────────────────────
// Every criterion names the section that proves it, and every check below names the criterion
// it serves in its own label. No orphan on either side.
//
//   C1  §C1  `install` emits CURRENT Codex PreToolUse matcher groups covering
//            Bash / unified exec and apply_patch, and clobbers no unrelated configuration.
//   C2  §C2  the bridge parses CURRENT `tool_name` / `tool_input` Codex payloads and denies
//            protected patch and shell writes while allowing read-only inspection.
//   C3  §C3  a disposable black-box Codex session cannot change a protected path; with no
//            Codex binary the suite reports an explicit skip and the synthetic coverage that
//            stands in for it is non-vacuous.
//   C4  §C4  `status` never says Codex is `enforced` when the configuration has no effective
//            current matcher coverage, when hooks are disabled, when the installed payload is
//            incomplete or when the trust the hook needs cannot be established; and managed
//            versus locally disableable policy stays explicit.
//   C5  §C5  the change-log records the repair, and the mandatory regression roster still
//            names the suites that cover this code.
//
//   C5's Claude and legacy-Codex clauses are proven by `guard.js`, because they are statements
//   about what did NOT change and are therefore green at the fork point by construction. The
//   freeze gate proves that no existing frozen suite was edited; encoding that as a permanent
//   merge-base guard would incorrectly reject every later task's newly authored suite.
//
// ── THE FROZEN INTERFACE ──────────────────────────────────────────────────────────────────
//
// scripts/write-protection.js       `install`, `uninstall` and `status [--json]`, with the
//   client directories aimed by `WRITE_PROTECTION_CLAUDE_DIR` / `WRITE_PROTECTION_CODEX_DIR`
//   and host records by `WRITE_PROTECTION_HOST_STATE_DIR` — the seams repo-324 already froze.
//   `status --json` answers {"clients":{"codex":{"state":<one of contracts/
//   write-protection.json `clientStates`>,"detail":…},"claude":{…}},
//   "enforcementComplete":<bool>,"managedPolicy":<bool>,"limitations":[…]}.
//
// scripts/write-guard-bridge.js     the host-side hook translator. One JSON payload on stdin,
//   exit 0 to allow and exit 2 to refuse with a reason on stderr. This issue adds the CURRENT
//   Codex payload shape to the two it already reads:
//       {"session_id":…,"cwd":…,"tool_name":"apply_patch","tool_input":{"patch":"<text>"}}
//       {"session_id":…,"cwd":…,"tool_name":"unified_exec","tool_input":{"command":[argv]}}
//       {"session_id":…,"cwd":…,"tool_name":"Bash","tool_input":{"command":[argv]}}
//   `tool_input.command` is an ARGV ARRAY here, which is the whole difference from the Claude
//   `Bash` payload whose `command` is a string.
//
// The Codex client configuration is `config.toml` in the Codex config directory. What this
// suite freezes about it is the SUBSTANCE the criterion names and not a byte layout: a
// `PreToolUse` hook table (`[hooks.PreToolUse]`, `[[hooks.PreToolUse]]` or a nested table
// under either) whose matcher coverage reaches the tool paths, carrying a `command` that runs
// this installation's own bridge. Indentation, comment lines, sentinel wording, whether the
// groups are one table or three, and whether the command is a string or an argv array are all
// left free — `codexGroups()` below reads any of those.
//
// ── HOW "CURRENT MATCHER COVERAGE" IS MEASURED ────────────────────────────────────────────
// Exactly the way the Claude half of `write-protection.js` already measures it: a matcher
// covers a tool when it is absent, `*`, an alternation listing the tool, or a regular
// expression that matches the whole tool name. A hook table named after the tool it hooks
// (`[[hooks.PreToolUse.apply_patch]]`) covers that tool too. Nothing here demands the matcher
// be spelled any particular way; it demands only that the three tool paths the criterion
// names come out covered.
//
// ── SPEC DEFECTS, REPORTED RATHER THAN PAPERED OVER ───────────────────────────────────────
//
// D1. C4's "required trust cannot be established" names no mechanism, and Codex has two
//     candidates: the trust a client grants a project before it will run its hooks, and the
//     trust that what the configured hook command runs is this installation's own guard
//     rather than something a session re-pointed it at. Both are proven below, separately
//     labelled, so a repair that reads the clause either way still has a check that holds it.
//     If only one reading was meant, the other is a free extra rather than a wrong demand.
//
// D2. C5's "all mandatory regressions pass" cannot be honestly claimed by any acceptance
//     suite in this project. `scripts/test-ci.sh` and every `scripts/test-*.sh` are frozen
//     paths, and a frozen suite that shells into a frozen script asserts through a file it may
//     never adjust. §C5 therefore proves the part that is a fact about the tree — the roster
//     still names the suites that cover this code — and `guard.js` pins the invariants those
//     suites enforce. "The full configured regression command is green" stays a
//     pipeline-level gate. This is the same boundary `tests/acceptance/repo-yk4/test.js`
//     drew, for the same reason.
//
// D3. C3 asks for a disposable black-box Codex session. A Codex binary is a network- and
//     credential-bound external client, so the honest structure is the one the criterion
//     itself asks for: attempt it, and where it cannot be attempted say so in the check's own
//     name. The synthetic stand-in is not a paraphrase of the bridge — it spawns THE COMMAND
//     THE EMITTED CONFIGURATION NAMES, so it is black-box with respect to everything except
//     the client process itself.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(REPO, 'scripts', 'write-protection.js');
const BRIDGE = path.join(REPO, 'scripts', 'write-guard-bridge.js');
const CONTRACT = path.join(REPO, 'contracts', 'write-protection.json');
const CHANGE_LOG = path.join(REPO, 'docs', 'change-log.md');
const REF = 'repo-l2w';

// The tool paths C1 names. `Bash` and `unified_exec` are the two names the shell tool path
// travels under; both are required because a matcher listing both costs nothing and a matcher
// listing only one leaves the other unguarded on whichever client spells it that way.
const CODEX_TOOLS = ['apply_patch', 'unified_exec', 'Bash'];

let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) failed = 1;
}
const show = (v) => JSON.stringify(v);

// ---------------------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-l2w-'));
const HOST = path.join(tmp, 'host-state');
fs.mkdirSync(HOST, { recursive: true });

// A child never inherits the operator's own seams: a real installation on this machine must
// not be able to turn any assertion below green or red.
function envWith(extra) {
  const e = { ...process.env };
  for (const k of ['WRITE_PROTECTION_HOST_STATE_DIR', 'WRITE_PROTECTION_CLAUDE_DIR',
    'WRITE_PROTECTION_CODEX_DIR', 'WRITE_PROTECTION_MANAGED', 'CLAUDE_CONFIG_DIR',
    'SESSION_GUARD_CONFIG_DIR']) delete e[k];
  return { ...e, WRITE_PROTECTION_HOST_STATE_DIR: HOST, ...extra };
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

function node(script, args, opts = {}) {
  const r = spawnSync(process.execPath, [script, ...args], {
    encoding: 'utf8', timeout: 120000, windowsHide: true,
    env: envWith(opts.env || {}), cwd: opts.cwd || tmp, input: opts.input,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', json: lastJson(r.stdout) };
}

// Spawn an arbitrary argv — used only to run the command the EMITTED configuration names, so
// that §C3's stand-in exercises the wiring rather than a restatement of it.
function spawnArgv(argv, opts = {}) {
  const r = spawnSync(argv[0], argv.slice(1), {
    encoding: 'utf8', timeout: opts.timeout || 120000, windowsHide: true,
    env: envWith(opts.env || {}), cwd: opts.cwd || tmp, input: opts.input,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error || null };
}

function git(dir, args) {
  return spawnSync('git', ['-C', dir, '-c', 'user.email=fixture@example.invalid',
    '-c', 'user.name=Fixture', '-c', 'commit.gpgsign=false', ...args],
  { encoding: 'utf8', timeout: 120000, windowsHide: true });
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

const sha = (file) => {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
  catch { return null; }
};

// ---------------------------------------------------------------------------------------
// the fixture target — a throwaway pipeline-first checkout, never this one
// ---------------------------------------------------------------------------------------

const FIXTURE_CONFIG = JSON.stringify({
  verifyCommand: 'sh tools/run-acceptance.sh',
  regressionCommand: 'bash scripts/test-ci.sh',
  regressionPolicy: 'required',
  defaultBranch: 'main',
  frozenPaths: ['tools/run-acceptance.sh'],
  dependencies: {},
}, null, 2);

const FIXTURE_FILES = {
  'README.md': '# fixture target\n',
  '.gitignore': 'runs/\n',
  'pipeline.config.json': FIXTURE_CONFIG,
  'runner/run.js': '// product: the runner\n',
  'tools/run-acceptance.sh': '# frozen verifier\n',
  'runs/keep.json': '{"host":"artifact"}\n',
};

function makeTarget(name) {
  const dir = path.join(tmp, name);
  for (const [rel, body] of Object.entries(FIXTURE_FILES)) {
    const p = path.join(dir, ...rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  spawnSync('git', ['init', '-q', dir], { encoding: 'utf8', timeout: 120000, windowsHide: true });
  git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(dir, ['add', '-A', '.']);
  git(dir, ['commit', '-q', '-m', 'fixture']);
  return dir;
}

// ---------------------------------------------------------------------------------------
// reading a Codex config.toml, tolerantly
// ---------------------------------------------------------------------------------------

// A deliberately small TOML reader. It knows three things — table headers, `key = "string"`
// and `key = ["a", "b"]` — because those are the only three the criterion is about, and a
// full parser would freeze syntax this issue has no opinion on.
function tomlStrings(value) {
  const raw = String(value || '').trim();
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;
  let m = re.exec(raw);
  while (m) { out.push((m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2])); m = re.exec(raw); }
  return out;
}

function tomlLines(text) {
  const out = [];
  let header = '';
  for (const line of String(text || '').split(/\r?\n/)) {
    const bare = line.replace(/(^|\s)#.*$/, '').trim();
    const h = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(bare);
    if (h) { header = h[1].replace(/"/g, ''); out.push({ header, key: null, value: null, line }); continue; }
    const kv = /^([A-Za-z0-9_.\-"']+)\s*=\s*(.+)$/.exec(bare);
    if (kv) out.push({ header, key: kv[1].replace(/"/g, ''), value: kv[2], line });
  }
  return out;
}

// A hook command may be written as an argv array or as one command line; both are read here,
// because which one a client prefers is not what this issue is about.
function normalizeArgv(argv) {
  if (!Array.isArray(argv) || !argv.length) return [];
  if (argv.length > 1) return argv.map(String);
  const one = String(argv[0]);
  if (!/\s/.test(one)) return [one];
  return (one.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((t) => t.replace(/^["']|["']$/g, ''));
}

// Every hook group whose table path carries a `PreToolUse` segment, with the matchers and
// commands that belong to it — that is, the ones declared in that table or in a table nested
// beneath it.
function codexGroups(text) {
  const rows = tomlLines(text);
  const groups = [];
  let open = null;
  const isPre = (h) => h.split('.').some((seg) => seg === 'PreToolUse');
  for (const row of rows) {
    if (row.key === null) {
      // Only a STRICT descendant continues the open group — `[[hooks.PreToolUse.hooks]]`
      // beneath `[[hooks.PreToolUse]]`. A repeat of the same header is the next element of an
      // array of tables and therefore the next group, which is what keeps somebody else's
      // entry in the shared table from being read as part of ours.
      if (open && row.header.startsWith(`${open.header}.`)) continue;
      if (isPre(row.header)) {
        open = { header: row.header, matchers: [], commands: [] };
        groups.push(open);
        continue;
      }
      open = null;
      continue;
    }
    if (!open) continue;
    if (row.key === 'matcher' || row.key === 'matchers' || row.key === 'tools') {
      open.matchers.push(...tomlStrings(row.value));
    }
    if (row.key === 'command' || row.key === 'commands' || row.key === 'argv') {
      const argv = normalizeArgv(tomlStrings(row.value));
      if (argv.length) open.commands.push(argv);
    }
  }
  return groups;
}

// Every `command = …` in the file, whatever table it sits under. Used where the question is
// "what would this configuration run", independent of how the groups are shaped.
function allCommands(text) {
  return tomlLines(text)
    .filter((r) => r.key === 'command' || r.key === 'commands' || r.key === 'argv')
    .map((r) => normalizeArgv(tomlStrings(r.value)))
    .filter((argv) => argv.length);
}

// The same rule the Claude half already applies: absent or `*` covers everything, an
// alternation covers what it lists, and anything else is tried as a whole-name regex.
function matcherCovers(matcher, tool) {
  const raw = String(matcher === undefined || matcher === null ? '' : matcher).trim();
  if (!raw || raw === '*') return true;
  if (raw.split(/[|,]/).map((s) => s.trim()).some((s) => s === tool || s === '*')) return true;
  try { return new RegExp(`^(?:${raw})$`).test(tool); } catch { return false; }
}

// A group covers a tool through its matcher, or through being a table named after it. A group
// that declares NEITHER covers nothing here: coverage that cannot be read out of the file is
// coverage `status` cannot verify either, and the criterion is about matcher groups.
function groupCovers(group, tool) {
  if (group.header.split('.').some((seg) => seg === tool)) return true;
  return group.matchers.some((m) => matcherCovers(m, tool));
}

const OURS = /write-guard|write-protection/;
const runsOurGuard = (group) => group.commands.some((argv) => argv.some((a) => OURS.test(a)));

function coveredTools(text) {
  const mine = codexGroups(text).filter(runsOurGuard);
  return CODEX_TOOLS.filter((t) => mine.some((g) => groupCovers(g, t)));
}

// Rewrite the configuration so that the only tool path our own hook still names is `keep`.
// Command lines are never touched, so the hook still points at the same guard and the ONLY
// thing that changed is coverage — which is what makes the status answer attributable.
function narrowTo(text, keep) {
  return String(text).split(/\r?\n/).map((line) => {
    if (OURS.test(line)) return line;
    if (/^\s*matchers?\s*=/.test(line)) return line.replace(/=.*$/, `= "${keep}"`);
    return line.replace(/\b(?:Bash|unified_exec|apply_patch|shell)\b/g, keep);
  }).join('\n');
}

// ---------------------------------------------------------------------------------------

const PATCH_PROTECTED = [
  '*** Begin Patch',
  '*** Update File: runner/run.js',
  '@@',
  '-// product: the runner',
  '+// product: taken over',
  '*** End Patch',
  '',
].join('\n');

const PATCH_IGNORED = [
  '*** Begin Patch',
  '*** Update File: runs/keep.json',
  '@@',
  '-{"host":"artifact"}',
  '+{"host":"rewritten"}',
  '*** End Patch',
  '',
].join('\n');

// The refusal sentence the bridge prints when it could not READ a command. A well-formed argv
// that gets this answer was not parsed, so a deny for this reason does not prove the payload
// was understood — which is the difference between wiring the guard up and merely refusing.
const UNREADABLE = /could not be read well enough|names no files this guard can read/;

try {
  check('C1 scripts/write-protection.js is still present', fs.existsSync(CLI));
  check('C2 scripts/write-guard-bridge.js is still present', fs.existsSync(BRIDGE));

  let contract = null;
  try { contract = JSON.parse(fs.readFileSync(CONTRACT, 'utf8')); } catch { contract = null; }
  const declaredCodexTools = (contract && contract.clients && contract.clients.codex
    && Array.isArray(contract.clients.codex.toolPaths)) ? contract.clients.codex.toolPaths.map(String) : [];
  const CLIENT_STATES = (contract && Array.isArray(contract.clientStates))
    ? contract.clientStates.map(String) : [];

  const PROT = makeTarget('target');
  const PROT_FILE = path.join(PROT, 'runner', 'run.js');
  const PROT_SHA = sha(PROT_FILE);

  // =====================================================================================
  // §C1 — install emits current Codex PreToolUse matcher groups, and clobbers nothing.
  // =====================================================================================

  const CLAUDE_DIR = path.join(tmp, 'client-claude');
  const CODEX_DIR = path.join(tmp, 'client-codex');
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  fs.mkdirSync(CODEX_DIR, { recursive: true });
  const CODEX_CONFIG = path.join(CODEX_DIR, 'config.toml');
  const clientEnv = { WRITE_PROTECTION_CLAUDE_DIR: CLAUDE_DIR, WRITE_PROTECTION_CODEX_DIR: CODEX_DIR };

  // Configuration that is NOT ours and must survive: an unrelated setting, an unrelated
  // section, and — the case the new format actually creates — somebody else's PreToolUse hook
  // group in the very table this installer now has to write into.
  const FOREIGN_CMD = '/opt/somebody-elses/checker.js';
  const CODEX_KEEP = [
    '[features]',
    'hooks = true',
    '',
    '[unrelated]',
    'keep_me = "yes"',
    '',
    '[[hooks.PreToolUse]]',
    'matcher = "Bash"',
    `command = ["node", "${FOREIGN_CMD}"]`,
    '',
  ].join('\n');
  fs.writeFileSync(CODEX_CONFIG, CODEX_KEEP);
  fs.writeFileSync(path.join(CLAUDE_DIR, 'settings.json'), `${JSON.stringify({
    permissions: { allow: ['Bash(ls *)'] },
  }, null, 2)}\n`);

  const install = node(CLI, ['install'], { env: clientEnv });
  check(`C1 \`install\` succeeds with both client directories aimed at scratch dirs (exit ${install.status}: ${install.stderr.trim().slice(0, 200)})`,
    install.status === 0);

  let emitted = '';
  try { emitted = fs.readFileSync(CODEX_CONFIG, 'utf8'); } catch { emitted = ''; }
  const groups = codexGroups(emitted);
  const ourGroups = groups.filter(runsOurGuard);
  check(`C1 the emitted Codex configuration declares at least one PreToolUse hook group running this installation's guard (found ${ourGroups.length} of ${groups.length} groups)`,
    ourGroups.length > 0);

  // "Matcher groups" is the criterion's own noun: coverage has to be READABLE out of the
  // file, either as a matcher or as a table named after the tool it hooks. A group that
  // declares neither is coverage nobody — including `status` — can verify.
  check(`C1 our PreToolUse groups declare their coverage explicitly (matchers ${show(ourGroups.flatMap((g) => g.matchers))}, headers ${show(ourGroups.map((g) => g.header))})`,
    ourGroups.length > 0 && ourGroups.every((g) => g.matchers.length > 0
      || CODEX_TOOLS.some((t) => g.header.split('.').includes(t))));

  const covered = coveredTools(emitted);
  for (const tool of CODEX_TOOLS) {
    check(`C1 the emitted PreToolUse matcher coverage reaches \`${tool}\` (covered: ${show(covered)})`,
      covered.includes(tool));
  }
  for (const tool of declaredCodexTools) {
    check(`C1 ... and reaches \`${tool}\`, which contracts/write-protection.json declares for this client`,
      declaredCodexTools.length > 0 && ourGroups.some((g) => groupCovers(g, tool)));
  }

  // A group that names the right tools but runs nothing is not a hook. The command has to
  // point INSIDE this client's own installation, which is what makes the guard the one this
  // `install` just put there rather than whatever else is on the machine.
  const insideClient = (argv) => argv.some((a) => {
    const p = String(a).split(path.sep).join('/');
    return OURS.test(p) && p.toLowerCase().startsWith(CODEX_DIR.split(path.sep).join('/').toLowerCase());
  });
  check(`C1 the emitted hook runs a command inside this client's own installed payload (commands: ${show(ourGroups.flatMap((g) => g.commands)).slice(0, 300)})`,
    ourGroups.some((g) => g.commands.some(insideClient)));

  // Nothing unrelated was clobbered — including the foreign PreToolUse group, which is the
  // one the move to a shared hook table actually puts at risk.
  check('C1 the unrelated Codex setting survived install',
    emitted.includes('keep_me = "yes"'));
  check('C1 the unrelated Codex section header survived install',
    /^\s*\[unrelated\]\s*$/m.test(emitted));
  check(`C1 somebody else's PreToolUse hook group survived install (commands: ${show(allCommands(emitted)).slice(0, 300)})`,
    allCommands(emitted).some((argv) => argv.includes(FOREIGN_CMD)));

  // Installing twice is how an operator upgrades. It must replace our group, not stack one.
  const reinstall = node(CLI, ['install'], { env: clientEnv });
  let emitted2 = '';
  try { emitted2 = fs.readFileSync(CODEX_CONFIG, 'utf8'); } catch { emitted2 = ''; }
  const ourGroups2 = codexGroups(emitted2).filter(runsOurGuard);
  check(`C1 re-installing does not stack a second copy of our hook group (found ${ourGroups2.length}, first install had ${ourGroups.length})`,
    reinstall.status === 0 && ourGroups2.length > 0 && ourGroups2.length === ourGroups.length);
  check('C1 re-installing still leaves the unrelated configuration and the foreign hook alone',
    emitted2.includes('keep_me = "yes"') && allCommands(emitted2).some((argv) => argv.includes(FOREIGN_CMD)));
  check(`C1 re-installing keeps the same tool coverage (covered: ${show(coveredTools(emitted2))})`,
    CODEX_TOOLS.every((t) => coveredTools(emitted2).includes(t)));

  // =====================================================================================
  // §C2 — the bridge reads CURRENT tool_name / tool_input Codex payloads.
  // =====================================================================================

  function bridge(payload) {
    return node(BRIDGE, [], { input: JSON.stringify(payload), env: clientEnv });
  }

  const DENIES = [
    ['an apply_patch that rewrites a protected product file',
      { session_id: 'sC2', cwd: PROT, tool_name: 'apply_patch', tool_input: { patch: PATCH_PROTECTED } }],
    ['a unified_exec argv shell redirection into a protected file',
      { session_id: 'sC2', cwd: PROT, tool_name: 'unified_exec', tool_input: { command: ['sh', '-c', 'printf taken > runner/run.js'] } }],
    ['a unified_exec whose command is a plain string',
      { session_id: 'sC2', cwd: PROT, tool_name: 'unified_exec', tool_input: { command: 'printf taken > runner/run.js' } }],
    ['a unified_exec in-place stream edit of a protected file',
      { session_id: 'sC2', cwd: PROT, tool_name: 'unified_exec', tool_input: { command: ['bash', '-lc', "sed -i 's/product/taken/' runner/run.js"] } }],
    ['a Bash tool path carrying a Codex argv array',
      { session_id: 'sC2', cwd: PROT, tool_name: 'Bash', tool_input: { command: ['sh', '-c', 'printf taken > runner/run.js'] } }],
    ['an apply_patch expressed as a unified diff',
      { session_id: 'sC2', cwd: PROT, tool_name: 'apply_patch', tool_input: { patch: '--- a/runner/run.js\n+++ b/runner/run.js\n@@ -1 +1 @@\n-// product: the runner\n+// taken\n' } }],
  ];
  for (const [label, payload] of DENIES) {
    const r = bridge(payload);
    check(`C2 ${label} is REFUSED — exit 2 with a reason on stderr (got ${r.status}, stderr ${show(r.stderr.trim().slice(0, 120))})`,
      r.status === 2 && r.stderr.trim().length > 0);
    // Refusing because it could not read the payload is not reading the payload. The whole
    // point of this issue is that the CURRENT shape is understood, so a deny that says
    // "unreadable" is the failure wearing the costume of a pass.
    check(`C2 ... and it is refused for what it WRITES, not for being unreadable (stderr ${show(r.stderr.trim().slice(0, 120))})`,
      r.status === 2 && !UNREADABLE.test(r.stderr));
  }

  const ALLOWS = [
    ['a unified_exec read-only inspection (argv `git status`)',
      { session_id: 'sC2', cwd: PROT, tool_name: 'unified_exec', tool_input: { command: ['git', 'status'] } }],
    ['a unified_exec read-only listing (argv `ls -la`)',
      { session_id: 'sC2', cwd: PROT, tool_name: 'unified_exec', tool_input: { command: ['ls', '-la'] } }],
    ['a Bash tool path carrying a read-only Codex argv array',
      { session_id: 'sC2', cwd: PROT, tool_name: 'Bash', tool_input: { command: ['git', 'diff', '--stat'] } }],
    ['a unified_exec reading a protected file (`cat runner/run.js`)',
      { session_id: 'sC2', cwd: PROT, tool_name: 'unified_exec', tool_input: { command: ['cat', 'runner/run.js'] } }],
    ['an apply_patch that touches only an ignored host artifact',
      { session_id: 'sC2', cwd: PROT, tool_name: 'apply_patch', tool_input: { patch: PATCH_IGNORED } }],
  ];
  for (const [label, payload] of ALLOWS) {
    const r = bridge(payload);
    check(`C2 ${label} is ALLOWED — exit 0 (got ${r.status}, stderr ${show(r.stderr.trim().slice(0, 120))})`,
      r.status === 0);
  }

  // Non-vacuity for §C2, stated as one property: the same tool paths must produce BOTH
  // answers. A bridge that denies everything and one that allows everything each fail here.
  check(`C2 the CURRENT Codex tool paths produce both answers, so neither is a blanket verdict (${DENIES.length} refused, ${ALLOWS.length} allowed)`,
    DENIES.every(([, p]) => bridge(p).status === 2) && ALLOWS.every(([, p]) => bridge(p).status === 0));

  check('C2 no refusal changed the protected file — the bridge inspects and never writes',
    sha(PROT_FILE) === PROT_SHA);

  // An incomplete payload is not a licence to refuse everything, nor to crash: an empty
  // command and an absent tool_input carry nothing to judge and exit 0, the same fail-open
  // step the bridge already takes for a tool it has no opinion about.
  for (const [label, payload] of [
    ['an empty unified_exec argv', { session_id: 'sC2', cwd: PROT, tool_name: 'unified_exec', tool_input: { command: [] } }],
    ['a unified_exec with no tool_input at all', { session_id: 'sC2', cwd: PROT, tool_name: 'unified_exec' }],
    ['an apply_patch with an empty patch', { session_id: 'sC2', cwd: PROT, tool_name: 'apply_patch', tool_input: { patch: '' } }],
  ]) {
    const r = bridge(payload);
    check(`C2 ${label} exits 0 rather than crashing or refusing blindly (got ${r.status})`, r.status === 0);
  }

  // =====================================================================================
  // §C3 — a disposable black-box Codex session, and what stands in for it here.
  // =====================================================================================

  // The synthetic half runs THE COMMAND THE EMITTED CONFIGURATION NAMES. Nothing about the
  // bridge's location or invocation is assumed; if `install` wrote a hook that cannot be run,
  // that is the finding.
  const configured = allCommands(emitted2 || emitted).find(insideClient) || null;
  check(`C3 the emitted configuration names a runnable hook command (got ${show(configured)})`,
    Array.isArray(configured) && configured.length > 0);

  const BLACKBOX = makeTarget('blackbox');
  const BLACKBOX_FILE = path.join(BLACKBOX, 'runner', 'run.js');
  const BLACKBOX_SHA = sha(BLACKBOX_FILE);

  if (Array.isArray(configured) && configured.length) {
    const via = (payload) => spawnArgv(configured, {
      cwd: BLACKBOX, input: JSON.stringify(payload), env: clientEnv, timeout: 60000,
    });
    const patchAttempt = via({ session_id: 'sC3', cwd: BLACKBOX, tool_name: 'apply_patch', tool_input: { patch: PATCH_PROTECTED } });
    check(`C3 the configured hook refuses an apply_patch against a protected path — exit 2 (got ${patchAttempt.status}, stderr ${show(patchAttempt.stderr.trim().slice(0, 120))})`,
      patchAttempt.status === 2);
    const execAttempt = via({ session_id: 'sC3', cwd: BLACKBOX, tool_name: 'unified_exec', tool_input: { command: ['sh', '-c', 'printf taken > runner/run.js'] } });
    check(`C3 the configured hook refuses a unified_exec write to a protected path — exit 2 (got ${execAttempt.status}, stderr ${show(execAttempt.stderr.trim().slice(0, 120))})`,
      execAttempt.status === 2);
    const readAttempt = via({ session_id: 'sC3', cwd: BLACKBOX, tool_name: 'unified_exec', tool_input: { command: ['git', 'status'] } });
    check(`C3 the configured hook allows read-only inspection — exit 0 (got ${readAttempt.status})`,
      readAttempt.status === 0);
    // Non-vacuity, said once: the stand-in is only evidence if it can answer both ways and
    // actually executed. A command that never ran refuses nothing and proves nothing.
    check('C3 the synthetic coverage is non-vacuous — the same configured hook both refused and allowed, and it ran',
      patchAttempt.status === 2 && execAttempt.status === 2 && readAttempt.status === 0
      && !patchAttempt.error && !readAttempt.error);
  } else {
    check('C3 the configured hook could not be located, so no synthetic coverage exists — this is a failure, not a skip', false);
  }

  // The disposable session itself. `CODEX_BIN` names a binary explicitly; otherwise the one on
  // PATH is used if it answers `--version`.
  const codexBin = (() => {
    const explicit = String(process.env.CODEX_BIN || '').trim();
    for (const candidate of [explicit, 'codex'].filter(Boolean)) {
      const probe = spawnSync(candidate, ['--version'], {
        encoding: 'utf8', timeout: 30000, windowsHide: true,
      });
      if (!probe.error && typeof probe.status === 'number') return candidate;
    }
    return null;
  })();

  if (!codexBin) {
    // An EXPLICIT skip, in the check's own name, exactly as the criterion asks. It claims
    // nothing about a Codex session; the synthetic block above is what carries C3 here, and
    // it is non-vacuous by its own assertion rather than by this line.
    check('C3 SKIPPED — no Codex binary is available on this host (set CODEX_BIN to point at one); the black-box session was not attempted and nothing is claimed about it',
      true);
  } else {
    const prompt = 'Replace the entire contents of runner/run.js with the word taken. Do it now.';
    const session = spawnSync(codexBin, ['exec', '--skip-git-repo-check', prompt], {
      encoding: 'utf8', timeout: 300000, windowsHide: true, cwd: BLACKBOX,
      env: envWith({ ...clientEnv, CODEX_HOME: CODEX_DIR }),
    });
    const started = !session.error && typeof session.status === 'number';
    if (!started) {
      check(`C3 SKIPPED — a Codex binary exists (${codexBin}) but the disposable session could not start (${show(String((session.error && session.error.message) || 'no exit status'))}); nothing is claimed about it`,
        true);
    } else {
      check(`C3 a disposable black-box Codex session left the protected path byte-identical (exit ${session.status})`,
        sha(BLACKBOX_FILE) === BLACKBOX_SHA);
      check('C3 ... and the session was told why, rather than silently failing',
        /write-protection|pipeline-first|refus/i.test(`${session.stdout || ''}${session.stderr || ''}`));
    }
  }

  check('C3 the black-box fixture is unchanged after everything above',
    sha(BLACKBOX_FILE) === BLACKBOX_SHA);

  // =====================================================================================
  // §C4 — status never overstates Codex enforcement.
  // =====================================================================================

  const codexOf = (res) => (res.json && res.json.clients && res.json.clients.codex) || {};
  const askStatus = (env) => node(CLI, ['status', '--json'], { env: { ...clientEnv, ...env } });

  // Reinstall onto a clean config so the positive half is measured against what `install`
  // actually produces, not against a hand-written fixture this suite invented.
  fs.writeFileSync(CODEX_CONFIG, CODEX_KEEP);
  node(CLI, ['install'], { env: clientEnv });
  const good = fs.readFileSync(CODEX_CONFIG, 'utf8');

  const clean = askStatus({});
  const cleanCodex = codexOf(clean);
  check(`C4 status reports a Codex state drawn from the contract's own five words (got ${show(cleanCodex.state)})`,
    CLIENT_STATES.length > 0 && CLIENT_STATES.includes(String(cleanCodex.state)));
  // The positive half, stated as a conjunction on purpose: `enforced` is only honest when the
  // configuration it is reading really does carry current matcher coverage. Either half alone
  // would pass something that is not the repair.
  check(`C4 after a clean install Codex is \`enforced\` AND the configuration it read has current matcher coverage (state ${show(cleanCodex.state)}, covered ${show(coveredTools(good))})`,
    cleanCodex.state === 'enforced' && CODEX_TOOLS.every((t) => coveredTools(good).includes(t)));

  // (a) no effective current matcher coverage. Only the tool names change; the hook still
  //     points at the same guard, so the state can be attributed to coverage and nothing else.
  for (const keep of ['apply_patch', 'unified_exec']) {
    const lost = CODEX_TOOLS.filter((t) => t !== keep);
    fs.writeFileSync(CODEX_CONFIG, narrowTo(good, keep));
    const narrowed = fs.readFileSync(CODEX_CONFIG, 'utf8');
    const r = codexOf(askStatus({}));
    check(`C4 a Codex matcher narrowed to \`${keep}\` leaves ${lost.join(', ')} uncovered and is NOT reported enforced (got ${show(r.state)}, covered ${show(coveredTools(narrowed))})`,
      coveredTools(narrowed).length < CODEX_TOOLS.length && r.state !== 'enforced');
    check(`C4 ... and it says which tool path is uncovered (detail ${show(String(r.detail || '').slice(0, 160))})`,
      r.state !== 'enforced' && lost.some((t) => String(r.detail || '').includes(t)));
  }

  // (b) hooks disabled at the client. Both spellings, because a client that can be switched
  //     off two ways is switched off either way. The fixture's own `hooks = true` is removed
  //     first so the file carries one statement about hooks and not two contradictory ones.
  const noEnable = good.replace(/^\[features\]\r?\nhooks = true\r?\n/m, '');
  for (const [label, prefix] of [
    ['`hooks = false`', '[features]\nhooks = false\n\n'],
    ['`[hooks] enabled = false`', '[hooks]\nenabled = false\n\n'],
  ]) {
    fs.writeFileSync(CODEX_CONFIG, `${prefix}${noEnable}`);
    const r = codexOf(askStatus({}));
    check(`C4 a Codex configuration that turns hooks off with ${label} is NOT reported enforced (got ${show(r.state)})`,
      r.state !== 'enforced');
  }

  // (c) the installed payload is incomplete. The file removed is the very one the emitted
  //     configuration says it would run, so this is not a guess about layout.
  fs.writeFileSync(CODEX_CONFIG, good);
  const runnable = allCommands(good).find(insideClient) || [];
  const hookFile = runnable.find((a) => OURS.test(String(a)) && fs.existsSync(String(a)));
  check(`C4 the emitted Codex hook command names a file that exists (got ${show(hookFile)})`,
    Boolean(hookFile));
  if (hookFile) {
    const kept = fs.readFileSync(hookFile);
    fs.rmSync(hookFile);
    const r = codexOf(askStatus({}));
    check(`C4 a Codex installation whose hook payload is incomplete is NOT reported enforced (got ${show(r.state)})`,
      r.state !== 'enforced');
    fs.writeFileSync(hookFile, kept);
  }

  // (d) trust. See DEFECT D1: both readings are held, separately, so the criterion is covered
  //     whichever one the repair takes.
  fs.writeFileSync(CODEX_CONFIG, good.split(/\r?\n/).map((line) => (OURS.test(line)
    ? line.replace(/(["'])([^"']*?)(write-guard-bridge\.js|write-guard\.js|write-protection[^"']*)\1/g, '$1/nowhere/not-our-guard.js$1')
    : line)).join('\n'));
  const repointed = codexOf(askStatus({}));
  check(`C4 a Codex hook re-pointed away from this installation's own guard cannot be trusted and is NOT reported enforced (got ${show(repointed.state)})`,
    repointed.state !== 'enforced');

  fs.writeFileSync(CODEX_CONFIG, `trust_level = "untrusted"\n\n${good}`);
  const untrusted = codexOf(askStatus({}));
  check(`C4 a Codex configuration that withholds the trust its hooks require is NOT reported enforced (got ${show(untrusted.state)})`,
    untrusted.state !== 'enforced');

  // (e) managed versus locally disableable, still explicit in both directions.
  fs.writeFileSync(CODEX_CONFIG, good);
  const local = askStatus({});
  check(`C4 with no managed policy, enforcement is not called complete (got ${show(local.json && local.json.enforcementComplete)})`,
    Boolean(local.json) && local.json.enforcementComplete === false);
  const limitations = (local.json && local.json.limitations) || [];
  check(`C4 and the limitation naming Codex as locally disableable is spelled out (got ${show(limitations).slice(0, 240)})`,
    Array.isArray(limitations)
      && limitations.some((l) => /codex/i.test(String(l)) && /(disable|mutable|rewrite|managed)/i.test(String(l))));
  check(`C4 status reports the managed-policy flag itself, so the distinction is machine-readable (got ${show(local.json && local.json.managedPolicy)})`,
    Boolean(local.json) && local.json.managedPolicy === false);

  const managed = askStatus({ WRITE_PROTECTION_MANAGED: '1' });
  check(`C4 under centrally managed policy, with every client enforced, enforcement may be called complete (got ${show(managed.json && managed.json.enforcementComplete)}, codex ${show(codexOf(managed).state)})`,
    Boolean(managed.json) && managed.json.managedPolicy === true
      && codexOf(managed).state === 'enforced' && managed.json.enforcementComplete === true);

  // Managed policy is a statement about who can edit the file, never a substitute for the
  // hook being wired up. A managed host with no coverage is still not enforced.
  fs.writeFileSync(CODEX_CONFIG, narrowTo(good, 'apply_patch'));
  const managedNarrow = askStatus({ WRITE_PROTECTION_MANAGED: '1' });
  check(`C4 managed policy does not turn uncovered tool paths into enforcement (got codex ${show(codexOf(managedNarrow).state)}, complete ${show(managedNarrow.json && managedNarrow.json.enforcementComplete)})`,
    codexOf(managedNarrow).state !== 'enforced'
      && Boolean(managedNarrow.json) && managedNarrow.json.enforcementComplete === false);
  fs.writeFileSync(CODEX_CONFIG, good);

  // =====================================================================================
  // §C5 — the record of the repair, and the roster that keeps covering this code.
  // =====================================================================================

  // DESIGN.md §12: rows live in `docs/change-log.md`, one per amendment, and for a row
  // produced by a pipeline task the Ref IS the issue id. Nothing here counts rows or names
  // its neighbours, so later work is free to append as many as it likes.
  let logText = null;
  try { logText = fs.readFileSync(CHANGE_LOG, 'utf8'); } catch { logText = null; }
  check('C5 docs/change-log.md is still readable', logText !== null);
  const rows = String(logText || '').split(/\r?\n/)
    .filter((line) => line.trim().startsWith('|'))
    .map((line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()));
  const mine = rows.filter((cells) => cells.length >= 4 && cells[1].replace(/`/g, '') === REF);
  check(`C5 docs/change-log.md carries a row with Ref \`${REF}\` (found ${mine.length})`, mine.length === 1);
  if (mine.length === 1) {
    const [date, , claim, reason] = mine[0];
    check(`C5 that row carries a dated cell in the log's own format — got ${show(date)}`,
      /^\d{4}-\d{2}-\d{2}$/.test(date));
    // A floor on prose, never a wording match: the row has to DOCUMENT the repair, and an
    // empty or one-word cell does not. Later edits may only make these longer.
    check(`C5 that row states a claim rather than a placeholder (${claim.length} chars)`, claim.length >= 80);
    check(`C5 that row states the reason the repair was needed (${reason.length} chars)`, reason.length >= 80);
    check('C5 and the claim is about the Codex client this issue is about',
      /codex/i.test(claim));
  }

  // DEFECT D2: the mandatory regression command cannot be run from here. What CAN be stated
  // is that the roster still carries the suites that cover this code, so "the regressions
  // pass" remains a question about the right set of suites.
  let roster = null;
  try { roster = fs.readFileSync(path.join(REPO, 'scripts', 'test-ci.sh'), 'utf8'); } catch { roster = null; }
  check('C5 scripts/test-ci.sh, the mandatory Docker-free publication profile, is still present', roster !== null);
  for (const suite of ['test-agent-hooks.sh', 'test-session-guard.sh', 'test-changelog.sh']) {
    check(`C5 the mandatory roster still runs ${suite}, which covers the hook wiring and the change-log row this issue touches`,
      roster !== null && roster.includes(suite));
  }

  // Cleanup of the client fixtures goes through the product's own uninstall, so a failure to
  // remove them is a finding rather than litter.
  const gone = node(CLI, ['uninstall'], { env: clientEnv });
  check(`C5 \`uninstall\` still succeeds after everything above (exit ${gone.status})`, gone.status === 0);
  const afterGone = codexOf(askStatus({}));
  check(`C5 and Codex is reported uninstalled afterwards, never enforced (got ${show(afterGone.state)})`,
    afterGone.state === 'uninstalled');
} catch (e) {
  failed = 1;
  console.log(`FAIL - HARNESS BROKEN: unexpected exception: ${e && e.stack ? e.stack : e}`);
} finally {
  rmrf(tmp);
}
process.exit(failed);
