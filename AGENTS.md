# Agent Instructions

Read `docs/control-plane.md` before changing the runner. It identifies the authoritative
machine-readable contracts and validation profiles; do not copy mutable rosters or enums
into this file.

<!-- BEGIN WRITE PROTECTION -->
## Pipeline-First Writes

This checkout is run by Multi-Agent Pipelines, so changes to it are made by a pipeline run
rather than by hand. Agent write hooks refuse product, configuration, control and
frozen-path edits here, and freeze, preparation and dispatch admission refuse them again
over the real checkout even where no hook was ever installed. Read-only inspection is
unaffected.

Plan the change, freeze its acceptance suite, and let a run make it. If you have already
edited by hand, move that work somewhere safe instead of undoing it:

```bash
node scripts/write-protection.js status     # what is enforced here, honestly
node scripts/write-protection.js recover    # a Git-registered home for refused edits
```

A person may lift this for one repository and one session with
`node scripts/write-protection.js allow-writes`; nothing inside the tree opts out, and no
file you can edit will change the answer.
<!-- END WRITE PROTECTION -->

## Noninteractive Shell Commands

Always use noninteractive flags with file operations so aliases cannot hang the session:

```bash
cp -f source dest
mv -f source dest
rm -f file
rm -rf directory
cp -rf source dest
```

Use `scp -o BatchMode=yes`, `ssh -o BatchMode=yes`, `apt-get -y`, and
`HOMEBREW_NO_AUTO_UPDATE=1 brew` where relevant.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal -->
## Beads Issue Tracker

This repository uses Beads for all durable task tracking. Read
`.agents/skills/beads/SKILL.md`, then run `bd prime` for the current workflow and command
reference. Do not create markdown task lists or ad hoc memory files.

Issues live in the local Dolt database. `.beads/issues.jsonl` is a passive export, not the
normal sync path; `bd dolt push/pull` synchronizes `refs/dolt/data` separately from Git
branches.

Useful entry points:

```bash
bd ready
bd show <id>
bd update <id> --claim
bd close <id>
```

The active profile is conservative/minimal: do not commit, push Git, or synchronize Dolt
unless the user or a stronger active instruction explicitly authorizes it. At handoff,
report changed files, validation, issue state, and any proposed commit or sync commands.
<!-- END BEADS INTEGRATION -->
