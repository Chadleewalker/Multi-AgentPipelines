# Run report — 2026-09-17T17-16-32-465Z

Started 2026-09-17T17:16:32.466Z · finished 2026-09-17T17:26:38.385Z
Target: `https://github.com/Chadleewalker/Multi-AgentPipelines.git`

**1 task(s)**: 1 done

**Spec concerns: 0 raised by 0 of 1 tasks.** Evidence only — none of them changed an outcome above (DESIGN.md §3.7); a spec may be changed in a planning session and nowhere else.

Ordered by how much scrutiny each item needs.

## repo-djf.51 — DONE

**Bind retained proofs to canonical target repository identity**

- Branch: `task/repo-djf.51`
- PR: https://github.com/Chadleewalker/Multi-AgentPipelines/pull/156
- Attempts: 1
- Active time: 579s
- Diff: 110 lines
- Model: claude-opus-5

**What changed**

`scripts/prove-tests.js` now binds a retained green proof to the canonical identity of the repository it was cloned from rather than to a path string: `prepareProbe` resolves `runner/lock.js`'s `canonicalTarget(cfg.targetRepoPath)` before creating anything and records it as `targetIdentity` in the ownership marker, failing preparation outright if the target cannot be canonicalized. `resumeProbe` recomputes that identity and refuses unless the recorded value is a non-empty string equal to it, so an equivalent path spelling of the same repository still resumes while a different repository, a junction or symlink retargeted underneath the same literal path, and a missing or malformed recorded identity are all rejected. The check is answered from the marker already in hand and runs ahead of every other resume validation, so a refusal launches no agent, runs no gate, moves no marker byte and sweeps nothing — the retained container stays byte-identical and the swapped-in path is neither followed nor deleted. Documentation was updated alongside: `DESIGN.md` 3.10 and change-log row `repo-djf-51-proof-target-identity` in the implementation commit, plus the resume-validation descriptions in `PLANNING.md` and `docs/control-plane.md`, which now list target repository identity as the first of seven dimensions.

**Verification evidence**

- Acceptance: **pass**
- Regressions: **pass**

```
resume of the identical real path succeeds
[test] PASS T2 C2,C4(same-repository alias) resume through an equivalent (non-real, redundant-segment) spelling of the same real target repository succeeds
[test] PASS T3 C2,C3,C4(different repository) resume refuses a genuinely different repository at the same config field, before touching the retained container
[test] PASS T4 C2,C3,C4(retargeted junction/symlink) resume refuses a junction/symlink retargeted to a different repository at the same literal path, without following or deleting the swapped-in decoy
[test] SKIP T5: host is not the case-insensitive, backslash-native platform this check exercises
[test] PASS T5 C2,C4(case and normalization) resume through a differently-cased, differently-slashed spelling of the same real target repository succeeds on a case-insensitive host filesystem
[test] PASS T6 C2,C3(missing/malformed canonical identity) resume refuses a retained marker whose canonical identity is missing or malformed, before touching the retained container
[test] PASS T7 C3 identity refusal at the proveTests() level happens before any agent launch, gate run, or marker mutation, and leaves the retained container byte-identical
[test] PASS T8 C5 the existing frozen tests/acceptance/repo-os9/test.js (target-lock) and tests/acceptance/repo-djf.14/test.js (probe ownership and freeze) still pass in full once canonical target identity binding is built
[test] PASS 8/8 focused checks
PASS: tests/acceptance/repo-djf.51//test.js
```

**Attempt notes**

```
run 2026-09-17T17-16-32-465Z: outcome done
  attempt 1: pass at 2026-09-17T17:23:54.922Z
  memory notes: 3
  memory in: 285
PR: https://github.com/Chadleewalker/Multi-AgentPipelines/pull/156
```

---

_Generated from the run manifest and git. Regenerating produces an identical file; never edit by hand._
