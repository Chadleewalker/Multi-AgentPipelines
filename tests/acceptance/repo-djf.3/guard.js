// Frozen acceptance test — repo-djf.3 legacy API-key mode [guard].
// [guard] C1: the established explicit API-key configuration and Docker boundary remain valid.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const REPO = path.resolve(__dirname, '..', '..', '..');
const CONFIG = require(path.join(REPO, 'runner', 'config.js'));
const CONTAINER = require(path.join(REPO, 'runner', 'container.js'));
let failed = 0;
function check(name, yes) { console.log(`${yes ? 'ok' : 'FAIL'} - ${name}`); if (!yes) failed = 1; }
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-djf3-guard-'));
try {
  const file = path.join(root, 'run.config.json');
  fs.writeFileSync(file, JSON.stringify({ targetRepoPath: 'C:/fixture', targetRepoRemote: 'https://example.invalid/f.git', image: 'fixture:image', provider: 'codex' }));
  const cfg = CONFIG.loadConfig(file);
  const args = CONTAINER.buildArgs(cfg, { containerName: 'guard', workspaceDir: 'work', pipelineDir: 'pipe', issueId: 'repo-djf.3', credential: { name: 'CODEX_API_KEY', value: 'not-in-argv' } });
  check('C1 [guard] existing Codex API-key configuration still resolves as Codex', cfg.provider === 'codex');
  check('C1 [guard] existing API-key launch carries its name but never its value in Docker argv', args.includes('CODEX_API_KEY') && !args.join('\n').includes('not-in-argv'));
} catch (e) { check('C1 [guard] legacy API-key fixture runs', false); }
finally { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} }
process.exit(failed);
