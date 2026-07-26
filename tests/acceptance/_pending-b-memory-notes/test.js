// Frozen acceptance test — Task B: container-side memory contract (DESIGN.md §3.6
// out-channel + in-channel consumer, §4.11). Written before implementation;
// criteria B1–B5 of the approved spec. Plain Node, Docker-free.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const STATUS_JS = path.join(ROOT, 'pipeline', 'status.js');
let failed = 0;
function check(name, cond) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) failed = 1;
}

// B1: schema declares memoryNotes inline with the pinned bounds.
const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'status.schema.json'), 'utf8'));
const mn = (schema.properties || {}).memoryNotes;
check('B1 memoryNotes declared', mn !== undefined);
if (mn) {
  check('B1 type array', mn.type === 'array');
  check('B1 maxItems 20', mn.maxItems === 20);
  check('B1 items type string', mn.items && mn.items.type === 'string');
  check('B1 items maxLength 500', mn.items && mn.items.maxLength === 500);
}
check('B1 additionalProperties still false', schema.additionalProperties === false);

// B2/B3: status.js note behavior, driven as a child process in a temp RUN_DIR.
function note(runDir, text) {
  return spawnSync(process.execPath, [STATUS_JS, 'note', text],
    { encoding: 'utf8', env: { ...process.env, RUN_DIR: runDir } });
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-b-'));
const statusFile = path.join(tmp, 'status.json');
const notes = (st) => (Array.isArray(st.memoryNotes) ? st.memoryNotes : []);
spawnSync(process.execPath, [STATUS_JS, 'init', 'test-issue'],
  { encoding: 'utf8', env: { ...process.env, RUN_DIR: tmp } });
check('B2 init created status.json', fs.existsSync(statusFile));

note(tmp, 'first');
note(tmp, 'second');
let st = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
check('B2 notes append in order',
  notes(st).length === 2 && notes(st)[0] === 'first' && notes(st)[1] === 'second');

const long = 'a'.repeat(300) + 'b'.repeat(300);
note(tmp, long);
st = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
check('B2 truncation keeps the first 500 chars',
  notes(st).length === 3 && notes(st)[2] === 'a'.repeat(300) + 'b'.repeat(200));

for (let i = notes(st).length; i < 20; i++) note(tmp, `filler ${i}`);
st = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
check('B2 filled to 20 notes', notes(st).length === 20);
const over = note(tmp, 'twenty-first');
st = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
check('B2 21st note exits 0', over.status === 0);
check('B2 21st note dropped, length still 20',
  notes(st).length === 20 && !notes(st).includes('twenty-first'));

// B3: no status.json -> non-zero exit, nothing created.
const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'accept-b3-'));
const r3 = note(tmp2, 'x');
check('B3 note without status.json exits non-zero', r3.status !== 0);
check('B3 no status.json created', !fs.existsSync(path.join(tmp2, 'status.json')));

// B4: the entrypoint prompt wiring, on non-comment lines.
const ep = fs.readFileSync(path.join(ROOT, 'pipeline', 'entrypoint.sh'), 'utf8');
const nonComment = ep.split('\n').filter((l) => !/^\s*#/.test(l));
check('B4 entrypoint references status.js note (non-comment)',
  nonComment.some((l) => l.includes('status.js note')));
check('B4 entrypoint references memory.md (non-comment)',
  nonComment.some((l) => l.includes('memory.md')));

// B5: the valid example covers the field.
const ex = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'examples', 'status.valid.json'), 'utf8'));
check('B5 valid example has memoryNotes with >=1 entry',
  Array.isArray(ex.memoryNotes) && ex.memoryNotes.length >= 1 &&
  ex.memoryNotes.every((n) => typeof n === 'string' && n.length <= 500));

process.exit(failed);
