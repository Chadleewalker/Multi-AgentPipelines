# Planning draft — the freeze gate proves only half of what it claims (2026-08-26)

**For approval.** The "Done means" list in §6 is what needs a yes.

---

## 1. The observation

`PLANNING.md` step 4 says: run the freeze gate, and the tests must be **red**. It does not
ask for anything else. `CLAUDE.md` says the fuller rule in prose —

> Prove a suite both ways before freezing it: red without the work, green with it.

— and prose is exactly what failed. On 2026-08-26 a spec was frozen after following step 4
to the letter. The gate said RED, the control was green, brittleness findings were zero. The
task then reached `stuck` at three attempts, because the criterion it existed for was
**unreachable by any implementation**: the fixture called `git init -q -c …`, `-c` is a git
wrapper option that must precede the subcommand, and no repository was ever created.

Worse, the two neighbouring checks passed **vacuously** — the file appends landed whether or
not git worked, and the "control conflicts" check passed because git had errored rather than
because anything conflicted. A broken fixture agreed with whatever it was asked.

**This is the second confirmed instance.** `repo-8v0` reached `stuck` the same way in June:
11 of 29 checks unreachable, because a `NODE_OPTIONS=--require` stub killed the child process
before its first line. Its giveaway was a check that passed *only while the tool under test
was dead*.

Both were found by the task agents through the §3.7 concern channel, not by the gate. Twice
is a pattern in the playbook, not in whoever follows it.

## 2. Why the gate cannot see it

The gate runs the suite at the fork point and reads the exit code. A correctly-red suite and
a broken-fixture suite are **the same observation**: non-zero. Nothing distinguishes them,
because the difference is not in this run — it is in whether *any other* run could come out
differently.

The gate already reasons carefully in this space, and its instincts are right. It separates
"failed" from "could not run" by exit code; it uses `_control` to tell a red test from a
broken harness; and where it cannot tell, it returns `indeterminate` and refuses to bless. Its
stated principle is to *refuse to bless rather than refuse to notice*.

It simply has no evidence about the other direction. It has never seen the suite pass.

## 3. What is proposed — the green probe

Give the gate a second input: a tree in which the criteria are **already satisfied**, and
require the suite to come out green there.

```
node scripts/freeze-gate.js --repo <target> --tests tests/acceptance/<id>/ \
     --green <dir> [--spec <draft>]
```

The critical reframing, and the reason this is cheap rather than expensive: **the green probe
is not an implementation.** It is a tree where the criteria have been made true by any means,
however crude — touch the file, append the line, hard-code the return value. Nobody reviews
it, nobody keeps it, and it never leaves the planning session.

The question it answers is: *if I cheat, does the suite notice?* If the criteria cannot be
satisfied by cheating, an honest implementation cannot satisfy them either. In the
2026-08-26 case a ten-line probe — create the file, add the attribute — would have exposed
the fixture bug in seconds, because C3 would still have failed with "not a git repository"
while every other check went green.

**The verdict gains a dimension.** Today: `red` (0), `green` (1), `indeterminate` (2). The
red verdict splits:

| Red side | Green side | Verdict | Exit |
|---|---|---|---|
| fails at the fork point | passes on the probe | **discriminating** | 0 |
| fails at the fork point | still fails on the probe | **unreachable** | 3 |
| fails at the fork point | no probe supplied | **half-proven** | 4 |

`unreachable` names the failing checks, which is the diagnosis: those are the criteria no
implementation can satisfy. `half-proven` is not an error and not a pass — it is the gate
saying it was only shown one side, in the same voice it already uses for `indeterminate`.

Exit codes above 2 are new and additive; 0, 1 and 2 keep their present meanings, so every
existing caller and suite reads the same.

## 4. Why not the cheaper options

**Doc-only — add "and prove it green" to `PLANNING.md` step 4.** This is the option that has
already been tried: the instruction exists in `CLAUDE.md` and was not enough. A rule that
only a careful reader applies is a rule that fails at the fourth spec at 11pm. Worth doing
*as well*, worthless *instead*.

**Detect it statically.** The brittleness lint (change-log row `repo-uw6`) reads what a suite
says. But "this fixture's setup command is malformed" is not a textual shape — `git init -c`
is well-formed JavaScript and a plausible command. The lint's own design note makes the point:
it keys only on the half a tool can settle exactly.

**Make the probe mandatory at exit 2.** Rejected: it would refuse to bless a freeze on a
project that has no convenient way to fake its criteria, and the gate's existing exit 2 means
"the harness is broken", which this is not. `half-proven` is the honest report.

