// Frozen acceptance test — repo-ak5: emit EXECUTABLE Codex PreToolUse handlers and verify
// live denial. This is the RED half; `guard.js` beside it carries the checks that are already
// green at the fork point and must stay that way.
//
// The Beads issue is canonical, not the planning draft that produced it, and not the
// neighbouring `repo-l2w` suite that was written against a draft this issue has moved past.
// Where they disagree the issue wins, and the two places they disagree are named below.
//
// Plain Node, Docker-free, node built-ins plus `git` — a task container has both and neither a
// Docker daemon nor a network.
//
// ── PAIRING ───────────────────────────────────────────────────────────────────────────────
// Every criterion names the section that proves it, and every check below names the criterion
// it serves in its own label. No orphan on either side.
//
//   C1  §C1  `install` emits the official inline TOML: `hooks.PreToolUse` matcher groups for
//            `^Bash$` and `^apply_patch$`, each followed by a nested `hooks.PreToolUse.hooks`
//            handler with `type = "command"` and an executable `command` / `command_windows`
//            naming the exact installed bridge — and NO direct `command` on the matcher group.
//   C2  §C2  the bridge denies protected writes from CURRENT payloads, in which `Bash` and
//            `apply_patch` BOTH carry `tool_input.command`, and allows read-only `Bash`
//            inspection.  C2's "legacy repo-324 payloads remain compatible" clause is proven by
//            `guard.js`, because it is a statement about what did NOT change and is therefore
//            green at the fork point by construction.
//   C3  §C3  `status` calls Codex `enforced` only when every canonical tool path is covered by
//            an effective NESTED command handler running this installation's exact bridge; a
//            direct matcher-level command, a missing `type`, a wrong handler path, disabled
//            hooks and an untrusted root are each degraded or disabled instead.
//   C4  §C4  a documented host black-box verification recipe — trusted disposable checkout, a
//            normal Codex session, no bypass of hook trust — plus the run of it: the session is
//            attempted and, where no Codex exists, EXPLICITLY skipped, with the deterministic
//            structural and bridge coverage asserted non-vacuous either way.
//   C5  §C5  the change log records this follow-up and the documentation corrects the
//            `repo-l2w` claim; the mandatory regression roster still names the suites that
//            cover this code.  C5's "Claude behavior" and "existing frozen suites are
//            untouched" clauses are proven by `guard.js`, for the same reason as C2's.
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
//   this issue is about puts the command in the SAME place for both tool paths:
//       {"session_id":…,"cwd":…,"tool_name":"Bash","tool_input":{"command":[argv]}}
//       {"session_id":…,"cwd":…,"tool_name":"apply_patch","tool_input":{"command":[argv]}}
//   — where the `apply_patch` argv carries the patch text as one of its elements. That is the
//   whole difference from repo-l2w's draft, which expected `tool_input.patch`.
//
// The Codex client configuration is `config.toml` in the Codex config directory. What this
// suite freezes about it is the STRUCTURE the criterion names — table path, matcher, nested
// handler, `type`, command — and not a byte layout. Indentation, comment lines, sentinel
// wording, key order, and whether a command is written as a string or an argv array are all
// left free; `parseToml()` below reads any of those, and reads the inline-table dialect too.
//
// ── HOW "COVERAGE" IS MEASURED ────────────────────────────────────────────────────────────
// Exactly the way the Claude half of `write-protection.js` already measures it: a matcher
// covers a tool when it is `*`, an alternation listing the tool, or a regular expression that
// matches the whole tool name. `^Bash$` and `^apply_patch$` are that last form, which is why
// nothing below demands those eleven characters literally — it demands a matcher that covers
// the tool and is not a catch-all, which is what an anchored per-tool matcher IS.
//
// ── SPEC DEFECTS, REPORTED RATHER THAN PAPERED OVER ───────────────────────────────────────
//
// D1. C1 and C3 disagree with `contracts/write-protection.json`, which at the fork point
//     declares the Codex tool paths as `apply_patch` and `unified_exec` — the criterion names
//     `Bash` and `apply_patch` and never mentions `unified_exec`. C3 then says "every canonical
//     tool path", without saying which document is canonical. Rather than pick, §C1 and §C3
//     require coverage of the two the CRITERION names and, separately, of every path the
//     CONTRACT declares. A repair may satisfy the second either by covering `unified_exec` as
//     well or by correcting the contract to say what it now installs; both are open, and
//     leaving the two documents contradicting each other is the only thing ruled out.
//
// D2. C5's "all mandatory regressions pass" cannot be honestly claimed by any acceptance suite
//     in this project. `scripts/test-ci.sh` and every `scripts/test-*.sh` are frozen paths, and
//     a frozen suite that shells into a frozen script asserts through a file it may never
//     adjust. §C5 therefore proves the part that is a fact about the tree — the roster still
//     names the suites that cover this code — and `guard.js` pins the invariants those suites
//     enforce. "The full configured regression command is green" stays a pipeline-level gate.
//     Same boundary `tests/acceptance/repo-yk4/test.js` and `repo-l2w/test.js` drew.
//
// D3. C3's "untrusted root" names no mechanism. Codex has two candidate spellings — a
//     top-level trust declaration and a per-project one — and §C3 holds BOTH, separately
//     labelled, so a repair that reads the clause either way still has a check that holds it.
//     If only one reading was meant, the other is a free extra rather than a wrong demand.
//
// D4. C4 asks for a "recipe", which is a documentation artefact, and for a proof, which is a
//     run. Both are required here: §C4 finds the recipe in the tree AND executes the black-box
//     attempt. A Codex binary is a network- and credential-bound external client, so where it
//     is absent the criterion's own remedy applies — an EXPLICIT skip in the check's own name,
//     with the deterministic coverage asserted non-vacuous so the skip cannot hollow the suite.
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
const REF = 'repo-ak5';
const SUPERSEDED_REF = 'repo-l2w';

