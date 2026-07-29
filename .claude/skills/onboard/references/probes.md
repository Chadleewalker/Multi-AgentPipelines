# Assessment probes

Concrete checks for Phase 1. All read-only. `$T` is the target repo path; run everything
with `git -C "$T"` or from `$T` so the pipeline repo is never the subject by accident.

Commands assume Git Bash on the reference host (CLAUDE.md). Prefer the Read/Grep/Glob
tools over shell equivalents where they fit — these are written as shell because most are
aggregations, not file reads.

Report **numbers and command output**, never impressions. Where a probe finds nothing,
say so explicitly; a silent dimension reads as a pass it did not earn.

---

## 1. Verifiability — the go/no-go

**Is there a test suite at all, and what runs it?**

```bash
ls "$T" | grep -iE 'makefile|justfile|taskfile'
cat "$T/package.json" 2>/dev/null | grep -A10 '"scripts"'
ls "$T" | grep -iE 'pytest.ini|tox.ini|pyproject.toml|setup.cfg|noxfile'
ls "$T" | grep -iE 'pom.xml|build.gradle|Cargo.toml|go.mod|\.csproj|\.sln'
```

**How big is it, and how long does it take?** Time it — the number matters, because the
verifier runs it on every attempt (attempt cap defaults to 3).

```bash
# adapt to the ecosystem; example for a node repo
cd "$T" && time npm test 2>&1 | tail -30
```

If the suite cannot be run at all on this host, that is itself the finding — record why
(missing service, missing credential, wrong platform) and treat it as a blocker.

**Determinism and isolation — the part that decides everything.** Grep the *test* tree for
the things a sealed container cannot provide. Tune paths per ecosystem.

```bash
grep -rniE 'https?://|localhost|127\.0\.0\.1|:5432|:3306|:6379|:27017' "$T/tests" "$T/test" "$T/spec" 2>/dev/null | head -40
grep -rniE 'datetime\.now|Date\.now|new Date\(\)|time\.time|Math\.random|uuid4|random\.' "$T/tests" "$T/test" "$T/spec" 2>/dev/null | head -40
grep -rniE 'sleep\(|Thread\.sleep|setTimeout|time\.sleep' "$T/tests" "$T/test" "$T/spec" 2>/dev/null | head -20
grep -rlniE 'psycopg|pg_|mysql|mongo|redis|boto3|s3|azure|gcloud' "$T/tests" "$T/test" "$T/spec" 2>/dev/null | head -20
```

Also look for shared mutable state across tests — a fixtures file writing to a fixed path,
an order-dependent suite, a global singleton reset in `setUp`. Try running the suite twice
in a row and, if the runner supports it, in a randomized order; a suite that only passes
in order will not survive a container.

**What to conclude.** The question is not "does this repo have good tests". It is: *for a
typical task, can a new frozen test be written that is fast, deterministic, and sealed?*
A repo with no tests but clean pure-function seams scores **better** here than a repo with
900 integration tests that all need a live database.

---

## 2. Coupling versus one-issue-one-PR

**Change footprint — how many files does a real change touch?**

```bash
git -C "$T" log --since=1.year --pretty=format:'%H' --name-only \
  | awk 'NF==0{next} /^[0-9a-f]{40}$/{if(n)print n; n=0; next} {n++} END{if(n)print n}' \
  | sort -n | awk '{a[NR]=$1} END{print "commits:",NR, " median files:",a[int(NR/2)], " p90:",a[int(NR*0.9)]}'
```

A median in the low single digits is healthy. A p90 in the dozens means tasks in one batch
will collide.

**Hotspots — what does everything route through?**

```bash
git -C "$T" log --since=1.year --pretty=format: --name-only \
  | grep -v '^$' | sort | uniq -c | sort -rn | head -20
```

Cross-reference the top entries against file size. A 4,000-line file at the top of this
list is the god-object, and tasks touching it must be queued one at a time.

**Where are the seams?** Find directories whose files rarely appear in the same commit as
the hotspots — those are the beachhead candidates. A leaf package, a module with its own
tests, anything with a narrow public surface.

---

## 3. Dependency and closed-network fitness

```bash
ls "$T" | grep -iE 'package-lock.json|yarn.lock|pnpm-lock|poetry.lock|Pipfile.lock|Gemfile.lock|go.sum|Cargo.lock'
grep -nE '"(pre|post)install"|"prepare"' "$T/package.json" 2>/dev/null
grep -rnE 'curl |wget |apt-get |pip install |npm i |go get ' "$T/Dockerfile" "$T/Makefile" "$T/scripts" 2>/dev/null | head -20
```

Check for: a lockfile (unpinned ranges make the image non-reproducible); install scripts
that fetch at build time; test-time downloads (fixture data pulled from a URL); and any
private registry, which needs credentials the container will not have.

Count the dependency tree if the ecosystem makes it cheap (`npm ls --all | wc -l`,
`pip freeze | wc -l`). The number goes in the report; it predicts how long step 4 takes.

---

## 4. Knowledge legibility

```bash
ls "$T"/*.md "$T/docs" 2>/dev/null
git -C "$T" log -1 --format=%ci -- "$T/README.md" "$T/docs" 2>/dev/null
```

**Staleness test — the one that matters.** Documentation naming paths that no longer exist
is the signature of drift, and a sealed agent will follow it anyway:

```bash
grep -rhoE '`[a-zA-Z0-9_./-]+\.(js|ts|py|go|rb|java|cs|sh|json|yml)`' "$T/docs" "$T/README.md" 2>/dev/null \
  | tr -d '`' | sort -u | while read -r f; do [ -e "$T/$f" ] || echo "MISSING: $f"; done
```

Compare the newest doc commit against the newest code commit. A README last touched years
before the code is not a documentation asset; it is a hazard to be marked historical.

**Look for behavior documentation specifically** — user guides, API references, "the system
does X when Y". That converts directly into "Done means" criteria and therefore into
acceptance tests, which is the scarce input for this whole adoption. Mine it before
writing anything new.

**Look for undocumented invariants** in code comments — `# do not`, `// HACK`, `// XXX`,
`// keep in sync`, `TODO`. These are the candidates for the design doc's invariants
section (Phase 4), and the things an agent will otherwise "clean up".

```bash
grep -rniE '(#|//|/\*)\s*(hack|xxx|do not|don.t (remove|change|touch)|keep in sync|fixme)' "$T" \
  --include='*.*' 2>/dev/null | grep -vE 'node_modules|vendor|\.git/' | head -30
```

---

## 5. Git and host readiness

```bash
git -C "$T" remote -v
git -C "$T" remote show origin | grep -i 'head branch'   # never assume main
git -C "$T" status --short
cat "$T/.gitattributes" 2>/dev/null
git -C "$T" branch -a --format='%(refname:short)' | head -20
```

Check: a GitHub remote exists (review happens as PRs — §6); the real integration branch is
known and will be recorded as `defaultBranch` if it is not `main`; `.gitattributes` carries
at least `*.sh text eol=lf`; the working tree is clean enough that onboarding edits will be
reviewable; and nothing that must exist lives only on this disk — the container clones from
the **remote**, so unpushed work does not exist as far as a run is concerned (§4.2).

Also confirm host prerequisites once, since they block step 4: Docker Desktop running,
`gh` authenticated, the pipeline base image built.