## 4b. It partly subsumes a parked idea, and that is evidence for the shape

`docs/IDEAS.md` already carries **"Give the freeze-gate control fixture a
dependency-exercising test"**, filed from a session where the control passed while every real
test went red for a harness reason — *a vacuous RED the gate then certified as
discriminating*. Different mechanism, same disease: the gate blessing a red that proves
nothing.

A green probe catches that case too, and by construction rather than by anticipating it. If
the harness cannot run — a missing engine binary, an unresolvable env var — then the probe
tree goes red as well, and the gate reports the suite as not-provably-reachable instead of
certifying it. Two independently-filed failures answered by one mechanism is the argument
that the mechanism is at the right level.

It does **not** fully replace that idea, and the spec should not claim it does. The probe
would say "no implementation could satisfy this" when the truth is "the harness is broken",
which is the wrong diagnosis even though it is the right refusal. A stronger control still
names the cause correctly. The parked entry should be **narrowed** rather than closed once
this ships — from "the gate can certify a vacuous red" to "the gate's diagnosis of a broken
harness can be wrong".

This also sharpens a question the implementation has to answer: a probe that **fails** and a
probe **where the runner could not execute at all** are different states, and the second is
much closer to the existing `indeterminate` than to `unreachable`.

## 5. What this does not fix

- A probe that cheats in the *same wrong way* the suite is wrong still goes green. The probe
  raises the floor; it is not a proof of correctness.
- Nothing here judges whether the criteria are the *right* criteria. That is the critic
  panel's job and stays there.
- It costs the planning session a few minutes per spec. That is the trade being proposed:
  minutes at planning time against three container attempts and a `stuck` result.

## 6. Done means — the list that needs approval

1. `scripts/freeze-gate.js` accepts `--green <dir>`, runs the same suite against that
   tree, and reports the green side on its own line in all verdicts.
2. Red at the fork point **and** green on the probe exits **0** and says `discriminating`.
3. Red at the fork point **and still red** on the probe exits **3**, says `unreachable`, and
   **names the checks that failed in both runs** — those are the ones no implementation can
   satisfy.
4. Red at the fork point with **no** `--green` exits **4** and says `half-proven`, naming what
   was not shown. It is not an error and not a pass.
5. Exit codes 0, 1 and 2 keep their exact present meanings, and every existing invocation
   without `--green` behaves as it does today apart from the new exit 4 and the extra line.
6. `PLANNING.md` step 4 requires the probe and shows the worked output, the way step 4 already
   shows the gate's.
7. Re-runnable coverage in `tests/unit/freeze-gate.test.js`, including the discriminating
   fixture: **a suite whose fixture is broken the way the 2026-08-26 one was** — red at the
   fork point, still red on a probe that satisfies every criterion. A gate that only looks at
   exit codes passes it; only the two-sided run catches it.
8. **The two repealed assertions are rewritten, not deleted.** `tests/unit/freeze-gate.test.js`
   currently asserts `CLI exits 0 when the tests are genuinely red` and `CLI still exits 0 with
   --spec supplied`. Both stop being true, because red without a probe now exits 4. Each must
   become an assertion of the *new* contract — red with a passing probe exits 0, red with no
   probe exits 4 — and the suite's total check count must go up, not down. A property that
   stops being true takes its own test with it (change-log row `repo-5yu`); deleting the two
   checks to get green is the failure this criterion exists to prevent.

### Scope decisions, made before the panel

- **`--green` takes a directory, never a git ref.** Ref support would put clone-or-worktree
  plumbing inside a tool that today spawns nothing but the verify command. A planning session
  can materialise a ref into a directory itself, so this removes most of the implementation
  risk for none of the value.
- **Nothing automates this gate.** Every reference in the tracked tree is documentation —
  `PLANNING.md` invokes it as a manual command; no script, suite or runner reads its exit code.
  That is what makes changing the exit contract a contained risk rather than a broad one, and
  it is worth stating so a reviewer does not have to re-derive it.

## 7. Recommendation

Approve and freeze. It is a `hard` task — small code delta, but it changes what a gate
concludes, and the way it fails is silent in both directions: a probe that is too generous
blesses an unreachable suite, and one that is too strict refuses a good one.

Sequence it **before** the next batch. Its whole value is in specs frozen after it exists, and
21 of the 240 tasks in the corpus have reached `stuck`, every one of them spending all three
attempts to get there.