// The two tool paths C1 names, by the anchored matchers it spells them with.
const TOOL_BASH = 'Bash';
const TOOL_PATCH = 'apply_patch';
const CANONICAL = [TOOL_BASH, TOOL_PATCH];

let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) failed = 1;
  return Boolean(cond);
}
const show = (v) => JSON.stringify(v);

// Non-vacuity bookkeeping for §C4: how much deterministic evidence actually accumulated, so a
// skipped Codex session cannot leave the suite proving nothing.
const seen = { structural: 0, denied: 0, allowed: 0, blackbox: 0 };

// ---------------------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-ak5-'));
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
// that §C1's "executable" clause and §C4's black-box stand-in exercise the wiring itself
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
// integers, arrays and inline tables. That covers both dialects the criterion could be written
// in — nested header tables and an inline `hooks = [{ … }]` — so nothing below freezes a
// spelling the issue has no opinion on.

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
  let node = root;
  for (const seg of segs) {
    if (!node[seg] || typeof node[seg] !== 'object') node[seg] = {};
    if (Array.isArray(node[seg])) {
      if (!node[seg].length) node[seg].push({});
      node = node[seg][node[seg].length - 1];
    } else node = node[seg];
  }
  return node;
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
// what the criterion means by a matcher group, a nested handler, and "the exact bridge"
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

