# Goal Version Lock runtime contract

This is the sole detailed public wire contract for protocol version 2. JSON
inputs are strict UTF-8 documents; persisted JSON uses canonical bytes. Every
object below has exact fields: unknown or missing fields are rejected. Digest
strings are lowercase SHA-256 hex; example digest values show shape only unless
explicitly stated to be a computed result.

The runtime records and authorizes data. It never executes a validation
method's `target`.

## Shared forms and path rules

A goal reference is exactly `{ goal_id, goal_version, goal_digest }`. A
ValidationRef adds exactly `plan_revision` and `validation_id`. IDs use
`GL-[A-Z0-9][A-Z0-9-]*`, `AC-NNN`, `TASK-NNNN`, `VAL-NNNN`,
`RISK-NNNN`, `CR-NNNN`, `EVID-NNNN`, and `EVT-NNNNNN`.

All timestamps are RFC 3339 UTC. Delivery, artifact, failure, and inventory
paths are exact repository-relative slash-separated paths: no empty, dot,
parent, absolute, drive, UNC, backslash, glob, or `.goal-lock/` path.
`@governed-workspace` is reserved for the sole affected path of a
`mandatory-gate` validation.

## Current goal and history

`.goal-lock/current.json` is the active approved goal. A version-1 `init`
input has the same exact shape; the runtime rejects any other
`schema_version`, requires a non-empty `scope.in`, unique constraint and
criterion IDs, and `predecessor: null` plus `accepted_change_id: null`.
For later versions, `predecessor` exactly names the prior version/digest and
`accepted_change_id` names the approved CR.

<!-- goal-lock-current-record:v2 -->
```json
{
  "schema_version": 2,
  "goal_id": "GL-CATALOG-EXPORT",
  "goal_version": 1,
  "objective": "Deliver the reviewed CSV catalog export",
  "scope": { "in": ["CSV export"], "out": ["XML export"] },
  "non_goals": ["Publish a package"],
  "constraints": [{ "id": "C-001", "text": "Use local repository files only" }],
  "acceptance_criteria": [{ "id": "AC-001", "outcome": "CSV export is delivered", "verification": "Record authorized evidence" }],
  "authorization_boundary": ["Only governed plan paths may change"],
  "assumptions": [{ "statement": "The target project is local", "confidence": "high" }],
  "predecessor": null,
  "accepted_change_id": null
}
```

`history/goals/vNNNN.json` is byte-for-byte the matching historical
`current.json`. A goal is locked only after the exact returned approval:
`APPROVE GOAL {goal_id} VERSION 1 {first-12-goal-digest}`.

## Scope baseline and lock

`.goal-lock/scope.json` is written exactly once for goal version 1. Its
`entries` are sorted by unique path. Each entry has exactly `path`,
`source`, `mode`, `size`, `digest`, `index_mode`, and
`index_digest`; source is `tracked`, `untracked`, or `inventory`.
Mode is `100644` or `100755`. Git tracked entries have both index fields;
untracked and inventory entries have both index fields `null`. The
`record_digest` hashes this object without itself.

<!-- goal-lock-scope-record:v2 -->
```json
{
  "schema_version": 2,
  "scope_version": 1,
  "goal": { "goal_id": "GL-CATALOG-EXPORT", "goal_version": 1, "goal_digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
  "mode": "inventory",
  "entries": [{ "path": "src/catalog/export.js", "source": "inventory", "mode": "100644", "size": 42, "digest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "index_mode": null, "index_digest": null }],
  "recorded_at": "2026-08-25T00:00:00.000Z",
  "record_digest": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
}
```

`.goal-lock/lock.json` binds current state and the immutable scope head. The
`approval_type` is `explicit-version-1` for version 1 and
`explicit-change` later. `predecessor_digest` is null only for version 1.
`progress_head` and `change_head` are null or their exact ID/digest pair;
`evidence_heads` maps every criterion ID to an exact evidence ID/digest.
`record_digest` hashes the record without itself.

