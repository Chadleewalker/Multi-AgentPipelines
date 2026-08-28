# Agent Instructions

Read `docs/control-plane.md` before changing the runner. It identifies the authoritative
machine-readable contracts and validation profiles; do not copy mutable rosters or enums
into this file.

## Non-Interactive Shell Commands

Always use non-interactive flags with file operations so aliases cannot hang the session:

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
