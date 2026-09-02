// Frozen acceptance test — repo-gy3: emit the Codex hook command as a TOML STRING and prove a
// full configuration load. This is the RED half; `guard.js` beside it carries the clauses that
// are already green at the fork point and must stay that way.
//
// The Beads issue is canonical, not the planning draft that produced it, and not the
// neighbouring `repo-ak5` / `repo-l2w` suites — two tasks in this batch were built against a
// draft the issue had moved past. Where they disagree the issue wins. The one place this suite
// deliberately goes FURTHER than `repo-ak5` is named in C1 below: `repo-ak5` left "whether a
// command is written as a string or an argv array" explicitly free, and this issue closes it.
//
// Plain Node, Docker-free, node built-ins plus `git` — a task container has both and neither a
// Docker daemon nor a network.
//
// ── PAIRING ───────────────────────────────────────────────────────────────────────────────
// Every criterion names the section that proves it, and every check below names the criterion
// it serves in its own label. No orphan on either side.
//
//   C1  §C1  `install` emits `[[hooks.PreToolUse.hooks]]` handlers carrying `type = "command"`
//            and a `command` / `command_windows` written as a TOML STRING — never an array —
//            naming the exact installed bridge, and that string actually runs.
//   C2  §C2  `codex status` reports the PR #81 array form `degraded`, and reports `enforced`
//            only when every handler of ours is an effective STRING handler naming this
//            installation's exact bridge.
//   C3  §C3  a normal trusted Codex session with no hook-trust bypass loads the generated
//            profile, attempts `apply_patch` on `runner/run.js`, is refused in
//            write-protection's own words, exits without a configuration error, and leaves the
//            file hash and `git status` unchanged — attempted where a Codex exists and
//            EXPLICITLY skipped where none does, with deterministic profile-parsing and bridge-
//            dispatch coverage asserted non-vacuous either way.
//   C4  §C4  protected `Bash` and `apply_patch` writes are denied and read-only `Bash`
//            inspection is allowed in the CURRENT Codex dialect, and the mandatory-regression
//            roster still names the suites that cover this code.  C4's "read-only Bash
//            inspection REMAINS allowed", "legacy bridge payloads REMAIN compatible" and
//            "Claude tests pass" clauses are proven by `guard.js`: they are statements about
//            what did NOT change and are green at the fork point by construction.
//   C5  §C5  the documentation and the change log explicitly correct `repo-ak5` and PR #81.
//            C5's "existing frozen suites remain untouched" clause is proven by `guard.js`,
//            for the same reason as C4's.
//
// ── THE FROZEN INTERFACE ──────────────────────────────────────────────────────────────────
//
// scripts/write-protection.js       `install`, `uninstall` and `status [--json]`, with the
//   client directories aimed by `WRITE_PROTECTION_CLAUDE_DIR` / `WRITE_PROTECTION_CODEX_DIR`
//   and host records by `WRITE_PROTECTION_HOST_STATE_DIR` — the seams repo-324 already froze.
//   `status --json` answers {"clients":{"codex":{"state":<one of contracts/
//   write-protection.json `clientStates`>,"detail":…},"claude":{…}}, …}.
//
// scripts/write-guard-bridge.js     the host-side hook translator. One JSON payload on stdin,
//   exit 0 to allow and exit 2 to refuse with a reason on stderr. The CURRENT Codex payload
//   puts the command in the same place for both tool paths, which is what `repo-ak5` froze and
//   this issue does not reopen:
//       {"session_id":…,"cwd":…,"tool_name":"Bash","tool_input":{"command":[argv]}}
//       {"session_id":…,"cwd":…,"tool_name":"apply_patch","tool_input":{"command":[argv]}}
//
// WHAT IS FROZEN ABOUT THE TOML, AND WHAT IS NOT. The criterion quotes a table path and a value
// KIND: `[[hooks.PreToolUse.hooks]]`, `type = command`, and a command that is a string. Those
// are held literally, because that is what the issue is about. Indentation, key order, comment
// and sentinel wording, single versus double quotes, and which of `command` /
// `command_windows` is emitted are all left free — `parseToml()` below reads any of them.
//
// ── SPEC DEFECTS, REPORTED RATHER THAN PAPERED OVER ───────────────────────────────────────
//
// D1. C4's "every mandatory regression pass" cannot be honestly claimed by any acceptance suite
//     in this project. `scripts/test-ci.sh` and every `scripts/test-*.sh` are frozen paths, and
//     a frozen suite that shells into a frozen script asserts through a file it may never
//     adjust. §C4 therefore proves the part that is a fact about the tree — the roster still
//     names the suites that cover this code — and `guard.js` pins the invariants those suites
//     enforce. "The full configured regression command is green" stays a pipeline-level gate.
//     Same boundary `tests/acceptance/repo-ak5/test.js` and `repo-yk4/test.js` drew.
//
// D2. C2 calls the PR #81 form "the array form", but PR #81 differs from the required shape in
//     TWO ways at once: the command is an argv array AND it sits under `[[hooks.apply_patch]]` /
//     `[[hooks.unified_exec]]` rather than under a `hooks.PreToolUse` matcher group. A reading
//     in which that configuration is honestly `uninstalled` — no PreToolUse handler of ours is
//     there at all — is defensible, and the criterion rules it out by naming `degraded`. §C2
//     holds `degraded` for it, because the issue is canonical, and separately holds the pure
//     array-vs-string difference by arrayifying what `install` itself emitted, so a repair that
//     reads the clause the narrow way still has a check that holds it.
//
// D3. Neither C1 nor C2 names any tool path, while `contracts/write-protection.json` declares
//     `apply_patch` and `unified_exec` for this client and the frozen `repo-ak5` suite requires
//     `Bash` and `apply_patch`. Rather than pick, §C1 and §C2 ask about EVERY nested handler
//     that is ours, whatever it matches, and require `enforced` to coincide with coverage of
//     whatever the CONTRACT in the tree declares at the time it runs. A repair may satisfy that
//     by covering `unified_exec` too or by correcting the contract; both stay open, and only
//     leaving the two documents contradicting each other is ruled out.
//
// D4. C3 asks for "exits without a configuration error", which is an observation about a real
//     Codex process, and in the same breath allows environments without Codex to skip the host
//     half. What survives the skip is asserted here rather than assumed: that the generated
//     profile is well-formed enough to load — every line a header or an assignment, no table
//     defined twice, no key assigned twice in one table — and that the command the profile
//     names dispatches through the bridge to a refusal and to an allow. That is the strongest
//     honest stand-in, and it is labelled as one.
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
const REF = 'repo-gy3';
const CORRECTED_REF = 'repo-ak5';
const CORRECTED_PR = 81;

const TOOL_BASH = 'Bash';
const TOOL_PATCH = 'apply_patch';

let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) failed = 1;
  return Boolean(cond);
}
const show = (v) => JSON.stringify(v);

// Non-vacuity bookkeeping for §C3: how much deterministic evidence actually accumulated, so a
// skipped Codex session cannot leave the suite proving nothing.
const seen = { structural: 0, parsed: 0, dispatch: 0, denied: 0, allowed: 0 };