<!-- goal-lock-lock-record:v2 -->
```json
{
  "schema_version": 2,
  "goal_id": "GL-CATALOG-EXPORT",
  "goal_version": 1,
  "goal_digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "approval_type": "explicit-version-1",
  "proposal_digest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "approved_at": "2026-08-25T00:00:00.000Z",
  "predecessor_digest": null,
  "state_revision": 1,
  "scope_head": { "scope_version": 1, "digest": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" },
  "progress_head": null,
  "change_head": null,
  "evidence_heads": {},
  "record_digest": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
}
```

Git mode captures tracked and non-ignored untracked regular files and rejects
a competing inventory. Outside Git, `lock --inventory inventory.json`
requires a sorted, unique, non-empty array of safe delivery-file paths.
Inventory mode cannot discover files never listed in that input; the runtime
cannot police host activity, external tools, or writes it cannot observe.

## Plan records and validation methods

A `plan` input has exactly `next_task_id`, `tasks`, `risks`, and
`deferred`; the runtime derives its schema, active goal reference, and next
plan revision. The stored `.goal-lock/plan.json` adds
`schema_version`, `goal`, and `plan_revision`:

<!-- goal-lock-plan-record:v2 -->
```json
{
  "schema_version": 2,
  "goal": { "goal_id": "GL-CATALOG-EXPORT", "goal_version": 1, "goal_digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
  "plan_revision": 1,
  "next_task_id": "TASK-0001",
  "tasks": [{
    "id": "TASK-0001",
    "outcome": "Implement the reviewed CSV catalog export",
    "acceptance_criteria": ["AC-001"],
    "dependencies": [],
    "permitted_paths": ["src/catalog/export.js"],
    "validations": [{ "id": "VAL-0001", "kind": "focused", "method": { "type": "deterministic-test", "target": "node --test tests/exporter-focused.test.js" }, "affected_paths": ["src/catalog/export.js"], "criterion_ids": ["AC-001"], "risk_ids": [] }],
    "status": "pending"
  }],
  "risks": [],
  "deferred": []
}
```

Tasks use `pending`, `in_progress`, `blocked`, `complete`, or
`stale`; dependencies must exist and cannot cycle. Risks have exactly
`id`, `statement`, `source`, and `affected_paths`; a source is either
`{ kind: "criterion", criterion_id }` or
`{ kind: "failed-validation", validation_ref, evidence_id }`.

Each validation has exactly `id`, `kind`, `method`, `affected_paths`,
`criterion_ids`, and `risk_ids`. Kind is `focused`,
`affected-regression`, or `mandatory-gate`; method type is
`deterministic-test`, `behavior-eval`, `audit`, `manual-review`, or
`delivery-gate`. The target is inert data:

<!-- goal-lock-inert-validation:v2 -->
```json
{
  "id": "VAL-0001",
  "kind": "focused",
  "method": { "type": "deterministic-test", "target": "node --test tests/exporter-focused.test.js" },
  "affected_paths": ["src/catalog/export.js"],
  "criterion_ids": ["AC-001"],
  "risk_ids": []
}
```

`history/plans/vNNNN-rNNNN.json` is byte-for-byte the superseded stored
plan. A plan revision may change only implementation decomposition; contract
changes require a CR.

## Progress, evidence, and final audit

Progress input has exactly the following shape. It cannot submit derived
`plan-revision` or `final-audit` event types; `task-complete` requires at
least one unique evidence ID.

<!-- goal-lock-progress-input:v2 -->
```json
{
  "kind": "progress",
  "event_type": "task-start",
  "task_id": "TASK-0001",
  "summary": "Started the authorized task.",
  "evidence_refs": []
}
```

The append-only `progress.jsonl` record derives goal binding, revision,
timestamp, ID, predecessor digest, and event digest. Event types are
`task-start`, `task-complete`, `blocker`, `verification-result`,
`plan-revision`, `goal-change`, `evidence-invalidation`, `recovery`,
and `final-audit`.

<!-- goal-lock-progress-record:v2 -->
```json
{
  "schema_version": 2,
  "event_id": "EVT-000001",
  "recorded_at": "2026-08-25T00:00:00.000Z",
  "goal": { "goal_id": "GL-CATALOG-EXPORT", "goal_version": 1, "goal_digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
  "plan_revision": 1,
  "task_id": "TASK-0001",
  "event_type": "task-start",
  "summary": "Started the authorized task.",
  "evidence_refs": [],
  "previous_event_digest": null,
  "event_digest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
}
```

