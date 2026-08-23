---
title: "Goal Version Lock Contract"
version: "1"
---

# Goal Version Lock Contract

This reference defines the public CLI inputs and persisted `.goal-lock/`
protocol. The approved goal and its goal-bound plan are authoritative;
external planning displays are optional and subordinate.

## Contents

- [When to load this reference](#when-to-load-this-reference)
- [Authority and lifecycle](#authority-and-lifecycle)
- [Machine-readable contract](#machine-readable-contract)
- [Input derivation rules](#input-derivation-rules)
- [Command envelopes](#command-envelopes)
- [Integrity and recovery boundary](#integrity-and-recovery-boundary)

## When to load this reference

Load this file when creating, validating, changing, gating, or recovering
runtime state. Ordinary implementation work needs only the verified current
goal and plan; loading the complete schemas on every work slice adds context
without changing their authority.

## Authority and lifecycle

The governed project's current working directory is the runtime root. A normal
lifecycle is `DRAFT` after `init`, `LOCKED` after exact version-1 approval,
`CHANGE_PENDING` while one change request awaits a decision, and `COMPLETE`
only when every gate condition passes. `TAMPERED` and integrity exit code `4`
are fail-closed states, not alternate versions of the goal.

`current.json`, `lock.json`, and `plan.json` are authoritative current state.
`progress.jsonl` is append-only. History, change, and evidence paths preserve
accepted lineage.

## Machine-readable contract

<!-- goal-lock-reference-contract:v1 -->
```json
{
  "schema_version": 1,
  "identifiers": {
    "goal_id": "^GL-[A-Z0-9][A-Z0-9-]*$",
    "acceptance_criterion_id": "^AC-[0-9]{3}$",
    "task_id": "^TASK-[0-9]{4}$",
    "change_request_id": "^CR-[0-9]{4}$",
    "event_id": "^EVT-[0-9]{6}$",
    "evidence_id": "^EVID-[0-9]{4}$"
  },
  "timestamp_format": "RFC 3339 UTC with a Z suffix",
  "canonicalization": {
    "encoding": "UTF-8",
    "object_keys": "recursively sorted by JavaScript ordinal string comparison",
    "arrays": "preserve input order",
    "document_terminator": "exactly one LF",
    "json": "compact JSON; reject non-finite numbers, unsafe integers, undefined, functions, symbols, sparse arrays, non-plain objects, and cycles",
    "digest": "SHA-256 of the exact canonical bytes as 64 lowercase hexadecimal characters"
  },
  "safe_relative_paths": {
    "separator": "/",
    "reject": [
      "absolute paths",
      "drive paths",
      "UNC paths",
      "backslashes",
      "NUL",
      "empty segments",
      ".",
      ".."
    ],
    "delivery_artifacts_reject_prefix": ".goal-lock/"
  },
  "inputs": {
    "initial_goal": {
      "command": "init",
      "fields": [
        "schema_version",
        "goal_id",
        "goal_version",
        "objective",
        "scope",
        "non_goals",
        "constraints",
        "acceptance_criteria",
        "authorization_boundary",
        "assumptions",
        "predecessor",
        "accepted_change_id"
      ],
      "fixed": {
        "schema_version": 1,
        "goal_version": 1,
        "predecessor": null,
        "accepted_change_id": null
      }
    },
    "plan_candidate": {
      "command": "plan",
      "fields": [
        "next_task_id",
        "tasks",
        "deferred"
      ],
      "derived": [
        "schema_version",
        "goal",
        "plan_revision"
      ]
    },
    "change_proposal": {
      "command": "propose",
      "fields": [
        "candidate",
        "changes",
        "rationale",
        "affected_tasks",
        "affected_criteria",
        "risks",
        "validation",
        "rollback"
      ],
      "candidate_fields": [
        "objective",
        "scope",
        "non_goals",
        "constraints",
        "acceptance_criteria",
        "authorization_boundary",
        "assumptions"
      ]
    },
    "progress": {
      "command": "record",
      "fields": [
        "kind",
        "event_type",
        "task_id",
        "summary",
        "evidence_refs"
      ],
      "fixed": {
        "kind": "progress"
      }
    },
    "evidence": {
      "command": "record",
      "fields": [
        "kind",
        "acceptance_criterion_id",
        "task_id",
        "method",
        "observed_result",
        "artifact_refs",
        "workspace_fingerprint",
        "state",
        "supersedes"
      ],
      "fixed": {
        "kind": "evidence"
      }
    },
    "final_audit": {
      "command": "record",
      "fields": [
        "kind",
        "semantic_summary",
        "inventory"
      ],
      "fixed": {
        "kind": "final-audit"
      }
    },
    "inventory": {
      "commands": [
        "gate",
        "record final-audit"
      ],
      "shape": "sorted non-empty array of unique safe delivery-file paths; required only outside Git"
    }
  },
  "artifacts": {
    ".write-lock.json": {
      "kind": "canonical internal cooperative-owner record; never accepted goal state",
      "required_fields": [
        "protocol",
        "token",
        "pid",
        "command",
        "created_at"
      ],
      "field_types": {
        "protocol": "literal goal-version-lock-write-v1",
        "token": "random owner token",
        "pid": "positive integer process identifier",
        "command": "non-empty trimmed command name",
        "created_at": "timestamp"
      }
    },
    "current.json": {
      "kind": "canonical JSON document",
      "required_fields": [
        "schema_version",
        "goal_id",
        "goal_version",
        "objective",
        "scope",
        "non_goals",
        "constraints",
        "acceptance_criteria",
        "authorization_boundary",
        "assumptions",
        "predecessor",
        "accepted_change_id"
      ],
      "field_types": {
        "schema_version": "integer literal 1",
        "goal_id": "goal_id",
        "goal_version": "positive integer",
        "objective": "non-empty trimmed string",
        "scope": "object { in: non-empty array of non-empty trimmed strings, out: array of non-empty trimmed strings }",
        "non_goals": "array of non-empty trimmed strings",
        "constraints": "array of unique objects { id: non-empty trimmed string, text: non-empty trimmed string }",
        "acceptance_criteria": "array of unique objects { id: acceptance_criterion_id, outcome: non-empty trimmed string, verification: non-empty trimmed string }",
        "authorization_boundary": "array of non-empty trimmed strings",
        "assumptions": "array of objects { statement: non-empty trimmed string, confidence: high|medium|low }",
        "predecessor": "null for version 1, otherwise { goal_version: positive integer, goal_digest: sha256 } for exactly version-1",
        "accepted_change_id": "null for version 1, otherwise change_request_id"
      }
    },
    "lock.json": {
      "kind": "canonical JSON document",
      "required_fields": [
        "schema_version",
        "goal_id",
        "goal_version",
        "goal_digest",
        "approval_type",
        "proposal_digest",
        "approved_at",
        "predecessor_digest",
        "state_revision",
        "progress_head",
        "change_head",
        "evidence_heads",
        "record_digest"
      ],
      "field_types": {
        "schema_version": "integer literal 1",
        "goal_id": "goal_id",
        "goal_version": "positive integer",
        "goal_digest": "sha256 of current.json exact canonical bytes",
        "approval_type": "explicit-version-1|explicit-change",
        "proposal_digest": "sha256",
        "approved_at": "timestamp",
        "predecessor_digest": "null for version 1, otherwise sha256",
        "state_revision": "positive integer incremented for every accepted state change",
        "progress_head": "null or { event_id: event_id, digest: sha256 }",
        "change_head": "null or { change_request_id: change_request_id, digest: sha256 }",
        "evidence_heads": "object keyed by acceptance_criterion_id with values { evidence_id: evidence_id, digest: sha256 }",
        "record_digest": "sha256 of this lock record with record_digest omitted"
      }
    },
    "plan.json": {
      "kind": "canonical JSON document",
      "required_fields": [
        "schema_version",
        "goal",
        "plan_revision",
        "next_task_id",
        "tasks",
        "deferred"
      ],
      "field_types": {
        "schema_version": "integer literal 1",
        "goal": "object { goal_id: goal_id, goal_version: positive integer, goal_digest: sha256 } equal to the active lock",
        "plan_revision": "positive integer starting at 1 for each goal version",
        "next_task_id": "task_id or null; a non-complete scheduled task",
        "tasks": "array of unique objects { id: task_id, outcome: non-empty trimmed string, acceptance_criteria: non-empty array of acceptance_criterion_id, dependencies: array of task_id, permitted_paths: array of safe relative paths, verification: non-empty trimmed string, status: task_status }",
        "deferred": "array of objects { id: task_id, reason: non-empty trimmed string }"
      }
    },
    "progress.jsonl": {
      "kind": "append-only canonical JSON lines",
      "required_fields": [
        "schema_version",
        "event_id",
        "recorded_at",
        "goal",
        "plan_revision",
        "task_id",
        "event_type",
        "summary",
        "evidence_refs",
        "previous_event_digest",
        "event_digest"
      ],
      "field_types": {
        "schema_version": "integer literal 1",
        "event_id": "event_id; sequential from EVT-000001",
        "recorded_at": "timestamp",
        "goal": "object { goal_id: goal_id, goal_version: positive integer, goal_digest: sha256 } equal to the active lock",
        "plan_revision": "positive integer",
        "task_id": "task_id or null",
        "event_type": "event_type",
        "summary": "non-empty trimmed string",
        "evidence_refs": "array of evidence_id",
        "previous_event_digest": "null for the first event, otherwise sha256 of the preceding event",
        "event_digest": "sha256 of the canonical event payload without event_digest"
      }
    },
    "changes/CR-0001.json": {
      "kind": "canonical immutable change-request record except status transition",
      "required_fields": [
        "schema_version",
        "id",
        "status",
        "base_goal",
        "candidate_goal",
        "candidate_digest",
        "proposal_digest",
        "changes",
        "rationale",
        "affected_tasks",
        "affected_criteria",
        "risks",
        "validation",
        "rollback",
        "approval_phrase",
        "recorded_at"
      ],
      "field_types": {
        "schema_version": "integer literal 1",
        "id": "change_request_id",
        "status": "change_status",
        "base_goal": "object { goal_id: goal_id, goal_version: positive integer, goal_digest: sha256 }",
        "candidate_goal": "full current.json contract for base_goal.goal_version + 1",
        "candidate_digest": "sha256 of candidate_goal canonical bytes",
        "proposal_digest": "sha256 of the CR payload without status and approval_phrase",
        "changes": "non-empty array of { field: non-empty trimmed string, before: JSON value, after: JSON value } covering each semantic difference",
        "rationale": "non-empty trimmed string",
        "affected_tasks": "array of task_id",
        "affected_criteria": "array of acceptance_criterion_id",
        "risks": "array of non-empty trimmed strings",
        "validation": "array of non-empty trimmed strings",
        "rollback": "array of non-empty trimmed strings",
        "approval_phrase": "change approval grammar",
        "recorded_at": "timestamp"
      }
    },
    "history/goals/v0001.json": {
      "kind": "immutable canonical current.json archive",
      "required_fields": [
        "schema_version",
        "goal_id",
        "goal_version",
        "objective",
        "scope",
        "non_goals",
        "constraints",
        "acceptance_criteria",
        "authorization_boundary",
        "assumptions",
        "predecessor",
        "accepted_change_id"
      ],
      "field_types": {
        "content": "byte-for-byte identical to current.json for the matching goal version",
        "filename": "vNNNN.json where NNNN is goal_version padded to four digits"
      }
    },
    "history/plans/v0001-r0001.json": {
      "kind": "immutable canonical prior plan archive",
      "required_fields": [
        "schema_version",
        "goal",
        "plan_revision",
        "next_task_id",
        "tasks",
        "deferred"
      ],
      "field_types": {
        "content": "byte-for-byte identical to the superseded plan.json revision",
        "filename": "vNNNN-rNNNN.json using padded goal version and plan revision"
      }
    },
    "evidence/AC-001/EVID-0001.json": {
      "kind": "canonical immutable evidence record",
      "required_fields": [
        "schema_version",
        "evidence_id",
        "acceptance_criterion_id",
        "goal",
        "plan_revision",
        "task_id",
        "method",
        "observed_result",
        "artifact_refs",
        "workspace_fingerprint",
        "state",
        "supersedes",
        "recorded_at"
      ],
      "field_types": {
        "schema_version": "integer literal 1",
        "evidence_id": "evidence_id; monotonically increasing within its acceptance_criterion_id directory",
        "acceptance_criterion_id": "acceptance_criterion_id matching the directory",
        "goal": "object { goal_id: goal_id, goal_version: positive integer, goal_digest: sha256 }",
        "plan_revision": "positive integer",
        "task_id": "task_id",
        "method": "non-empty trimmed command or manual method",
        "observed_result": "non-empty trimmed string",
        "artifact_refs": "array of safe relative paths",
        "workspace_fingerprint": "sha256",
        "state": "evidence_state",
        "supersedes": "null for the first record, otherwise the immediately preceding evidence_id for this criterion",
        "recorded_at": "timestamp"
      }
    }
  },
  "enums": {
    "task_status": ["pending", "in_progress", "blocked", "complete", "stale"],
    "change_status": ["proposed", "approved", "rejected", "superseded"],
    "evidence_state": ["pass", "fail", "stale"],
    "event_type": ["task-start", "task-complete", "plan-revision", "blocker", "verification-result", "goal-change", "evidence-invalidation", "recovery", "final-audit"],
    "request_classification": ["aligned", "implementation-choice", "clarification", "goal-change", "constraint-change", "ambiguous", "conflicting"]
  },
  "approval": {
    "initial": "APPROVE GOAL {goal_id} VERSION 1 {first-12-goal-digest}",
    "change": "APPROVE {cr_id} GOAL VERSION {candidate-version} {first-12-proposal-digest}",
    "matching": "byte-for-byte and case-sensitive",
    "generic_confirmation": "rejected with exit code 5"
  },
  "digest_rules": {
    "current_history": "current.json and history/goals/vNNNN.json have byte-for-byte identical canonical bytes",
    "lock_record": "record_digest hashes every lock.json field except record_digest",
    "lock_heads": "state_revision and every head update atomically with each accepted state change",
    "progress": "event_digest hashes the canonical event payload without event_digest; previous_event_digest links the preceding event",
    "evidence": "a newer immutable record names the immediately preceding evidence ID in supersedes; stale records supersede affected current evidence"
  },
  "plan_transitions": {
    "allowed": ["pending->in_progress", "pending->blocked", "pending->stale", "in_progress->blocked", "in_progress->complete", "in_progress->stale", "blocked->in_progress", "blocked->stale"],
    "terminal": ["complete", "stale"],
    "rule": "A plan revision can change implementation decomposition only; any objective, scope, non-goal, mandatory-constraint, completion-definition, or authorization-boundary change requires a change request."
  },
  "fingerprints": {
    "git": "canonical manifest of HEAD identity, tracked diff bytes, and sorted non-ignored untracked delivery names, modes, sizes, and bytes; exclude .git/ and .goal-lock/",
    "inventory": "canonical manifest of the explicit repository-relative artifact inventory names and bytes",
    "completion": "a final semantic audit event and the gate use the exact active workspace fingerprint"
  },
  "cli": {
    "exit_codes": {
      "0": "success or read-only help",
      "2": "usage or input error",
      "3": "invalid state transition",
      "4": "integrity, tamper, or unsafe-path failure",
      "5": "approval phrase or stale-approval failure",
      "6": "I/O, Git, or rollback/recovery failure"
    },
    "commands": [
      { "command": "init", "input": "draft.json or -" },
      { "command": "lock", "approval": "required" },
      { "command": "verify" },
      { "command": "plan", "input": "plan.json or -", "classification": ["aligned", "implementation-choice"] },
      { "command": "propose", "input": "change-proposal.json or -" },
      { "command": "approve", "cr": "CR-0001", "approval": "required" },
      { "command": "reject", "cr": "CR-0001", "reason": "required" },
      { "command": "record", "input": "progress-input.json or -" },
      { "command": "gate", "inventory": "optional inventory.json" },
      { "command": "recover-lock", "owner_token": "required", "lock_digest": "required" }
    ]
  }
}
```

## Input derivation rules

- `init` accepts one complete version-1 goal. It does not derive or approve
  omitted semantic fields.
- `plan` accepts only `next_task_id`, `tasks`, and `deferred`. Task objects use
  the persisted `plan.json` task shape. The runtime derives the schema, active
  goal reference, and next plan revision; shared task status is preserved and
  a new task starts as `pending`.
- `propose` accepts all seven semantic goal fields under `candidate` and an
  exact `changes` entry for every semantic difference. The runtime derives the
  next version, predecessor, CR ID, candidate digest, proposal digest, and
  approval phrase. Affected task and criterion IDs must exist in current state.
- `record` accepts exactly one of the three input shapes above. Ordinary
  progress cannot submit derived `plan-revision` or `final-audit` event types.
  Evidence must supersede the immediately preceding record for its criterion.
- A final-audit input uses `inventory: null` in Git. Outside Git, use the same
  sorted, unique, non-empty safe delivery-file array for the final audit and
  `gate --inventory`; bookkeeping paths under `.git/` or `.goal-lock/` are
  forbidden.

All CLI JSON inputs must be strict UTF-8 documents of at most 1 MiB. File
inputs are repository-relative, use `/`, and must be unlinked regular files.
The CLI also accepts `--input -` for `init`, `plan`, `propose`, and `record`.
Inventory input must be a file, not stdin.

## Command envelopes

On success, the CLI writes exactly one compact JSON line to stdout and nothing
to stderr:

```json
{"ok":true,"command":"verify","result":{"state":"LOCKED"}}
```

On failure, it writes exactly one redacted JSON line to stderr and nothing to
stdout. The process exit code matches `cli.exit_codes`:

```json
{"ok":false,"command":"verify","error":{"code":"GOAL_REPOSITORY_TAMPERED","message":"Goal-lock integrity or path safety verification failed."}}
```

Diagnostics do not echo input bytes, objectives, approval phrases, rejection
reasons, owner tokens, digests, or file paths. `--help` is a read-only success
whose `result` is the complete usage string.

## Integrity and recovery boundary

Every mutating command verifies the accepted state and uses a cooperative
`.write-lock.json`, atomic replacement, read-back verification, and rollback.
Do not remove that file merely because it exists. `recover-lock` succeeds only
when its owner token and SHA-256 bind to the unchanged lock and recovery safety
checks pass.

Recovery of `.write-lock.json` is not recovery of `current.json`, history,
progress, change requests, evidence, or their digest chains. Preserve an
integrity failure for inspection and restore only exact user-selected
known-good bytes; never rewrite damaged state into a newly accepted goal.

See the [Agent workflow](../SKILL.md) for semantic routing and the [Skill
Brief](../docs/skill-brief.md) for the current requirements.
