# Readiness probes — the commands behind ONBOARDING.md stage 0

Concrete checks for assessing an existing codebase before adopting it as a pipeline
target. `ONBOARDING.md` stage 0 states what the five dimensions mean and how to report a
verdict; this file is only the mechanics.

All read-only — stage 0 changes nothing. `$T` is the target repo path; run everything with
`git -C "$T"` or from `$T` so this repo is never the subject by accident. Commands assume
Git Bash on the reference host (CLAUDE.md).

Report numbers and command output, never impressions. Where a probe finds nothing, say so
explicitly: a silent dimension reads as a pass it did not earn.

---

## 1. Verifiability — the go/no-go

**Is there a test suite, and what runs it?**

```bash
ls "$T" | grep -iE 'makefile|justfile|taskfile'
grep -A10 '"scripts"' "$T/package.json" 2>/dev/null
ls "$T" | grep -iE 'pytest.ini|tox.ini|pyproject.toml|setup.cfg|noxfile'
ls "$T" | grep -iE 'pom.xml|build.gradle|Cargo.toml|go.mod|\.csproj|\.sln'
```

**How long does it take?** Time it — the verifier runs it on every attempt, and the attempt
cap defaults to 3.

```bash
cd "$T" && time npm test 2>&1 | tail -30   # adapt to the ecosystem
```

If the suite cannot be run on this host at all, that is the finding — record why (missing
service, missing credential, wrong platform) and treat it as a blocker.

**Determinism and isolation — the part that decides everything.** Grep the *test* tree for
what a sealed container cannot provide; tune paths per ecosystem.

```bash
grep -rniE 'https?://|localhost|127\.0\.0\.1|:5432|:3306|:6379|:27017' "$T/tests" "$T/test" "$T/spec" 2>/dev/null | head -40
grep -rniE 'datetime\.now|Date\.now|new Date\(\)|time\.time|Math\.random|uuid4|random\.' "$T/tests" "$T/test" "$T/spec" 2>/dev/null | head -40
grep -rniE 'sleep\(|Thread\.sleep|setTimeout|time\.sleep' "$T/tests" "$T/test" "$T/spec" 2>/dev/null | head -20
grep -rlniE 'psycopg|pg_|mysql|mongo|redis|boto3|s3|azure|gcloud' "$T/tests" "$T/test" "$T/spec" 2>/dev/null | head -20
```

Look also for shared mutable state — a fixture writing to a fixed path, an order-dependent
suite, a global reset in `setUp`. Run the suite twice in a row, and in randomized order if
the runner supports it; a suite that only passes in order will not survive a container.

**What to conclude.** The question is not "does this repo have good tests". It is: *for a
typical task, can a new frozen test be written that is fast, deterministic and sealed?* A
repo with no tests but clean pure-function seams scores **better** here than one with 900
integration tests that all need a live database.

---

## 2. Coupling versus one-issue-one-PR

**Change footprint — how many files does a real change touch?**

```bash
git -C "$T" log --since=1.year --pretty=format:'%H' --name-only \
  | awk 'NF==0{next} /^[0-9a-f]{40}$/{if(n)print n; n=0; next} {n++} END{if(n)print n}' \
  | sort -n | awk '{a[NR]=$1} END{print "commits:",NR," median files:",a[int(NR/2)]," p90:",a[int(NR*0.9)]}'
```

A median in the low single digits is healthy. A p90 in the dozens means tasks in one batch
will collide.

**Hotspots — what does everything route through?**

```bash
git -C "$T" log --since=1.year --pretty=format: --name-only \
  | grep -v '^$' | sort | uniq -c | sort -rn | head -20
```

Cross-reference the top entries against file size. A 4,000-line file at the top of this
list is the god-object; tasks touching it must be queued one at a time.

**Where are the seams?** Directories whose files rarely appear in the same commit as the
hotspots are the beachhead candidates — a leaf package, a module with its own tests,
anything with a narrow public surface.

---

## 3. Closed-network fitness

```bash
ls "$T" | grep -iE 'package-lock.json|yarn.lock|pnpm-lock|poetry.lock|Pipfile.lock|Gemfile.lock|go.sum|Cargo.lock'
grep -nE '"(pre|post)install"|"prepare"' "$T/package.json" 2>/dev/null
grep -rnE 'curl |wget |apt-get |pip install |npm i |go get ' "$T/Dockerfile" "$T/Makefile" "$T/scripts" 2>/dev/null | head -20
```

Check for: a lockfile (unpinned ranges make the image non-reproducible); install scripts
that fetch at build time; test-time downloads (fixture data pulled from a URL); and any
private registry, which needs credentials the container will not have.

Count the dependency tree where the ecosystem makes it cheap (`npm ls --all | wc -l`,
`pip freeze | wc -l`). The number predicts how long the image step takes.

---

## 4. Knowledge legibility

```bash
ls "$T"/*.md "$T/docs" 2>/dev/null
git -C "$T" log -1 --format=%ci -- README.md docs 2>/dev/null
```

**Staleness test — the one that matters.** Documentation naming paths that no longer exist
is the signature of drift, and a sealed agent follows it anyway:

```bash
grep -rhoE '`[a-zA-Z0-9_./-]+\.(js|ts|py|go|rb|java|cs|sh|json|yml)`' "$T/docs" "$T/README.md" 2>/dev/null \
  | tr -d '`' | sort -u | while read -r f; do [ -e "$T/$f" ] || echo "MISSING: $f"; done
```

Compare the newest doc commit against the newest code commit. A README last touched years
before the code is not an asset; it is a hazard to be marked historical.

**Behavior documentation is the prize.** User guides, API references, "the system does X
when Y" — that converts directly into "Done means" criteria and therefore into acceptance
tests, which is the scarce input for the whole adoption. Mine it before writing anything new.

**Undocumented invariants** hide in comments, and are exactly what an agent will tidy away:

```bash
grep -rniE '(#|//|/\*)\s*(hack|xxx|do not|don.t (remove|change|touch)|keep in sync|fixme)' "$T" \
  --include='*.*' 2>/dev/null | grep -vE 'node_modules|vendor|\.git/' | head -30
```

These are the candidates for the design doc's invariants section.

---

## 5. Git and host readiness

```bash
git -C "$T" remote -v
git -C "$T" remote show origin | grep -i 'head branch'   # never assume main
git -C "$T" status --short
cat "$T/.gitattributes" 2>/dev/null
```

Check: a GitHub remote exists (review happens as PRs — §6); the real integration branch is
known, and will be recorded as `defaultBranch` if it is not `main`; `.gitattributes` carries
at least `*.sh text eol=lf`; the working tree is clean enough that onboarding edits stay
reviewable; and nothing needed lives only on this disk — the container clones from the
**remote**, so unpushed work does not exist as far as a run is concerned (§4.2).

Confirm host prerequisites once, since they block the image step: Docker Desktop running,
`gh` authenticated, the pipeline base image built.
