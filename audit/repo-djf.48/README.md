# repo-djf.48 cross-account audit export

This directory is a sanitized, read-only handoff of machine-local evidence associated with the
continuous-conveyor goal. It is published on an audit-only branch and is not product code.

## Included evidence

- The append-only proposal-supervisor journal (16 events covering three submitted proposals).
- Canonical run manifests, event ledgers, reports, task status, and verification receipts for
  `repo-djf.49`, `repo-djf.50`, and `repo-djf.51`.
- `manifest.json`, which records SHA-256 hashes of both the original local bytes and the
  sanitized exported bytes.

## Deliberate exclusions

Model memory, agent transcripts, container logs, copied issue prompts, documentation-agent output,
credentials, private keys, authority/lease/nonce/token fields, and machine-local host paths are not
published. The export is evidence for diagnosis and handoff; it is not a freeze receipt and does
not make PR #157 mergeable.

## Provenance

The export branch starts from complete WIP commit `ab691d130f0b0e0c10086adad11c58d374034f45`. PR #157 contains the proof
timeline and resume instructions. Raw source artifacts remain machine-local.
