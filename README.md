# goal-version-lock

Goal Version Lock keeps multi-step development work attached to one approved,
versioned goal contract. It is a local Node.js 22+ Skill with no runtime
dependencies.

Use it for a governed development goal, not ordinary planning, personal goals,
configuration drift, or read-only questions. Read the [Agent workflow](SKILL.md)
for operating rules and the [runtime contract](references/contract.md) for all
wire formats and persisted-state details.

## Quick start

Run commands from the governed project. The examples are fictional and the
digest is illustrative; always use the value returned by your own `init`.

1. Save a version-1 goal draft.

<!-- goal-lock-goal-input:v2 -->
```json
{
  "schema_version": 2,
  "goal_id": "GL-CATALOG-EXPORT",
  "goal_version": 1,
  "objective": "Deliver the reviewed CSV catalog export",
  "scope": { "in": ["CSV export"], "out": ["XML export"] },
  "non_goals": ["Publish a package"],
  "constraints": [{ "id": "C-001", "text": "Use local repository files only" }],
  "acceptance_criteria": [{ "id": "AC-001", "outcome": "CSV export is delivered", "verification": "Record its authorized evidence" }],
  "authorization_boundary": ["Only governed plan paths may change"],
  "assumptions": [{ "statement": "The target project is local", "confidence": "high" }],
  "predecessor": null,
  "accepted_change_id": null
}
```

```console
node scripts/goal-lock.js init --input goal.json
node scripts/goal-lock.js lock --approval "<exact approval_required value>"
```

2. Build a plan candidate whose task has only the declared paths and
validations. The runtime derives its goal binding and plan revision.

<!-- goal-lock-goal-reference:v2 -->
```json
{
  "goal_digest": "fd071f19616f06b4c410d0781a9d2c456582b279e95b4e49a59858795fb7b2c0"
}
```

<!-- goal-lock-plan-input:v2 -->
```json
{
  "next_task_id": "TASK-0001",
  "tasks": [{
    "id": "TASK-0001",
    "outcome": "Implement the reviewed CSV catalog export",
    "acceptance_criteria": ["AC-001"],
    "dependencies": [],
    "permitted_paths": ["src/catalog/export.js"],
    "validations": [{
      "id": "VAL-0001",
      "kind": "focused",
      "method": { "type": "deterministic-test", "target": "node --test tests/exporter-focused.test.js" },
      "affected_paths": ["src/catalog/export.js"],
      "criterion_ids": ["AC-001"],
      "risk_ids": []
    }],
    "status": "pending"
  }],
  "risks": [],
  "deferred": []
}
```

```console
node scripts/goal-lock.js plan --input plan.json --classification aligned
node scripts/goal-lock.js verify
```

The Agent chooses only authorized validation IDs and records evidence by the
exact ValidationRef. The runtime stores validation targets as data and never
executes them.

## CLI

```console
node scripts/goal-lock.js --help
node scripts/goal-lock.js init --input goal.json
node scripts/goal-lock.js lock --approval "<exact phrase>"
node scripts/goal-lock.js lock --approval "<exact phrase>" --inventory inventory.json
node scripts/goal-lock.js verify
node scripts/goal-lock.js plan --input plan.json --classification implementation-choice
node scripts/goal-lock.js propose --input change.json
node scripts/goal-lock.js approve --cr CR-0001 --approval "<exact phrase>"
node scripts/goal-lock.js reject --cr CR-0001 --reason "Keep the approved scope"
node scripts/goal-lock.js record --input event.json
node scripts/goal-lock.js gate --inventory inventory.json
node scripts/goal-lock.js recover-lock --owner-token <uuid> --lock-digest <sha256>
```

The CLI produces one JSON line on stdout for success or one redacted JSON
diagnostic on stderr for failure. `--inventory` is valid for `lock` only
when Git discovery is unavailable; Git mode rejects a competing inventory.

## Scope and completion

Before every slice, verify state and select only the active task's declared
paths and `focused` or `affected-regression` validations. If the needed path
or validation is absent, stop and revise the governed plan. Refuse cleanup,
unrelated evaluations, regression sweeps, and confidence work.

After all current evidence passes, record the final semantic audit and run the
one authorized mandatory gate. Claim completion only when it returns
`COMPLETE`.

Git discovery governs tracked and non-ignored untracked files. In a non-Git
workspace, an explicit sorted inventory is required; files never listed there
are outside runtime visibility. The runtime records governed state but cannot
police host activity.

## Development

The Brief and state remain draft until the final evidence sequence. Do not
publish, release, use credentials, or make remote changes without explicit
authorization.

## License

Apache-2.0. See [LICENSE](LICENSE).
