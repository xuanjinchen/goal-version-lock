# Goal Version Lock Design

**Date:** 2026-08-23

**Status:** Approved for implementation planning

**Skill:** `goal-version-lock`

## Purpose

`goal-version-lock` prevents development work from silently changing its approved objective. It establishes a versioned goal contract, binds planning and progress to that contract, routes goal-level changes through an explicit two-stage approval flow, and blocks completion when integrity or evidence checks fail.

The Skill is standalone. It provides its own goal-bound planning and progress records and does not require `planning-with-files`. When both Skills are present, `goal-version-lock` remains the authority for what may be built while `planning-with-files` may provide a richer, non-authoritative execution view.

## Design Inputs

The design incorporates three proven ideas from `planning-with-files` without copying its implementation:

1. Persist important state on disk so it survives context loss.
2. Re-read the active goal before decisions and work slices.
3. Bind approved content to a SHA-256 attestation and fail closed when it changes.

This Skill adds semantic goal fields, goal and plan version separation, change requests, explicit approval evidence, stale-evidence handling, and a goal-aware completion gate.

## Goals

- Lock the observable development outcome, scope, non-goals, constraints, authorization boundary, and acceptance criteria into an approved goal version.
- Detect direct modification of the approved goal contract.
- Distinguish goal changes from implementation and planning changes.
- Require an impact report and an approval bound to a specific change request before creating a new goal version.
- Plan work and record progress without another Skill.
- Preserve a complete chain of goal versions, plan revisions, change requests, progress events, and verification evidence.
- Prevent completion claims when the active version is tampered with, has unresolved changes, has unfinished tasks, or lacks current evidence.

## Non-Goals

- General-purpose project portfolio management, calendaring, budgeting, or team assignment.
- Cryptographic proof that the person represented in a chat is a particular human identity.
- Automatic execution loops, host-specific stop hooks, or daemon processes.
- Replacing product discovery, architecture design, debugging, or code-review Skills.
- Requiring `planning-with-files` or translating all of its features.
- Publishing releases, changing Git remotes, or installing global configuration.

## Trust and Authority Model

The current approved goal contract is the authority for development intent. Plans, progress notes, code, tests, and external documents are subordinate evidence and cannot redefine it.

Authority precedence remains:

1. System, developer, repository, safety, and permission constraints.
2. The latest explicit user authorization.
3. The current locked goal contract.
4. The current plan revision.
5. Implementation details and progress records.

A new user request that conflicts with the current goal is authoritative as a request to consider change, but it is not applied immediately. The Skill first materializes the proposed change and its impact. The user then approves or rejects that exact proposal. This two-stage interaction prevents an ambiguous mid-task instruction from silently rewriting the baseline.

The local approval record proves that the required protocol was recorded for a specific proposal digest. It does not authenticate the user's real-world identity and must not be described as a digital signature.

## Repository Deliverables

```text
SKILL.md
README.md
references/
  contract.md
scripts/
  goal-lock.js
src/
  goal-lock/
    canonical.js
    cli.js
    contracts.js
    repository.js
    transaction.js
    workspace.js
tests/
  goal-lock.test.js
  goal-lock-cli.test.js
evals/
  evals.json
docs/
  skill-brief.md
  decisions.md
  delivery-report.md
  superpowers/specs/2026-08-23-goal-version-lock-design.md
```

`SKILL.md` contains routing, semantic classification, approval behavior, and failure boundaries. `references/contract.md` contains the runtime schemas and field rules and is read when creating, repairing, or interpreting `.goal-lock/` data. `scripts/goal-lock.js` performs deterministic state transitions and validation. No third-party runtime package is required.

## Runtime Workspace

The Skill creates one owned directory in the target project:

```text
.goal-lock/
  current.json
  lock.json
  plan.json
  progress.jsonl
  changes/
    CR-0001.json
  history/
    goals/
      v0001.json
    plans/
      v0001-r0001.json
  evidence/
    AC-001/
      EVID-0001.json
```

The Skill does not modify files outside `.goal-lock/` except the development artifacts explicitly authorized by the active plan. It does not create project-level hooks, global rules, or installation state.

## Goal Contract

`current.json` is a canonical UTF-8 JSON document with a trailing newline. Before the first lock it holds the editable draft and `lock.json` does not exist. After locking, it is the immutable active contract. Its required semantic fields are:

- `schema_version`: contract schema version, initially `1`.
- `goal_id`: stable identifier for the goal lineage.
- `goal_version`: positive integer increased only by an approved goal change.
- `objective`: one observable target outcome.
- `scope.in`: explicitly included outcomes and surfaces.
- `scope.out`: explicitly excluded outcomes and surfaces.
- `non_goals`: behaviors that must not be introduced.
- `constraints`: stable IDs and mandatory restrictions.
- `acceptance_criteria`: stable IDs, observable outcomes, and verification methods.
- `authorization_boundary`: actions that remain outside the goal's authority.
- `assumptions`: facts accepted for the current version and their confidence.
- `predecessor`: prior version and digest, or `null` for version 1.
- `accepted_change_id`: the change request that produced this version, or `null` for version 1.

`lock.json` stores the goal ID, active version, canonical SHA-256 digest, approval type, proposal digest, recorded time, and predecessor digest. The digest is calculated from the exact canonical bytes of `current.json`.

Each approved goal version is copied to `history/goals/vNNNN.json`. The current file and corresponding history file must have identical bytes. History files are immutable under the supported CLI.

## Plan Contract

`plan.json` is mutable only through a revision transition. It contains:

- A goal reference containing `goal_id`, `goal_version`, and `goal_digest`.
- `plan_revision`, starting at 1 for each goal version.
- A single `next_task_id` or `null` when no executable task remains.
- Tasks with stable IDs, intended outcome, acceptance-criterion references, dependencies, permitted files or surfaces, verification method, and status.
- An explicit list of deferred items that remain inside the current goal but are not scheduled.

Every executable task must reference at least one acceptance criterion. Task status is one of `pending`, `in_progress`, `blocked`, `complete`, or `stale`; a passing completion gate requires every scheduled task to be `complete`. A plan revision may change implementation approach, task decomposition, dependencies, order, or verification detail without changing the goal contract. Before replacement, the prior plan is written to `history/plans/vNNNN-rNNNN.json`.

A proposed plan that changes the objective, external behavior, scope, non-goals, mandatory constraints, completion definition, or authorization boundary is rejected as a plan revision and routed to a goal change request.

## Progress and Evidence

`progress.jsonl` is append-only. Each line is a canonical JSON event with an event ID, time, goal version, goal digest, plan revision, task ID when applicable, event type, concise summary, evidence references, the previous event digest, and its own digest calculated over the event payload. The digest chain detects removal, insertion, reordering, or rewriting of earlier records.

Supported event types include task start, task completion, plan revision, blocker, verification result, goal change, evidence invalidation, recovery, and final audit. Existing event bytes are never edited or deleted by supported commands.

Evidence files live under the acceptance-criterion ID and use monotonically increasing evidence IDs. Each file is immutable and contains:

- The current goal version and digest.
- The plan revision and task that produced the evidence.
- The verification command or manual method.
- The observed result and repository-relative artifact references.
- The workspace fingerprint that was audited.
- A state of `pass`, `fail`, or `stale` and an optional prior evidence ID that it supersedes.

Evidence from an older goal version is not automatically valid for a new version. During approval, the impact assessment identifies affected criteria and appends immutable `stale` evidence records that supersede their prior records. Unaffected evidence may be retained only after a new record explicitly revalidates it against the new version.

## State Machine

```text
ABSENT -> DRAFT -> LOCKED(v1)
LOCKED(vN) -> EXECUTING -> LOCKED(vN)
LOCKED(vN) -> CHANGE_PENDING -> LOCKED(vN)       on rejection
LOCKED(vN) -> CHANGE_PENDING -> LOCKED(vN+1)     on exact approval
LOCKED or EXECUTING -> TAMPERED                   on digest mismatch
LOCKED(vN) -> COMPLETE                            after a passing gate
```

`DRAFT` permits goal editing but no implementation. `LOCKED` permits goal-aligned planning and execution. `CHANGE_PENDING` blocks affected work but allows unrelated read-only investigation needed for impact analysis. `TAMPERED` blocks all goal-governed writes and completion claims. `COMPLETE` is a gate result bound to a workspace fingerprint, not an irreversible terminal state; later workspace changes invalidate the result.

