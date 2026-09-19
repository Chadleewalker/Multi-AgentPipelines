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
const { isDeepStrictEqual } = require('util');
const { canonicalPacket, VERSION: INTENT_VERSION } = require('../scripts/kickoff');

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

// Intake permits omitted optional fields and supplies their defaults. Persisted intent is the
// complete canonicalPacket result, so compare decoded structure with that same canonicalizer.
// This rejects omitted/defaulted fields and malformed values without normalizing the original
// intent bytes, changing their hash, or maintaining a second field/type contract here.
function isCanonicalIntent(obj) {
  try {
    return isDeepStrictEqual(obj, canonicalPacket(Buffer.from(JSON.stringify(obj), 'utf8')));
  } catch { return false; }
}

// The single reader of host-owned scope metadata on a Beads issue, shared by the host export
// (runner/queue.js) and the acceptance-author brief (scripts/spec-brief.js) so neither can judge
// a record by a different rule. The presence of either genuinely new field (`intent` or `scope`)
// is the new-format marker; `kickoffHash`/`specHash` predate this feature and are NOT markers.
// Returns exactly one of:
//   { format: 'legacy' }                                        — no new fields; prior behaviour
//   { format: 'invalid', error }                                — presents as new but is
//                                                                 incomplete, malformed or tampered
//   { format: 'scoped', intent, kickoffHash, intentObj, scope } — verified, lossless
// A stored scope is never trusted: the host re-derives it from the verified canonical intent and
// refuses a record whose stored scope disagrees, so a container-editable field cannot weaken it.
function readScopeMetadata(metadata) {
  const meta = (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) ? metadata : {};
  const newFormat = Object.prototype.hasOwnProperty.call(meta, 'intent')
    || Object.prototype.hasOwnProperty.call(meta, 'scope');
  if (!newFormat) return { format: 'legacy' };
  if (typeof meta.intent !== 'string'
      || typeof meta.kickoffHash !== 'string'
      || !meta.scope || typeof meta.scope !== 'object' || Array.isArray(meta.scope)) {
    return { format: 'invalid', error: 'incomplete scope metadata' };
  }
  if (hashOf(meta.intent) !== meta.kickoffHash) {
    return { format: 'invalid', error: 'intent does not bind to its recorded kickoff hash' };
  }
  let intentObj;
  try { intentObj = JSON.parse(meta.intent); } catch {
    return { format: 'invalid', error: 'immutable intent is not JSON' };
  }
  if (!isCanonicalIntent(intentObj)) {
    return { format: 'invalid', error: 'immutable intent is not a canonical kickoff intent' };
  }
  const derived = deriveScope(intentObj);
  if (meta.scope.documentation !== derived.documentation
      || meta.scope.directive !== derived.directive) {
    return { format: 'invalid', error: 'derived documentation scope was tampered' };
  }
  return { format: 'scoped', intent: meta.intent, kickoffHash: meta.kickoffHash, intentObj, scope: derived };
}

// The protected documentation surface: root-level Markdown and Markdown anywhere beneath docs/,
// with a case-insensitive Markdown extension. `[\s\S]` rather than `.` so a whitespace- or
// newline-bearing path (a real Git delta the `-z` reader preserves literally) is still matched.
// src/README.md and any other nested non-docs Markdown are deliberately OUTSIDE the surface.
//
// The path is taken LITERALLY. `git diff -z` already emits POSIX `/` directory separators, so a
// backslash in a path is a genuine filename character, not a Windows separator to fold away.
// Rewriting `\` to `/` (repo-062 review correction 2) mis-classified both directions: a
// root-level blob literally named `src\README.md` (no slash — a root file) escaped protection,
// and it could turn an unrelated backslash name into a spurious `docs/` hit. Classification here
// must not depend on Windows filesystem path interpretation.
function isProtectedMarkdown(p) {
  const s = String(p);
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
  DIRECTIVE_ALIAS, DIRECTIVE_DEMO, INTENT_VERSION, hashOf, deriveScope, isPreserve,
  isCanonicalIntent, readScopeMetadata,
  isProtectedMarkdown, parseNameStatusZ, protectedMarkdownPaths,
};
