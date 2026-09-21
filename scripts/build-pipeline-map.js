#!/usr/bin/env node
// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0
'use strict';

/**
 * Pre-render the mermaid blocks in docs/pipeline-map.html to inline SVG.
 *
 * WHY THIS EXISTS. The authored page ships its diagrams as raw `<pre class="mermaid">`
 * text and draws none of them itself — it has no renderer, by deliberate choice (the
 * pan/zoom code says so: "no library is needed — which matters here, since the page
 * can't load one"). That handed the drawing to whatever host displayed the file, and a
 * host is not a contract:
 *
 *   - Opened from disk, the page renders NO diagrams at all.
 *   - Published as an artifact, the diagrams are drawn by the host's mermaid, whose
 *     version and config policy we do not control. The master map is the only block
 *     carrying a `%%{init}%%` config directive; a host that refuses directives drops
 *     that one diagram and keeps the other nine, which is exactly the failure that
 *     prompted this script.
 *
 * So the drawing moves to build time. The output is self-contained: every diagram is an
 * `<svg>` element in the file, present at parse time, identical everywhere.
 *
 * WHAT IT IS NOT. This is a host-only dev tool. Nothing in the pipeline — runner,
 * verifier, report generator — depends on it or on its node_modules; those stay
 * dependency-free (CLAUDE.md, "Node for everything"). It is never run inside a task
 * container, which has no npm and no route to one.
 *
 * Usage:
 *   node scripts/build-pipeline-map.js
 *
 * Env seams (used by tests and for re-aiming at a copy):
 *   MAP_SRC   input html   (default docs/pipeline-map.html)
 *   MAP_OUT   output html  (default docs/pipeline-map.built.html)
 *   MAP_MMDC  mermaid-cli entry point (default tools/mapbuild/node_modules/...)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = process.env.MAP_SRC || path.join(ROOT, 'docs', 'pipeline-map.html');
const OUT = process.env.MAP_OUT || path.join(ROOT, 'docs', 'pipeline-map.built.html');
const MMDC = process.env.MAP_MMDC || path.join(
  ROOT, 'tools', 'mapbuild', 'node_modules', '@mermaid-js', 'mermaid-cli', 'src', 'cli.js'
);

// A page wide enough that a 40-node left-to-right flowchart is laid out as one band
// rather than wrapped. This is the puppeteer viewport, not the diagram size — the SVG
// carries its own viewBox — but mermaid's layout does consult it.
const PAGE_W = 2400;
const PAGE_H = 1600;

const BLOCK = /<pre class="mermaid">([\s\S]*?)<\/pre>/g;

function fail(msg) {
  process.stderr.write('build-pipeline-map: ' + msg + '\n');
  process.exit(1);
}

/**
 * Undo HTML entity encoding. The authored blocks are mostly raw (`-->` is written as
 * itself), but a label containing a literal `<`, `>` or `&` has to be escaped in the
 * source or it would close the `<pre>`, and mermaid must see the character, not the
 * entity. Numeric forms are handled too, since a future edit may paste one in.
 */
function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;|&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    // Last, or it would undo the escaping of the entities above.
    .replace(/&amp;/g, '&');
}

/**
 * Keep only the `<svg>` element. mermaid-cli writes a standalone document, so the file
 * opens with an XML declaration and may carry a doctype; both are illegal inside an
 * HTML body and Chrome drops the whole node rather than the offending line.
 */
function svgElementOnly(doc, i) {
  const start = doc.indexOf('<svg');
  if (start < 0) fail(`diagram ${i}: mermaid-cli produced no <svg> element`);
  const end = doc.lastIndexOf('</svg>');
  if (end < 0) fail(`diagram ${i}: mermaid-cli produced an unterminated <svg>`);
  return doc.slice(start, end + '</svg>'.length);
}

function render(source, i, tmp) {
  const inFile = path.join(tmp, `block-${i}.mmd`);
  const outFile = path.join(tmp, `block-${i}.svg`);
  fs.writeFileSync(inFile, source, 'utf8');

  // A distinct id per diagram. mermaid-cli scopes the stylesheet it emits by this id
  // (`#my-svg .node { ... }`), so ten diagrams sharing the default would have each
  // one's styles apply to all ten — the last block on the page would win everywhere.
  const svgId = `pipeline-map-${i}`;

  const r = spawnSync(process.execPath, [
    MMDC,
    '-i', inFile,
    '-o', outFile,
    '-I', svgId,
    '-b', 'transparent',
    '-w', String(PAGE_W),
    '-H', String(PAGE_H),
    '-q',
  ], { encoding: 'utf8', timeout: 120000 });

  if (r.error) fail(`diagram ${i}: could not run mermaid-cli (${r.error.message})`);
  if (r.status !== 0) {
    fail(`diagram ${i}: mermaid-cli exited ${r.status}\n${(r.stderr || r.stdout || '').trim()}`);
  }
  if (!fs.existsSync(outFile)) fail(`diagram ${i}: mermaid-cli wrote no output file`);

  return { svg: svgElementOnly(fs.readFileSync(outFile, 'utf8'), i), svgId };
}

