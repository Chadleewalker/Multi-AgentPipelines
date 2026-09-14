// Frozen acceptance guard — repo-djf.33. [guard]
// Criteria -> tests: C4 -> guard.js + test.js; C1-C3 -> test.js.
// Tests -> criteria: this guard serves C4's retained managed-auth, publication,
// credential-hygiene, and mandatory-regression surfaces.
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const ENTRYPOINT = path.join(ROOT, 'pipeline', 'entrypoint.sh');
let failed = 0;
function check(name, yes, detail = '') {
  console.log(`${yes ? 'ok' : 'FAIL'} - ${name}${yes ? '' : ` — ${detail}`}`);
  if (!yes) failed = 1;
}
const source = (() => { try { return fs.readFileSync(ENTRYPOINT, 'utf8'); } catch { return ''; } })();
const config = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'pipeline.config.json'), 'utf8')); } catch { return null; } })();

check('C4 [guard] managed ChatGPT verification remains key-free and runs as nobody',
  /runuser -u nobody -- env -u CODEX_API_KEY -u OPENAI_API_KEY -u CODEX_HOME/.test(source));
check('C4 [guard] the managed Codex agent remains the unprivileged node user with its internal cache only',
  /runuser -u node --preserve-environment -- env CODEX_HOME=\/root\/\.codex/.test(source)
    && !/CODEX_HOME=\/run\/pipeline-auth-host\/cache/.test(source));
check('C4 [guard] docs publication remains a detached worktree, Markdown-only transfer, and final verification boundary',
  /git worktree add --detach "\$DOCS_WORKTREE" "\$VERIFIED_HEAD"/.test(source)
    && /docs_paths_allowed "\$VERIFIED_HEAD"/.test(source)
    && /git apply --index/.test(source) && /remove_new_workspace_paths/.test(source));
check('C4 [guard] mandatory regression policy remains required and runnable',
  config && config.regressionPolicy === 'required' && config.regressionCommand === 'bash scripts/test-ci.sh'
    && fs.existsSync(path.join(ROOT, 'scripts', 'test-ci.sh')));
process.exitCode = failed;
