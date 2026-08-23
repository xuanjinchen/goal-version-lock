# goal\-version\-lock

`goal-version-lock` is a local Agent Skill and dependency-free Node.js CLI for keeping multi-step development work aligned to an approved goal. It versions the goal contract, separates plan revisions from goal changes, records progress and evidence, and blocks unsupported completion claims.

The primary audience is developers who already use a local Codex or Agent Skill directory. The quick start also explains each required artifact for first-time Skill users. Host discovery and loading remain features of the configured Agent environment, not compatibility claims made by this project.

## Features

- Canonical versioned goals with objective, scope, non-goals, constraints, authorization boundaries, and measurable acceptance criteria.
- Exact approval phrases for the initial lock and every later field-level change request.
- Goal-bound plans, append-only progress, immutable evidence lineage, and context-loss resume state.
- Fail-closed verification for missing history, digest mismatch, broken predecessor chains, and unsafe paths.
- Final semantic audit and deterministic completion checklist.
- Node.js standard-library implementation with no runtime dependencies.

## Prerequisites

- Node.js 22 or newer.
- A local Skill directory already loaded by your Agent host.
- A development project that the Agent may read and modify within the user's authorization boundary.
- Git for automatic workspace fingerprints. A non-Git project must provide an explicit sorted artifact inventory.

No package installation is required for runtime use.

## Install as a local Skill

Create a `goal-version-lock/` directory under your configured local Skill directory. Copy these paths without flattening their layout:

```text
goal-version-lock/
├── SKILL.md
├── package.json
├── references/
│   └── contract.md
├── scripts/
│   └── goal-lock.js
└── src/
    └── goal-lock/
        └── *.js
```

The required runtime bundle is `SKILL.md`, `references/`, `scripts/`, `src/goal-lock/`, and `package.json`. The package file supplies the Node.js ESM boundary; it does not install dependencies.

Ask the host to reload local Skills according to its own configuration. Then check the copied CLI from the Skill directory:

```console
node scripts/goal-lock.js --help
```

When the Skill is installed outside the governed project, use the installed script's real path while keeping the governed project as the current working directory. The remaining examples use the repository-development form `node scripts/goal-lock.js` for readability.

## Quick start

The paths, goal ID, and digests below are fictional. Run the commands from the project you want to govern.

1. Save a complete version-1 draft as `goal-draft.json`:

```json
{
  "schema_version": 1,
  "goal_id": "GL-CATALOG-EXPORT",
  "goal_version": 1,
  "objective": "Add a reviewed catalog export",
  "scope": { "in": ["CSV export"], "out": ["Scheduled delivery"] },
  "non_goals": ["Publish a release"],
  "constraints": [{ "id": "C-001", "text": "Keep the existing API stable" }],
  "acceptance_criteria": [{
    "id": "AC-001",
    "outcome": "A user can export the catalog as CSV",
    "verification": "Run the export integration test"
  }],
  "authorization_boundary": ["Modify catalog export code and tests only"],
  "assumptions": [{ "statement": "The current CSV library remains available", "confidence": "medium" }],
  "predecessor": null,
  "accepted_change_id": null
}
```

2. Create the draft:

```console
node scripts/goal-lock.js init --input goal-draft.json
```

Expected output shape:

```json
{"ok":true,"command":"init","result":{"state":"DRAFT","goal_id":"GL-CATALOG-EXPORT","goal_version":1,"goal_digest":"<64-lowercase-hex>","approval_required":"APPROVE GOAL GL-CATALOG-EXPORT VERSION 1 <first-12-digest>"}}
```

3. Show `approval_required` to the user. Paste the actual returned value only after they repeat it exactly:

```console
node scripts/goal-lock.js lock --approval "APPROVE GOAL GL-CATALOG-EXPORT VERSION 1 0123456789ab"
```

The digest in that command is a fictional example. A generic “yes” or “approved” is not accepted.

4. Save a plan candidate as `plan-input.json`, then bind it to the active goal:

```console
node scripts/goal-lock.js plan --input plan-input.json --classification aligned
node scripts/goal-lock.js verify
```

Expected output from `verify` is one JSON success envelope whose result state reflects the verified repository, such as `LOCKED`. Errors use stderr, a JSON error envelope, and a nonzero documented exit code.

## CLI reference

The CLI accepts separated `--option value` arguments. JSON input paths are safe repository-relative paths, or `-` where stdin is supported.

| Purpose | Example |
| --- | --- |
| Show read-only help | `node scripts/goal-lock.js --help` |
| Create a draft | `node scripts/goal-lock.js init --input goal-draft.json` |
| Lock version 1 | `node scripts/goal-lock.js lock --approval "<exact phrase>"` |
| Verify state | `node scripts/goal-lock.js verify` |
| Create or revise a plan | `node scripts/goal-lock.js plan --input plan-input.json --classification implementation-choice` |
| Propose a goal change | `node scripts/goal-lock.js propose --input change-proposal.json` |
| Approve a current proposal | `node scripts/goal-lock.js approve --cr CR-0001 --approval "<exact phrase>"` |
| Reject a current proposal | `node scripts/goal-lock.js reject --cr CR-0001 --reason "Keep the approved scope"` |
| Record progress, evidence, or audit | `node scripts/goal-lock.js record --input event.json` |
| Run the completion checklist | `node scripts/goal-lock.js gate --inventory inventory.json` |
| Recover a stale write lock | `node scripts/goal-lock.js recover-lock --owner-token 11111111-1111-4111-8111-111111111111 --lock-digest 0000000000000000000000000000000000000000000000000000000000000000` |

