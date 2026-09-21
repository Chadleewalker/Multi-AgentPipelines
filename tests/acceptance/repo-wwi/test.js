// Frozen acceptance test — repo-wwi: structured Codex deny decisions and a mandatory host-review
// gate. This is the RED half; `guard.js` beside it carries the clauses that are already green at
// the fork point and must stay that way.
//
// The Beads issue is canonical, not the planning draft that produced it. The neighbouring
// closed `repo-gy3` suite was built against a draft this issue moved past and its PR #82 never
// landed on `main`; before this suite was frozen, its spent exit-code assertions were therefore
// re-approved and re-frozen around semantic denial. This issue now extends that corrected
// baseline without editing any frozen suite during implementation.
//
// Plain Node, Docker-free, node built-ins plus `git` — a task container has both and neither a
// Docker daemon nor a network.
//
// ── PAIRING ───────────────────────────────────────────────────────────────────────────────
// Every criterion names the section that proves it, and every check below names the criterion
// it serves in its own label. No orphan on either side.
//
//   C0  §C0  `install` emits, for Codex, two SEPARATE nested array-of-tables groups —
//            `[[hooks.PreToolUse]]` with `matcher = "^Bash$"` and another with
//            `matcher = "^apply_patch$"` — each carrying its own `[[hooks.PreToolUse.hooks]]`
//            handler with `type = "command"` and a `command` written as a TOML STRING naming the
//            exact installed bridge; the whole emitted profile loads (parses without a duplicate
//            table or a duplicate key); and `status` reports the OLD top-level
//            `[[hooks.apply_patch]]` / `[[hooks.unified_exec]]` array-command layout as
//            `degraded`, proving only that THIS project's bridge is absent from any nested
//            group and never that a coexisting, unrelated `[[hooks.PreToolUse]]` group must also
//            be gone.
//   C1  §C1  a CURRENT Codex PreToolUse payload (`tool_name: "Bash"|"apply_patch"`,
//            `tool_input.command` as a STRING, as the official contract and a real 0.151 host
//            both send it) that names a protected write gets back, on exit 0 — the exit Codex
//            reads as "the hook ran and rendered a decision", never a crash — one JSON object on
//            stdout: `hookSpecificOutput.hookEventName === "PreToolUse"`,
//            `hookSpecificOutput.permissionDecision === "deny"`, and a write-protection-worded
//            reason somewhere inside `hookSpecificOutput`. A read-only payload of the same shape
//            continues (exit 0, no `permissionDecision: "deny"` body).
//   C2  §C2  a small, deterministic "Codex-compatible result interpreter" — written here, the
//            same way `repo-gy3/test.js` wrote its own TOML reader rather than import one — reads
//            a raw `{status, stdout, stderr}` the way a Codex hook harness would: exit 2 with a
//            plain-text reason and no JSON body, the exact shape PR #82 shipped, is read as a
//            HOOK EXECUTION FAILURE, never as a deliberate `deny`, so it is proved NOT to count
//            as enforcement. Fed the INSTALLED Codex command's answers to both current tool
//            paths — `Bash` and `apply_patch` — for a protected write, the same interpreter reads
//            `decision: "deny"` from both. Codex and Claude both carry Bash as a STRING, so the
//            installed commands must identify their client explicitly: payload shape is not a
//            discriminator. The installed Claude command and a no-identity legacy bridge call
//            remain on exit 2 plus stderr.
//   C3  §C3  `install`'s plain-text output tells activation and trust apart and names the exact
//            interactive step, `/hooks`, for a non-managed installation. A non-managed,
//            correctly-shaped Codex configuration is NOT reported `enforced` until a new
//            `review --client codex` host record exists; that record is bound to the exact
//            installed hook definitions and stops being honoured the moment either nested
//            handler's command changes, while a change ELSEWHERE in the file (something this
//            project's bridge does not own) does not disturb it. A centrally managed
//            installation (`WRITE_PROTECTION_MANAGED`) is `enforced`, and `enforcementComplete`
//            can be true, without any review at all. A malformed profile and one missing either
//            required nested handler are both reported truthfully — never `enforced`.
//   C4  §C4  host verification is a human gate this suite documents and validates the machinery
//            under, and DOES NOT PERFORM: nothing in `tests/acceptance/repo-wwi/` spawns a
//            `codex` process (checked by reading this directory's own two files), a direct bridge
//            dispatch of the same protected `apply_patch` never prints the phrase "Hook Failed",
//            and the protected file's hash and `git status` are read as unchanged only once the
//            dispatch that produced them is confirmed to have actually run — never after a spawn
//            error or a missing exit code, which would make "unchanged" ambiguous rather than
//            evidence. The written human recipe (open an interactive session, run `/hooks`,
//            trust both exact definitions, then attempt one `apply_patch` write and one `Bash`
//            string-command write from SEPARATE normal sessions with no bypass flag) is required
//            to exist in the documentation and is checked for containing it; it is never executed
//            here.
//   C5  §C5  the change log and documentation explicitly correct `repo-gy3`, PR #82 and rejected
//            PR #83, in the vocabulary this issue introduces — trust, explicit client identity,
//            the official string command input, and a structured denial schema.
//            C5's "existing frozen suites remain untouched" and "mandatory regressions pass"
//            clauses are proved in `guard.js`, for the reason `repo-gy3/guard.js` gives for the
//            same two clauses: they are statements about what did NOT change.
//
// ── THE FROZEN INTERFACE THIS SUITE ASKS FOR ──────────────────────────────────────────────
//
// scripts/write-protection.js
//   `install [--json]` as today, plus a new subcommand:
//     `review --client codex [--json]`   records, on the host (never inside a repository, under
//       the same `WRITE_PROTECTION_HOST_STATE_DIR` seam every other host record already uses),
//       that a person has run the interactive `/hooks` review for the CURRENTLY installed Codex
//       hook definitions. `status` only ever calls a non-managed Codex client `enforced` while a
//       record like this one exists AND matches what is installed right now.
//   `status [--json]` as today: `clients.codex.state` drawn from
//   `contracts/write-protection.json`'s `clientStates`.
//
// scripts/write-guard-bridge.js
//   Unmoved: the legacy `hook`/`input` dialect and the Claude dialect, both on exit 2 plus a
//   plain-text reason on stderr (`guard.js`).
//   Moved by this issue: the CURRENT Codex dialect — both `{"tool_name":"Bash",…}` and
//   `{"tool_name":"apply_patch",…}` carry `tool_input.command` as a STRING — answers with exit 0
//   when invoked through an installed command that explicitly identifies Codex, and, for a
//   refusal, writes one JSON object on stdout carrying
//   `hookSpecificOutput.hookEventName`, `hookSpecificOutput.permissionDecision` and a
//   write-protection-worded reason under `hookSpecificOutput`, under whatever key name it likes —
//   `command`/`command_windows` was left free the same way in `repo-gy3`, so the reason's OWN key
//   is left free here.
//
// ── SPEC DEFECTS, REPORTED RATHER THAN PAPERED OVER ───────────────────────────────────────
//
// D1. `repo-gy3/test.js` originally required exit 2 for the SAME current-dialect payload this
//     issue moves to exit 0 plus structured JSON. That closed suite was corrected and re-frozen
//     before this one: it now recognizes semantic denial under either transport, and delegates
//     real host verification to this issue's interactive `/hooks` gate. The implementation must
//     therefore keep `repo-gy3` green rather than treating its earlier contradiction as expected
//     regression noise.
//
// D2. `contracts/write-protection.json`'s `clients.codex.toolPaths` reads
//     `["apply_patch", "unified_exec"]` — the LEGACY dialect's names. C0 names `^Bash$` and
//     `^apply_patch$`, the CURRENT dialect's tool names, and one of those (`Bash`) is not in the
//     contract's list at all. `repo-gy3/test.js` D3 flagged the same document as already
//     ambiguous about which tool paths this client contract's own numbers describe. C0 resolves
//     that ambiguity: the authoritative roster must be exactly `Bash` and `apply_patch` for the
//     current installed hooks; legacy `unified_exec` translation remains compatible in the
//     bridge but is not advertised as a current hook path.
//
// D3. Nothing in the issue or in `contracts/write-protection.json` names the exact shape of a
//     review record or the exact wording `status` should use for "shape is right, but nobody has
//     reviewed it yet." §C3 is written against OBSERVABLE BEHAVIOUR only: a state string that is
//     one of the contract's own `clientStates` and is not `"enforced"`, never a literal new state
//     name, and a boolean effect of `review --client codex` rather than an assumption about how
//     or where it is recorded. A repair is free to add a new state to the contract's vocabulary,
//     reuse `"degraded"`, or add an entirely new top-level field, so long as `status` stops
//     answering `"enforced"` for a non-managed, unreviewed, correctly-shaped Codex client and
//     starts answering it once `review` has run against exactly what is installed.
//
// D4. Rejected PR #83 guessed that a Bash command ARRAY identified Codex while a Bash command
//     STRING identified Claude. Real Codex 0.151 sends the official string form. After both exact
//     hooks were interactively reviewed, apply_patch was blocked but Bash therefore returned the
//     Claude exit-2 response; Codex logged `PreToolUse Failed` and executed the protected write.
//     C0-C4 correct that false green by binding client identity in the installed command and by
//     exercising the identical Bash STRING payload through both installed client invocations.
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
const REF = 'repo-wwi';
const CORRECTED_REF = 'repo-gy3';
const CORRECTED_PR = 82;
const REJECTED_PR = 83;

