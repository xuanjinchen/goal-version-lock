# goal\-version\-lock

Goal Version Lock keeps each development work slice aligned with one explicitly
confirmed stage goal. It is a local Node.js 22+ Skill with no runtime
dependencies.

This release uses protocol-v1 goal records and is incompatible with protocol-v2
state. It does not read, migrate, or wrap protocol-v2 records.

## Goal input

Create a JSON file containing exactly these four fields:

<!-- goal-lock-input:v1 -->
```json
{
  "objective": "Preserve the final row in the CSV export",
  "success_criteria": ["The final source row is present in the CSV output"],
  "constraints": ["Keep the confirmed CSV format"],
  "non_goals": ["Add another export format"]
}
```

## Commands

Run these commands from the governed project:

```console
node scripts/goal-lock.js init --input goal.json
node scripts/goal-lock.js propose --input goal.json
node scripts/goal-lock.js approve --approval "APPROVAL_PHRASE_FROM_PROPOSAL"
node scripts/goal-lock.js verify
node scripts/goal-lock.js status
```

`verify` must run before every new work slice. An initial `init` or a clear
change proposal has no authority until its exact generated approval phrase is
accepted. The active record is the only authority that permits work to continue.

## Outcomes

- `aligned`: the requested work changes none of the four active fields; continue
  with the active version and digest.
- `goal-change-required`: the request clearly changes one or more fields; show
  every changed field and wait for exact approval of the complete proposal.
- `clarification-required`: the request has both aligned and goal-changing
  readings; ask one focused question and leave accepted state unchanged.

## Persisted records

- `.goal-lock/current.json` stores the active goal.
- `.goal-lock/history/vNNNN.json` stores immutable versions.
- `.goal-lock/proposal.json` stores a pending, non-authoritative proposal.

Every accepted version is bound to canonical bytes, a SHA-256 digest, and its
predecessor. Tampered records or broken history fail closed.

## License

Apache-2.0. See [LICENSE](LICENSE).
