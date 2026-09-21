#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// Unit suite for the pipeline-map build — scripts/build-pipeline-map.js (DESIGN.md §12,
// change-log row `map-prerender`). Run it as `node tests/unit/pipeline-map-build.test.js`
// from anywhere; the sweep picks it up through scripts/test-pipeline-map.sh.
//
// Plain Node, no test framework, no Docker, no network, and — the point of the seam —
// NO mermaid-cli. The real renderer lives in tools/mapbuild/node_modules, which is
// git-ignored and absent from a fresh clone and from every task container, so a suite
// that drove the real thing would fail everywhere except this one machine. MAP_MMDC
// aims the builder at a stand-in written into a throwaway temp directory; per CLAUDE.md
// it is a `.js` file invoked through process.execPath, never a `#!/bin/sh` script, which
// spawnSync fails with EFTYPE on the Windows host.
//
// WHAT THIS SUITE IS REALLY FOR. The builder's job is to notice when a diagram came back
// WRONG, and both times that check has been got wrong it was wrong in the same direction
// — it read something true of every render as evidence of failure, or something true of
// a failure as evidence of success:
//
//   * Every successful mermaid render ships a stylesheet defining `.error-icon` and
//     `.error-text`. The first version of the guard searched the whole file for those
//     words and therefore rejected all ten diagrams, including the nine that were fine.
//     Check 3 is that fixture, and it is the load-bearing one: it is a GOOD svg whose
//     stylesheet carries the exact bytes that used to trip the alarm.
//   * A mermaid error card is itself a well-formed, non-empty svg (CLAUDE.md, "the
//     harder failures write something plausible and wrong"). Check 4 is its twin, and
//     the pair has to be read together — check 3 alone could be passed by deleting the
//     guard, and check 4 alone by rejecting everything.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'build-pipeline-map.js');

// The suite owns its fixtures: a seam inherited from the shell would let the caller's
// environment decide the result, and MAP_OUT in particular would aim a write at the
// real docs/ tree.
delete process.env.MAP_SRC;
delete process.env.MAP_OUT;
delete process.env.MAP_MMDC;