Exit codes are stable: `0` success/help, `2` usage/input, `3` invalid transition, `4` integrity/tamper/unsafe path, `5` approval/stale approval, and `6` I/O/Git/rollback/recovery. See the [runtime contract](references/contract.md) for exact input and persisted schemas.

## Core concepts

| Concept | Meaning |
| --- | --- |
| Goal contract | The approved objective and boundaries in `.goal-lock/current.json`. |
| Goal version | A sequential version accepted through an exact initial or change approval. |
| Goal digest | SHA-256 of the canonical current goal bytes. It binds plans, progress, evidence, and approvals. |
| Plan revision | Implementation decomposition under one unchanged goal version. It cannot change the goal contract. |
| Change request | A field-level proposal for the next goal version, with risks, validation, rollback, and an exact approval phrase. |
| Progress and evidence | Digest-linked events and immutable criterion evidence tied to the current goal and plan. |
| Completion gate | A deterministic checklist over verified state, current evidence, final audit, and workspace fingerprint. |

`current.json`, `lock.json`, and `plan.json` are current authority. `progress.jsonl`, history, change requests, and evidence preserve lineage. Conversation memory and external planners are not authority.

## Common workflows

### Resume after context loss

Run `verify`. Re-read `current.json`, `lock.json`, `plan.json`, and the final complete progress event. Resume only the verified `next_task_id`, after checking its dependencies and permitted paths.

### Record a task and evidence

Use `record` with `kind: "progress"` to append `task-start`, `blocker`, or `task-complete`. Use `kind: "evidence"` for an immutable acceptance-criterion result. Record current evidence before `task-complete`, and include its evidence ID in `evidence_refs`.

### Revise implementation without changing the goal

Classify decomposition, ordering, or permitted-path changes as `aligned` or `implementation-choice`. Submit only `next_task_id`, `tasks`, and `deferred` to `plan`. The runtime preserves task status and derives the goal binding and revision.

### Change the approved contract

Run `verify`, then submit the seven semantic candidate fields plus complete field-level changes to `propose`. Review the CR ID, candidate version, proposal digest, impacts, risk, validation, and rollback. Run `approve` only after the user repeats the returned `approval_required` phrase exactly. Use `reject` to close an unwanted current proposal.

### Complete governed work

Finish all tasks and record current passing evidence for every criterion. Perform a semantic diff audit, record `kind: "final-audit"`, make no further delivery write, and run `gate` with the same inventory when outside Git. Claim completion only for `state: "COMPLETE"` with every checklist item passing.

## Recovery and tamper troubleshooting

### `verify` returns an integrity failure or exit code 4

**Cause:** A digest, history record, predecessor, append-only prefix, path, or other integrity boundary is invalid.

**Resolution:** Stop goal-governed writes. Preserve the reported bytes and inspect them read-only. Restore only an exact, user-selected known-good copy, then run `verify` again. Do not edit JSON by hand, recreate missing history, or accept the changed bytes as a new goal.

### A stale `.write-lock.json` blocks commands

**Cause:** A cooperative writer may have stopped before releasing its lock.

**Resolution:** First establish that no owner is active. Read the exact owner token and calculate SHA-256 over the unchanged lock bytes. Supply both values to `recover-lock`. The command fails if either binding changed. This recovery removes only the matching stale write lock; it does not repair contract tampering.

### `gate` returns `BLOCKED`

Read the returned checklist. Typical causes are an open change request, a nonterminal task, missing current passing evidence, no final audit, or a workspace fingerprint changed after audit. Fix the specific governed state, record a new final audit, and rerun the gate.

## Optional planning-with-files bridge

`planning-with-files` is optional and non-authoritative. If you use it as a navigation display, map only the active goal ID, version, and digest:

| External display | `.goal-lock/` source |
| --- | --- |
| `goal_id` | `current.json` |
| `goal_version` | `lock.json` |
| `goal_digest` | `lock.json` |

The mapping is by goal ID, version, and digest. Never substitute an external plan for `current.json`, `lock.json`, `plan.json`, `progress.jsonl`, or evidence. On disagreement, stop and trust only state that passes `verify`.

## Non-goals

- Personal OKR or habit tracking.
- Infrastructure configuration-drift detection.
- Identity authentication, autonomous loops, host hooks, or a Skill installer.
- Replacing specialist design, coding, test, review, or release workflows.
- Publishing, tags, releases, remote changes, credential use, paid operations, or destructive recovery without explicit authorization.
- Formal cross-platform certification or verified adapters for named Agent products.

## Documentation

- [Agent workflow](SKILL.md)
- [Runtime and persistence contract](references/contract.md)
- [Current requirements brief](docs/skill-brief.md)

## Contributing

Use Node.js 22 or newer. Write deterministic tests before runtime changes, keep documentation aligned to the actual CLI, and run:

```console
npm run check
```

Do not publish, tag, release, change remotes, use credentials, or run paid evaluations without explicit authorization.

## License

Licensed under Apache-2.0. See [LICENSE](LICENSE).
