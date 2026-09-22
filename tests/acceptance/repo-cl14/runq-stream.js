'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const root = path.resolve(__dirname, '../../..');
const source = fs.readFileSync(path.join(root, 'scripts/test-runner-queue.sh'), 'utf8');
const runq = source.split(/\r?\n/).find((line) => line.startsWith('runq() {'));
assert.ok(runq, 'T12 runq function missing');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-cl14-'));
(async () => {
  try {
    const script = `TMP=${JSON.stringify(tmp.replace(/\\/g, '/'))}\nCFG=/unused\nnode() { printf 'live-marker\\n'; i=0; while [ ! -f "$TMP/release" ]; do i=$((i+1)); [ "$i" -ge 30 ] && return 88; sleep 0.1; done; return 7; }\n${runq}\nOUT=$(runq stub task)\nRC=$?\nprintf 'CAPTURE=%s\\nRC=%s\\n' "$OUT" "$RC"\n`;
    const child = spawn('bash', ['-c', script], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let released = false;
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (!released && stderr.includes('live-marker')) {
        released = true;
        fs.writeFileSync(path.join(tmp, 'release'), 'go');
      }
    });
    const exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill(); reject(new Error('runq streaming check timed out')); }, 10000);
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('close', (code) => { clearTimeout(timer); resolve(code); });
    });
    assert.strictEqual(exitCode, 0, stderr);
    assert.ok(released, 'runq did not stream progress before the runner completed');
    assert.match(stdout, /CAPTURE=live-marker/, 'runq did not capture runner output');
    assert.match(stdout, /RC=7/, 'runq masked the runner exit status');
    console.log('PASS: T12 streams live, captures output, and preserves exit status');
  } finally {
    const resolved = path.resolve(tmp);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep), 'temporary cleanup path escaped OS temp');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
