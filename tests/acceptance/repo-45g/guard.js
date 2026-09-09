// Frozen acceptance test — repo-45g, the legacy-Claude [guard] half.
// [guard] Every check here is GREEN at the fork point. This file proves only C1's
// byte-for-byte absent-field fallback, C2/C7's Claude author/probe launch path, C3's
// Claude credential, and C4's Anthropic-only profile. All Codex requirements are red in test.js.
// It is self-contained and Docker-free: the launch seam is a deterministic fake executable.
'use strict';
const path = require('path');
const AUTHOR = require(path.resolve(__dirname, '..', '..', '..', 'scripts', 'author-tests.js'));
const PROBE = require(path.resolve(__dirname, '..', '..', '..', 'scripts', 'prove-tests.js'));
const CONTAINER = require(path.resolve(__dirname, '..', '..', '..', 'runner', 'container.js'));
const fs = require('fs');
let failed = 0;
function check(name, yes, detail = '') {
  console.log(`${yes ? 'ok' : 'FAIL'} - ${name}${yes || !detail ? '' : ` — ${detail}`}`);
  if (!yes) failed = 1;
}
function captured(fn) {
  let call = null;
  const result = fn((command, args, opts) => {
    call = { command, args, opts };
    return { status: 0, stdout: '', stderr: '' };
  });
  return { call, result };
}
const cfg = { wallClockMinutes: 7, model: 'opus', hostEnv: { AUTHOR_ONLY: 'present' } };
const built = {
  id: 'repo-45g', suiteId: 'repo-45g', cfg, text: 'legacy author prompt',
  policy: { verifyCommand: 'sh tools/run-acceptance.sh' }, folder: { dir: 'C:/legacy author tree' },
};
const author = captured((run) => AUTHOR.launchAuthor(built, 'opus', run));
const probe = captured((run) => PROBE.launchProbe(built, { probe: 'C:/legacy probe tree' }, 'opus', '', run));
const authorArgs = ['-p', '--model', 'opus', '--restricted', '--permission-mode', 'acceptEdits',
  '--tools', AUTHOR.AUTHOR_TOOLS, '--allowedTools', 'Read,Edit,Write,Glob,Grep,Bash(sh tools/run-acceptance.sh tests/acceptance/repo-45g/)',
  '--disallowedTools', AUTHOR.DENIED_TOOLS, '--no-session-persistence'];
const probeArgs = ['-p', '--model', 'opus', '--restricted', '--permission-mode', 'acceptEdits',
  '--tools', PROBE.PROBE_TOOLS, '--allowedTools', PROBE.PROBE_TOOLS,
  '--disallowedTools', PROBE.PROBE_DENIED, '--no-session-persistence'];
check('C1 [guard] absent provider fields retain the Claude test-author argv byte-for-byte',
  author.call && author.call.command === 'claude' && JSON.stringify(author.call.args) === JSON.stringify(authorArgs), JSON.stringify(author.call));
check('C1 [guard] absent provider fields retain the Claude test-probe argv byte-for-byte',
  probe.call && probe.call.command === 'claude' && JSON.stringify(probe.call.args) === JSON.stringify(probeArgs), JSON.stringify(probe.call));
check('C2 [guard] Claude author still receives stdin, its worktree, hostEnv, and the configured timeout',
  author.call && author.call.opts.input === 'legacy author prompt\n' && author.call.opts.cwd === built.folder.dir
    && author.call.opts.env.AUTHOR_ONLY === 'present' && author.call.opts.timeoutMs === 420000);
check('C2 [guard] Claude probe remains shell-free, gets stdin, omits hostEnv, and keeps its timeout',
  probe.call && probe.call.opts.input.includes('GREEN PROBE') && probe.call.opts.cwd === 'C:/legacy probe tree'
    && probe.call.opts.env.AUTHOR_ONLY === undefined && probe.call.opts.timeoutMs === 420000);
check('C7 [guard] legacy launch fakes propagate the executable success status unchanged',
  author.result.status === 0 && probe.result.status === 0);
check('C3 [guard] Claude container tasks still receive CLAUDE_CODE_OAUTH_TOKEN by name',
  CONTAINER.buildArgs({ network: 'n', proxyUrl: 'http://p', image: 'i', provider: 'claude' },
    { containerName: 'c', workspaceDir: 'C:/w', pipelineDir: 'C:/p', issueId: 'x', token: 'fixture' }).includes('CLAUDE_CODE_OAUTH_TOKEN'));
const anthropic = path.resolve(__dirname, '..', '..', '..', 'docker', 'proxy', 'allowlist.txt');
const anthText = fs.existsSync(anthropic) ? fs.readFileSync(anthropic, 'utf8') : '';
check('C4 [guard] the existing Anthropic-only proxy profile remains an Anthropic profile, not OpenAI',
  /api\.anthropic\.com/.test(anthText) && !/api\.openai\.com/.test(anthText));
process.exit(failed);