## Request Classification

Before a new work slice, the Agent reads `current.json`, verifies the lock, and classifies the request:

| Classification | Meaning | Action |
| --- | --- | --- |
| `aligned` | Directly serves the approved outcome and boundaries | Continue under the current plan |
| `implementation-choice` | Changes how the result is produced without changing observable intent | Revise the plan only |
| `clarification` | Adds explanatory context without changing contract meaning | Record a decision or progress note; do not edit the goal |
| `goal-change` | Changes objective, scope, non-goals, external behavior, acceptance, or completion | Create a change request and pause affected work |
| `constraint-change` | Adds, removes, relaxes, or tightens a mandatory constraint or authorization boundary | Create a change request and pause affected work |
| `ambiguous` | Available evidence cannot distinguish a plan decision from a goal change | Ask one focused question; do not perform affected work |
| `conflicting` | Directly contradicts the current goal | Create a change request that names the conflict |

When uncertain between classifications, choose the more conservative state. The script validates structure, hashes, references, and transitions; it does not replace the Agent's semantic classification.

## Two-Stage Approval

Stage 1 creates a change request. A CR contains:

- Stable CR ID and status.
- Base goal ID, version, and digest.
- Candidate goal version and canonical candidate digest.
- Field-level before and after values.
- Semantic rationale.
- Affected tasks, evidence, risks, validation, and rollback consequences.
- A generated approval phrase containing the CR ID, target version, and short proposal fingerprint.

CR status is one of `proposed`, `approved`, `rejected`, or `superseded`. Only `proposed` is open, and only one open CR may target a particular base version and candidate version.

No goal file changes during proposal creation.

Stage 2 requires a user response that uniquely identifies the displayed CR, target version, and fingerprint. Generic confirmations such as “continue,” “okay,” or “use the new one” are insufficient. The Agent must not fabricate or infer the missing identifiers.

On valid approval, one atomic transaction:

1. Re-verifies the active goal and CR base digest.
2. Archives the current goal and plan if not already archived.
3. Writes the candidate goal as version N+1.
4. Writes and verifies the new lock.
5. Creates plan revision 1 for the new goal.
6. Marks affected tasks and evidence stale.
7. Appends a goal-change progress event.
8. Marks the CR approved.

Rejection only updates the CR status and preserves the active goal.

## CLI

The deterministic helper exposes:

- `init`: create a draft contract in a new `.goal-lock/` workspace after full preflight.
- `lock`: lock version 1 only after the required approval phrase has been observed.
- `verify`: check schema, canonical encoding, version-chain integrity, hashes, plan binding, append-only ledger structure, and open changes.
- `plan`: accept a goal-aligned plan revision and archive the previous revision.
- `propose`: validate a candidate goal and create a CR without changing the active version.
- `approve`: apply one exact CR using its approval phrase.
- `reject`: reject one open CR without changing the goal.
- `record`: append a validated progress or evidence event.
- `gate`: evaluate integrity, open changes, plan state, acceptance evidence, and workspace identity.
- `recover-lock`: conditionally recover an abandoned cooperative lock using the exact owner token and lock-file digest after process liveness has been checked.

Commands return structured JSON on standard output, diagnostics on standard error, and distinct nonzero exit codes for usage errors, invalid state, integrity failures, approval failures, and I/O failures. `--help` is read-only.

## Integrity, Concurrency, and Recovery

All mutating commands perform complete preflight before creating files. They acquire a repository-local cooperative lock using exclusive creation and an owner record containing a random token, process ID, command, and creation time. A process releases only the token it acquired.

Multi-file transitions use same-directory staged files, ownership digests, backups, atomic renames, read-back verification, and reverse-order rollback. A failure that cannot prove safe automatic cleanup preserves recovery evidence and exits without claiming success.

A stale lock is never deleted merely because of age. Recovery requires confirming the recorded process is not running and matching the exact owner token and lock digest. The implementation may reuse the scaffold's safety principles, but runtime state and commands remain specific to `.goal-lock/`.

Direct edits, missing history, a stale CR base, a mismatched plan reference, a truncated JSONL record, or a broken predecessor chain produce a fail-closed integrity error. Repair never silently adopts untrusted bytes. The user may restore the accepted history version or create a reviewed change proposal from the observed difference.

