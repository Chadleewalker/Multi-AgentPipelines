// Frozen acceptance test — repo-djf.6. [guard]
// [guard] C1 relies on the established Codex CLI hardening: its exec invocation is ephemeral,
// noninteractive, ignores user configuration, and excludes CODEX_API_KEY from child shells.
'use strict';
const path = require('path');
const REPO = path.resolve(__dirname, '..', '..', '..');
const provider = require(path.join(REPO, 'runner', 'agent-provider.js'));
let failed = 0;
function check(name, yes) { console.log(`${yes ? 'ok' : 'FAIL'} - ${name}`); if (!yes) failed = 1; }
const argv = provider.codexExecArgs('gpt-5.6-terra', 'low');
check('C1 [guard] existing Codex exec remains ephemeral, noninteractive and isolated from user configuration',
  argv.includes('--ephemeral') && argv.includes('--ignore-user-config') && argv.includes('--json') && argv.at(-1) === '-');
check('C1 [guard] existing Codex exec continues to exclude CODEX_API_KEY from child-shell environments',
  argv.some((part) => String(part).includes('shell_environment_policy.filters.CODEX_API_KEY') && String(part).includes('exclude')));
process.exit(failed);