Evidence input has exactly `kind`, `acceptance_criterion_id`,
`validation_ref`, `task_id`, `observed_result`, `artifact_refs`,
`inventory`, `state`, `failure_paths`, and `supersedes`. In Git,
`inventory` is null; outside Git it is the same explicit inventory used for
scope comparison. State is `pass`, `fail`, or `stale`; only fail may
list failure paths.

<!-- goal-lock-evidence-input:v2 -->
```json
{
  "kind": "evidence",
  "acceptance_criterion_id": "AC-001",
  "validation_ref": { "goal_id": "GL-CATALOG-EXPORT", "goal_version": 1, "goal_digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "plan_revision": 1, "validation_id": "VAL-0001" },
  "task_id": "TASK-0001",
  "observed_result": "The focused export validation passed.",
  "artifact_refs": ["src/catalog/export.js"],
  "inventory": null,
  "state": "pass",
  "failure_paths": [],
  "supersedes": null
}
```

Stored `evidence/AC-NNN/EVID-NNNN.json` derives identity, workspace
fingerprint, timestamp, and derivation. It has no independent method:

<!-- goal-lock-stored-evidence:v2 -->
```json
{
  "schema_version": 2,
  "evidence_id": "EVID-0001",
  "acceptance_criterion_id": "AC-001",
  "validation_ref": { "goal_id": "GL-CATALOG-EXPORT", "goal_version": 1, "goal_digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "plan_revision": 1, "validation_id": "VAL-0001" },
  "task_id": "TASK-0001",
  "observed_result": "The focused export validation passed.",
  "artifact_refs": ["src/catalog/export.js"],
  "workspace_fingerprint": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "state": "pass",
  "failure_paths": [],
  "supersedes": null,
  "derivation": null,
  "recorded_at": "2026-08-25T00:00:00.000Z"
}
```

Final audit input has exactly `kind`, `semantic_summary`, and `inventory`.
It is recorded only after current evidence and before the final gate.

<!-- goal-lock-final-audit-input:v2 -->
```json
{
  "kind": "final-audit",
  "semantic_summary": "Reviewed the delivered workspace against the active contract.",
  "inventory": null
}
```

## Change request input and persistence

A `propose` input has exactly `candidate`, `changes`, `rationale`,
`affected_tasks`, `criterion_impact`, `risks`, `validation`, and
`rollback`. Candidate has exactly the seven semantic goal fields:
`objective`, `scope`, `non_goals`, `constraints`,
`acceptance_criteria`, `authorization_boundary`, and `assumptions`.
Changes exactly cover semantic differences. Criterion impact exactly partitions
candidate criteria into disjoint `affected` and `unaffected` arrays.

<!-- goal-lock-change-input:v2 -->
```json
{
  "candidate": { "objective": "Deliver reviewed CSV and XML catalog exports", "scope": { "in": ["CSV export", "XML export"], "out": [] }, "non_goals": ["Publish a package"], "constraints": [{ "id": "C-001", "text": "Use local repository files only" }], "acceptance_criteria": [{ "id": "AC-001", "outcome": "CSV and XML exports are delivered", "verification": "Record authorized evidence" }], "authorization_boundary": ["Only governed plan paths may change"], "assumptions": [{ "statement": "The target project is local", "confidence": "high" }] },
  "changes": [{ "field": "objective", "before": "Deliver the reviewed CSV catalog export", "after": "Deliver reviewed CSV and XML catalog exports" }],
  "rationale": "The approved outcome expands.",
  "affected_tasks": ["TASK-0001"],
  "criterion_impact": { "affected": ["AC-001"], "unaffected": [] },
  "risks": ["The new output needs fresh evidence."],
  "validation": ["Declare the successor validation."],
  "rollback": ["Reject the proposal."]
}
```

The persisted `changes/CR-NNNN.json` adds base/candidate metadata, status,
digests, exact approval phrase, and timestamp. Status is `proposed`,
`approved`, `rejected`, or `superseded`; its proposal digest excludes
status and approval phrase.

