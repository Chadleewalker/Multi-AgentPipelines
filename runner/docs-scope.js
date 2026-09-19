// Copyright 2026 Chad Walker
// SPDX-License-Identifier: Apache-2.0

// The single source for the "preserve kickoff intent / no-documentation" scope (DESIGN.md,
// docs/design/provenance/repo-062.md). Everything that must agree on it — the canonical
// serializer (scripts/specify-proposal.js), the host export/scope binding (runner/queue.js),
// the host publication backstop (runner/publish.js) and the container docs skip
// (pipeline/entrypoint.sh, via runner/run.js) — reads the two exact directives, the byte-exact
// kickoff hash, the derivation and the protected Markdown surface from HERE, so a second copy of
// any of them cannot drift silently.
'use strict';
const crypto = require('crypto');

// The two — and only two — exact directive strings. Documentation preservation activates only
// when an ENTIRE element of the original `constraints` or `nonGoals` array equals one of these.
// The second string is a compatibility alias for the existing demo's restriction. Neither is a
// substring rule, a casing variant, or an enforcement of package-management or arbitrary
// natural-language constraints — this mechanism binds the documentation surface only.
const DIRECTIVE_ALIAS = 'pipeline:docs=preserve';
const DIRECTIVE_DEMO = 'Do not add documentation or package-management files.';

// Byte-exact over the immutable intent bytes — identical to scripts/kickoff.js `hashOf`.
const hashOf = (intent) => `sha256:${crypto.createHash('sha256')
  .update(Buffer.from(String(intent), 'utf8')).digest('hex')}`;

// Deterministic derivation from the immutable intent. Reads exact standalone elements of the
// `constraints` and `nonGoals` arrays and nothing else — never the title, description, examples,
// or any planner-supplied field. The planner cannot relax it.
function deriveScope(intent) {
  const obj = intent && typeof intent === 'object' && !Array.isArray(intent) ? intent : {};
  const items = [
    ...(Array.isArray(obj.constraints) ? obj.constraints : []),
    ...(Array.isArray(obj.nonGoals) ? obj.nonGoals : []),
  ];
  const hit = items.find((x) => x === DIRECTIVE_ALIAS || x === DIRECTIVE_DEMO);
  return hit
    ? { documentation: 'preserve', directive: hit }
    : { documentation: 'normal', directive: null };
}

const isPreserve = (scope) => !!scope && scope.documentation === 'preserve';

// The protected documentation surface: root-level Markdown and Markdown anywhere beneath docs/,
// with a case-insensitive Markdown extension. `[\s\S]` rather than `.` so a whitespace- or
// newline-bearing path (a real Git delta the `-z` reader preserves literally) is still matched.
// src/README.md and any other nested non-docs Markdown are deliberately OUTSIDE the surface.
function isProtectedMarkdown(p) {
  const s = String(p).replace(/\\/g, '/');
  return /^[^/]+\.md$/i.test(s) || /^docs\/[\s\S]+\.md$/i.test(s);
}

// Parse `git diff --name-status -M -z <base> <head>` output. With `-z` paths are literal
// (no quoting) and NUL-terminated; a rename/copy record carries a status then TWO paths, every
// other record a status then ONE path. Both sides of a rename are returned so a rename INTO or
// OUT OF the protected surface is caught.
function parseNameStatusZ(text) {
  const tokens = String(text || '').split('\0');
  const changes = [];
  let i = 0;
  while (i < tokens.length) {
    const status = tokens[i];
    if (status === undefined || status === '') { i += 1; continue; }
    if (/^[RC]/i.test(status)) {
      changes.push({ status, paths: [tokens[i + 1], tokens[i + 2]].filter((x) => x) });
      i += 3;
    } else {
      changes.push({ status, paths: [tokens[i + 1]].filter((x) => x) });
      i += 2;
    }
  }
  return changes;
}

// Every path (either side of a rename) that lands in the protected Markdown surface.
function protectedMarkdownPaths(nameStatusZ) {
  const hits = new Set();
  for (const change of parseNameStatusZ(nameStatusZ)) {
    for (const p of change.paths) if (isProtectedMarkdown(p)) hits.add(p);
  }
  return [...hits];
}

module.exports = {
  DIRECTIVE_ALIAS, DIRECTIVE_DEMO, hashOf, deriveScope, isPreserve,
  isProtectedMarkdown, parseNameStatusZ, protectedMarkdownPaths,
};
