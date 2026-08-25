# Goal Version Lock runtime contract

This is the sole detailed wire contract for protocol version 2. All JSON is
strict UTF-8 and canonicalized by the runtime. Unknown fields are rejected.
The runtime never executes a validation method target.

## Authority and state

`.goal-lock/current.json`, `lock.json`, `scope.json`, `plan.json`,
`progress.jsonl`, history, evidence, and change requests are local authority.
`scope.json` is captured once for goal version 1 and `lock.scope_head`
continues to bind it for every later goal version.

A goal contains exactly `schema_version: 2`, `goal_id`, `goal_version`,
`objective`, `scope`, `non_goals`, `constraints`,
`acceptance_criteria`, `authorization_boundary`, `assumptions`,
`predecessor`, and `accepted_change_id`.

A persisted plan contains `schema_version`, `goal`, `plan_revision`,
`next_task_id`, `tasks`, `risks`, and `deferred`. A task contains
`id`, `outcome`, `acceptance_criteria`, `dependencies`,
`permitted_paths`, `validations`, and `status`. Paths are exact safe
repository-relative paths: no aliases, globs, parent segments, absolute paths,
or bookkeeping paths.

## Validation and evidence

A validation has `id`, `kind`, `method`, `affected_paths`,
`criterion_ids`, and `risk_ids`. Its kind is `focused`,
`affected-regression`, or `mandatory-gate`. Only the final sequence may
use the single authorized `mandatory-gate`.

The method is inert descriptive data. Its `target` is not a command for this
runtime, CLI, or persistence layer to execute.

<!-- goal-lock-inert-validation:v2 -->
```json
{
  "id": "VAL-0001",
  "kind": "focused",
  "method": {
    "type": "deterministic-test",
    "target": "node --test tests/exporter-focused.test.js"
  },
  "affected_paths": ["src/catalog/export.js"],
  "criterion_ids": ["AC-001"],
  "risk_ids": []
}
```

A ValidationRef has exactly `goal_id`, `goal_version`, `goal_digest`,
`plan_revision`, and `validation_id`. Evidence input names that exact
reference and has no independent method or command field:

<!-- goal-lock-evidence-input:v2 -->
```json
{
  "kind": "evidence",
  "acceptance_criterion_id": "AC-001",
  "validation_ref": {
    "goal_id": "GL-CATALOG-EXPORT",
    "goal_version": 1,
    "goal_digest": "fd071f19616f06b4c410d0781a9d2c456582b279e95b4e49a59858795fb7b2c0",
    "plan_revision": 1,
    "validation_id": "VAL-0001"
  },
  "task_id": "TASK-0001",
  "observed_result": "The focused export validation passed.",
  "artifact_refs": ["src/catalog/export.js"],
  "inventory": null,
  "state": "pass",
  "failure_paths": [],
  "supersedes": null
}
```

The runtime derives stored evidence identity, timestamp, fingerprint, and
lineage. It authorizes the reference against the persisted plan history; prose
or an unplanned command never becomes evidence authority.

## Workspace baseline

At version-1 lock, Git mode captures the tracked and non-ignored untracked
workspace manifest. A supplied inventory in Git mode is rejected. Outside
Git, `lock --inventory inventory.json` requires a sorted, unique, non-empty
array of safe delivery-file paths and becomes the baseline.

Inventory mode proves only listed files. In inventory mode, never-listed files outside an inventory are not discoverable, so inventory mode cannot establish their
absence or control their changes. The runtime cannot police host activity,
external tools, or writes outside its observed workspace state.

Evidence and final-audit inputs use `inventory: null` in Git; outside Git
they use the same explicit inventory. `gate --inventory inventory.json`
uses that inventory for the final comparison.

## CLI data operations

Commands accept only separated `--option value` forms:

| Command | Required data |
| --- | --- |
| `init` | `--input` draft JSON or `-` |
| `lock` | exact `--approval`; optional `--inventory` only outside Git |
| `verify` | none |
| `plan` | `--input` candidate and `--classification aligned\|implementation-choice` |
| `propose` | `--input` change-request candidate |
| `approve` | `--cr` and exact `--approval` |
| `reject` | `--cr` and `--reason` |
| `record` | `--input` progress, evidence, or final-audit data |
| `gate` | optional `--inventory` |
| `recover-lock` | exact `--owner-token` and `--lock-digest` |

Success is one JSON document on stdout. Failure is one redacted JSON
diagnostic on stderr. Exit codes are 0 success/help, 2 input, 3 transition, 4
integrity/path safety, 5 approval, and 6 I/O, Git, rollback, or recovery.

## Change, recovery, and completion

Version 1 accepts only `APPROVE GOAL {goal_id} VERSION 1
{first-12-goal-digest}`. A later goal change requires `propose` and the
exact current `APPROVE {cr_id} GOAL VERSION {candidate-version}
{first-12-proposal-digest}` phrase. Generic confirmation is rejected.

On tamper or integrity failure, stop governed writes. `recover-lock` applies
only to a stale cooperative owner with its unchanged token-and-digest binding;
it is not a migration or repair mechanism.

Completion requires verified integrity, no pending CR, complete tasks, current
passing evidence, validation trace, one accepted mandatory gate, an authorized
delivery scope, and a final audit bound to the current workspace fingerprint.
See the [Agent workflow](../SKILL.md) for the operating sequence.