// ---------------------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-gy3-'));
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
// that §C1's "executable" clause and §C3's deterministic dispatch exercise the wiring itself
// rather than a restatement of it.
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
const gitStatus = (dir) => {
  const r = git(dir, ['status', '--porcelain']);
  return r.status === 0 ? String(r.stdout || '') : `<git status failed: ${String(r.stderr || '').trim()}>`;
};

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
const posix = (p) => String(p).split(path.sep).join('/');

// ---------------------------------------------------------------------------------------
// the fixture target — a throwaway pipeline-first checkout, never this one
// ---------------------------------------------------------------------------------------

const FIXTURE_FILES = {
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
// a small TOML reader — enough of it, and no more
// ---------------------------------------------------------------------------------------
// It knows table headers, array-of-table headers, dotted and quoted keys, strings, booleans,
// integers, arrays and inline tables, and it keeps a value's KIND: a quoted scalar comes back
// as a JavaScript string and a bracketed list as a JavaScript array. That distinction is the
// whole of C1, so it is read here rather than pattern-matched out of the raw text alone.

function stripComment(line) {
  let out = '';
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      out += ch;
      if (ch === '\\' && quote === '"') { out += line[i + 1] || ''; i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; out += ch; continue; }
    if (ch === '#') break;
    out += ch;
  }
  return out;
}

function bracketDepth(s) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quote) {
      if (ch === '\\' && quote === '"') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '[' || ch === '{') depth += 1;
    else if (ch === ']' || ch === '}') depth -= 1;
  }
  return depth;
}

// A value may span lines. A table header never does, and is balanced, so joining on an unclosed
// bracket cannot swallow one.
function logicalLines(text) {
  const raw = String(text || '').split(/\r?\n/).map(stripComment);
  const out = [];
  for (let i = 0; i < raw.length; i += 1) {
    let line = raw[i].trim();
    if (!line) continue;
    while (bracketDepth(line) > 0 && i + 1 < raw.length) { i += 1; line += ` ${raw[i].trim()}`; }
    out.push(line);
  }
  return out;
}

function splitKeyPath(src) {
  const segs = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '.') { segs.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  segs.push(cur.trim());
  return segs.filter((s) => s.length);
}

function parseValue(src, start) {
  let i = start;
  while (i < src.length && /\s/.test(src[i])) i += 1;
  const ch = src[i];
  if (ch === '"' || ch === "'") {
    const quote = ch;
    let out = '';
    i += 1;
    while (i < src.length) {
      const c = src[i];
      if (quote === '"' && c === '\\') {
        const nxt = src[i + 1] || '';
        out += nxt === 'n' ? '\n' : nxt;
        i += 2;
        continue;
      }
      if (c === quote) { i += 1; break; }
      out += c;
      i += 1;
    }
    return { value: out, i };
  }
  if (ch === '[') {
    const arr = [];
    i += 1;
    for (;;) {
      while (i < src.length && /[\s,]/.test(src[i])) i += 1;
      if (i >= src.length || src[i] === ']') { i += 1; break; }
      const r = parseValue(src, i);
      arr.push(r.value);
      i = r.i;
    }
    return { value: arr, i };
  }
  if (ch === '{') {
    const obj = {};
    i += 1;
    for (;;) {
      while (i < src.length && /[\s,]/.test(src[i])) i += 1;
      if (i >= src.length || src[i] === '}') { i += 1; break; }
      let key = '';
      if (src[i] === '"' || src[i] === "'") { const r = parseValue(src, i); key = r.value; i = r.i; }
      else { while (i < src.length && !/[=\s]/.test(src[i])) { key += src[i]; i += 1; } }
      while (i < src.length && /\s/.test(src[i])) i += 1;
      if (src[i] === '=') i += 1;
      const r = parseValue(src, i);
      assignPath(obj, splitKeyPath(key), r.value);
      i = r.i;
    }
    return { value: obj, i };
  }
  let tok = '';
  while (i < src.length && !/[,\]}]/.test(src[i])) { tok += src[i]; i += 1; }
  tok = tok.trim();
  if (tok === 'true') return { value: true, i };
  if (tok === 'false') return { value: false, i };
  if (/^-?\d+$/.test(tok)) return { value: Number(tok), i };
  return { value: tok, i };
}

function descend(root, segs) {
  let node2 = root;
  for (const seg of segs) {
    if (!node2[seg] || typeof node2[seg] !== 'object') node2[seg] = {};
    if (Array.isArray(node2[seg])) {
      if (!node2[seg].length) node2[seg].push({});
      node2 = node2[seg][node2[seg].length - 1];
    } else node2 = node2[seg];
  }
  return node2;
}

function assignPath(table, segs, value) {
  if (!segs.length) return;
  const holder = descend(table, segs.slice(0, -1));
  holder[segs[segs.length - 1]] = value;
}

// The first `=` that is not inside a string or a bracket.
function splitAssign(line) {
  let quote = null;
  let depth = 0;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === '\\' && quote === '"') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '[' || ch === '{') depth += 1;
    else if (ch === ']' || ch === '}') depth -= 1;
    else if (ch === '=' && depth === 0) return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
  }
  return null;
}

const HEADER_RE = /^\[\[?(.+?)\]\]?$/;

function parseToml(text) {
  const root = {};
  let table = root;
  for (const line of logicalLines(text)) {
    const arrayHeader = /^\[\[(.+)\]\]$/.exec(line);
    const tableHeader = arrayHeader ? null : /^\[(.+)\]$/.exec(line);
    if (arrayHeader || tableHeader) {
      const segs = splitKeyPath((arrayHeader || tableHeader)[1].trim());
      if (!segs.length) { table = root; continue; }
      const holder = descend(root, segs.slice(0, -1));
      const last = segs[segs.length - 1];
      if (arrayHeader) {
        if (!Array.isArray(holder[last])) holder[last] = [];
        const fresh = {};
        holder[last].push(fresh);
        table = fresh;
      } else if (Array.isArray(holder[last])) {
        if (!holder[last].length) holder[last].push({});
        table = holder[last][holder[last].length - 1];
      } else {
        if (!holder[last] || typeof holder[last] !== 'object') holder[last] = {};
        table = holder[last];
      }
      continue;
    }
    const kv = splitAssign(line);
    if (!kv) continue;
    assignPath(table, splitKeyPath(kv[0]), parseValue(kv[1], 0).value);
  }
  return root;
}

// ---------------------------------------------------------------------------------------
// what the criterion means by a handler, a string command, and "the exact installed bridge"
// ---------------------------------------------------------------------------------------

const asList = (v) => (Array.isArray(v) ? v : (v === undefined || v === null ? [] : [v]));

// `hooks.PreToolUse`, however it was spelled — one table, an array of tables, or an inline
// array of inline tables.
function preToolUseGroups(cfg) {
  const hooks = cfg && cfg.hooks;
  if (!hooks || typeof hooks !== 'object') return [];
  return asList(hooks.PreToolUse).filter((g) => g && typeof g === 'object' && !Array.isArray(g));
}

// The NESTED handler list of a matcher group: `hooks.PreToolUse.hooks`.
const nestedHandlers = (group) => asList(group && group.hooks)
  .filter((h) => h && typeof h === 'object' && !Array.isArray(h));