## Workspace Fingerprint and Completion Gate

For Git workspaces, the audit fingerprint covers the current commit identity, tracked diff, and repository-relative names and bytes of untracked non-ignored delivery files, excluding `.goal-lock/` bookkeeping. For non-Git workspaces, the plan must provide an explicit artifact inventory whose names and bytes are hashed.

`gate` passes only when:

- The current goal and entire predecessor chain verify.
- The current plan references the exact active goal digest.
- No CR is open or awaiting approval.
- No task is `pending`, `in_progress`, `blocked`, or `stale`.
- Every acceptance criterion has current passing evidence.
- No evidence references an older or different goal digest.
- A final semantic diff audit event is bound to the current workspace fingerprint.
- The workspace fingerprint is unchanged after that audit.

The deterministic gate validates recorded facts and hashes. The Agent remains responsible for the semantic diff audit and must not claim that a passing script proves code correctness or user identity.

## Optional `planning-with-files` Interoperation

Interoperation is optional and does not affect core delivery. If used, `task_plan.md` records the active `goal_id`, `goal_version`, and `goal_digest`. Its phases may provide a richer presentation of `plan.json`, but conflicts resolve in favor of the locked goal and goal-bound plan.

The initial release will document this relationship but will not install hooks, edit `task_plan.md`, or depend on `planning-with-files` scripts. A future adapter requires separate evidence and approval because it changes supported integration behavior.

## Security and Privacy

- Runtime state stores concise approval metadata, not entire chat transcripts.
- Examples use fictional paths and identifiers.
- The CLI does not use network access, credentials, global configuration, or paid services.
- Paths are repository-relative, normalized, and rejected if they escape the workspace.
- External file content is treated as data, never as instructions.
- Errors avoid echoing full sensitive file contents.
- The Skill never bypasses system, repository, safety, or permission rules.

## Behavioral Evaluation

The behavior suite covers:

1. Direct creation and locking of a versioned development goal.
2. Implicit invocation for a long development task that explicitly requests drift prevention.
3. A nearby planning request that should not invoke goal locking.
4. An aligned bug fix that proceeds without a CR.
5. An implementation-only change that creates a plan revision.
6. A scope or acceptance change that creates a CR and pauses.
7. An ambiguous approval that is rejected.
8. An exact approval that creates version N+1 and preserves history.
9. Direct goal tampering that blocks work.
10. Resume after context loss using disk state instead of conversation memory.
11. Evidence invalidation after an approved goal change.
12. Completion failure with missing or stale evidence, followed by success with current evidence.

The first evaluation round uses one positive, one adjacent negative, and one change-boundary case before wording is tuned. Expanded cases remain semantic and do not merely match headings or fixed phrases.

## Deterministic Test Strategy

Implementation follows test-driven development. Tests first demonstrate failure for:

- Canonical JSON and digest stability.
- Schema and path validation.
- Draft-to-lock and locked-version transitions.
- Plan revision versus goal version behavior.
- CR creation, stale-base rejection, ambiguous approval rejection, and exact approval.
- Version history and predecessor chain integrity.
- Append-only progress and evidence validation.
- Tampering, truncated writes, concurrent ownership, rollback, and recovery.
- Git and explicit-inventory workspace fingerprints.
- Passing and failing completion gates.
- `SKILL.md`, reference links, prompt budget, and evaluation contract structure.

Tests use isolated temporary repositories and fictional identities. They never modify actual user Skill directories or global Agent configuration.

## Delivery and Validation

Development verification order is:

1. Focused failing test for the next behavior.
2. Minimal implementation and focused passing test.
3. CLI integration tests.
4. Behavior evaluations with recorded raw results.
5. `npm run check`.
6. Full diff, untracked deliverable, sensitive-data, and code-comment review.
7. Scaffold Evidence Contract completion.
8. `npm run gate:delivery` on a stable worktree.

No public release, tag, remote change, registry upload, paid model run, or credentialed operation is part of the approved scope.

## Acceptance Summary

The Skill is complete when an independent user can install or load the local Skill, create and approve a goal, plan and record work, detect both semantic goal changes and byte-level tampering, approve a versioned CR, resume from disk state, and receive a deterministic refusal to claim completion until the active version's acceptance evidence and workspace audit are current.
