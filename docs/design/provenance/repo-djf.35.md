# Windows-canonical supervisor intake

The durable kickoff record and the proposal supervisor must compare target repositories by
the control plane's canonical target identity, never by the caller's path spelling. On Windows,
drive-letter and path-component casing are not repository identity; separators, trailing
separators, and dot segments likewise cannot create a second identity. On POSIX, case remains
significant.

`kickoff.js` already stores the canonical target supplied by `runner/lock.js`. The supervisor
must canonicalize its configured project and the verified record target through that same
authority before accepting the record. A genuinely different canonical target is refused before
the journal changes. Replaying the same immutable record after a supervisor restart remains
idempotent and creates one proposal history only.

The change is confined to target comparison and state-key derivation. It must not relax record
hash validation, cross-target isolation, symlink handling, supervisor authority, or any write,
publication, and credential boundary.
