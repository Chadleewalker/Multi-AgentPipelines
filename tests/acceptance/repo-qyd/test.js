// Frozen acceptance test — Task A: advisor registry + the three planning-critic
// charters (DESIGN.md §3.5 slot 1, §3.2). Written before implementation; criteria
// A1–A4 of the approved spec. Plain Node, Docker-free.
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ADV = path.join(ROOT, 'advisors');
let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) failed = 1;
}
function read(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

// A1: README exists with the mandated literals.
const readme = read(path.join(ADV, 'README.md'));
check('A1 advisors/README.md exists', readme !== null);
if (readme !== null) {
  for (const lit of ['## Lens', '## Checks', '## Output', 'advisories', 'status.schema.json']) {
    check(`A1 README contains literal "${lit}"`, readme.includes(lit));
  }
  for (const word of ['ok', 'concerns', 'error']) {
    check(`A1 README contains whole word "${word}"`, new RegExp(`\\b${word}\\b`).test(readme));
  }
}

// A2: the three charters exist, each with the mandated h2 headings on their own lines.
const charters = ['ambiguity', 'testability', 'scope'];
const texts = {};
for (const c of charters) {
  const t = read(path.join(ADV, `${c}.md`));
  texts[c] = t;
  check(`A2 advisors/${c}.md exists`, t !== null);
  if (t === null) continue;
  for (const h of ['Lens', 'Checks', 'Output']) {
    check(`A2 ${c}.md has line "## ${h}"`, new RegExp(`^## ${h}\\s*$`, 'm').test(t));
  }
}

// A3: the testability charter encodes the shadow-01 lesson.
const tst = texts['testability'];
if (tst !== null) {
  check('A3 testability.md contains NODE_TEST_CONTEXT', tst.includes('NODE_TEST_CONTEXT'));
  check('A3 testability.md mentions nested/self-nesting tests', /nested test|self-nest/i.test(tst));
  check('A3 testability.md mentions environment inheritance', /environment inherit/i.test(tst));
}

// A4: exactly one ```json fence per charter; JSON parses and matches the advisories
// item shape (keys subset, verdict enum, types).
function fences(text) {
  const lines = text.split('\n');
  const out = [];
  let buf = null;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (buf === null) {
      if (/^```json\s*$/.test(line)) buf = [];
    } else if (/^```\s*$/.test(line)) {
      out.push(buf.join('\n'));
      buf = null;
    } else {
      buf.push(line);
    }
  }
  return out;
}
const ALLOWED = new Set(['advisor', 'verdict', 'summary', 'details']);
for (const c of charters) {
  const t = texts[c];
  if (t === null) continue;
  const f = fences(t);
  check(`A4 ${c}.md has exactly one json fence (found ${f.length})`, f.length === 1);
  if (f.length !== 1) continue;
  let obj = null;
  try { obj = JSON.parse(f[0]); } catch { /* fails below */ }
  const isObj = obj !== null && typeof obj === 'object' && !Array.isArray(obj);
  check(`A4 ${c}.md fence parses to an object`, isObj);
  if (!isObj) continue;
  check(`A4 ${c}.md keys subset of advisories shape`, Object.keys(obj).every((k) => ALLOWED.has(k)));
  check(`A4 ${c}.md advisor is a string`, typeof obj.advisor === 'string');
  check(`A4 ${c}.md summary is a string`, typeof obj.summary === 'string');
  check(`A4 ${c}.md verdict in enum`, ['ok', 'concerns', 'error'].includes(obj.verdict));
  if ('details' in obj) {
    check(`A4 ${c}.md details is array of strings`,
      Array.isArray(obj.details) && obj.details.every((d) => typeof d === 'string'));
  }
}

process.exit(failed);
