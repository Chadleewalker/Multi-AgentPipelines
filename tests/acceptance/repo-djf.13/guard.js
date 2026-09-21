// Frozen acceptance [guard] — repo-djf.13: post-spawn and settlement recovery remain intact.
'use strict';
const path = require('path');
const { spawnSync } = require('child_process');
const prior = path.resolve(__dirname, '..', 'repo-djf.12', 'test.js');
const result = spawnSync(process.execPath, [prior], { encoding: 'utf8', timeout: 30000 });
const ok = result.status === 0;
console.log(`${ok ? 'ok' : 'FAIL'} - C4 [guard] repo-djf.12 post-spawn and settlement recovery remains green`
  + `${ok ? '' : ` — ${String(result.stderr || result.stdout || '').slice(-1200)}`}`);
process.exitCode = ok ? 0 : 1;