let failed = 0;
function check(name, cond, detail) {
  console.log(`${cond ? 'ok' : 'FAIL'} - ${name}`);
  if (!cond) {
    failed = 1;
    if (detail) console.log(`       ${String(detail).split('\n').join('\n       ')}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mapbuild-test-'));

// ---------------------------------------------------------------------------
// The stand-in renderer.
//
// It reproduces the three things about mermaid-cli's real output that the builder has
// to cope with: a standalone XML document (declaration and doctype ahead of the root),
// an id-scoped stylesheet, and — critically — that stylesheet's `.error-icon` rules,
// which are present whether or not anything went wrong. What it draws is decided by a
// marker in the diagram source, so one stub serves every case.
// ---------------------------------------------------------------------------
const STUB = path.join(tmp, 'mmdc-stub.js');
fs.writeFileSync(STUB, `'use strict';
const fs = require('fs');
const a = process.argv.slice(2);
function opt(f) { const i = a.indexOf(f); return i < 0 ? null : a[i + 1]; }
const inFile = opt('-i'), outFile = opt('-o'), svgId = opt('-I') || 'my-svg';
const src = fs.readFileSync(inFile, 'utf8');

// Echo exactly what the builder handed us back through the svg, base64 so no diagram
// text can break the markup. This is what lets the suite prove entity decoding happened
// BEFORE the renderer saw the text rather than after — the builder deletes its own temp
// directory, so a sidecar file would be gone by the time the suite could read it.
const echo = Buffer.from(src, 'utf8').toString('base64');

if (src.indexOf('EXIT_FAIL') !== -1) {
  process.stderr.write('stub: refusing to render\\n');
  process.exit(1);
}
if (src.indexOf('WRITE_NOTHING') !== -1) process.exit(0);

// The stylesheet every real render carries, error or not. The .error-icon and
// .error-text rules are mermaid's own; the comment is this fixture's doing, and it is
// deliberate — it states the rule the guard has to obey (do not read the stylesheet)
// strongly enough that a guard which merely searches the whole file for the words
// cannot pass. Without it the style-stripping is unobservable and could be deleted.
const style = '<style>/* Syntax error in text: none */#' + svgId +
  ' .node rect{fill:#eee;}#' + svgId +
  ' .error-icon{fill:#552222;}#' + svgId +
  ' .error-text{fill:#552222;stroke:#552222;}</style>';

let body;
if (src.indexOf('MERMAID_ERROR') !== -1) {
  // A real error card: well-formed, non-empty, and wrong.
  body = '<svg id="' + svgId + '" aria-roledescription="error" viewBox="0 0 100 100">' +
    style + '<g class="error-icon"></g><text class="error-text">Syntax error in text</text></svg>';
} else if (src.indexOf('NO_NODES') !== -1) {
  body = '<svg id="' + svgId + '" viewBox="0 0 100 100">' + style + '<g class="nodes"></g></svg>';
} else {
  const n = (src.match(/^\\s*[A-Z]\\w*\\[/gm) || []).length || 1;
  let g = '';
  for (let i = 0; i < n; i++) g += '<g class="node default box"><rect/></g>';
  body = '<svg id="' + svgId + '" data-stub-input="' + echo + '" viewBox="0 0 100 100">' +
    style + '<g class="nodes">' + g + '</g></svg>';
}

fs.writeFileSync(outFile,
  '<?xml version="1.0" encoding="UTF-8"?>\\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd">\\n' +
  body + '\\n', 'utf8');
`, 'utf8');

// ---------------------------------------------------------------------------
// Fixtures and the driver.
// ---------------------------------------------------------------------------
function page(blocks) {
  return '<title>Fixture</title>\n<div class="wrap">\n' +
    blocks.map((b) => `  <div class="plate">\n<pre class="mermaid">\n${b}\n</pre>\n  </div>\n`).join('') +
    '</div>\n';
}

let caseNo = 0;
function build(html, opts) {
  const dir = path.join(tmp, `case-${++caseNo}`);
  fs.mkdirSync(dir, { recursive: true });
  const src = path.join(dir, 'in.html');
  const out = path.join(dir, 'out.html');
  fs.writeFileSync(src, html, 'utf8');
  const r = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      MAP_SRC: src,
      MAP_OUT: out,
      MAP_MMDC: (opts && opts.mmdc !== undefined) ? opts.mmdc : STUB,
    }),
  });
  return {
    dir,
    src,
    out,
    status: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    text: fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null,
  };
}

const GOOD_A = 'flowchart LR\n  A["one"] --> B["two"]';
const GOOD_B = 'flowchart TB\n  C["three"] --> D["four"]\n  D --> E["five"]';

// --- 1. the happy path ------------------------------------------------------
const happy = build(page([GOOD_A, GOOD_B]));
check('happy path exits 0', happy.status === 0, happy.stderr);
check('happy path writes the output page', happy.text !== null);
check('every mermaid block became an <svg>',
  happy.text && (happy.text.match(/<svg\b/g) || []).length === 2);
check('no <pre class="mermaid"> survives in the output',
  happy.text && !/<pre class="mermaid">/.test(happy.text));
check('the output is marked as generated',
  happy.text && /^<!--\s*\n\s*GENERATED FILE/.test(happy.text));
check('the report names the diagram count',
  /2 diagrams/.test(happy.stdout), happy.stdout);
check('the report carries a per-diagram node count',
  /\bnodes\b/.test(happy.stdout), happy.stdout);

// --- 2. surrounding prose is preserved --------------------------------------
check('prose around the blocks is left alone',
  happy.text && happy.text.includes('<title>Fixture</title>') &&
  (happy.text.match(/class="plate"/g) || []).length === 2);

// --- 3. THE LOAD-BEARING ONE ------------------------------------------------
// A good render whose stylesheet defines .error-icon / .error-text — the exact shape
// that made the first version of the guard fail all ten diagrams — must be accepted.
check('a good svg whose stylesheet mentions .error-icon is accepted',
  happy.status === 0 && happy.text && happy.text.includes('.error-icon{fill:#552222;}'),
  happy.stderr);

// --- 4. its twin: a real error card is refused ------------------------------
const errCard = build(page([GOOD_A, 'flowchart LR\n  MERMAID_ERROR --> X']));
check('a mermaid error card fails the build', errCard.status !== 0);
check('the error names which diagram failed',
  /diagram 1\b/.test(errCard.stderr), errCard.stderr);
check('no output page is written when a diagram fails', errCard.text === null);

// --- 5. an empty render is refused ------------------------------------------
const noNodes = build(page(['flowchart LR\n  NO_NODES --> X']));
check('an svg with no nodes fails the build', noNodes.status !== 0);
check('the no-nodes failure says so', /no nodes/i.test(noNodes.stderr), noNodes.stderr);

// --- 6. renderer failures surface -------------------------------------------
const boom = build(page(['flowchart LR\n  EXIT_FAIL --> X']));
check('a non-zero renderer exit fails the build', boom.status !== 0);
check('the renderer stderr is surfaced', /refusing to render/.test(boom.stderr), boom.stderr);

const silent = build(page(['flowchart LR\n  WRITE_NOTHING --> X']));
check('a renderer that writes no file fails the build', silent.status !== 0);

// --- 7. entities are decoded before the renderer sees them ------------------
// A label containing `<`, `>` or `&` has to be escaped in the authored page or it would
// close the <pre> — but mermaid must be handed the character, not the entity, or the
// label renders as literal `&amp;`. The stub echoes its input back through the svg, so
// this reads what the renderer actually received.
const ent = build(page([
  'flowchart LR\n  A["salt &amp; pepper"] --> B["&lt;tag&gt;"]\n  B --> C["&#39;quoted&#39;"]\n  C --> D["&#x2713; tick"]',
]));
check('entity fixture builds', ent.status === 0, ent.stderr);
const echoed = (() => {
  const m = ent.text && /data-stub-input="([^"]+)"/.exec(ent.text);
  return m ? Buffer.from(m[1], 'base64').toString('utf8') : '';
})();
check('named entities reach the renderer as characters',
  echoed.includes('salt & pepper') && echoed.includes('<tag>'), echoed);
check('numeric entities reach the renderer as characters',
  echoed.includes("'quoted'") && echoed.includes('✓ tick'), echoed);
check('no entity survives into the renderer input',
  echoed.length > 0 && !/&(amp|lt|gt|quot|#\d+|#x[0-9a-fA-F]+);/.test(echoed), echoed);

// --- 8. the standalone XML wrapper is stripped ------------------------------
check('the XML declaration is stripped', happy.text && !happy.text.includes('<?xml'));
check('the doctype is stripped', happy.text && !/<!DOCTYPE svg/i.test(happy.text));
check('each svg element survives intact',
  happy.text && (happy.text.match(/<\/svg>/g) || []).length === 2);

// --- 9. identical blocks are replaced separately ----------------------------
const dup = build(page([GOOD_A, GOOD_A, GOOD_B]));
check('two identical mermaid blocks both render', dup.status === 0, dup.stderr);
check('identical blocks are not collapsed into one',
  dup.text && (dup.text.match(/<svg\b/g) || []).length === 3);

// --- 10. ids are unique -----------------------------------------------------
const ids = dup.text ? (dup.text.match(/<svg id="([^"]+)"/g) || []) : [];
check('every svg gets its own id', ids.length === 3 && new Set(ids).size === 3, ids.join(' '));
check('the id scopes the stylesheet',
  dup.text && /#pipeline-map-0 \.node/.test(dup.text) && /#pipeline-map-2 \.node/.test(dup.text));

// --- 11. a missing renderer is a clear failure ------------------------------
const noMmdc = build(page([GOOD_A]), { mmdc: path.join(tmp, 'not-installed.js') });
check('a missing mermaid-cli fails the build', noMmdc.status !== 0);
check('the missing-renderer message says how to fix it',
  /npm install/.test(noMmdc.stderr), noMmdc.stderr);

// --- 12. a page with no diagrams is a failure, not an empty success ---------
const none = build('<title>x</title>\n<p>no diagrams here</p>\n');
check('a page with no mermaid blocks fails the build', none.status !== 0);
check('no output page is written for a page with no blocks', none.text === null);

// --- 13. the build writes nothing but its output ----------------------------
// The builder scratches in the OS temp dir, so that is where a leak would land — not
// under this suite's own fixture root. Snapshot it around a build and diff.
const scratchBefore = new Set(
  fs.readdirSync(os.tmpdir()).filter((n) => /^mapbuild-/.test(n))
);
const before = fs.readFileSync(happy.src, 'utf8');
const again = spawnSync(process.execPath, [SCRIPT], {
  encoding: 'utf8',
  env: Object.assign({}, process.env, {
    MAP_SRC: happy.src, MAP_OUT: happy.out, MAP_MMDC: STUB,
  }),
});
check('a rebuild exits 0', again.status === 0, again.stderr);
check('the source page is left byte-identical',
  fs.readFileSync(happy.src, 'utf8') === before);
check('the build is deterministic',
  fs.readFileSync(happy.out, 'utf8') === happy.text);
const leaked = fs.readdirSync(os.tmpdir())
  .filter((n) => /^mapbuild-/.test(n) && !scratchBefore.has(n));
check('the build leaves no scratch directory behind', leaked.length === 0, leaked.join(' '));

// --- 14. the builder stays dependency-free ----------------------------------
// Its whole warrant is that it is host-only scaffolding around one dev dependency; a
// require of anything else would make it need an install of its own.
const source = fs.readFileSync(SCRIPT, 'utf8');
const requires = (source.match(/require\(['"]([^'"]+)['"]\)/g) || [])
  .map((r) => r.replace(/^require\(['"]|['"]\)$/g, ''));
const builtins = new Set(['fs', 'os', 'path', 'child_process']);
check('the builder requires node built-ins only',
  requires.every((r) => builtins.has(r)), requires.join(' '));

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failed ? 'FAILED' : 'All pipeline-map build checks passed');
process.exit(failed);