function main() {
  if (!fs.existsSync(SRC)) fail(`no such input: ${SRC}`);
  if (!fs.existsSync(MMDC)) {
    fail(`mermaid-cli not installed. Run:\n  cd tools/mapbuild && npm install`);
  }

  const html = fs.readFileSync(SRC, 'utf8');
  const blocks = [];
  let m;
  BLOCK.lastIndex = 0;
  while ((m = BLOCK.exec(html)) !== null) {
    blocks.push({ whole: m[0], source: decodeEntities(m[1]).trim() });
  }
  if (!blocks.length) fail(`no <pre class="mermaid"> blocks found in ${SRC}`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mapbuild-'));
  let out = html;
  const report = [];

  try {
    blocks.forEach((b, i) => {
      const { svg, svgId } = render(b.source, i, tmp);

      // Assert the diagram is RIGHT, not merely present (CLAUDE.md). An SVG that
      // rendered mermaid's own error card is a well-formed, non-empty, wrong answer —
      // and so is one that silently lost its nodes.
      //
      // The error card must be detected in the MARKUP, never in the whole file: every
      // successful render also carries `.error-icon` and `.error-text` rules inside the
      // stylesheet mermaid emits, so a naive search for those words fails every diagram
      // on the page. Stripping the stylesheet first is the difference between a check
      // and a false alarm.
      const markup = svg.replace(/<style\b[\s\S]*?<\/style>/gi, '');
      const isErrorCard =
        /aria-roledescription="error"/i.test(markup) ||
        /class="error-(icon|text)"/i.test(markup) ||
        /Syntax error in text/i.test(markup);
      if (isErrorCard) fail(`diagram ${i}: mermaid rendered an error card, not the diagram`);

      // Node groups carry `class="node default <classDef>"`, so an anchored word match
      // counts drawn shapes without also counting the `nodes` container or `nodeLabel`.
      const nodes = (markup.match(/class="node\b[^"]*"/g) || []).length;
      if (nodes === 0) fail(`diagram ${i}: rendered SVG contains no nodes`);

      // Replace this occurrence only. A plain String.replace on the block text would be
      // fine today (all ten differ) but would silently collapse two identical diagrams
      // into one if the page ever repeated a small one.
      const at = out.indexOf(b.whole);
      if (at < 0) fail(`diagram ${i}: block vanished from the working copy`);
      out = out.slice(0, at) + svg + out.slice(at + b.whole.length);

      report.push({ i, svgId, nodes, bytes: svg.length });
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // Whole-file assertions. Each of these has a failure mode behind it: a leftover
  // `<pre>` means a block was skipped, a duplicate id means the scoping above broke,
  // and a count mismatch means a replacement landed in the wrong place.
  const leftover = (out.match(/<pre class="mermaid">/g) || []).length;
  if (leftover) fail(`${leftover} mermaid block(s) were not rendered`);
  const svgCount = (out.match(/<svg\b/g) || []).length;
  if (svgCount !== blocks.length) {
    fail(`expected ${blocks.length} <svg> elements, found ${svgCount}`);
  }
  const ids = report.map((r) => r.svgId);
  if (new Set(ids).size !== ids.length) fail('duplicate svg ids in output');

  // Say so in the file. Both pages open in a browser and look alike, and the built one
  // is the one a reader is handed — so it is the one that gets edited by mistake.
  const banner =
    '<!--\n' +
    '  GENERATED FILE — do not edit.\n' +
    '  Built from docs/pipeline-map.html by scripts/build-pipeline-map.js.\n' +
    '  Edit the source page, then rebuild:  node scripts/build-pipeline-map.js\n' +
    '-->\n';

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, banner + out, 'utf8');

  // Print the count and the per-diagram numbers where a human already looks: a build
  // that quietly rendered nine of ten, or one whose master map dropped from 40 nodes to
  // 3, is visible here and nowhere else.
  process.stdout.write(`${path.relative(ROOT, OUT)} — ${blocks.length} diagrams\n`);
  report.forEach((r) => {
    process.stdout.write(
      `  ${String(r.i).padStart(2)}  ${r.svgId.padEnd(18)} ` +
      `${String(r.nodes).padStart(3)} nodes  ${(r.bytes / 1024).toFixed(1)} KiB\n`
    );
  });
}

main();