const TOOL_BASH = 'Bash';
const TOOL_PATCH = 'apply_patch';
const MATCHER_BASH = '^Bash$';
const MATCHER_PATCH = '^apply_patch$';

let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) failed = 1;
  return Boolean(cond);
}
const show = (v) => JSON.stringify(v);
const seen = { structural: 0, dispatch: 0, denied: 0, allowed: 0, interpreted: 0 };

// ---------------------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------------------

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-wwi-'));
const HOST = path.join(tmp, 'host-state');
fs.mkdirSync(HOST, { recursive: true });

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

function hookCommand(command, payload, opts = {}) {
  const argv = normalizeArgv(command);
  if (!argv.length) return { status: null, stdout: '', stderr: '', json: null,
    error: new Error('no hook command') };
  const r = spawnSync(argv[0], argv.slice(1), {
    encoding: 'utf8', timeout: 120000, windowsHide: true,
    env: envWith(opts.env || {}), cwd: opts.cwd || tmp, input: JSON.stringify(payload),
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '',
    json: lastJson(r.stdout), error: r.error || null };
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
// a small TOML reader — enough of it, and no more (adapted from the same reasoning
// `tests/acceptance/repo-gy3/test.js` used: a value's KIND is the whole of §C0, so it is read
// here rather than pattern-matched out of the raw text alone)
// ---------------------------------------------------------------------------------------

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

const asList = (v) => (Array.isArray(v) ? v : (v === undefined || v === null ? [] : [v]));
function preToolUseGroups(cfg) {
  const hooks = cfg && cfg.hooks;
  if (!hooks || typeof hooks !== 'object') return [];
  return asList(hooks.PreToolUse).filter((g) => g && typeof g === 'object' && !Array.isArray(g));
}
const nestedHandlers = (group) => asList(group && group.hooks)
  .filter((h) => h && typeof h === 'object' && !Array.isArray(h));

function normalizeArgv(value) {
  if (Array.isArray(value)) return value.map(String).filter((s) => s.length);
  const one = String(value === undefined || value === null ? '' : value).trim();
  if (!one) return [];
  return (one.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((t) => t.replace(/^["']|["']$/g, ''));
}

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

function effectiveCommandValue(handler) {
  const entries = commandEntries(handler);
  if (!entries.length) return null;
  const win = entries.find((e) => e.key === 'command_windows');
  const gen = entries.find((e) => e.key === 'command');
  if (process.platform === 'win32' && win) return win.value;
  return (gen || win).value;
}
const handlerArgv = (handler) => normalizeArgv(effectiveCommandValue(handler));
const carriesClient = (argv, client) => argv.some((arg, i) => arg === '--client' && argv[i + 1] === client);

const OURS = /write-guard|write-protection/;
const mentionsOurs = (value) => normalizeArgv(value).some((a) => OURS.test(posix(String(a))));
const handlerIsOurs = (h) => commandEntries(h).some((e) => mentionsOurs(e.value));
const ourHandlers = (cfg) => preToolUseGroups(cfg).flatMap(nestedHandlers).filter(handlerIsOurs);

function namesExactBridge(argv, codexDir, bridgeSha) {
  const root = `${posix(codexDir).replace(/\/+$/, '')}/`.toLowerCase();
  return argv.some((a) => {
    const p = posix(String(a));
    if (!p.toLowerCase().startsWith(root)) return false;
    const digest = sha(String(a));
    return Boolean(digest) && digest === bridgeSha;
  });
}

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

const groupsWithExactMatcher = (cfg, literal) => preToolUseGroups(cfg)
  .filter((g) => String(g.matcher === undefined || g.matcher === null ? '' : g.matcher).trim() === literal);

// Every command assignment anywhere in the file, as RAW TEXT next to its parsed value.
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

// A profile a loader would choke on: a stray line that is neither a header nor an assignment
// (an unterminated string produces exactly this), a plain table defined twice, or one key
// assigned twice inside one table instance.
function profileWellFormedIssues(text) {
  const lines = logicalLines(text);
  const issues = lines.filter((l) => !/^\[\[?.+\]\]?$/.test(l) && !splitAssign(l));
  const plainTables = new Set();
  let current = 'root';
  let keys = new Set();
  for (const line of lines) {
    const arr = /^\[\[(.+)\]\]$/.exec(line);
    const tab = arr ? null : /^\[(.+)\]$/.exec(line);
    if (arr || tab) {
      const name = splitKeyPath((arr || tab)[1].trim()).join('.');
      if (tab) {
        if (plainTables.has(name)) issues.push(`table [${name}] defined twice`);
        plainTables.add(name);
      }
      current = `${arr ? '[[' : '['}${name}]`;
      keys = new Set();
      continue;
    }
    const kv = splitAssign(line);
    if (!kv) continue;
    const key = splitKeyPath(kv[0]).join('.');
    if (keys.has(key)) issues.push(`key ${key} assigned twice in ${current}`);
    keys.add(key);
  }
  return issues;
}

// Locate every top-level `[[hooks.PreToolUse]]` block's [start, end) line range in the RAW text
// (not the comment-stripped logical lines, so surgery preserves everything else byte for byte).
function preToolUseGroupBounds(text) {
  const rawLines = String(text).split(/\r?\n/);
  const isHeader = (line) => /^\[\[hooks\.PreToolUse\]\]\s*$/.test(stripComment(line).trim());
  const headers = [];
  rawLines.forEach((line, i) => { if (isHeader(line)) headers.push(i); });
  return headers.map((start, idx) => ({ start, end: idx + 1 < headers.length ? headers[idx + 1] : rawLines.length }));
}
function groupMatcherInRange(rawLines, start, end) {
  for (let i = start; i < end; i += 1) {
    const kv = splitAssign(stripComment(rawLines[i]).trim());
    if (kv && splitKeyPath(kv[0]).pop() === 'matcher') return parseValue(kv[1], 0).value;
  }
  return null;
}
function removeGroupByMatcher(text, matcherLiteral) {
  const rawLines = String(text).split(/\r?\n/);
  const bounds = preToolUseGroupBounds(text);
  const target = bounds.find((b) => groupMatcherInRange(rawLines, b.start, b.end) === matcherLiteral);
  if (!target) return null;
  return rawLines.slice(0, target.start).concat(rawLines.slice(target.end)).join('\n');
}

// Change every one of OUR command values by the same suffix — "the exact installed hook
// definitions" changing, in the strongest sense any reasonable binding could recognise, since
// every handler naming this bridge changes at once.
function mutateOurCommands(text) {
  let out = String(text);
  const seenValues = new Set();
  for (const a of commandAssignments(text)) {
    if (!mentionsOurs(a.value) || typeof a.value !== 'string' || seenValues.has(a.value)) continue;
    seenValues.add(a.value);
    const oldQuoted = JSON.stringify(a.value);
    const newQuoted = JSON.stringify(`${a.value} --after-review`);
    if (!out.includes(oldQuoted)) continue;
    out = out.split(oldQuoted).join(newQuoted);
  }
  return seenValues.size > 0 ? out : null;
}

// The historical PR #82 / PR #81 shape, rebuilt around whatever bridge THIS install actually put
// in place: per-tool array-of-tables under `hooks.<tool>`, an argv ARRAY command.
function oldLayoutBlock(bridgePath) {
  const p = posix(bridgePath);
  return [
    '# BEGIN WRITE PROTECTION (multi-agent-pipelines)',
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
// a Codex-compatible result interpreter — §C2's own subject. Deterministic, and it never
// spawns anything: it reads a `{status, stdout, stderr}` the way a Codex hook harness would.
// ---------------------------------------------------------------------------------------

function interpretCodexHookResult(result) {
  if (!result || typeof result.status !== 'number' || result.status !== 0) {
    // A nonzero exit is the hook FAILING to run to completion — Codex's own "Hook Failed" case —
    // and carries no decision at all, whatever text happened to land on stderr.
    return { hookFailed: true, decision: null, hookEventName: null, reason: null };
  }
  let body = null;
  try { body = JSON.parse(String(result.stdout || '').trim()); } catch { body = null; }
  const hso = body && typeof body === 'object' && !Array.isArray(body) ? body.hookSpecificOutput : null;
  if (!hso || typeof hso !== 'object') return { hookFailed: false, decision: 'allow', hookEventName: null, reason: null };
  const decision = String(hso.permissionDecision || '') === 'deny' ? 'deny' : 'allow';
  const reason = Object.values(hso).find((v) => typeof v === 'string' && /write-protection/i.test(v)) || null;
  return { hookFailed: false, decision, hookEventName: hso.hookEventName || null, reason };
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

const HOOK_FAILED_TEXT = /hook\s*failed/i;

try {
  check('C0 scripts/write-protection.js is still present', fs.existsSync(CLI));
  check('C1 scripts/write-guard-bridge.js is still present', fs.existsSync(BRIDGE));
  const BRIDGE_SHA = sha(BRIDGE);
  check('C0 the bridge in this checkout could be hashed, so "the exact installed bridge" is a question with an answer',
    Boolean(BRIDGE_SHA));

  let contract = null;
  try { contract = JSON.parse(fs.readFileSync(CONTRACT, 'utf8')); } catch { contract = null; }
  const CLIENT_STATES = (contract && Array.isArray(contract.clientStates)) ? contract.clientStates.map(String) : [];
  const CODEX_TOOL_PATHS = (contract && contract.clients && contract.clients.codex
    && Array.isArray(contract.clients.codex.toolPaths))
    ? contract.clients.codex.toolPaths.map(String) : [];
  check(`C0 contracts/write-protection.json still declares the status vocabulary (states ${show(CLIENT_STATES)})`,
    CLIENT_STATES.includes('degraded') && CLIENT_STATES.includes('enforced'));
  check(`C0 the authoritative Codex toolPaths roster names exactly the current hook paths Bash and apply_patch, while legacy unified_exec remains bridge compatibility rather than an installed path (got ${show(CODEX_TOOL_PATHS)})`,
    CODEX_TOOL_PATHS.length === 2
    && CODEX_TOOL_PATHS.includes(TOOL_BASH)
    && CODEX_TOOL_PATHS.includes(TOOL_PATCH));

  const PROT = makeTarget('target');
  const PROT_FILE = path.join(PROT, 'runner', 'run.js');
  const PROT_SHA = sha(PROT_FILE);

  const CLAUDE_DIR = path.join(tmp, 'client-claude');
  const CODEX_DIR = path.join(tmp, 'client-codex');
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  fs.mkdirSync(CODEX_DIR, { recursive: true });
  const CODEX_CONFIG = path.join(CODEX_DIR, 'config.toml');
  const CLAUDE_SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
  const clientEnv = { WRITE_PROTECTION_CLAUDE_DIR: CLAUDE_DIR, WRITE_PROTECTION_CODEX_DIR: CODEX_DIR };

  // =====================================================================================
  // §C0 — nested, string-commanded PreToolUse groups for ^Bash$ and ^apply_patch$; a full
  //       profile loads; the old top-level array layout is `degraded`, alongside a coexisting
  //       unrelated PreToolUse group that must NOT be required gone.
  // =====================================================================================

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
  fs.writeFileSync(CLAUDE_SETTINGS, `${JSON.stringify({
    permissions: { allow: ['Bash(ls *)'] },
  }, null, 2)}\n`);

  const install = node(CLI, ['install'], { env: clientEnv });
  check(`C0 \`install\` succeeds with both client directories aimed at scratch dirs (exit ${install.status}: ${install.stderr.trim().slice(0, 200)})`,
    install.status === 0);

  let good = '';
  try { good = fs.readFileSync(CODEX_CONFIG, 'utf8'); } catch { good = ''; }
  const goodCfg = parseToml(good);
  const INSTALLED_BRIDGE = findInstalledBridge(CODEX_DIR, BRIDGE_SHA);
  check(`C0 the installation put a byte-identical copy of the bridge inside the Codex configuration directory (got ${show(INSTALLED_BRIDGE && posix(INSTALLED_BRIDGE))})`,
    Boolean(INSTALLED_BRIDGE));

  for (const [label, matcher] of [['^Bash$', MATCHER_BASH], ['^apply_patch$', MATCHER_PATCH]]) {
    const groups = groupsWithExactMatcher(goodCfg, matcher);
    if (check(`C0 a \`[[hooks.PreToolUse]]\` group with matcher \`${label}\` exists (found ${groups.length})`,
      groups.length > 0)) seen.structural += 1;
    const handlers = groups.flatMap(nestedHandlers).filter(handlerIsOurs);
    if (check(`C0 that group carries a nested \`[[hooks.PreToolUse.hooks]]\` handler of ours (found ${handlers.length})`,
      handlers.length > 0)) seen.structural += 1;
    if (check(`C0 ... typed \`type = "command"\` (types ${show(handlers.map((h) => h.type))})`,
      handlers.length > 0 && handlers.every((h) => String(h.type || '') === 'command'))) seen.structural += 1;
    if (check(`C0 ... whose command is a TOML STRING, never an array (kinds ${show(handlers.flatMap((h) => commandEntries(h).map((e) => (Array.isArray(e.value) ? 'array' : typeof e.value))))})`,
      handlers.length > 0 && handlers.every(everyCommandIsAString))) seen.structural += 1;
    if (check('C0 ... naming the EXACT installed bridge',
      handlers.length > 0 && handlers.every((h) => namesExactBridge(handlerArgv(h), CODEX_DIR, BRIDGE_SHA)))) seen.structural += 1;
    if (check('C0 ... and explicitly identifying the Codex client to that bridge',
      handlers.length > 0 && handlers.every((h) => carriesClient(handlerArgv(h), 'codex')))) seen.structural += 1;
    const written = commandAssignments(good).filter((a) => mentionsOurs(a.value));
    check(`C0 ... and every such command is WRITTEN as a quoted string in the file, never a bracketed list (raw ${show(written.map((a) => a.raw.slice(0, 80)))})`,
      written.length > 0 && written.every((a) => /^["']/.test(a.raw) && !a.raw.startsWith('[')));
  }

  const wellFormed = profileWellFormedIssues(good);
  if (check(`C0 the full emitted Codex configuration LOADS — no stray line, no table or key defined twice (found ${show(wellFormed.slice(0, 5))})`,
    good.length > 0 && wellFormed.length === 0)) seen.structural += 1;

  check('C0 the unrelated Codex setting survived install', good.includes('keep_me = "yes"'));
  check(`C0 somebody else's PreToolUse handler survived install with its argv ARRAY command intact`,
    preToolUseGroups(goodCfg).flatMap(nestedHandlers)
      .some((h) => !handlerIsOurs(h) && Array.isArray(h.command) && h.command.map(String).includes(FOREIGN_CMD)));

  // "and it actually runs": the string command on the Bash group, tokenised and spawned with a
  // read-only payload of the CURRENT dialect.
  const bashGroup = groupsWithExactMatcher(goodCfg, MATCHER_BASH)[0];
  const bashHandler = bashGroup ? nestedHandlers(bashGroup).find((h) => handlerIsOurs(h)) : null;
  const bashCommand = bashHandler ? effectiveCommandValue(bashHandler) : null;
  const patchGroup = groupsWithExactMatcher(goodCfg, MATCHER_PATCH)[0];
  const patchHandler = patchGroup ? nestedHandlers(patchGroup).find((h) => handlerIsOurs(h)) : null;
  const patchCommand = patchHandler ? effectiveCommandValue(patchHandler) : null;
  if (check(`C0 the emitted configuration names a string hook command this suite can run (got ${show(bashCommand)})`,
    isTomlString(bashCommand))) seen.structural += 1;
  if (isTomlString(bashCommand)) {
    const smoke = hookCommand(bashCommand,
      { session_id: 'sC0', cwd: PROT, tool_name: TOOL_BASH, tool_input: { command: 'git status' } },
      { cwd: PROT, env: clientEnv });
    check(`C0 that string command is executable and allows a read-only inspection (exit ${smoke.status}, spawn error ${show(smoke.error && smoke.error.message)})`,
      !smoke.error && smoke.status === 0);
  }

  let claudeSettings = null;
  try { claudeSettings = JSON.parse(fs.readFileSync(CLAUDE_SETTINGS, 'utf8')); } catch { claudeSettings = null; }
  const claudeCommands = (((claudeSettings && claudeSettings.hooks
    && claudeSettings.hooks.PreToolUse) || []).flatMap((g) => (g && g.hooks) || []))
    .map((h) => h && h.command).filter((c) => typeof c === 'string' && mentionsOurs(c));
  const claudeCommand = claudeCommands[0] || null;
  check(`C0 the installed Claude command explicitly identifies Claude to the same bridge (got ${show(claudeCommand)})`,
    Boolean(claudeCommand) && carriesClient(normalizeArgv(claudeCommand), 'claude'));

  // The OLD top-level array layout, rebuilt around this installation's own bridge, coexisting
  // with the SAME unrelated `^Read$` group `CODEX_KEEP` declared.
  const oldLayout = INSTALLED_BRIDGE ? `${CODEX_KEEP}\n${oldLayoutBlock(INSTALLED_BRIDGE)}` : '';
  const oldLayoutCfg = parseToml(oldLayout);
  check('C0 the old-layout case was actually constructed: it runs our exact bridge from a top-level array-of-tables and carries no nested handler of ours at all',
    Boolean(INSTALLED_BRIDGE)
    && preToolUseGroups(oldLayoutCfg).flatMap(nestedHandlers).filter(handlerIsOurs).length === 0
    && (oldLayoutCfg.hooks && Array.isArray(oldLayoutCfg.hooks.apply_patch) && oldLayoutCfg.hooks.apply_patch.length > 0));
  check('C0 ... and the coexisting UNRELATED `^Read$` PreToolUse group is still there — this case does not require every foreign group gone, only that OUR bridge is absent from any nested group',
    groupsWithExactMatcher(oldLayoutCfg, '^Read$').length === 1);
  fs.writeFileSync(CODEX_CONFIG, oldLayout);
  const oldLayoutStatus = node(CLI, ['status', '--json'], { env: clientEnv });
  const oldLayoutCodex = (oldLayoutStatus.json && oldLayoutStatus.json.clients && oldLayoutStatus.json.clients.codex) || {};
  check(`C0 status reports the old top-level array layout \`degraded\`, never \`enforced\` (got ${show(oldLayoutCodex.state)}, detail ${show(String(oldLayoutCodex.detail || '').slice(0, 160))})`,
    String(oldLayoutCodex.state) === 'degraded');

  fs.writeFileSync(CODEX_CONFIG, good);

  // =====================================================================================
  // §C1 — the CURRENT Codex dialect answers a protected write with structured JSON on exit 0.
  // =====================================================================================

  const legacyBridge = (payload) => node(BRIDGE, [], { input: JSON.stringify(payload), env: clientEnv });
  const codexBash = (payload) => hookCommand(bashCommand, payload, { cwd: PROT, env: clientEnv });
  const codexPatch = (payload) => hookCommand(patchCommand, payload, { cwd: PROT, env: clientEnv });

  const CURRENT_DENIES = [
    ['Bash, official string command', codexBash,
      { session_id: 'sC1', cwd: PROT, tool_name: TOOL_BASH, tool_input: { command: 'printf taken > runner/run.js' } }],
    ['apply_patch, official string command', codexPatch,
      { session_id: 'sC1', cwd: PROT, tool_name: TOOL_PATCH, tool_input: { command: PATCH_PROTECTED } }],
  ];
  const denyResults = [];
  for (const [label, invoke, payload] of CURRENT_DENIES) {
    const r = invoke(payload);
    denyResults.push([label, r]);
    if (check(`C1 a protected write via ${label} answers on the exit Codex treats as a successful hook decision (got ${r.status})`,
      r.status === 0)) seen.dispatch += 1;
    const hso = r.json && typeof r.json === 'object' && !Array.isArray(r.json) ? r.json.hookSpecificOutput : null;
    if (check(`C1 ... with a valid \`hookSpecificOutput\` object on stdout (stdout ${show(r.stdout.trim().slice(0, 160))})`,
      Boolean(hso) && typeof hso === 'object')) seen.structural += 1;
    check('C1 ... \`hookSpecificOutput.hookEventName\` is exactly `"PreToolUse"`',
      Boolean(hso) && String(hso.hookEventName) === 'PreToolUse');
    if (check('C1 ... \`hookSpecificOutput.permissionDecision\` is exactly `"deny"`',
      Boolean(hso) && String(hso.permissionDecision) === 'deny')) seen.denied += 1;
    check('C1 ... and somewhere inside `hookSpecificOutput` a string names this project\'s own refusal',
      Boolean(hso) && Object.values(hso).some((v) => typeof v === 'string' && /write-protection/i.test(v)));
  }

  const CURRENT_ALLOWS = [
    ['Bash `git status`, official string command', codexBash,
      { session_id: 'sC1', cwd: PROT, tool_name: TOOL_BASH, tool_input: { command: 'git status' } }],
    ['apply_patch touching only an ignored host artifact', codexPatch,
      { session_id: 'sC1', cwd: PROT, tool_name: TOOL_PATCH, tool_input: { command: PATCH_IGNORED } }],
  ];
  for (const [label, invoke, payload] of CURRENT_ALLOWS) {
    const r = invoke(payload);
    const hso = r.json && typeof r.json === 'object' && !Array.isArray(r.json) ? r.json.hookSpecificOutput : null;
    if (check(`C1 a read-only ${label} continues — exit 0 and no \`permissionDecision: "deny"\` body (exit ${r.status}, stdout ${show(r.stdout.trim().slice(0, 120))})`,
      r.status === 0 && (!hso || String(hso.permissionDecision) !== 'deny'))) seen.allowed += 1;
  }

  check('C1 no refusal wrote to the protected file — the bridge inspects and never writes',
    sha(PROT_FILE) === PROT_SHA);

  // =====================================================================================
  // §C2 — a Codex-compatible result interpreter proves the PR #82 exit-2 shape is not
  //       enforcement, and reads `deny` from both current-dialect tool paths.
  // =====================================================================================

  const pr82Shape = { status: 2, stdout: '', stderr: 'write-protection: this checkout is pipeline-first.\n' };
  const pr82Read = interpretCodexHookResult(pr82Shape);
  if (check(`C2 the interpreter reads the PR #82 exit-2, no-JSON-body shape as a HOOK FAILURE, never a deliberate deny (got ${show(pr82Read)})`,
    pr82Read.hookFailed === true && pr82Read.decision !== 'deny')) seen.interpreted += 1;

  // The same shape, but with the OLD plain-text reason accidentally also being valid trailing
  // JSON, would still not count: a plain-text stderr line is not a `hookSpecificOutput` body,
  // and any nonzero exit is read as failed regardless of what stdout carries.
  const pr82WithStrayJson = { status: 2, stdout: '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny"}}', stderr: '' };
  check('C2 ... and a nonzero exit is read as a hook failure even if a decision-shaped body is present on stdout, because Codex would already have logged the failure before reading it',
    interpretCodexHookResult(pr82WithStrayJson).hookFailed === true);

  const bashDenyResult = denyResults.find(([label]) => label.startsWith('Bash'))[1];
  const patchDenyResult = denyResults.find(([label]) => label.startsWith('apply_patch'))[1];
  const bashInterpreted = interpretCodexHookResult(bashDenyResult);
  const patchInterpreted = interpretCodexHookResult(patchDenyResult);
  if (check(`C2 the interpreter reads \`deny\` from the real bridge's answer to a protected Bash write (got ${show(bashInterpreted)})`,
    bashInterpreted.hookFailed === false && bashInterpreted.decision === 'deny')) seen.interpreted += 1;
  if (check(`C2 ... and from its answer to a protected apply_patch (got ${show(patchInterpreted)})`,
    patchInterpreted.hookFailed === false && patchInterpreted.decision === 'deny')) seen.interpreted += 1;

  const allowInterpreted = interpretCodexHookResult(codexBash({ session_id: 'sC2', cwd: PROT,
    tool_name: TOOL_BASH, tool_input: { command: 'git status' } }));
  check(`C2 ... and \`allow\` from a read-only current-dialect payload (got ${show(allowInterpreted)})`,
    allowInterpreted.hookFailed === false && allowInterpreted.decision === 'allow');

  const sameBashString = { session_id: 'sC2', cwd: PROT, tool_name: TOOL_BASH,
    tool_input: { command: 'printf taken > runner/run.js' } };
  const claudeTransport = hookCommand(claudeCommand, sameBashString, { cwd: PROT, env: clientEnv });
  check(`C2 the identical Bash STRING through the installed Claude invocation preserves exit-2 stderr refusal (got ${claudeTransport.status}, stderr ${show(claudeTransport.stderr.trim().slice(0, 120))})`,
    claudeTransport.status === 2 && /write-protection/i.test(claudeTransport.stderr));
  const legacyTransport = legacyBridge(sameBashString);
  check(`C2 the identical no-identity legacy bridge call preserves exit-2 stderr refusal (got ${legacyTransport.status})`,
    legacyTransport.status === 2 && /write-protection/i.test(legacyTransport.stderr));

  // =====================================================================================
  // §C3 — install output tells activation from trust; a non-managed correct shape alone is
  //       not `enforced`; a review record binds to the exact definitions; managed policy
  //       needs none of it; malformed and missing-handler stay truthful.
  // =====================================================================================

  const codexOf = (res) => (res.json && res.json.clients && res.json.clients.codex) || {};
  const askStatus = (env) => node(CLI, ['status', '--json'], { env: env || clientEnv });

  // (a) install's plain-text output.
  const CODEX_DIR_TXT = path.join(tmp, 'client-codex-txt');
  const CLAUDE_DIR_TXT = path.join(tmp, 'client-claude-txt');
  fs.mkdirSync(CODEX_DIR_TXT, { recursive: true });
  fs.mkdirSync(CLAUDE_DIR_TXT, { recursive: true });
  const txtEnv = { WRITE_PROTECTION_CLAUDE_DIR: CLAUDE_DIR_TXT, WRITE_PROTECTION_CODEX_DIR: CODEX_DIR_TXT };
  const installTxt = node(CLI, ['install'], { env: txtEnv });
  check(`C3 a non-managed \`install\`'s plain-text output instructs the exact interactive review step, \`/hooks\` (stdout ${show(installTxt.stdout.slice(0, 400))})`,
    installTxt.stdout.includes('/hooks'));
  check('C3 ... and that instruction is about TRUST, distinct from the activation line it also prints',
    /trust/i.test(installTxt.stdout) && /install|activ/i.test(installTxt.stdout));

  // (b) a non-managed, correctly-shaped Codex client is not `enforced` on shape alone.
  fs.writeFileSync(CODEX_CONFIG, good);
  const shapeOnly = codexOf(askStatus());
  check(`C3 a non-managed, correctly-shaped Codex configuration with no review record is reported truthfully — a known state, and NOT \`enforced\` (got ${show(shapeOnly.state)}, allowed ${show(CLIENT_STATES)})`,
    CLIENT_STATES.length > 0 && CLIENT_STATES.includes(String(shapeOnly.state)) && shapeOnly.state !== 'enforced');

  // (c) `review --client codex` grants it, bound to exactly what is installed.
  const review = node(CLI, ['review', '--client', 'codex'], { env: clientEnv });
  check(`C3 \`review --client codex\` is accepted (exit ${review.status}: ${review.stderr.trim().slice(0, 160)})`,
    review.status === 0);
  const reviewed = codexOf(askStatus());
  check(`C3 ... and status now reports \`enforced\` for that exact, reviewed configuration (got ${show(reviewed.state)})`,
    reviewed.state === 'enforced');

  // An unrelated change — something this project's bridge does not own — must not disturb it.
  const unrelatedChanged = good.replace('keep_me = "yes"', 'keep_me = "still-yes"');
  check('C3 the unrelated-change case was actually constructed', unrelatedChanged !== good && unrelatedChanged.includes('still-yes'));
  fs.writeFileSync(CODEX_CONFIG, unrelatedChanged);
  const afterUnrelated = codexOf(askStatus());
  check(`C3 ... a change ELSEWHERE in the file does not invalidate the review (got ${show(afterUnrelated.state)})`,
    afterUnrelated.state === 'enforced');
  fs.writeFileSync(CODEX_CONFIG, good);

  // A change to one of OUR OWN command definitions invalidates it.
  const mutated = mutateOurCommands(good);
  check('C3 the own-definition-changed case was actually constructed', Boolean(mutated) && mutated !== good);
  if (mutated) {
    fs.writeFileSync(CODEX_CONFIG, mutated);
    const afterMutation = codexOf(askStatus());
    check(`C3 ... but a change to one of OUR OWN installed command definitions invalidates the review — no longer \`enforced\` (got ${show(afterMutation.state)})`,
      afterMutation.state !== 'enforced');
  }
  fs.writeFileSync(CODEX_CONFIG, good);
  node(CLI, ['review', '--client', 'codex'], { env: clientEnv });

  const missingIdentity = good.replace(/\s+--client\s+codex/g, '');
  check('C3/C0 the missing-client-identity case was actually constructed', missingIdentity !== good);
  fs.writeFileSync(CODEX_CONFIG, missingIdentity);
  const missingIdentityStatus = codexOf(askStatus());
  check(`C3/C0 a Codex configuration whose handler does not explicitly identify Codex is not enforced (got ${show(missingIdentityStatus.state)})`,
    CLIENT_STATES.length > 0 && CLIENT_STATES.includes(String(missingIdentityStatus.state))
    && missingIdentityStatus.state !== 'enforced');
  fs.writeFileSync(CODEX_CONFIG, good);
  node(CLI, ['review', '--client', 'codex'], { env: clientEnv });

  // (d) malformed stays truthful.
  const malformed = `${good}\nstray = "unterminated\n`;
  fs.writeFileSync(CODEX_CONFIG, malformed);
  const malformedStatus = codexOf(askStatus());
  check(`C3 a malformed profile (an unterminated string) is reported truthfully — a known state, and NOT \`enforced\` (got ${show(malformedStatus.state)})`,
    CLIENT_STATES.length > 0 && CLIENT_STATES.includes(String(malformedStatus.state)) && malformedStatus.state !== 'enforced');
  fs.writeFileSync(CODEX_CONFIG, good);
  node(CLI, ['review', '--client', 'codex'], { env: clientEnv });

  // (e) missing-handler stays truthful — the same coverage question §C0 asks, at status time.
  const missingPatch = removeGroupByMatcher(good, MATCHER_PATCH);
  check('C3/C0 the missing-handler case was actually constructed: the apply_patch group is gone and the Bash group is still there',
    Boolean(missingPatch) && groupsWithExactMatcher(parseToml(missingPatch || ''), MATCHER_PATCH).length === 0
    && groupsWithExactMatcher(parseToml(missingPatch || ''), MATCHER_BASH).length === 1);
  if (missingPatch) {
    fs.writeFileSync(CODEX_CONFIG, missingPatch);
    const missingStatus = codexOf(askStatus());
    check(`C3/C0 a Codex configuration missing the apply_patch handler is reported truthfully — NOT \`enforced\` (got ${show(missingStatus.state)})`,
      CLIENT_STATES.length > 0 && CLIENT_STATES.includes(String(missingStatus.state)) && missingStatus.state !== 'enforced');
  }
  fs.writeFileSync(CODEX_CONFIG, good);

  // (f) centrally managed policy needs none of the above.
  const CODEX_DIR_MANAGED = path.join(tmp, 'client-codex-managed');
  const CLAUDE_DIR_MANAGED = path.join(tmp, 'client-claude-managed');
  fs.mkdirSync(CODEX_DIR_MANAGED, { recursive: true });
  fs.mkdirSync(CLAUDE_DIR_MANAGED, { recursive: true });
  const managedEnv = {
    WRITE_PROTECTION_CLAUDE_DIR: CLAUDE_DIR_MANAGED,
    WRITE_PROTECTION_CODEX_DIR: CODEX_DIR_MANAGED,
    WRITE_PROTECTION_MANAGED: '1',
  };
  node(CLI, ['install'], { env: managedEnv });
  const managedStatus = askStatus(managedEnv);
  const managedCodex = codexOf(managedStatus);
  check(`C3 a centrally managed installation is \`enforced\` with NO review record at all (got ${show(managedCodex.state)})`,
    managedCodex.state === 'enforced');
  check(`C3 ... and \`enforcementComplete\` can be true under managed policy without personal review (got ${show(managedStatus.json && managedStatus.json.enforcementComplete)})`,
    managedStatus.json && managedStatus.json.enforcementComplete === true);

  // =====================================================================================
  // §C4 — a human gate this suite documents and validates the machinery under, and does not
  //       perform: no `codex` process is spawned anywhere in this directory, the direct-dispatch
  //       refusal never says "Hook Failed", and file/Git evidence is trusted only once the
  //       dispatch that produced it is confirmed to have actually run.
  // =====================================================================================

  const OWN_SOURCE = [__filename, path.join(__dirname, 'guard.js')]
    .map((f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } }).join('\n');
  // Built by concatenation on purpose: the marker strings this checks for never appear as
  // CONTIGUOUS text anywhere in this suite's own source, so this check cannot trigger on
  // itself — only on an actual call this suite is forbidden from making.
  const CLI_NAME = ['c', 'o', 'd', 'e', 'x'].join('');
  const SPAWN_MARKERS = [
    `spawnSync('${CLI_NAME}'`, `spawnSync("${CLI_NAME}"`, `spawnSync(${CLI_NAME}Bin`,
    `execFileSync('${CLI_NAME}'`, `execFileSync("${CLI_NAME}"`, `execFileSync(${CLI_NAME}Bin`,
    `execSync('${CLI_NAME}`, `execSync("${CLI_NAME}`, `execSync(\`${CLI_NAME}`,
  ];
  const spawnsCli = SPAWN_MARKERS.filter((m) => OWN_SOURCE.includes(m));
  check(`C4 nothing in tests/acceptance/repo-wwi/ spawns the Codex CLI — the deterministic suite performs no host verification itself (found ${show(spawnsCli)})`,
    spawnsCli.length === 0);

  const BLACKBOX = makeTarget('blackbox');
  const BLACKBOX_FILE = path.join(BLACKBOX, 'runner', 'run.js');
  const BLACKBOX_SHA = sha(BLACKBOX_FILE);
  const BLACKBOX_STATUS = gitStatus(BLACKBOX);
  const patchAttempt = hookCommand(patchCommand,
    { session_id: 'sC4', cwd: BLACKBOX, tool_name: TOOL_PATCH, tool_input: { command: PATCH_PROTECTED } },
    { cwd: BLACKBOX, env: clientEnv });
  const dispatchRanCleanly = typeof patchAttempt.status === 'number';
  if (check(`C4 the direct-dispatch refusal of a protected apply_patch actually ran, so what follows is evidence and not an ambiguous process failure (status ${show(patchAttempt.status)})`,
    dispatchRanCleanly)) seen.dispatch += 1;
  check(`C4 ... and its answer never says "Hook Failed" — a denial rendered as a decision, not a crash (stdout ${show(patchAttempt.stdout.trim().slice(0, 120))}, stderr ${show(patchAttempt.stderr.trim().slice(0, 120))})`,
    dispatchRanCleanly && !HOOK_FAILED_TEXT.test(patchAttempt.stdout) && !HOOK_FAILED_TEXT.test(patchAttempt.stderr));
  check(`C4 ... and only because it ran do the protected file's unchanged hash (${show(BLACKBOX_SHA && BLACKBOX_SHA.slice(0, 12))}) and unchanged \`git status\` count as evidence`,
    dispatchRanCleanly && sha(BLACKBOX_FILE) === BLACKBOX_SHA && gitStatus(BLACKBOX) === BLACKBOX_STATUS);

  const docFiles = (() => {
    const out = [];
    const visit = (dir, depth) => {
      let names = [];
      try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of names) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (depth > 0 && entry.name !== 'archive') visit(p, depth - 1); continue; }
        if (/\.md$/i.test(entry.name) && !/^planning-draft-|^spec-draft-|^change-log\.md$/.test(entry.name)) out.push(p);
      }
    };
    visit(REPO, 0);
    visit(path.join(REPO, 'docs'), 2);
    return out;
  })();
  const RECIPE_TERMS = [/\/hooks\b/, new RegExp(TOOL_PATCH, 'i'), new RegExp(TOOL_BASH, 'i'),
    /\btrust(ed)?\b/i, /\bgit status\b|\bhash\b/i, /\bseparate\b|\bno bypass\b|\bnormal\b/i];
  const recipeHit = (() => {
    for (const file of docFiles) {
      let text = [];
      try { text = fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch { continue; }
      for (let i = 0; i < text.length; i += 1) {
        const window = text.slice(i, i + 80).join('\n');
        if (RECIPE_TERMS.every((re) => re.test(window))) return { file: path.relative(REPO, file), line: i + 1 };
      }
    }
    return null;
  })();
  check(`C4 the documentation carries the human recipe this suite cannot execute — interactive \`/hooks\` review, then SEPARATE normal trusted apply_patch and Bash string-write attempts whose denials leave hashes and git status unchanged (searched ${docFiles.length} documents; found ${show(recipeHit)})`,
    Boolean(recipeHit));

  // =====================================================================================
  // §C5 — the change log and the documentation both correct repo-gy3 and PR #82, in this
  //       issue's own vocabulary: trust, and a structured denial schema.
  // =====================================================================================

  let logText = null;
  try { logText = fs.readFileSync(CHANGE_LOG, 'utf8'); } catch { logText = null; }
  check('C5 docs/change-log.md is still readable', logText !== null);
  const rows = String(logText || '').split(/\r?\n/)
    .filter((line) => line.trim().startsWith('|'))
    .map((line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim()));
  const ours = rows.filter((cells) => cells.length >= 4 && cells[1].replace(/`/g, '') === REF);
  check(`C5 docs/change-log.md carries a row with Ref \`${REF}\` (found ${ours.length})`,
    ours.length === 1);
  if (ours.length === 1) {
    const [date, , claim, reason] = ours[0];
    check(`C5 that row carries a dated cell in the log's own format — got ${show(date)}`,
      /^\d{4}-\d{2}-\d{2}$/.test(date));
    check(`C5 that row states a claim rather than a placeholder (${claim.length} chars)`, claim.length >= 80);
    check(`C5 that row states the reason the correction was needed (${reason.length} chars)`, reason.length >= 80);
    const both = `${claim} ${reason}`;
    check(`C5 and the row explicitly names \`${CORRECTED_REF}\` as a claim it corrects`,
      new RegExp(CORRECTED_REF, 'i').test(both));
    check(`C5 and the row explicitly names PR #${CORRECTED_PR} as the other claim it corrects`,
      new RegExp(`#\\s*${CORRECTED_PR}\\b`).test(both));
    check(`C5 and the row explicitly names rejected PR #${REJECTED_PR}`,
      new RegExp(`#\\s*${REJECTED_PR}\\b`).test(both));
    check('C5 and the row states this issue\'s own corrected vocabulary — trust, explicit client identity, string command input, and a structured denial schema',
      /\btrust\b/i.test(both) && /client/i.test(both) && /string/i.test(both)
      && /(structured|hookSpecificOutput|json)/i.test(both));
  }

  const CORRECTION_TERMS = [
    new RegExp(CORRECTED_REF, 'i'),
    new RegExp(`#\\s*${CORRECTED_PR}\\b`),
    new RegExp(`#\\s*${REJECTED_PR}\\b`),
    /\btrust\b/i,
    /client/i,
    /string/i,
    /(structured|hookSpecificOutput|permissionDecision)/i,
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
  check(`C5 the documentation explicitly corrects \`${CORRECTED_REF}\`, PR #${CORRECTED_PR}, and rejected PR #${REJECTED_PR} in one passage, naming trust, explicit client identity, string input, and structured denial (searched ${docFiles.length} documents; found ${show(correctionHit)})`,
    Boolean(correctionHit));

  // Non-vacuity, said once and out loud.
  check(`this suite's structural, dispatch, deny, allow and interpreter coverage is non-vacuous (structural ${seen.structural}, dispatch ${seen.dispatch}, denied ${seen.denied}, allowed ${seen.allowed}, interpreted ${seen.interpreted})`,
    seen.structural > 0 && seen.dispatch > 0 && seen.denied > 0 && seen.allowed > 0 && seen.interpreted > 0);

  const cleanupEnvs = [clientEnv, txtEnv, managedEnv];
  for (const env of cleanupEnvs) node(CLI, ['uninstall'], { env });
} catch (e) {
  failed = 1;
  console.log(`FAIL - HARNESS BROKEN: unexpected exception: ${e && e.stack ? e.stack : e}`);
} finally {
  rmrf(tmp);
}
process.exit(failed);