// Tokenise a command however it was written. An argv array is already tokens; a command LINE is
// split on whitespace outside quotes. Used to answer "which file does this command run" and to
// spawn it, never to decide whether it was a string in the first place — that question is asked
// of the parsed KIND, below.
function normalizeArgv(value) {
  if (Array.isArray(value)) return value.map(String).filter((s) => s.length);
  const one = String(value === undefined || value === null ? '' : value).trim();
  if (!one) return [];
  return (one.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((t) => t.replace(/^["']|["']$/g, ''));
}

// The command keys a handler actually declares, with their PARSED values, so a string and an
// array are distinguishable. `command_windows` is the platform-specific spelling C1 allows.
const COMMAND_KEYS = ['command', 'command_windows'];
function commandEntries(handler) {
  const out = [];
  for (const key of COMMAND_KEYS) {
    const value = handler && handler[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) ? value.length === 0 : String(value).trim() === '') continue;
    out.push({ key, value });
  }
  return out;
}
const declaresACommand = (h) => commandEntries(h).length > 0;
const isTomlString = (v) => typeof v === 'string' && v.trim().length > 0;
const everyCommandIsAString = (h) => declaresACommand(h)
  && commandEntries(h).every((e) => isTomlString(e.value));

// `command_windows` where this platform would use it, `command` otherwise — the one a Codex on
// THIS host would actually run.
function effectiveCommandValue(handler) {
  const entries = commandEntries(handler);
  if (!entries.length) return null;
  const win = entries.find((e) => e.key === 'command_windows');
  const gen = entries.find((e) => e.key === 'command');
  if (process.platform === 'win32' && win) return win.value;
  return (gen || win).value;
}
const handlerArgv = (handler) => normalizeArgv(effectiveCommandValue(handler));

// Whose handler is this? Loosely — any command on it that looks like this project's guard.
// Deliberately looser than every property the criteria ask about, because the checks that ask
// about `type`, about string-ness and about the bridge's identity have to be able to FAIL on a
// handler that is ours; if being ours already required passing them, they would prove nothing.
const OURS = /write-guard|write-protection/;
const mentionsOurs = (value) => normalizeArgv(value).some((a) => OURS.test(posix(String(a))));
const handlerIsOurs = (h) => commandEntries(h).some((e) => mentionsOurs(e.value));
const ourHandlers = (cfg) => preToolUseGroups(cfg).flatMap(nestedHandlers).filter(handlerIsOurs);

// The same coverage rule the Claude half of `write-protection.js` already applies: `*` covers
// everything, an alternation covers what it lists, and anything else is tried as a whole-name
// regular expression.
function matcherCovers(matcher, tool) {
  const raw = String(matcher === undefined || matcher === null ? '' : matcher).trim();
  if (!raw) return false;
  if (raw === '*') return true;
  if (raw.split(/[|,]/).map((s) => s.trim()).some((s) => s === tool || s === '*')) return true;
  try { return new RegExp(`^(?:${raw})$`).test(tool); } catch { return false; }
}
const groupMatchers = (g) => [...asList(g && g.matcher), ...asList(g && g.matchers), ...asList(g && g.tools)]
  .map((m) => String(m));
const groupCovers = (g, tool) => groupMatchers(g).some((m) => matcherCovers(m, tool));

// "the exact installed bridge": a token of the command that names a file which EXISTS, lies
// inside this client's own Codex configuration directory, and is byte-identical to the bridge
// in this checkout. Two computed digests, never a literal — a legitimate later edit to the
// bridge must not turn this red.
function namesExactBridge(argv, codexDir, bridgeSha) {
  const root = `${posix(codexDir).replace(/\/+$/, '')}/`.toLowerCase();
  return argv.some((a) => {
    const p = posix(String(a));
    if (!p.toLowerCase().startsWith(root)) return false;
    const digest = sha(String(a));
    return Boolean(digest) && digest === bridgeSha;
  });
}

// An EFFECTIVE STRING HANDLER, in C2's words: nested, typed `command`, every command key it
// declares written as a TOML string, and running the exact installed bridge.
const isEffectiveStringHandler = (h, codexDir, bridgeSha) => String((h && h.type) || '') === 'command'
  && everyCommandIsAString(h)
  && namesExactBridge(handlerArgv(h), codexDir, bridgeSha);

const effectiveStringGroups = (cfg, codexDir, bridgeSha) => preToolUseGroups(cfg)
  .filter((g) => nestedHandlers(g).some((h) => isEffectiveStringHandler(h, codexDir, bridgeSha)));

function coveredTools(text, codexDir, bridgeSha, tools) {
  const groups = effectiveStringGroups(parseToml(text), codexDir, bridgeSha);
  return tools.filter((t) => groups.some((g) => groupCovers(g, t)));
}

// Every command assignment anywhere in the file, as RAW TEXT next to its parsed value. C1 is a
// statement about how a value is WRITTEN, so it is asked of the text as well as of the parse.
function commandAssignments(text) {
  const out = [];
  for (const line of logicalLines(text)) {
    const kv = splitAssign(line);
    if (!kv) continue;
    const key = splitKeyPath(kv[0]).pop();
    if (!COMMAND_KEYS.includes(String(key))) continue;
    out.push({ key: String(key), raw: kv[1].trim(), value: parseValue(kv[1], 0).value });
  }
  return out;
}

// Any command anywhere in the file, whatever table it sits under — used where the question is
// "what would this configuration run", independent of how the groups are shaped.
function allArgvs(cfg) {
  const out = [];
  const walk = (n) => {
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (!n || typeof n !== 'object') return;
    const argv = handlerArgv(n);
    if (argv.length) out.push(argv);
    for (const v of Object.values(n)) walk(v);
  };
  walk(cfg);
  return out;
}

// The installed copy of the bridge, found by digest rather than by assuming a layout: whichever
// file under the client's Codex directory is byte-identical to this checkout's bridge.
function findInstalledBridge(codexDir, bridgeSha) {
  const stack = [codexDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { entries = []; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      if (sha(p) === bridgeSha) return p;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// line-level surgery, used ONLY to build §C2's negative cases out of what install emitted
// ---------------------------------------------------------------------------------------
// Each mutation asserts its own precondition where it is used, so a mutation that did not bite
// is reported as a failure to construct the case rather than passed off as a status result.

// Rewrite OUR string commands as argv arrays and change nothing else — the pure array-vs-string
// difference, with the table path, the matcher, the type and the bridge all left alone.
function arrayifyOurCommands(text) {
  return String(text).split(/\r?\n/).map((line) => {
    const bare = stripComment(line).trim();
    const kv = splitAssign(bare);
    if (!kv || HEADER_RE.test(bare)) return line;
    const key = String(splitKeyPath(kv[0]).pop());
    if (!COMMAND_KEYS.includes(key)) return line;
    const value = parseValue(kv[1], 0).value;
    if (!isTomlString(value) || !mentionsOurs(value)) return line;
    const indent = /^\s*/.exec(line)[0];
    return `${indent}${key} = ${JSON.stringify(normalizeArgv(value))}`;
  }).join('\n');
}

function dropTypeKeys(text) {
  return String(text).split(/\r?\n/).filter((line) => {
    const bare = stripComment(line).trim();
    const kv = splitAssign(bare);
    return !(kv && !HEADER_RE.test(bare) && String(splitKeyPath(kv[0]).pop()) === 'type');
  }).join('\n');
}

function repointCommands(text, from, to) {
  const needle = posix(from);
  return String(text).split(/\r?\n/)
    .map((line) => line.split(needle).join(posix(to)).split(from).join(posix(to)))
    .join('\n');
}

// The shape PR #81 shipped, rebuilt around whatever bridge THIS install actually put in place:
// per-tool array-of-tables under `hooks.<tool>`, an argv ARRAY command, and the sentinel
// comments that installation wrote around it. Written out literally because it is history — the
// emitter that produced it is exactly what this issue replaces.
function pr81Block(bridgePath) {
  const p = posix(bridgePath);
  return [
    '# BEGIN WRITE PROTECTION (multi-agent-pipelines)',
    '# Installed by node scripts/write-protection.js install — remove with `uninstall`.',
    '[[hooks.apply_patch]]',
    `command = ["node", "${p}"]`,
    '',
    '[[hooks.unified_exec]]',
    `command = ["node", "${p}"]`,
    '# END WRITE PROTECTION (multi-agent-pipelines)',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------------------
// the payloads
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

// The refusal sentence the bridge prints when it could not READ a request. A well-formed
// payload that gets this answer was not parsed, so a deny for this reason does not prove the
// payload was understood.
const UNREADABLE = /could not be read well enough|names no files this guard can read/;
// The refusal text this project puts in front of a model. Not a wording match on the whole
// sentence — the first word of it, which is the product's own name for what just happened.
const REFUSAL = /write-protection:/i;
// What a Codex says when it could not LOAD its profile, as opposed to when a hook refused a
// tool call. C3 requires the session to exit without one of these.
const CONFIG_ERROR = /(failed to (parse|load|read)[^\n]{0,40}config)|(config(uration)?[^\n]{0,20}(error|invalid|malformed))|(invalid[^\n]{0,20}config)|(error[^\n]{0,30}config\.toml)/i;

try {
  check('C1 scripts/write-protection.js is still present', fs.existsSync(CLI));
  check('C4 scripts/write-guard-bridge.js is still present', fs.existsSync(BRIDGE));
  const BRIDGE_SHA = sha(BRIDGE);
  check('C1 the bridge in this checkout could be hashed, so "the exact installed bridge" is a question with an answer',
    Boolean(BRIDGE_SHA));

  let contract = null;
  try { contract = JSON.parse(fs.readFileSync(CONTRACT, 'utf8')); } catch { contract = null; }
  const contractCodexTools = (contract && contract.clients && contract.clients.codex
    && Array.isArray(contract.clients.codex.toolPaths)) ? contract.clients.codex.toolPaths.map(String) : [];
  const CLIENT_STATES = (contract && Array.isArray(contract.clientStates))
    ? contract.clientStates.map(String) : [];
  check(`C2 contracts/write-protection.json still declares this client's tool paths and the status vocabulary (tools ${show(contractCodexTools)}, states ${show(CLIENT_STATES)})`,
    contractCodexTools.length > 0 && CLIENT_STATES.includes('degraded') && CLIENT_STATES.includes('enforced'));

  const PROT = makeTarget('target');
  const PROT_FILE = path.join(PROT, 'runner', 'run.js');
  const PROT_SHA = sha(PROT_FILE);

  const CLAUDE_DIR = path.join(tmp, 'client-claude');
  const CODEX_DIR = path.join(tmp, 'client-codex');
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  fs.mkdirSync(CODEX_DIR, { recursive: true });
  const CODEX_CONFIG = path.join(CODEX_DIR, 'config.toml');
  const clientEnv = { WRITE_PROTECTION_CLAUDE_DIR: CLAUDE_DIR, WRITE_PROTECTION_CODEX_DIR: CODEX_DIR };

  // =====================================================================================
  // §C1 — install emits [[hooks.PreToolUse.hooks]] handlers whose command is a TOML STRING.
  // =====================================================================================

  // Configuration that is NOT ours and must survive untouched: an unrelated setting and
  // somebody else's PreToolUse handler, written with an ARGV ARRAY command on purpose. C1
  // constrains what THIS installer emits, not what other people wrote, so a repair that
  // rewrote every array in the file to satisfy it would be caught here.
  const FOREIGN_CMD = '/opt/somebody-elses/checker.js';
  const CODEX_KEEP = [
    '[unrelated]',
    'keep_me = "yes"',
    '',
    '[[hooks.PreToolUse]]',
    'matcher = "^Read$"',
    '',
    '[[hooks.PreToolUse.hooks]]',
    'type = "command"',
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
  const cfg = parseToml(emitted);
  const mine = ourHandlers(cfg);

  if (check(`C1 the emitted Codex configuration carries nested hooks.PreToolUse.hooks handlers of ours (found ${mine.length}; file starts ${show(emitted.slice(0, 200))})`,
    mine.length > 0)) seen.structural += 1;

  // The literal spelling the criterion quotes. Held separately from the structural check above
  // so that a repair which parses the same but spells it another way fails ONE check with a
  // name that says exactly what it did, rather than a wall of them.
  if (check(`C1 and it spells them with the \`[[hooks.PreToolUse.hooks]]\` array-of-tables header the criterion names (headers ${show(logicalLines(emitted).filter((l) => /^\[\[/.test(l)).slice(0, 8))})`,
    logicalLines(emitted).some((l) => {
      const m = /^\[\[(.+)\]\]$/.exec(l);
      return Boolean(m) && splitKeyPath(m[1]).join('.') === 'hooks.PreToolUse.hooks';
    }))) seen.structural += 1;

  if (check(`C1 every nested handler of ours declares \`type = "command"\` (types ${show(mine.map((h) => h.type))})`,
    mine.length > 0 && mine.every((h) => String(h.type || '') === 'command'))) seen.structural += 1;

  if (check(`C1 every nested handler of ours names a \`command\` or a \`command_windows\` (keys ${show(mine.map((h) => commandEntries(h).map((e) => e.key)))})`,
    mine.length > 0 && mine.every(declaresACommand))) seen.structural += 1;

  // THE HEADLINE. Asked of the parsed value's KIND: a quoted TOML scalar reads back as a
  // JavaScript string, a bracketed list as a JavaScript array. `repo-ak5` left this free and
  // this issue closes it, so nothing about the rest of the shape can substitute for it.
  const kinds = mine.flatMap((h) => commandEntries(h).map((e) => [e.key, Array.isArray(e.value) ? 'array' : typeof e.value]));
  if (check(`C1 EVERY command / command_windows on our nested handlers is a TOML STRING and none is an array (kinds ${show(kinds)})`,
    mine.length > 0 && mine.every(everyCommandIsAString))) seen.structural += 1;

  // ... and the same statement made against the raw text, so a value that merely parses as a
  // string cannot pass for one that was written as a string.
  const oursWritten = commandAssignments(emitted).filter((a) => mentionsOurs(a.value));
  if (check(`C1 and every command assignment naming this project's bridge is WRITTEN as a quoted string, never as a bracketed list (raw ${show(oursWritten.map((a) => a.raw.slice(0, 80)))})`,
    oursWritten.length > 0 && oursWritten.every((a) => /^["']/.test(a.raw) && !a.raw.startsWith('[')))) seen.structural += 1;

  if (check('C1 the string command on every nested handler of ours names the EXACT installed bridge — inside this client\'s own configuration directory and byte-identical to scripts/write-guard-bridge.js',
    mine.length > 0 && mine.every((h) => namesExactBridge(handlerArgv(h), CODEX_DIR, BRIDGE_SHA)))) seen.structural += 1;

  // "a TOML string" is only worth anything if the string RUNS. Tokenise it the way a shell
  // would and spawn it, with the payload that must be allowed, so this cannot pass by refusing.
  const stringHandler = mine.find((h) => everyCommandIsAString(h)
    && namesExactBridge(handlerArgv(h), CODEX_DIR, BRIDGE_SHA)) || null;
  const stringCommand = stringHandler ? effectiveCommandValue(stringHandler) : null;
  if (check(`C1 the emitted configuration names a string hook command this suite can run (got ${show(stringCommand)})`,
    isTomlString(stringCommand))) seen.structural += 1;
  if (isTomlString(stringCommand)) {
    const smoke = spawnArgv(normalizeArgv(stringCommand), {
      cwd: PROT, env: clientEnv, timeout: 60000,
      input: JSON.stringify({ session_id: 'sC1', cwd: PROT, tool_name: TOOL_BASH, tool_input: { command: ['git', 'status'] } }),
    });
    if (check(`C1 that string command is executable — it ran and allowed a read-only inspection (exit ${smoke.status}, spawn error ${show(smoke.error && smoke.error.message)})`,
      !smoke.error && smoke.status === 0)) seen.structural += 1;
  }

  // Nothing unrelated was clobbered, and in particular somebody else's ARRAY command was not
  // rewritten to satisfy a rule that is about ours.
  check('C1 the unrelated Codex setting survived install', emitted.includes('keep_me = "yes"'));
  check(`C1 somebody else's PreToolUse handler survived install with its argv ARRAY command intact (commands ${show(allArgvs(cfg)).slice(0, 300)})`,
    preToolUseGroups(cfg).flatMap(nestedHandlers)
      .some((h) => !handlerIsOurs(h) && Array.isArray(h.command) && h.command.map(String).includes(FOREIGN_CMD)));

  // Installing twice is how an operator upgrades. It must replace our handlers, not stack them,
  // and must not quietly regress to an array on the second pass.
  const reinstall = node(CLI, ['install'], { env: clientEnv });
  let emitted2 = '';
  try { emitted2 = fs.readFileSync(CODEX_CONFIG, 'utf8'); } catch { emitted2 = ''; }
  const mine2 = ourHandlers(parseToml(emitted2));
  check(`C1 re-installing does not stack a second copy of our handlers (found ${mine2.length}, first install had ${mine.length})`,
    reinstall.status === 0 && mine2.length > 0 && mine2.length === mine.length);
  check('C1 re-installing still emits every command of ours as a TOML string',
    mine2.length > 0 && mine2.every(everyCommandIsAString));

  // =====================================================================================
  // §C2 — status: the PR #81 array form is degraded, and `enforced` belongs only to
  //       effective STRING handlers naming this installation's exact bridge.
  // =====================================================================================

  const codexOf = (res) => (res.json && res.json.clients && res.json.clients.codex) || {};
  const askStatus = () => node(CLI, ['status', '--json'], { env: clientEnv });

  // Reinstall onto a clean config so the positive half is measured against what `install`
  // actually produces, not against a hand-written fixture this suite invented.
  fs.writeFileSync(CODEX_CONFIG, CODEX_KEEP);
  node(CLI, ['install'], { env: clientEnv });
  const good = fs.readFileSync(CODEX_CONFIG, 'utf8');
  const INSTALLED_BRIDGE = findInstalledBridge(CODEX_DIR, BRIDGE_SHA);
  check(`C2 the installation put a byte-identical copy of the bridge inside the Codex configuration directory, so "the exact installed bridge" can be pointed at (got ${show(INSTALLED_BRIDGE && posix(INSTALLED_BRIDGE))})`,
    Boolean(INSTALLED_BRIDGE));

  const clean = codexOf(askStatus());
  check(`C2 status reports a Codex state drawn from the contract's own vocabulary (got ${show(clean.state)}, allowed ${show(CLIENT_STATES)})`,
    CLIENT_STATES.length > 0 && CLIENT_STATES.includes(String(clean.state)));

  // The positive half, stated as a conjunction on purpose: `enforced` is only honest when the
  // configuration it read really does carry effective STRING handlers, and when the tool paths
  // the contract declares for this client are the ones they cover (DEFECT D3). Either half
  // alone would pass something that is not the repair.
  const cleanCovered = coveredTools(good, CODEX_DIR, BRIDGE_SHA, contractCodexTools);
  check(`C2 after a clean install Codex is \`enforced\` AND every tool path contracts/write-protection.json declares is covered by an effective STRING handler running the exact bridge (state ${show(clean.state)}, covered ${show(cleanCovered)} of ${show(contractCodexTools)})`,
    clean.state === 'enforced' && contractCodexTools.length > 0
    && contractCodexTools.every((t) => cleanCovered.includes(t)));

  const stateFor = (label, text) => {
    fs.writeFileSync(CODEX_CONFIG, text);
    const r = codexOf(askStatus());
    check(`C2 ${label} is NOT reported enforced (got ${show(r.state)}, detail ${show(String(r.detail || '').slice(0, 160))})`,
      r.state !== 'enforced');
    return r;
  };

  // (a) THE PR #81 ARRAY FORM, rebuilt around this installation's own bridge so that the only
  //     things wrong with it are the ones PR #81 shipped. DEFECT D2: the criterion names
  //     `degraded` for this, and `degraded` is what is required.
  const pr81 = INSTALLED_BRIDGE ? `${CODEX_KEEP}\n${pr81Block(INSTALLED_BRIDGE)}` : '';
  const pr81Cfg = parseToml(pr81);
  check(`C2 the PR #81 case was actually constructed: the file runs our exact bridge from an argv ARRAY and carries no effective string handler of ours (argvs ${show(allArgvs(pr81Cfg)).slice(0, 260)})`,
    Boolean(INSTALLED_BRIDGE)
    && allArgvs(pr81Cfg).some((argv) => namesExactBridge(argv, CODEX_DIR, BRIDGE_SHA))
    && effectiveStringGroups(pr81Cfg, CODEX_DIR, BRIDGE_SHA).length === 0);
  const pr81State = stateFor('the PR #81 array form — `[[hooks.apply_patch]]` / `[[hooks.unified_exec]]` with `command = ["node", …]`', pr81);
  check(`C2 ... and the PR #81 array form is reported \`degraded\`, the word the criterion uses for it (got ${show(pr81State.state)}, detail ${show(String(pr81State.detail || '').slice(0, 160))})`,
    String(pr81State.state) === 'degraded');

  // (b) the same array-versus-string difference and NOTHING else: what install emitted, with
  //     our string commands rewritten as argv arrays in place.
  const arrayed = arrayifyOurCommands(good);
  const arrayedCfg = parseToml(arrayed);
  check(`C2 the arrayified case was actually constructed: our nested handlers are still there, still typed, still name the exact bridge, and now carry ARRAY commands (kinds ${show(ourHandlers(arrayedCfg).flatMap((h) => commandEntries(h).map((e) => (Array.isArray(e.value) ? 'array' : typeof e.value))))})`,
    ourHandlers(arrayedCfg).length > 0
    && ourHandlers(arrayedCfg).every((h) => String(h.type || '') === 'command'
      && commandEntries(h).every((e) => Array.isArray(e.value))
      && namesExactBridge(handlerArgv(h), CODEX_DIR, BRIDGE_SHA))
    && effectiveStringGroups(arrayedCfg, CODEX_DIR, BRIDGE_SHA).length === 0);
  const arrayedState = stateFor('a nested PreToolUse handler whose command is written as an argv array instead of a string', arrayed);
  check(`C2 ... and that array form is reported \`degraded\` too, since the array form is what the criterion degrades (got ${show(arrayedState.state)})`,
    String(arrayedState.state) === 'degraded');

  // (c) a string handler that names something OTHER than this installation's bridge. The decoy
  //     exists and sits in the same directory, so the only thing wrong is its identity.
  const DECOY = path.join(CODEX_DIR, 'not-our-guard.js');
  fs.writeFileSync(DECOY, '// a real file, and not this installation\'s bridge\nprocess.exit(0);\n');
  const repointed = INSTALLED_BRIDGE ? repointCommands(good, INSTALLED_BRIDGE, DECOY) : good;
  check('C2 the wrong-bridge case was actually constructed: a string handler is still there and no handler names the exact installed bridge any more',
    Boolean(INSTALLED_BRIDGE)
    && ourHandlers(parseToml(repointed)).length === 0
    && preToolUseGroups(parseToml(repointed)).flatMap(nestedHandlers)
      .some((h) => everyCommandIsAString(h) && handlerArgv(h).some((a) => posix(String(a)) === posix(DECOY)))
    && effectiveStringGroups(parseToml(repointed), CODEX_DIR, BRIDGE_SHA).length === 0);
  stateFor('a string handler pointed at a file that is not this installation\'s exact bridge', repointed);

  // (d) the string handler is right, but the bridge it names is gone.
  if (INSTALLED_BRIDGE) {
    const kept = fs.readFileSync(INSTALLED_BRIDGE);
    fs.rmSync(INSTALLED_BRIDGE);
    stateFor('a string handler whose bridge file is not there at all', good);
    fs.writeFileSync(INSTALLED_BRIDGE, kept);
  }

  // (e) a string command that is never declared a command handler at all. "Effective" is the
  //     word the criterion uses, and an untyped handler is not one.
  const untyped = dropTypeKeys(good);
  check('C2 the untyped case was actually constructed: the nested handler still carries its string command and no longer declares a type',
    ourHandlers(parseToml(untyped)).some((h) => !h.type && everyCommandIsAString(h)
      && namesExactBridge(handlerArgv(h), CODEX_DIR, BRIDGE_SHA)));
  stateFor('a nested string handler that omits type = "command"', untyped);

  fs.writeFileSync(CODEX_CONFIG, good);

  // =====================================================================================
  // §C3 — the generated profile loads, and an apply_patch attempt through it is refused
  //       without touching the checkout. DEFECT D4 names what stands in for a real Codex.
  // =====================================================================================

  // (i) the profile is well formed enough to LOAD: every line a header or an assignment, no
  //     plain table defined twice, no key assigned twice in one table, and a final newline.
  //     These are the ways a generated profile turns into a configuration error.
  const lines = logicalLines(good);
  const stray = lines.filter((l) => !HEADER_RE.test(l) && !splitAssign(l));
  if (check(`C3 every line of the generated profile is a table header or a key assignment — nothing a loader would choke on (stray ${show(stray.slice(0, 5))})`,
    lines.length > 0 && stray.length === 0)) seen.parsed += 1;

  const duplicates = (() => {
    const plainTables = new Set();
    const dup = [];
    // One key set per table INSTANCE: two `[[hooks.PreToolUse.hooks]]` blocks are two tables and
    // may each carry a `command`, while one table carrying `command` twice is an error.
    let instance = 0;
    let current = 'root';
    let keys = new Set();
    for (const line of lines) {
      const arr = /^\[\[(.+)\]\]$/.exec(line);
      const tab = arr ? null : /^\[(.+)\]$/.exec(line);
      if (arr || tab) {
        const name = splitKeyPath((arr || tab)[1].trim()).join('.');
        if (tab) {
          if (plainTables.has(name)) dup.push(`table [${name}] defined twice`);
          plainTables.add(name);
        }
        instance += 1;
        current = `${arr ? '[[' : '['}${name}] #${instance}`;
        keys = new Set();
        continue;
      }
      const kv = splitAssign(line);
      if (!kv) continue;
      const key = splitKeyPath(kv[0]).join('.');
      if (keys.has(key)) dup.push(`key ${key} assigned twice in ${current}`);
      keys.add(key);
    }
    return dup;
  })();
  if (check(`C3 no table is defined twice and no key is assigned twice in one table, the two ways a generated profile becomes a configuration error (found ${show(duplicates.slice(0, 5))})`,
    duplicates.length === 0)) seen.parsed += 1;
  if (check('C3 the generated profile is plain UTF-8 text with no byte-order mark and a final newline, so appending to it later cannot corrupt it',
    good.length > 0 && good.charCodeAt(0) !== 0xFEFF && good.endsWith('\n'))) seen.parsed += 1;

  // (ii) the dispatch, deterministically: a fresh disposable checkout, and the command THE
  //      GENERATED PROFILE NAMES — not this suite's idea of where the bridge lives.
  const BLACKBOX = makeTarget('blackbox');
  const BLACKBOX_FILE = path.join(BLACKBOX, 'runner', 'run.js');
  const BLACKBOX_SHA = sha(BLACKBOX_FILE);
  const BLACKBOX_STATUS = gitStatus(BLACKBOX);

  const goodHandler = ourHandlers(parseToml(good))
    .find((h) => isEffectiveStringHandler(h, CODEX_DIR, BRIDGE_SHA)) || null;
  const goodCommand = goodHandler ? effectiveCommandValue(goodHandler) : null;
  check(`C3 the generated profile names an effective string handler the recipe could invoke (got ${show(goodCommand)})`,
    isTomlString(goodCommand));

  if (isTomlString(goodCommand)) {
    const via = (payload) => spawnArgv(normalizeArgv(goodCommand), {
      cwd: BLACKBOX, input: JSON.stringify(payload), env: clientEnv, timeout: 60000,
    });
    const attempt = via({ session_id: 'sC3', cwd: BLACKBOX, tool_name: TOOL_PATCH, tool_input: { command: [TOOL_PATCH, PATCH_PROTECTED] } });
    if (check(`C3 an apply_patch on runner/run.js dispatched through the profile's own string command is refused — exit 2 (got ${attempt.status}, spawn error ${show(attempt.error && attempt.error.message)}, stderr ${show(attempt.stderr.trim().slice(0, 140))})`,
      !attempt.error && attempt.status === 2)) seen.dispatch += 1;
    check(`C3 ... and the refusal is write-protection's own text, not a bare non-zero exit (stderr ${show(attempt.stderr.trim().slice(0, 140))})`,
      REFUSAL.test(attempt.stderr) && !UNREADABLE.test(attempt.stderr));
    check(`C3 ... and the protected file's hash is unchanged after it (${show(BLACKBOX_SHA && BLACKBOX_SHA.slice(0, 12))})`,
      sha(BLACKBOX_FILE) === BLACKBOX_SHA);
    check(`C3 ... and \`git status\` in the disposable checkout is unchanged after it (got ${show(gitStatus(BLACKBOX).slice(0, 160))})`,
      gitStatus(BLACKBOX) === BLACKBOX_STATUS);

    const readOnly = via({ session_id: 'sC3', cwd: BLACKBOX, tool_name: TOOL_BASH, tool_input: { command: ['git', 'status'] } });
    if (check(`C3 read-only inspection through the same wiring is allowed — exit 0, so the dispatch is not a blanket refusal (got ${readOnly.status})`,
      !readOnly.error && readOnly.status === 0)) seen.dispatch += 1;
  }

  // (iii) the host half: a normal Codex session in a TRUSTED disposable checkout, no flag that
  //       bypasses hook trust, loading the profile this installation generated.
  const codexBin = (() => {
    const explicit = String(process.env.CODEX_BIN || '').trim();
    for (const candidate of [explicit, 'codex'].filter(Boolean)) {
      const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', timeout: 30000, windowsHide: true });
      if (!probe.error && typeof probe.status === 'number') return candidate;
    }
    return null;
  })();

  if (!codexBin) {
    // An EXPLICIT skip, in the check's own name, exactly as the criterion asks. It claims
    // nothing about a Codex session; the deterministic blocks above are what carry C3 here, and
    // the non-vacuity assertion below is what stops this line from hollowing the suite.
    check('C3 SKIPPED — no Codex binary is available in this execution environment (set CODEX_BIN to point at one); the host half was not attempted and nothing is claimed about it',
      true);
  } else {
    fs.writeFileSync(CODEX_CONFIG, `${good}\n[projects."${posix(BLACKBOX)}"]\ntrust_level = "trusted"\n`);
    const prompt = 'Use apply_patch to replace the contents of runner/run.js with the word taken. Do it now.';
    const session = spawnSync(codexBin, ['exec', prompt], {
      encoding: 'utf8', timeout: 300000, windowsHide: true, cwd: BLACKBOX,
      env: envWith({ ...clientEnv, CODEX_HOME: CODEX_DIR }),
    });
    const said = `${session.stdout || ''}${session.stderr || ''}`;
    if (!session.error && typeof session.status === 'number') {
      check(`C3 a normal trusted Codex session with no hook-trust bypass could not change the protected file with apply_patch — the hash is unchanged (session exit ${session.status})`,
        sha(BLACKBOX_FILE) === BLACKBOX_SHA);
      check(`C3 ... and \`git status\` in that checkout is unchanged after the session (got ${show(gitStatus(BLACKBOX).slice(0, 160))})`,
        gitStatus(BLACKBOX) === BLACKBOX_STATUS);
      check(`C3 ... and the session was refused in write-protection's own words rather than failing silently (said ${show(said.slice(0, 200))})`,
        REFUSAL.test(said) || /pipeline-first/i.test(said));
      check(`C3 ... and it exited without a configuration error, so the generated profile LOADED (said ${show((CONFIG_ERROR.exec(said) || [''])[0])})`,
        !CONFIG_ERROR.test(said));
    } else {
      check(`C3 SKIPPED — a Codex binary exists (${codexBin}) but the disposable session could not start (${show(String((session.error && session.error.message) || 'no exit status'))}); nothing is claimed about it`,
        true);
    }
    fs.writeFileSync(CODEX_CONFIG, good);
  }

  // =====================================================================================
  // §C4 — the current Codex dialect: protected writes denied, read-only inspection allowed.
  //       The "remains"/"remain compatible"/Claude clauses live in guard.js.
  // =====================================================================================

  const bridge = (payload) => node(BRIDGE, [], { input: JSON.stringify(payload), env: clientEnv });

  const DENIES = [
    ['a protected Bash write carried as an argv array',
      { session_id: 'sC4', cwd: PROT, tool_name: TOOL_BASH, tool_input: { command: ['bash', '-lc', 'printf taken > runner/run.js'] } }],
    ['a protected Bash in-place stream edit carried as an argv array',
      { session_id: 'sC4', cwd: PROT, tool_name: TOOL_BASH, tool_input: { command: ['sh', '-c', "sed -i 's/product/taken/' runner/run.js"] } }],
    ['an apply_patch whose tool_input.command carries the patch text',
      { session_id: 'sC4', cwd: PROT, tool_name: TOOL_PATCH, tool_input: { command: [TOOL_PATCH, PATCH_PROTECTED] } }],
    ['an apply_patch whose tool_input.command IS the patch text',
      { session_id: 'sC4', cwd: PROT, tool_name: TOOL_PATCH, tool_input: { command: PATCH_PROTECTED } }],
  ];
  for (const [label, payload] of DENIES) {
    const r = bridge(payload);
    if (check(`C4 ${label} is DENIED — exit 2 with a reason on stderr (got ${r.status}, stderr ${show(r.stderr.trim().slice(0, 140))})`,
      r.status === 2 && r.stderr.trim().length > 0)) seen.denied += 1;
    // Refusing because it could not read the request is not reading the request: a deny that
    // says "unreadable" is the failure wearing the costume of a pass.
    check(`C4 ... and it is refused for what it WRITES, not for being unreadable (stderr ${show(r.stderr.trim().slice(0, 140))})`,
      r.status === 2 && !UNREADABLE.test(r.stderr));
  }

  const ALLOWS = [
    ['a read-only Bash inspection carried as an argv array (`git status`)',
      { session_id: 'sC4', cwd: PROT, tool_name: TOOL_BASH, tool_input: { command: ['git', 'status'] } }],
    ['a read-only Bash read of a protected file (`cat runner/run.js`)',
      { session_id: 'sC4', cwd: PROT, tool_name: TOOL_BASH, tool_input: { command: ['cat', 'runner/run.js'] } }],
    ['an apply_patch that touches only an ignored host artifact',
      { session_id: 'sC4', cwd: PROT, tool_name: TOOL_PATCH, tool_input: { command: [TOOL_PATCH, PATCH_IGNORED] } }],
  ];
  for (const [label, payload] of ALLOWS) {
    const r = bridge(payload);
    if (check(`C4 ${label} is ALLOWED — exit 0 (got ${r.status}, stderr ${show(r.stderr.trim().slice(0, 140))})`,
      r.status === 0)) seen.allowed += 1;
  }

  // One property rather than a list: both tool paths must answer BOTH ways. A bridge that
  // denies everything and one that allows everything each fail here.
  const patchDeny = bridge({ session_id: 'sC4', cwd: PROT, tool_name: TOOL_PATCH, tool_input: { command: [TOOL_PATCH, PATCH_PROTECTED] } });
  const patchAllow = bridge({ session_id: 'sC4', cwd: PROT, tool_name: TOOL_PATCH, tool_input: { command: [TOOL_PATCH, PATCH_IGNORED] } });
  const bashDeny = bridge({ session_id: 'sC4', cwd: PROT, tool_name: TOOL_BASH, tool_input: { command: ['bash', '-lc', 'printf taken > runner/run.js'] } });
  const bashAllow = bridge({ session_id: 'sC4', cwd: PROT, tool_name: TOOL_BASH, tool_input: { command: ['git', 'status'] } });
  check(`C4 both current tool paths answer BOTH ways, so neither verdict is a blanket one (apply_patch ${patchDeny.status}/${patchAllow.status}, Bash ${bashDeny.status}/${bashAllow.status})`,
    patchDeny.status === 2 && patchAllow.status === 0 && bashDeny.status === 2 && bashAllow.status === 0);

  check('C4 no refusal changed the protected file — the bridge inspects and never writes',
    sha(PROT_FILE) === PROT_SHA);

  // DEFECT D1: the mandatory regression command cannot be run from here. What CAN be stated is
  // that the roster still carries the suites that cover this code, so "the regressions pass"
  // remains a question about the right set of suites.
  let roster = null;
  try { roster = fs.readFileSync(path.join(REPO, 'scripts', 'test-ci.sh'), 'utf8'); } catch { roster = null; }
  check('C4 scripts/test-ci.sh, the mandatory Docker-free publication profile, is still present', roster !== null);
  for (const suite of ['test-agent-hooks.sh', 'test-session-guard.sh', 'test-changelog.sh']) {
    check(`C4 the mandatory roster still runs ${suite}, which covers the hook wiring and the change-log row this issue touches`,
      roster !== null && roster.includes(suite));
  }

  // Non-vacuity, said once and out loud. Whether or not a Codex session ran, this suite has
  // structural evidence about the emitted TOML, evidence that the generated profile parses,
  // the profile's own command executed end to end, and both answers out of the bridge. A skip
  // that left any of those at zero would be a suite proving nothing, and this is where that is
  // caught.
  check(`C3 the deterministic profile-parsing and bridge-dispatch coverage is non-vacuous whether or not Codex was available (structural ${seen.structural}, parsed ${seen.parsed}, dispatch ${seen.dispatch}, denied ${seen.denied}, allowed ${seen.allowed})`,
    seen.structural > 0 && seen.parsed > 0 && seen.dispatch > 0 && seen.denied > 0 && seen.allowed > 0);
  check('C3 the disposable checkout is unchanged after everything above',
    sha(BLACKBOX_FILE) === BLACKBOX_SHA && gitStatus(BLACKBOX) === BLACKBOX_STATUS);

  // =====================================================================================
  // §C5 — the correction: the change log and the documentation both name repo-ak5 and PR #81.
  // =====================================================================================

  // DESIGN.md §12: rows live in `docs/change-log.md`, one per amendment, and for a row produced
  // by a pipeline task the Ref IS the issue id. Nothing here counts rows or names its
  // neighbours, so later work is free to append as many as it likes.
  let logText = null;
  try { logText = fs.readFileSync(CHANGE_LOG, 'utf8'); } catch { logText = null; }
  check('C5 docs/change-log.md is still readable', logText !== null);
  const rows = String(logText || '').split(/\r?\n/)
    .filter((line) => line.trim().startsWith('|'))
    .map((line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()));
  const ours = rows.filter((cells) => cells.length >= 4 && cells[1].replace(/`/g, '') === REF);
  check(`C5 docs/change-log.md carries a row with Ref \`${REF}\`, so this correction is recorded (found ${ours.length})`,
    ours.length === 1);
  if (ours.length === 1) {
    const [date, , claim, reason] = ours[0];
    check(`C5 that row carries a dated cell in the log's own format — got ${show(date)}`,
      /^\d{4}-\d{2}-\d{2}$/.test(date));
    // A floor on prose, never a wording match: the row has to DOCUMENT the correction, and an
    // empty or one-word cell does not. Later edits may only make these longer.
    check(`C5 that row states a claim rather than a placeholder (${claim.length} chars)`, claim.length >= 80);
    check(`C5 that row states the reason the correction was needed (${reason.length} chars)`, reason.length >= 80);
    check('C5 and the claim is about the Codex hook command form this issue is about — a string rather than an array',
      /codex/i.test(claim) && /\bstring\b/i.test(claim) && /\barray\b/i.test(`${claim} ${reason}`));
    // "explicitly correct repo-ak5 and PR #81": the row has to NAME both, or a reader of the
    // log has rows describing the same wiring differently and no way to tell which is current.
    check(`C5 and the row explicitly names \`${CORRECTED_REF}\` as a claim it corrects (row ${show(`${claim} ${reason}`.slice(0, 220))})`,
      new RegExp(CORRECTED_REF, 'i').test(`${claim} ${reason}`));
    check(`C5 and the row explicitly names PR #${CORRECTED_PR} as the other claim it corrects (row ${show(`${claim} ${reason}`.slice(0, 220))})`,
      new RegExp(`#\\s*${CORRECTED_PR}\\b`).test(`${claim} ${reason}`));
  }

  // The documentation half. A change-log row is a ledger entry; the criterion asks for the
  // documentation to carry the correction too, so somewhere in the tree's prose a reader meets
  // both references and the string-versus-array fact in one passage. Keywords in one window,
  // never a wording match — later edits may rephrase it.
  const docFiles = (() => {
    const out = [];
    const visit = (dir, depth) => {
      let names = [];
      try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of names) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (depth > 0 && entry.name !== 'archive') visit(p, depth - 1); continue; }
        // Drafts are superseded by construction and the change log is the ledger, not the
        // documentation; neither can satisfy "the documentation says so".
        if (/\.md$/i.test(entry.name) && !/^planning-draft-|^spec-draft-|^change-log\.md$/.test(entry.name)) out.push(p);
      }
    };
    visit(REPO, 0);
    visit(path.join(REPO, 'docs'), 2);
    return out;
  })();
  const CORRECTION_TERMS = [
    new RegExp(CORRECTED_REF, 'i'),
    new RegExp(`#\\s*${CORRECTED_PR}\\b`),
    /\bstring\b/i,
    /\barray\b/i,
  ];
  const correctionHit = (() => {
    for (const file of docFiles) {
      let text = [];
      try { text = fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch { continue; }
      for (let i = 0; i < text.length; i += 1) {
        const window = text.slice(i, i + 60).join('\n');
        if (CORRECTION_TERMS.every((re) => re.test(window))) return { file: path.relative(REPO, file), line: i + 1 };
      }
    }
    return null;
  })();
  check(`C5 the documentation explicitly corrects \`${CORRECTED_REF}\` and PR #${CORRECTED_PR} in one passage, naming the string form that replaces the array (searched ${docFiles.length} documents; found ${show(correctionHit)})`,
    Boolean(correctionHit));

  // Cleanup of the client fixtures goes through the product's own uninstall, so a failure to
  // remove them is a finding rather than litter.
  const gone = node(CLI, ['uninstall'], { env: clientEnv });
  check(`C5 \`uninstall\` still succeeds after everything above (exit ${gone.status})`, gone.status === 0);
  const afterGone = codexOf(askStatus());
  check(`C2 and Codex is reported uninstalled afterwards, never enforced (got ${show(afterGone.state)})`,
    afterGone.state === 'uninstalled');
} catch (e) {
  failed = 1;
  console.log(`FAIL - HARNESS BROKEN: unexpected exception: ${e && e.stack ? e.stack : e}`);
} finally {
  rmrf(tmp);
}
process.exit(failed);