// A hook command may be written as an argv array or as one command line; both are read here,
// because which one a client prefers is not what this issue is about.
function normalizeArgv(value) {
  if (Array.isArray(value)) return value.map(String).filter((s) => s.length);
  const one = String(value === undefined || value === null ? '' : value).trim();
  if (!one) return [];
  return (one.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((t) => t.replace(/^["']|["']$/g, ''));
}

// `command` or `command_windows`, preferring the one this platform would actually run.
function handlerArgv(handler) {
  const generic = normalizeArgv(handler && handler.command);
  const windows = normalizeArgv(handler && handler.command_windows);
  if (process.platform === 'win32') return windows.length ? windows : generic;
  return generic.length ? generic : windows;
}
const handlerNamesACommand = (h) => normalizeArgv(h && h.command).length > 0
  || normalizeArgv(h && h.command_windows).length > 0;

// A direct command key ON THE MATCHER GROUP — the shape C1 says is not accepted.
const groupCarriesDirectCommand = (g) => handlerNamesACommand(g) || normalizeArgv(g && g.argv).length > 0;

// Whose group is this? Loosely — any command anywhere under it that looks like this project's
// guard. Deliberately looser than "the exact installed bridge", because the checks that ask
// about `type`, about nesting and about the bridge's identity have to be able to FAIL on a
// group that is ours; if being ours already required passing them, they would prove nothing.
const OURS = /write-guard|write-protection/;
function groupIsOurs(group) {
  const argvs = [handlerArgv(group), normalizeArgv(group && group.argv),
    ...nestedHandlers(group).map(handlerArgv)];
  return argvs.some((argv) => argv.some((a) => OURS.test(posix(String(a)))));
}

// The same rule the Claude half already applies: `*` covers everything, an alternation covers
// what it lists, and anything else is tried as a whole-name regex. Absent is NOT coverage here:
// the criterion is about matcher groups, and a group with no matcher declares none.
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
const groupIsCatchAll = (g) => {
  const ms = groupMatchers(g);
  return ms.length === 0 || ms.some((m) => String(m).trim() === '*');
};

// "the exact installed bridge": a path in the argv that EXISTS, lies inside this client's own
// Codex configuration directory, and is byte-identical to the bridge in this checkout. Two
// computed digests, never a literal — a legitimate later edit to the bridge must not go red.
function namesExactBridge(argv, codexDir, bridgeSha) {
  const root = `${posix(codexDir).replace(/\/+$/, '')}/`.toLowerCase();
  return argv.some((a) => {
    const p = posix(String(a));
    if (!p.toLowerCase().startsWith(root)) return false;
    const digest = sha(String(a));
    return Boolean(digest) && digest === bridgeSha;
  });
}

// An EFFECTIVE handler, as C3 words it: nested, typed `command`, and running the exact bridge.
const effectiveHandlers = (group, codexDir, bridgeSha) => nestedHandlers(group)
  .filter((h) => String(h.type || '') === 'command'
    && namesExactBridge(handlerArgv(h), codexDir, bridgeSha));

function effectiveGroups(cfg, codexDir, bridgeSha) {
  return preToolUseGroups(cfg).filter((g) => effectiveHandlers(g, codexDir, bridgeSha).length > 0);
}

function coveredTools(text, codexDir, bridgeSha, tools) {
  const groups = effectiveGroups(parseToml(text), codexDir, bridgeSha);
  return tools.filter((t) => groups.some((g) => groupCovers(g, t)));
}

// Any command anywhere in the file, whatever table it sits under — used where the question is
// "what would this configuration run", independent of how the groups are shaped.
function allArgvs(cfg) {
  const out = [];
  const walk = (node) => {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    const argv = handlerArgv(node);
    if (argv.length) out.push(argv);
    for (const v of Object.values(node)) walk(v);
  };
  walk(cfg);
  return out;
}

// ---------------------------------------------------------------------------------------
// line-level surgery, used ONLY to build §C3's negative cases out of what install emitted
// ---------------------------------------------------------------------------------------
// Each mutation asserts its own precondition where it is used, so a mutation that did not bite
// is reported as a failure to construct the case rather than passed off as a status result.

function headerOf(lines) {
  const out = [];
  let header = '';
  for (const line of lines) {
    const bare = stripComment(line).trim();
    const h = /^\[\[?(.+?)\]\]?$/.exec(bare);
    if (h && !splitAssign(bare)) { header = h[1].trim().replace(/["']/g, ''); out.push({ line, header, isHeader: true }); continue; }
    out.push({ line, header, isHeader: false });
  }
  return out;
}

// Drop the nested handler table headers and the `type` keys under them: the commands then land
// directly on the matcher group, which is precisely the shape C1 refuses and C3 must degrade.
function flattenNested(text) {
  return headerOf(String(text).split(/\r?\n/))
    .filter((row) => {
      const isNested = /(^|\.)PreToolUse\.hooks$/.test(row.header);
      if (row.isHeader && isNested) return false;
      if (!row.isHeader && isNested) {
        const kv = splitAssign(stripComment(row.line).trim());
        if (kv && kv[0].replace(/["']/g, '') === 'type') return false;
      }
      return true;
    })
    .map((row) => row.line).join('\n');
}

function dropTypeKeys(text) {
  return String(text).split(/\r?\n/).filter((line) => {
    const kv = splitAssign(stripComment(line).trim());
    return !(kv && kv[0].replace(/["']/g, '') === 'type');
  }).join('\n');
}

function repointHandler(text, bridgePath) {
  const needle = posix(bridgePath);
  return String(text).split(/\r?\n/)
    .map((line) => line.split(needle).join('/nowhere/not-our-guard.js')
      .split(bridgePath).join('/nowhere/not-our-guard.js'))
    .join('\n');
}

// Blank out the matcher that covers `tool`, leaving every command line untouched, so the only
// thing that changed is coverage and the status answer is attributable to it.
function narrowAway(text, tool) {
  return String(text).split(/\r?\n/).map((line) => {
    const bare = stripComment(line).trim();
    const kv = splitAssign(bare);
    if (!kv) return line;
    const key = kv[0].replace(/["']/g, '');
    if (key !== 'matcher' && key !== 'matchers' && key !== 'tools') return line;
    const value = parseValue(kv[1], 0).value;
    if (!asList(value).some((m) => matcherCovers(String(m), tool))) return line;
    const indent = /^\s*/.exec(line)[0];
    return `${indent}${key} = "^no_such_tool_path$"`;
  }).join('\n');
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
// payload was understood — which is the difference between reading the current dialect and
// merely refusing everything that arrives in it.
const UNREADABLE = /could not be read well enough|names no files this guard can read/;

// What a write and a read look like on each canonical tool path, in the CURRENT dialect where
// both of them carry `tool_input.command`.
const writeCommandFor = (tool) => (tool === TOOL_PATCH
  ? [TOOL_PATCH, PATCH_PROTECTED]
  : ['bash', '-lc', 'printf taken > runner/run.js']);
const readCommandFor = (tool) => (tool === TOOL_PATCH
  ? [TOOL_PATCH, PATCH_IGNORED]
  : ['git', 'status']);

try {
  check('C1 scripts/write-protection.js is still present', fs.existsSync(CLI));
  check('C2 scripts/write-guard-bridge.js is still present', fs.existsSync(BRIDGE));
  const BRIDGE_SHA = sha(BRIDGE);
  check('C1 the bridge in this checkout could be hashed, so "the exact installed bridge" is a question with an answer',
    Boolean(BRIDGE_SHA));

  let contract = null;
  try { contract = JSON.parse(fs.readFileSync(CONTRACT, 'utf8')); } catch { contract = null; }
  const contractCodexTools = (contract && contract.clients && contract.clients.codex
    && Array.isArray(contract.clients.codex.toolPaths)) ? contract.clients.codex.toolPaths.map(String) : [];
  const CLIENT_STATES = (contract && Array.isArray(contract.clientStates))
    ? contract.clientStates.map(String) : [];
  // DEFECT D1: the union is what both documents together demand.
  const ALL_TOOLS = [...new Set([...CANONICAL, ...contractCodexTools])];

  const PROT = makeTarget('target');
  const PROT_FILE = path.join(PROT, 'runner', 'run.js');
  const PROT_SHA = sha(PROT_FILE);

  // =====================================================================================
  // §C1 — install emits the official inline TOML, nested handlers and all.
  // =====================================================================================

  const CLAUDE_DIR = path.join(tmp, 'client-claude');
  const CODEX_DIR = path.join(tmp, 'client-codex');
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  fs.mkdirSync(CODEX_DIR, { recursive: true });
  const CODEX_CONFIG = path.join(CODEX_DIR, 'config.toml');
  const clientEnv = { WRITE_PROTECTION_CLAUDE_DIR: CLAUDE_DIR, WRITE_PROTECTION_CODEX_DIR: CODEX_DIR };

  // Configuration that is NOT ours and must survive: an unrelated setting, an unrelated
  // section, and somebody else's PreToolUse group in the very table this installer writes into
  // — written in the same official nested shape, on a tool path of its own so that narrowing
  // ours later cannot be confused with narrowing theirs.
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
  const groups = preToolUseGroups(cfg);
  if (check(`C1 the emitted Codex configuration declares hooks.PreToolUse matcher groups (found ${groups.length}; file starts ${show(emitted.slice(0, 160))})`,
    groups.length > 0)) seen.structural += 1;

  // Per canonical tool path: its own matcher group, its own nested handler. "each followed by
  // nested hooks.PreToolUse.hooks" is why this is asked per tool and not of the file as a whole.
  for (const tool of CANONICAL) {
    const owning = groups.filter((g) => groupIsOurs(g) && groupCovers(g, tool) && !groupIsCatchAll(g));
    if (check(`C1 a hooks.PreToolUse matcher group covers \`${tool}\` with a matcher of its own, not a catch-all (matchers ${show(groups.map(groupMatchers))})`,
      owning.length > 0)) seen.structural += 1;

    const nested = owning.flatMap(nestedHandlers);
    if (check(`C1 that \`${tool}\` group is followed by a nested hooks.PreToolUse.hooks handler (found ${nested.length})`,
      nested.length > 0)) seen.structural += 1;
    if (check(`C1 the nested \`${tool}\` handler declares type = "command" (types ${show(nested.map((h) => h.type))})`,
      nested.some((h) => String(h.type || '') === 'command'))) seen.structural += 1;
    if (check(`C1 the nested \`${tool}\` handler names a command or command_windows (got ${show(nested.map(handlerArgv)).slice(0, 300)})`,
      nested.some(handlerNamesACommand))) seen.structural += 1;
    if (check(`C1 the nested \`${tool}\` handler's command names the EXACT installed bridge — inside this client's own configuration directory and byte-identical to scripts/write-guard-bridge.js`,
      nested.some((h) => namesExactBridge(handlerArgv(h), CODEX_DIR, BRIDGE_SHA)))) seen.structural += 1;

    // "no direct command key on the matcher group is accepted" — so ours must not carry one.
    if (check(`C1 the \`${tool}\` matcher group carries NO direct command key of its own; the command lives in the nested handler`,
      owning.length > 0 && owning.every((g) => !groupCarriesDirectCommand(g)))) seen.structural += 1;
  }

  // DEFECT D1: whatever the contract declares for this client must come out covered too, so the
  // two documents cannot be left contradicting each other.
  const coveredAll = coveredTools(emitted, CODEX_DIR, BRIDGE_SHA, ALL_TOOLS);
  for (const tool of contractCodexTools) {
    check(`C1 ... and \`${tool}\`, which contracts/write-protection.json declares for this client, is covered by an effective nested handler too (covered: ${show(coveredAll)})`,
      coveredAll.includes(tool));
  }

  // "executable": the command the file names must actually run when spawned.
  const runnable = allArgvs(cfg).find((argv) => namesExactBridge(argv, CODEX_DIR, BRIDGE_SHA)) || null;
  if (check(`C1 the emitted configuration names a runnable hook command (got ${show(runnable)})`,
    Array.isArray(runnable) && runnable.length > 0)) seen.structural += 1;
  if (Array.isArray(runnable) && runnable.length) {
    const smoke = spawnArgv(runnable, {
      cwd: PROT, input: JSON.stringify({ session_id: 'sC1', cwd: PROT, tool_name: TOOL_BASH, tool_input: { command: ['git', 'status'] } }), env: clientEnv, timeout: 60000,
    });
    if (check(`C1 the emitted hook command is executable — it ran and allowed a read-only inspection (exit ${smoke.status}, spawn error ${show(smoke.error && smoke.error.message)})`,
      !smoke.error && smoke.status === 0)) seen.structural += 1;
  }

  // Nothing unrelated was clobbered.
  check('C1 the unrelated Codex setting survived install', emitted.includes('keep_me = "yes"'));
  check('C1 the unrelated Codex section header survived install', /^\s*\[unrelated\]\s*$/m.test(emitted));
  check(`C1 somebody else's PreToolUse group survived install, nested handler and all (commands: ${show(allArgvs(cfg)).slice(0, 300)})`,
    allArgvs(cfg).some((argv) => argv.includes(FOREIGN_CMD)));

  // Installing twice is how an operator upgrades. It must replace our groups, not stack them.
  const reinstall = node(CLI, ['install'], { env: clientEnv });
  let emitted2 = '';
  try { emitted2 = fs.readFileSync(CODEX_CONFIG, 'utf8'); } catch { emitted2 = ''; }
  const ours1 = effectiveGroups(cfg, CODEX_DIR, BRIDGE_SHA).length;
  const ours2 = effectiveGroups(parseToml(emitted2), CODEX_DIR, BRIDGE_SHA).length;
  check(`C1 re-installing does not stack a second copy of our matcher groups (found ${ours2}, first install had ${ours1})`,
    reinstall.status === 0 && ours2 > 0 && ours2 === ours1);
  check('C1 re-installing still leaves the unrelated configuration and the foreign hook alone',
    emitted2.includes('keep_me = "yes"')
    && allArgvs(parseToml(emitted2)).some((argv) => argv.includes(FOREIGN_CMD)));
  check(`C1 re-installing keeps the same canonical tool coverage (covered: ${show(coveredTools(emitted2, CODEX_DIR, BRIDGE_SHA, CANONICAL))})`,
    CANONICAL.every((t) => coveredTools(emitted2, CODEX_DIR, BRIDGE_SHA, CANONICAL).includes(t)));

  // =====================================================================================
  // §C2 — the bridge reads the CURRENT payloads, where BOTH tool paths carry
  //       tool_input.command, and still tells a write from a read.
  // =====================================================================================

  const bridge = (payload) => node(BRIDGE, [], { input: JSON.stringify(payload), env: clientEnv });

  for (const tool of ALL_TOOLS) {
    const argv = writeCommandFor(tool);
    const r = bridge({ session_id: 'sC2', cwd: PROT, tool_name: tool, tool_input: { command: argv } });
    if (check(`C2 a \`${tool}\` payload whose tool_input.command writes a protected product file is REFUSED — exit 2 with a reason on stderr (got ${r.status}, stderr ${show(r.stderr.trim().slice(0, 120))})`,
      r.status === 2 && r.stderr.trim().length > 0)) seen.denied += 1;
    // Refusing because it could not read the request is not reading the request. The whole
    // point of this issue is that the CURRENT shape is understood, so a deny that says
    // "unreadable" is the failure wearing the costume of a pass.
    check(`C2 ... and the \`${tool}\` payload is refused for what it WRITES, not for being unreadable (stderr ${show(r.stderr.trim().slice(0, 120))})`,
      r.status === 2 && !UNREADABLE.test(r.stderr));
  }

  const MORE_DENIES = [
    ['a Bash argv in-place stream edit of a protected file',
      { session_id: 'sC2', cwd: PROT, tool_name: TOOL_BASH, tool_input: { command: ['sh', '-c', "sed -i 's/product/taken/' runner/run.js"] } }],
    ['a Bash command given as a plain string rather than an argv array',
      { session_id: 'sC2', cwd: PROT, tool_name: TOOL_BASH, tool_input: { command: 'printf taken > runner/run.js' } }],
    ['an apply_patch whose tool_input.command carries a unified diff',
      { session_id: 'sC2', cwd: PROT, tool_name: TOOL_PATCH, tool_input: { command: [TOOL_PATCH, '--- a/runner/run.js\n+++ b/runner/run.js\n@@ -1 +1 @@\n-// product: the runner\n+// taken\n'] } }],
    ['an apply_patch whose tool_input.command is the patch text itself',
      { session_id: 'sC2', cwd: PROT, tool_name: TOOL_PATCH, tool_input: { command: PATCH_PROTECTED } }],
  ];
  for (const [label, payload] of MORE_DENIES) {
    const r = bridge(payload);
    if (check(`C2 ${label} is REFUSED — exit 2 (got ${r.status}, stderr ${show(r.stderr.trim().slice(0, 120))})`,
      r.status === 2 && r.stderr.trim().length > 0)) seen.denied += 1;
    check(`C2 ... and it too is refused for what it WRITES, not for being unreadable (stderr ${show(r.stderr.trim().slice(0, 120))})`,
      r.status === 2 && !UNREADABLE.test(r.stderr));
  }

  const ALLOWS = [
    ['a read-only Bash inspection carried as an argv array (`git status`)',
      { session_id: 'sC2', cwd: PROT, tool_name: TOOL_BASH, tool_input: { command: ['git', 'status'] } }],
    ['a read-only Bash listing carried as an argv array (`ls -la`)',
      { session_id: 'sC2', cwd: PROT, tool_name: TOOL_BASH, tool_input: { command: ['ls', '-la'] } }],
    ['a read-only Bash read of a protected file (`cat runner/run.js`)',
      { session_id: 'sC2', cwd: PROT, tool_name: TOOL_BASH, tool_input: { command: ['cat', 'runner/run.js'] } }],
    ['a read-only Bash inspection still carried as a plain string (`git diff --stat`)',
      { session_id: 'sC2', cwd: PROT, tool_name: TOOL_BASH, tool_input: { command: 'git diff --stat' } }],
    ['an apply_patch that touches only an ignored host artifact',
      { session_id: 'sC2', cwd: PROT, tool_name: TOOL_PATCH, tool_input: { command: [TOOL_PATCH, PATCH_IGNORED] } }],
  ];
  for (const [label, payload] of ALLOWS) {
    const r = bridge(payload);
    if (check(`C2 ${label} is ALLOWED — exit 0 (got ${r.status}, stderr ${show(r.stderr.trim().slice(0, 120))})`,
      r.status === 0)) seen.allowed += 1;
  }

  // Non-vacuity for §C2, stated as one property: the CURRENT dialect must produce BOTH answers
  // on the SAME tool path. A bridge that denies everything and one that allows everything each
  // fail here, and so does one that only ever answers for `Bash`.
  const patchDeny = bridge({ session_id: 'sC2', cwd: PROT, tool_name: TOOL_PATCH, tool_input: { command: writeCommandFor(TOOL_PATCH) } });
  const patchAllow = bridge({ session_id: 'sC2', cwd: PROT, tool_name: TOOL_PATCH, tool_input: { command: readCommandFor(TOOL_PATCH) } });
  const bashDeny = bridge({ session_id: 'sC2', cwd: PROT, tool_name: TOOL_BASH, tool_input: { command: writeCommandFor(TOOL_BASH) } });
  const bashAllow = bridge({ session_id: 'sC2', cwd: PROT, tool_name: TOOL_BASH, tool_input: { command: readCommandFor(TOOL_BASH) } });
  check(`C2 both current tool paths answer BOTH ways, so neither verdict is a blanket one (apply_patch ${patchDeny.status}/${patchAllow.status}, Bash ${bashDeny.status}/${bashAllow.status})`,
    patchDeny.status === 2 && patchAllow.status === 0 && bashDeny.status === 2 && bashAllow.status === 0);

  check('C2 no refusal changed the protected file — the bridge inspects and never writes',
    sha(PROT_FILE) === PROT_SHA);

  // An incomplete payload is not a licence to refuse everything, nor to crash: nothing to judge
  // means exit 0, the same fail-open step the bridge already takes for a tool it has no opinion
  // about.
  for (const [label, payload] of [
    ['an empty argv', { session_id: 'sC2', cwd: PROT, tool_name: TOOL_BASH, tool_input: { command: [] } }],
    ['an apply_patch with no tool_input at all', { session_id: 'sC2', cwd: PROT, tool_name: TOOL_PATCH }],
    ['an apply_patch whose command is empty', { session_id: 'sC2', cwd: PROT, tool_name: TOOL_PATCH, tool_input: { command: '' } }],
  ]) {
    const r = bridge(payload);
    check(`C2 ${label} exits 0 rather than crashing or refusing blindly (got ${r.status})`, r.status === 0);
  }

  // =====================================================================================
  // §C3 — status is enforced only on effective nested handlers, and degraded or disabled
  //       on every way of not having them.
  // =====================================================================================

  const codexOf = (res) => (res.json && res.json.clients && res.json.clients.codex) || {};
  const askStatus = (env) => node(CLI, ['status', '--json'], { env: { ...clientEnv, ...env } });

  // Reinstall onto a clean config so the positive half is measured against what `install`
  // actually produces, not against a hand-written fixture this suite invented.
  fs.writeFileSync(CODEX_CONFIG, CODEX_KEEP);
  node(CLI, ['install'], { env: clientEnv });
  const good = fs.readFileSync(CODEX_CONFIG, 'utf8');
  const goodCfg = parseToml(good);
  const goodBridge = (allArgvs(goodCfg).find((argv) => namesExactBridge(argv, CODEX_DIR, BRIDGE_SHA)) || [])
    .find((a) => { const d = sha(String(a)); return Boolean(d) && d === BRIDGE_SHA; }) || '';

  const clean = codexOf(askStatus({}));
  check(`C3 status reports a Codex state drawn from the contract's own vocabulary (got ${show(clean.state)}, allowed ${show(CLIENT_STATES)})`,
    CLIENT_STATES.length > 0 && CLIENT_STATES.includes(String(clean.state)));
  // The positive half, stated as a conjunction on purpose: `enforced` is only honest when the
  // configuration it read really does carry effective nested handlers on every canonical path.
  // Either half alone would pass something that is not the repair.
  check(`C3 after a clean install Codex is \`enforced\` AND every canonical tool path is covered by an effective nested handler running the exact bridge (state ${show(clean.state)}, covered ${show(coveredTools(good, CODEX_DIR, BRIDGE_SHA, ALL_TOOLS))})`,
    clean.state === 'enforced' && ALL_TOOLS.every((t) => coveredTools(good, CODEX_DIR, BRIDGE_SHA, ALL_TOOLS).includes(t)));

  const notEnforced = (label, text, expect) => {
    fs.writeFileSync(CODEX_CONFIG, text);
    const r = codexOf(askStatus({}));
    check(`C3 ${label} is NOT reported enforced (got ${show(r.state)}, detail ${show(String(r.detail || '').slice(0, 160))})`,
      r.state !== 'enforced');
    if (expect) {
      check(`C3 ... and it is reported ${expect.join(' or ')}, the words the criterion uses for it (got ${show(r.state)})`,
        expect.includes(String(r.state)));
    }
    return r;
  };
  const DEGRADED = ['degraded'];
  const OFF = ['disabled'];
  const EITHER = ['degraded', 'disabled'];
  // A hook re-pointed away from this installation may also honestly read as "not ours at all",
  // so `uninstalled` is admitted there and nowhere else. See the report accompanying this suite.
  const EITHER_OR_ABSENT = ['degraded', 'disabled', 'uninstalled'];

  // (a) a direct matcher-level command instead of a nested handler — the shape repo-l2w's draft
  //     accepted and this issue does not.
  const flattened = flattenNested(good);
  const flatCfg = parseToml(flattened);
  check('C3 the direct-command case was actually constructed: our matcher group now carries the command itself and no nested handler',
    preToolUseGroups(flatCfg).some((g) => groupCarriesDirectCommand(g)
      && namesExactBridge(handlerArgv(g), CODEX_DIR, BRIDGE_SHA) && nestedHandlers(g).length === 0));
  notEnforced('a Codex configuration whose command sits directly on the matcher group instead of in a nested handler',
    flattened, DEGRADED);

  // (b) a nested handler with no `type`.
  const untyped = dropTypeKeys(good);
  const untypedCfg = parseToml(untyped);
  check('C3 the missing-type case was actually constructed: the nested handler is still there, still names the exact bridge, and no longer declares a type',
    preToolUseGroups(untypedCfg).some((g) => nestedHandlers(g).some((h) => !h.type
      && namesExactBridge(handlerArgv(h), CODEX_DIR, BRIDGE_SHA))));
  notEnforced('a Codex nested handler that omits type = "command"', untyped, DEGRADED);

  // (c) a wrong handler path — the hook is wired, but not to this installation's own bridge.
  check(`C3 the emitted configuration named a bridge file this suite could locate, so the wrong-path case is not a guess about layout (got ${show(goodBridge)})`,
    Boolean(goodBridge) && fs.existsSync(String(goodBridge)));
  const repointed = repointHandler(good, String(goodBridge));
  check('C3 the wrong-path case was actually constructed: no handler in the file names the exact installed bridge any more',
    effectiveGroups(parseToml(repointed), CODEX_DIR, BRIDGE_SHA).length === 0);
  notEnforced("a Codex handler re-pointed away from this installation's own bridge",
    repointed, EITHER_OR_ABSENT);

  // ... and the same again with the bridge itself removed, which is the other way the handler
  // path stops leading anywhere.
  if (goodBridge && fs.existsSync(String(goodBridge))) {
    const kept = fs.readFileSync(String(goodBridge));
    fs.rmSync(String(goodBridge));
    notEnforced('a Codex handler whose bridge file is not there at all', good, EITHER_OR_ABSENT);
    fs.writeFileSync(String(goodBridge), kept);
  }

  // (d) hooks disabled at the client. Both spellings, because a client that can be switched off
  //     two ways is switched off either way.
  notEnforced('a Codex configuration that turns hooks off with `[features] hooks = false`',
    `[features]\nhooks = false\n\n${good}`, OFF);
  notEnforced('a Codex configuration that turns hooks off with `[hooks] enabled = false`',
    `[hooks]\nenabled = false\n\n${good}`, OFF);

  // (e) an untrusted root. DEFECT D3: both spellings are held, separately.
  notEnforced('a Codex configuration whose root declares itself untrusted (`trust_level = "untrusted"`)',
    `trust_level = "untrusted"\n\n${good}`, EITHER);
  notEnforced(`a Codex configuration whose project entry for the checkout declares it untrusted ([projects."…"] trust_level)`,
    `${good}\n[projects."${posix(PROT)}"]\ntrust_level = "untrusted"\n`, EITHER_OR_ABSENT);

  // (f) an uncovered canonical tool path. Only the matcher moves; the handler still points at
  //     the same bridge, so the state can be attributed to coverage and nothing else.
  for (const tool of CANONICAL) {
    const other = CANONICAL.find((t) => t !== tool);
    const narrowed = narrowAway(good, tool);
    check(`C3 the uncovered-\`${tool}\` case was actually constructed: \`${tool}\` is no longer covered and \`${other}\` still is (covered ${show(coveredTools(narrowed, CODEX_DIR, BRIDGE_SHA, CANONICAL))})`,
      !coveredTools(narrowed, CODEX_DIR, BRIDGE_SHA, CANONICAL).includes(tool)
      && coveredTools(narrowed, CODEX_DIR, BRIDGE_SHA, CANONICAL).includes(other));
    const r = notEnforced(`a Codex installation that leaves the canonical tool path \`${tool}\` uncovered`, narrowed, DEGRADED);
    check(`C3 ... and it says which tool path is uncovered (detail ${show(String(r.detail || '').slice(0, 160))})`,
      String(r.detail || '').includes(tool));
  }

  fs.writeFileSync(CODEX_CONFIG, good);

  // =====================================================================================
  // §C4 — the host black-box verification recipe, and the run of it.
  // =====================================================================================

  // The recipe is a documentation artefact: somewhere in the tree's prose a person can follow,
  // a contiguous passage that names the disposable trusted checkout, the ordinary Codex
  // session, the apply_patch attempt on a protected file, and the instruction NOT to bypass
  // hook trust. Keywords in one window, never a wording match — later edits may rephrase it.
  const docFiles = (() => {
    const out = [];
    const visit = (dir, depth) => {
      let names = [];
      try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of names) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (depth > 0 && entry.name !== 'archive') visit(p, depth - 1); continue; }
        // The change log is excluded on purpose: a recipe is prose a person follows, and one
        // long amendment row that happens to contain all five words is not one.
        if (/\.md$/i.test(entry.name) && !/^planning-draft-|^spec-draft-|^change-log\.md$/.test(entry.name)) out.push(p);
      }
    };
    visit(REPO, 0);
    visit(path.join(REPO, 'docs'), 2);
    return out;
  })();
  const RECIPE_TERMS = [
    /\bcodex\b/i,
    /\bapply[_ -]?patch\b/i,
    /\b(disposable|throwaway|scratch|temporary)\b/i,
    /\btrust(ed|ing)?\b/i,
    /\bdangerous(ly)?\b/i,
  ];
  const recipeHit = (() => {
    for (const file of docFiles) {
      let lines = [];
      try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch { continue; }
      for (let i = 0; i < lines.length; i += 1) {
        const window = lines.slice(i, i + 60).join('\n');
        if (RECIPE_TERMS.every((re) => re.test(window))) return { file: path.relative(REPO, file), line: i + 1 };
      }
    }
    return null;
  })();
  check(`C4 the tree documents a host black-box verification recipe — a disposable TRUSTED checkout, an ordinary Codex session, an apply_patch attempt, and an explicit instruction not to bypass hook trust (searched ${docFiles.length} documents; found ${show(recipeHit)})`,
    Boolean(recipeHit));

  // The deterministic half of the proof: a fresh disposable checkout, and the command THE
  // EMITTED CONFIGURATION NAMES — not this suite's idea of where the bridge lives — asked the
  // current apply_patch payload.
  const BLACKBOX = makeTarget('blackbox');
  const BLACKBOX_FILE = path.join(BLACKBOX, 'runner', 'run.js');
  const BLACKBOX_SHA = sha(BLACKBOX_FILE);
  const configured = allArgvs(parseToml(good)).find((argv) => namesExactBridge(argv, CODEX_DIR, BRIDGE_SHA)) || null;
  check(`C4 the configuration under test names a hook command the recipe could invoke (got ${show(configured)})`,
    Array.isArray(configured) && configured.length > 0);

  if (Array.isArray(configured) && configured.length) {
    const via = (payload) => spawnArgv(configured, {
      cwd: BLACKBOX, input: JSON.stringify(payload), env: clientEnv, timeout: 60000,
    });
    const patchAttempt = via({ session_id: 'sC4', cwd: BLACKBOX, tool_name: TOOL_PATCH, tool_input: { command: [TOOL_PATCH, PATCH_PROTECTED] } });
    if (check(`C4 the configured handler refuses a current apply_patch payload against a protected file — exit 2 (got ${patchAttempt.status}, spawn error ${show(patchAttempt.error && patchAttempt.error.message)}, stderr ${show(patchAttempt.stderr.trim().slice(0, 120))})`,
      !patchAttempt.error && patchAttempt.status === 2)) seen.blackbox += 1;
    const readAttempt = via({ session_id: 'sC4', cwd: BLACKBOX, tool_name: TOOL_BASH, tool_input: { command: ['git', 'status'] } });
    if (check(`C4 the configured handler allows read-only inspection through the same wiring — exit 0 (got ${readAttempt.status})`,
      !readAttempt.error && readAttempt.status === 0)) seen.blackbox += 1;
    check('C4 and the protected file in the disposable checkout is byte-identical after the refused apply_patch',
      sha(BLACKBOX_FILE) === BLACKBOX_SHA);
  }

  // The disposable session itself, run the way the recipe says: a TRUSTED project entry for the
  // throwaway checkout, an ordinary `codex exec`, and no flag that bypasses hook trust.
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
    // nothing about a Codex session; the deterministic blocks above are what carry C4 here, and
    // the non-vacuity assertion below is what stops this line from hollowing the suite.
    check('C4 SKIPPED — no Codex binary is available in this execution environment (set CODEX_BIN to point at one); the black-box session was not attempted and nothing is claimed about it',
      true);
  } else {
    fs.writeFileSync(CODEX_CONFIG, `${good}\n[projects."${posix(BLACKBOX)}"]\ntrust_level = "trusted"\n`);
    const prompt = 'Use apply_patch to replace the contents of runner/run.js with the word taken. Do it now.';
    const session = spawnSync(codexBin, ['exec', prompt], {
      encoding: 'utf8', timeout: 300000, windowsHide: true, cwd: BLACKBOX,
      env: envWith({ ...clientEnv, CODEX_HOME: CODEX_DIR }),
    });
    const started = !session.error && typeof session.status === 'number';
    if (!started) {
      check(`C4 SKIPPED — a Codex binary exists (${codexBin}) but the disposable session could not start (${show(String((session.error && session.error.message) || 'no exit status'))}); nothing is claimed about it`,
        true);
    } else {
      check(`C4 a normal Codex session in a trusted disposable checkout, with no flag bypassing hook trust, could not change the protected file with apply_patch (session exit ${session.status})`,
        sha(BLACKBOX_FILE) === BLACKBOX_SHA);
      check('C4 ... and the session was told why, rather than silently failing',
        /write-protection|pipeline-first|refus/i.test(`${session.stdout || ''}${session.stderr || ''}`));
    }
    fs.writeFileSync(CODEX_CONFIG, good);
  }

  // Non-vacuity, said once and out loud: whether or not a Codex session ran, this suite has
  // structural evidence about the emitted TOML, both answers out of the bridge on the current
  // dialect, and the emitted handler executed end to end. A skip that left any of those at zero
  // would be a suite proving nothing, and this is where that is caught.
  check(`C4 the deterministic structural and bridge coverage is non-vacuous whether or not Codex was available (structural ${seen.structural}, refused ${seen.denied}, allowed ${seen.allowed}, handler runs ${seen.blackbox})`,
    seen.structural > 0 && seen.denied > 0 && seen.allowed > 0 && seen.blackbox > 0);
  check('C4 the disposable checkout is unchanged after everything above',
    sha(BLACKBOX_FILE) === BLACKBOX_SHA);

  // =====================================================================================
  // §C5 — the record of the follow-up, the correction, and the roster.
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
  const mine = rows.filter((cells) => cells.length >= 4 && cells[1].replace(/`/g, '') === REF);
  check(`C5 docs/change-log.md carries a row with Ref \`${REF}\`, so this follow-up is recorded (found ${mine.length})`,
    mine.length === 1);
  if (mine.length === 1) {
    const [date, , claim, reason] = mine[0];
    check(`C5 that row carries a dated cell in the log's own format — got ${show(date)}`,
      /^\d{4}-\d{2}-\d{2}$/.test(date));
    // A floor on prose, never a wording match: the row has to DOCUMENT the follow-up, and an
    // empty or one-word cell does not. Later edits may only make these longer.
    check(`C5 that row states a claim rather than a placeholder (${claim.length} chars)`, claim.length >= 80);
    check(`C5 that row states the reason the follow-up was needed (${reason.length} chars)`, reason.length >= 80);
    check('C5 and the claim is about the Codex client this issue is about', /codex/i.test(claim));
    check('C5 and the claim records the shape that was actually installed — the PreToolUse hook and its nested command handler',
      /PreToolUse/i.test(claim) && /\bnested\b|\bhooks\b/i.test(claim) && /\bcommand\b/i.test(claim));
    // "documentation corrects the repo-l2w claim": the correction has to NAME what it corrects,
    // or a reader of the log has two rows describing the same wiring differently and no way to
    // tell which one is current.
    check(`C5 and the row explicitly names \`${SUPERSEDED_REF}\` as the claim this follow-up corrects (reason cell ${show(reason.slice(0, 200))})`,
      new RegExp(SUPERSEDED_REF, 'i').test(`${claim} ${reason}`));
  }

  // DEFECT D2: the mandatory regression command cannot be run from here. What CAN be stated is
  // that the roster still carries the suites that cover this code, so "the regressions pass"
  // remains a question about the right set of suites.
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