<!-- goal-lock-change-record:v2 -->
```json
{
  "schema_version": 2,
  "id": "CR-0001",
  "status": "proposed",
  "base_goal": { "goal_id": "GL-CATALOG-EXPORT", "goal_version": 1, "goal_digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
  "candidate_goal": { "schema_version": 2, "goal_id": "GL-CATALOG-EXPORT", "goal_version": 2, "objective": "Deliver reviewed CSV and XML catalog exports", "scope": { "in": ["CSV export", "XML export"], "out": [] }, "non_goals": ["Publish a package"], "constraints": [{ "id": "C-001", "text": "Use local repository files only" }], "acceptance_criteria": [{ "id": "AC-001", "outcome": "CSV and XML exports are delivered", "verification": "Record authorized evidence" }], "authorization_boundary": ["Only governed plan paths may change"], "assumptions": [{ "statement": "The target project is local", "confidence": "high" }], "predecessor": { "goal_version": 1, "goal_digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, "accepted_change_id": "CR-0001" },
  "candidate_digest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "proposal_digest": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "changes": [{ "field": "objective", "before": "Deliver the reviewed CSV catalog export", "after": "Deliver reviewed CSV and XML catalog exports" }],
  "rationale": "The approved outcome expands.",
  "affected_tasks": ["TASK-0001"],
  "criterion_impact": { "affected": ["AC-001"], "unaffected": [] },
  "risks": ["The new output needs fresh evidence."],
  "validation": ["Declare the successor validation."],
  "rollback": ["Reject the proposal."],
  "approval_phrase": "APPROVE CR-0001 GOAL VERSION 2 cccccccccccc",
  "recorded_at": "2026-08-25T00:00:00.000Z"
}
```

Apply a later goal only after the exact returned
`APPROVE {cr_id} GOAL VERSION {candidate-version} {first-12-proposal-digest}`
phrase; generic confirmation is rejected.

## Mandatory-gate failure and completion

Only one `mandatory-gate` ValidationRef may be accepted per plan revision.
After that gate passes, do not repeat it. If it fails, do focused remediation
under the active plan, create a new plan revision, then declare and accept
exactly one successor mandatory-gate ValidationRef. Never rerun or reuse the
failed ValidationRef in the same revision.

<!-- goal-lock-mandatory-gate-failure:v2 -->
```json
{
  "failed_validation_ref": { "goal_id": "GL-CATALOG-EXPORT", "goal_version": 1, "goal_digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "plan_revision": 1, "validation_id": "VAL-0002" },
  "required_sequence": ["focused-remediation", "new-plan-revision", "one-successor-mandatory-gate"],
  "successor_validation_ref": { "goal_id": "GL-CATALOG-EXPORT", "goal_version": 1, "goal_digest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "plan_revision": 2, "validation_id": "VAL-0003" }
}
```

Run `gate` only after that authorized final sequence, with the same
inventory outside Git. It returns `COMPLETE` only when integrity, change
control, task state, current passing evidence, validation trace, mandatory
gate, delivery scope, and final-audit binding all pass.

## CLI envelopes and recovery

Commands accept only separated `--option value` forms. `--input -` is
allowed for `init`, `plan`, `propose`, and `record`; inventory is a
file, never stdin.

| Command | Exact public input |
| --- | --- |
| `init` | one current-goal-shaped version-1 JSON input |
| `lock` | exact initial approval; optional `--inventory inventory.json` only outside Git |
| `verify` | no input |
| `plan` | one four-field plan input and `--classification aligned` or `implementation-choice` |
| `propose` | one eight-field change input |
| `approve` | `--cr CR-NNNN` and the exact current CR approval |
| `reject` | `--cr CR-NNNN` and non-empty normalized `--reason` |
| `record` | exactly one progress, evidence, or final-audit input shape above |
| `gate` | no input in Git; `--inventory inventory.json` outside Git |
| `recover-lock` | exact stale `--owner-token` UUID and `--lock-digest` SHA-256 |

Success is one JSON document on stdout; failure is one
redacted JSON diagnostic on stderr. Exit codes: 0 success/help, 2 input, 3
transition, 4 integrity/path safety, 5 approval, and 6 I/O, Git, rollback, or
recovery.

On integrity failure, stop governed writes. `recover-lock` is only for a
stale cooperative owner with the exact unchanged owner token and lock digest;
it never migrates, reconstructs, or silently accepts damaged state. See the
[Agent workflow](../SKILL.md) for the operating sequence.
