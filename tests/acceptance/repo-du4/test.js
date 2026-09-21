// repo-du4 RED acceptance half. Each T test must fail on the unimplemented fork.
// Canonical criteria, paired both ways (guards also declare this index):
// C1 141 eligible Markdown files reach enumeration -> T1 (controls G1).
// C2 exactly 256 admitted, 257 refused before effects -> T2 and guard G2.
// C3 one shared 256-file capacity for producer/consumer -> T3,T4.
// C4 unchanged byte/count/reference ceilings -> guards G3-G7.
// C5 add only this suite, preserve frozen acceptance -> guard G8.
// C6 guide and change log describe 256 files -> T5,T6 (matcher controls G1).
// Kickoff no truncation/sampling/exclusion -> T1,T2; safety semantics -> guard G7.
// Spec defect: the old repo-djf.60 G4 guard contradicts the new file capacity.
// It is deliberately preserved, and is not invoked or changed by this suite.
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const h = require('./guard');
const tests = [
  ['T1 C1 all 141 eligible files reach candidate enumeration', async () => {
    const world = h.realRepo(h.filesFor(141));
    const discover = h.adapters(world.repo).deriveDesignReferenceCandidates;
    assert.deepStrictEqual(await discover(world.commit), h.refsFor(141), 'no truncation, sampling or priority filtering');
    await h.admitted(discover, h.refsFor(141), world.commit);
  }],
  ['T2 C2 all 256 eligible files admitted including files without headings', async () => {
    const world = h.realRepo(h.filesFor(256));
    await h.admitted(h.adapters(world.repo).deriveDesignReferenceCandidates, h.refsFor(256), world.commit);
    const files = h.filesFor(256, false);
    files['docs/f255.md'] = '# Heading 255\n';
    await h.admitted(h.synthetic(files).discover, [h.refsFor(256).at(-1)]);
    // Overflow half is independently green and lives in G2, not disguised as red.
  }],
  ['T3 C3 consumer independently admits 256 distinct files and refuses 257 before effects', async () => {
    await h.admitted(async () => h.refsFor(256), h.refsFor(256));
    await h.refused(async () => h.refsFor(257));
    // Count unique files, not references: unchanged 1024-candidate bound is G5.
    const many = h.refsFor(256).flatMap(ref => [ref, ref + '-second']);
    await h.admitted(async () => many, many);
  }],
  ['T4 C3 producer and consumer use the same 256-file constant', async () => {
    const source = fs.readFileSync(h.MODULE, 'utf8');
    const declaration = /\bconst\s+MAX_DESIGN_FILES\s*=\s*([^;]+);/;
    const match = declaration.exec(source);
    assert(match, 'shared MAX_DESIGN_FILES declaration is absent');
    // Compile an isolated in-memory copy with an observation export, without writing
    // or mutating product files/require.cache. Then perturb only the existing shared
    // binding to 3; both real algorithms must follow it. Two hardcoded 256s fail.
    function load(text) {
      const instance = new Module(h.MODULE, module);
      instance.filename = h.MODULE;
      instance.paths = Module._nodeModulePaths(path.dirname(h.MODULE));
      instance._compile(text + '\nmodule.exports.__capacity = MAX_DESIGN_FILES;\n', h.MODULE);
      return instance.exports;
    }
    assert.strictEqual(load(source).__capacity, 256, 'shared eligible Markdown capacity must be exactly 256');
    const probe = load(source.replace(declaration, 'const MAX_DESIGN_FILES = 3;'));
    await h.admitted(h.synthetic(h.filesFor(3), undefined, probe).discover, h.refsFor(3), h.COMMIT, probe);
    await h.refused(h.synthetic(h.filesFor(4), undefined, probe).discover, h.COMMIT, probe);
    await h.admitted(async () => h.refsFor(3), h.refsFor(3), h.COMMIT, probe);
    await h.refused(async () => h.refsFor(4), h.COMMIT, probe);
  }],
  ['T5 C6 control-plane guide documents 256 eligible Markdown files', async () => {
    const doc = fs.readFileSync(path.join(h.ROOT, 'docs/control-plane.md'), 'utf8');
    assert(h.describesCapacity(doc), 'guide lacks a design-discovery passage describing the 256 Markdown-file capacity');
    assert(!/at most 128 eligible Markdown\s+files/i.test(doc), 'guide still states the old 128-file ceiling');
  }],
  ['T6 C6 change log describes the new 256 eligible Markdown file capacity', async () => {
    const log = fs.readFileSync(path.join(h.ROOT, 'docs/change-log.md'), 'utf8');
    assert(h.describesCapacity(log), 'change log lacks an entry describing the 256 Markdown-file design-discovery capacity');
  }],
];
h.run(tests).catch(e => { console.error('HARNESS BROKEN', e); process.exitCode = 1; });
