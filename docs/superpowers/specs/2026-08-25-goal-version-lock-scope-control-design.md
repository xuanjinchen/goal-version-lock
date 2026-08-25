# Goal Version Lock Scope-Control Design

**Date:** 2026-08-25  
**Status:** Approved architecture specification  
**Protocol:** clean pre-release schema v2  
**Audience:** implementers and reviewers of `goal-version-lock`

This design supersedes the scope, validation, and evidence portions of the
2026-08-23 design and supersedes the old Task 16 run-5 preparation. Unchanged
goal approval, canonicalization, transaction, and recovery guarantees remain
in force.

## Context and problem

Protocol v1 binds tasks to acceptance criteria and gives each task
`permitted_paths`, but its task verification and evidence method are prose.
The runtime fingerprints a workspace snapshot without proving that every
changed path was authorized. Consequently, an Agent can run an unrelated test,
collect evidence for a method that was never planned, or change an unplanned
path and still attempt to make that activity authoritative at completion.

Requirements version 2 adds `REQ-011`:

> Every task, changed path, validation, test, evaluation, regression, and
> accepted evidence must trace to an acceptance criterion, a declared risk, an
> explicit governed plan revision, or a mandatory delivery gate. Untraceable
> activity is denied.

The runtime cannot stop an operating-system process from writing a file or
running a command. It can, however, prevent unplanned activity from becoming
accepted evidence and prevent a workspace containing an unauthorized delivery
delta from reaching `COMPLETE`.

## Goals

- Use one authorization graph for tasks, writes, validations, evidence, and
  completion rather than independent prose checks.
- Preserve `task.permitted_paths` as the write-authorization boundary.
- Replace task verification prose with stable, structured validation records.
- Capture one immutable workspace baseline when goal version 1 is locked and
  retain it for the full goal lineage.
- Compare the actual delivery delta with the cumulative authority granted by
  every verified plan revision in that lineage.
- Allow a plan revision to add justified implementation authority while still
  requiring a change request for any goal-contract change.
- Keep previously accepted work and evidence verifiable after a later plan is
  tightened.
- Admit evidence and completion only when exact validation authorization can be
  replayed from immutable state.

## Non-goals

- Sandboxing the Agent, intercepting file-system writes, or monitoring every
  process invocation.
- Embedding a shell, command interpreter, package runner, test runner, or
  arbitrary-command executor in the runtime.
- Proving that a declared validation method was executed honestly; the runtime
  proves authorization and record integrity, while the evidence remains an
  attestation.
- Discovering files omitted from a non-Git inventory or treating ignored Git
  files as delivery artifacts.
- Supporting protocol v1 and v2 concurrently.
- Adding release, publishing, remote, credential, global-configuration, hook,
  installer, or daemon behavior.

## Chosen design and rejected alternatives

| Alternative | Decision and rationale |
| --- | --- |
| Keep prose verification and lint it | Rejected. Text cannot provide stable identities for evidence replay or mechanically bound scope. |
| Add a separate test-authorization system beside the plan | Rejected. Parallel authorities can disagree; validations belong to the same plan graph that grants writes. |
| Compare only the final workspace fingerprint | Rejected. Equality proves snapshot identity, not whether changed paths were authorized. |
| Reset the workspace baseline for every goal version | Rejected. A later version or tighter plan could erase the history of already accepted activity. |
| Make plan authority only shrink | Rejected. A within-goal implementation discovery may require a justified new path or focused validation. |
| Execute declared methods inside the runtime | Rejected. It would create an arbitrary-command boundary and still would not stop work performed outside the runner. |
| Maintain v1 compatibility branches | Rejected. This is a pre-release protocol; a single v2 schema is smaller, safer, and unambiguous. |

## Architecture and module boundaries

The existing transaction and authority hierarchy remain. Scope control adds one
pure authorization layer and extends workspace capture.

| Boundary | Responsibility |
| --- | --- |
| `contracts.js` | Validate schema v2 values, identifiers, exact path syntax, validation kinds, risk sources, evidence references, and lock/scope heads. It performs no repository I/O. |
| `authorization.js` | Build the authorization graph from verified goal and plan history; resolve validation references; compute cumulative permitted paths; reject orphan or cyclic trace nodes. It performs no writes and executes no methods. |
| `workspace.js` | Safely capture immutable workspace manifests, compute path-level deltas, reject unsafe paths and links, and produce manifest/delta digests. |
| `repository.js` | Orchestrate state transitions, archive plans, accept evidence, replay progress, derive scope blockers, and evaluate the completion checklist using the pure authorization and workspace layers. |
| `transaction.js` | Atomically install `scope.json`, lock heads, plans, progress, and evidence using the existing cooperative lock, journal, read-back, and rollback protocol. |
| `cli.js` | Parse strict data inputs and expose deterministic state operations. Validation methods remain data; the CLI never executes them. |
| `SKILL.md` | Tell the Agent to verify before each slice, execute only validations authorized for that slice, record their exact IDs, and stop on unplanned work or scope blockers. |
| `references/contract.md` | Publish the complete v2 wire and persistence contract after implementation. |

No second scope ledger, validation registry, or command manifest is introduced.
The plan is the registry, plan history supplies immutability, `scope.json`
supplies the single baseline, and existing progress/evidence records supply the
audit trail.

## Protocol v2 conceptual schemas

All documents use the existing canonical UTF-8, exact-key, safe-relative-path,
and SHA-256 rules. Every delivery path below is an exact repository-relative
file path. Globs, path prefixes, `.`, `..`, absolute paths, drive paths, UNC
paths, backslashes, bookkeeping paths, and path aliases are invalid.

### Identifiers and references

Schema v2 adds `RISK-NNNN` and `VAL-NNNN`. A validation is identified by the
immutable tuple:

```text
ValidationRef = {
  goal_id,
  goal_version,
  goal_digest,
  plan_revision,
  validation_id
}
```

`validation_id` is unique within one plan revision. Reusing its spelling in a
later revision does not reuse its authority because the enclosing tuple differs.

### Immutable workspace scope baseline

Version-1 locking creates `.goal-lock/scope.json` in the same transaction as
the first accepted goal history and lock:

```text
ScopeBaselineV2 = {
  schema_version: 2,
  scope_version: 1,
  goal: GoalRef for the accepted goal version 1,
  mode: "git" | "inventory",
  entries: sorted unique ScopeEntry[],
  recorded_at: RFC-3339 UTC timestamp,
  record_digest: sha256 of the canonical record without record_digest
}

ScopeEntry = {
  path: exact safe delivery file path,
  source: "tracked" | "untracked" | "inventory",
  mode: regular-file executable/non-executable mode,
  size: non-negative safe integer,
  digest: sha256 of exact worktree file bytes,
  index_mode: regular-file Git index mode | null,
  index_digest: sha256 of exact staged blob bytes | null
}
```

The index fields are non-null only for Git-tracked entries. They make staged-only
changes visible without binding the baseline to one Git object format.

`lock.json` adds exactly one binding:

```text
scope_head: { scope_version: 1, digest: sha256 of exact scope.json bytes }
```

The scope record and `scope_head` never change during a goal lineage, including
approved goal-version transitions. Every later lock record repeats the same
head. Missing, replaced, noncanonical, or mismatched scope bytes are integrity
failures.

Schema v2 `lock` accepts a safe inventory-file input only when Git mode is not
available. Git mode rejects a competing inventory so one operation cannot choose
between two scope views.

### Integrated plan authorization

`plan.json` replaces task `verification` with `validations` and adds only the
risk records needed by validation traceability:

```text
PlanV2 = {
  schema_version: 2,
  goal: active GoalRef,
  plan_revision: positive integer,
  next_task_id: task_id | null,
  tasks: non-empty TaskV2[],
  risks: RiskV2[],
  deferred: DeferredTask[]
}

TaskV2 = {
  id: task_id,
  outcome: non-empty text,
  acceptance_criteria: non-empty unique acceptance_criterion_id[],
  dependencies: unique task_id[],
  permitted_paths: unique exact safe delivery path[],
  validations: unique ValidationV2[],
  status: pending | in_progress | blocked | complete | stale
}

ValidationV2 = {
  id: validation_id,
  kind: focused | affected-regression | mandatory-gate,
  method: {
    type: deterministic-test | behavior-eval | audit | manual-review | delivery-gate,
    target: non-empty stable repository-defined name
  },
  affected_paths: non-empty unique exact safe delivery path[]
                  | ["@governed-workspace"],
  criterion_ids: unique acceptance_criterion_id[],
  risk_ids: unique risk_id[]
}

RiskV2 = {
  id: risk_id,
  statement: non-empty testable risk description,
  source:
    { kind: criterion, criterion_id }
    | { kind: failed-validation, validation_ref, evidence_id },
  affected_paths: non-empty unique exact safe delivery path[]
}
```

`method.target` names an entry point or review protocol for the Agent. It is not
a command string and is never interpreted by the runtime. The closed token
`@governed-workspace` is not a file path and is allowed only on a
`mandatory-gate` validation. A plan lineage may declare only one
workspace-wide full-regression authorization at a time.

A validation must cite at least one criterion or risk. Every cited risk must
exist in the same plan and every risk must be used by at least one validation.
A criterion-sourced risk must name a criterion owned by the task that uses it.
A failure-sourced risk must reference a verified failing evidence record and an
exact validation from verified plan history. Its affected paths must be a
subset of the failure paths in that evidence. A validation relying on that risk
must stay within the risk's affected paths. These rules prevent a failed check
from becoming authority for an unrelated sweep.

### Evidence and progress binding

Evidence keeps its criterion-specific immutable lineage and adds an exact
validation reference. It no longer supplies an independent method:

```text
EvidenceV2 = {
  schema_version: 2,
  evidence_id,
  acceptance_criterion_id,
  validation_ref: ValidationRef,
  task_id,
  observed_result: non-empty text,
  artifact_refs: unique exact safe delivery path[],
  workspace_fingerprint,
  state: pass | fail | stale,
  failure_paths: unique exact safe delivery path[],
  supersedes,
  derivation: null
    | {
        kind: carry-forward | invalidation,
        source_validation_ref: ValidationRef,
        source_evidence_id,
        source_evidence_digest
      },
  recorded_at
}
```

For `pass` and `stale`, `failure_paths` is empty. For `fail`, each failure path
must lie within the referenced validation's bounded paths; a failure with no
localized path may be recorded but cannot source a new risk. The evidence
criterion must be reachable from the validation through `criterion_ids` or the
validation's risk-source chain. `task_id` must own that validation in the exact
referenced plan. Every artifact reference must lie within the validation's
bounded affected paths (or its workspace-wide mandatory coverage); any artifact
that differs from the baseline must also have cumulative write authority.

New evidence may target only the active goal and active plan revision. During
replay, earlier evidence remains valid against the exact archived plan revision
that authorized it, provided chronology proves it was recorded before that
revision was superseded. Removing a validation from a later plan does not erase
already accepted evidence.

`verification-result` and `task-complete` progress events continue to reference
evidence IDs; replay resolves each record's `validation_ref`. Unknown IDs,
missing archived plans, changed validation definitions, late writes against an
old revision, stale evidence, or an untraced criterion are rejected.

A `final-audit` event stores runtime-derived bindings rather than caller claims:

```text
FinalAuditBindingV2 = {
  scope_digest,
  authorization_graph_digest,
  delta_digest,
  workspace_fingerprint
}
```

The completion gate recomputes all four values independently.

For goal transitions, schema v2 replaces the ambiguous affected-only criterion
list with an exhaustive impact partition:

```text
ChangeRequestV2.criterion_impact = {
  affected: unique acceptance_criterion_id[],
  unaffected: unique acceptance_criterion_id[]
}
```

The two arrays are disjoint and together name every retained candidate-goal
criterion. A new or semantically changed criterion is always `affected`.
Removal remains a goal change recorded in the field-level change set. Only the
`unaffected` array authorizes adjacent-goal carry-forward.

## Authorization graph and invariants

The runtime compiles these edges from accepted bytes:

```text
criterion -> task -> permitted path
criterion -> task -> validation
criterion -> risk -> validation
failed validation evidence -> risk -> affected follow-up validation
plan revision -> task, risk, validation, and permitted-path definitions
mandatory-gate validation -> final mandatory sequence
validation -> evidence -> progress event -> task completion
scope baseline + verified plan history -> authorized delivery delta
```

The graph is accepted only when all of the following hold:

1. Every scheduled task owns a current goal criterion.
2. Every permitted path belongs to a task and therefore reaches a criterion and
   immutable plan revision.
3. Every validation belongs to one task, has bounded affected paths, and
   reaches a criterion, declared risk, or mandatory gate.
4. Every risk has a resolvable source and a consumer; orphan risks and cyclic
   risk chains are invalid.
5. Every evidence record resolves the exact validation tuple, owning task,
   criterion trace, and chronological plan state.
6. Every completion-relevant progress reference resolves accepted evidence;
   prose summaries never create authority.
7. The cumulative permitted-path set is the union across every verified plan
   revision from goal version 1 through the active version. Later removal never
   subtracts authority already accepted for path-delta accounting.
8. Adding a path, risk, or validation requires an accepted plan revision whose
   graph is valid. Changing objective, scope, non-goals, constraints,
   acceptance outcomes, completion definition, or authorization boundary still
   requires a change request.
9. Untraceable nodes are denied before persistence; untraceable persisted nodes
   found during replay are integrity failures.

## State transitions and data flow

1. `init` creates only the v2 draft.
2. Exact version-1 approval captures the Git manifest or requires an explicit
   complete non-Git inventory. The baseline, goal history, and lock with
   `scope_head` commit atomically. A capture failure leaves the goal unlocked.
3. `plan` validates the entire candidate authorization graph, archives the
   prior plan, installs the new plan, and appends its derived plan-revision
   event atomically.
4. Before a work slice, the Agent verifies state, selects one task, and executes
   only that task's authorized `focused` or `affected-regression` validations.
5. `record evidence` resolves the exact active `ValidationRef`, computes the
   workspace fingerprint and scope delta, rejects any unauthorized changed
   path, and atomically appends evidence and progress heads.
6. An approved goal change preserves `scope_head` and plan history. Prior
   evidence bytes remain immutable. The transition creates an adjacent-goal
   carry-forward only for criteria explicitly listed as unaffected and only
   when the copied task and validation definition remain identical. Affected
   criteria receive stale invalidation records. The change request must record
   disjoint, exhaustive affected and unaffected criterion sets.
7. The Agent records the semantic final audit after all delivery writes. The
   runtime derives its scope, graph, delta, and fingerprint bindings.
8. `gate` re-verifies all histories, captures the workspace again, rebuilds the
   graph and cumulative path union, recomputes the audit bindings, and derives
   `COMPLETE` or `BLOCKED`.

`COMPLETE` is a derived observation, not an irreversible state. If initial
completion lacks current evidence or an audit, it is `BLOCKED`; after legitimate
remediation records the missing authorized evidence and audit, a later gate may
return `COMPLETE`. Any subsequent workspace or authority change causes the next
gate to recompute from current facts.

## Workspace scope algorithm

### Git mode

The governed root must equal the Git top level. At baseline and gate time the
runtime enumerates all tracked files plus non-ignored untracked files, excluding
`.git/` and `.goal-lock/`. It reads every included file through the safe reader
and records path, trackedness, regular-file mode, size, and byte digest. It
captures the Git/index view before and after the reads and rejects a race.

The full manifest, not `HEAD`, is the comparison baseline. This makes the
algorithm independent of later commits and correctly handles:

- initial dirty tracked and untracked state, which is frozen as pre-governance
  baseline rather than retroactively treated as governed work;
- modifications before or after commits;
- tracked and non-ignored untracked additions;
- deletions;
- renames, represented as deletion of the old path plus addition of the new
  path, so both paths require authority; and
- trackedness or executable-mode changes.

The delta is the sorted set of paths whose presence, source, worktree mode or
digest, or Git index mode or digest differs between the immutable baseline and
current manifest. Every delta path must appear in the cumulative union of exact
`permitted_paths`. Empty deltas pass path scope without inventing work.

Any invalid UTF-8 path, unsafe relative path, duplicate or case-colliding path
alias, symbolic link, submodule-like entry, linked/non-regular file, unsafe
parent, root replacement, or changed-during-read state fails closed. Git-ignored
files are outside the delivery manifest and cannot be evidence artifacts.

### Non-Git inventory mode

Version-1 approval and every later evidence, audit, and gate operation require
an explicit sorted complete inventory of existing delivery files. The baseline
stores the initial inventory manifest. Later inventories must include every
baseline-bound path and safely read every listed file.

The runtime compares the supplied current manifest to the stored manifest and
checks every listed addition or modification against cumulative permitted
paths. Omission or deletion of a baseline-bound file fails closed, even if a
plan names that path, because the runtime cannot distinguish deletion from an
incomplete inventory. Unsafe paths and links fail identically to Git mode.

This mode cannot discover an external file that the caller omits and that was
never in the bound baseline. The Skill must disclose that limitation and must
not describe non-Git inventory mode as complete workspace surveillance.

## Development validation policy

- A work slice may run only the owning task's authorized `focused` validations
  and directly `affected-regression` validations.
- A failure grants no implicit authority. A plan revision may add only a
  follow-up validation bounded by a structured risk sourced from that exact
  failed validation evidence.
- An unrelated regression sweep cannot be justified by a failure, convenience,
  available time, or a desire for confidence.
- A full regression is legal only as the declared workspace-wide
  `mandatory-gate`. It runs once in the final mandatory sequence, after all
  implementation slices and focused remediation are complete. Evidence replay
  rejects a second result for the same mandatory-gate validation reference.
- If that final full gate fails, delivery remains blocked. The failure may
  authorize focused remediation through a plan revision, but this design does
  not authorize an automatic repeated full sweep or a completion claim. After
  the affected remediation is accepted, the new plan revision may declare one
  new mandatory-gate validation reference and execute it once; the failed
  revision can never rerun its mandatory-gate reference.

These constraints govern both product development and the Agent workflow. The
runtime enforces what evidence and completion can accept; `SKILL.md` instructs
the Agent not to perform the unplanned activity in the first place.

## Completion gate

The gate returns one independent checklist result for each condition below. A
combined umbrella result cannot hide a failed subcheck.

1. Goal, lock, immutable scope head, goal history, change history, plan history,
   progress, and evidence integrity pass.
2. No change request is open and no goal-contract change was routed through a
   plan revision.
3. Every scheduled task has valid criterion coverage and is complete; `stale`
   and `blocked` tasks do not pass.
4. Every active acceptance criterion has current passing or valid adjacent-goal
   carry-forward evidence.
5. Every evidence and completion progress reference resolves its exact
   validation authorization and is neither unknown, late, stale, nor untraced.
6. Every declared mandatory-gate validation has exactly one passing accepted
   result, including the one workspace-wide full regression.
7. The actual baseline-to-current delta is a subset of cumulative verified
   `permitted_paths`.
8. The final semantic audit matches the independently recomputed scope, graph,
   delta, and workspace fingerprint.
9. No current derived scope blocker remains. A scope blocker is any currently
   observed unauthorized delta path, unresolved validation trace, invalid risk
   edge, non-Git bound-path omission, or unsafe workspace entry; it is derived
   from authoritative state and does not require another ledger.

## Failure and recovery semantics

| Failure | Result | Authorized recovery |
| --- | --- | --- |
| Schema v1 state or input | Unsupported protocol; no mutation | Rewrite development fixtures to v2 before execution. No compatibility fallback. |
| Missing or mismatched `scope.json`/`scope_head` | Integrity failure | Restore the exact known-good bytes through existing evidence-preserving recovery rules. |
| Invalid graph, orphan risk, unknown validation, or untraced evidence in candidate input | State/input rejection; no write | Submit a corrected, justified plan or evidence record. |
| The same defect found in accepted persisted bytes | Integrity failure; governed writes stop | Inspect or restore exact known-good state; never normalize tampered bytes into acceptance. |
| Unauthorized Git delta path | Completion and new authoritative evidence are blocked | Revert the path locally, or add path authority through a justified plan revision; use a CR if the goal contract must change. |
| Non-Git baseline path omitted or deleted | Fail closed | Restore and inventory the path, or move governance to an initialized Git baseline; do not guess. |
| Failed focused validation | Failing evidence remains immutable | Add only directly affected risk/validation authority in a plan revision, repair, and record new evidence. |
| Failed final full regression | Completion remains blocked | Stop the delivery attempt; do focused, plan-governed remediation only. No automatic repeat is authorized by the failure. |
| Missing evidence or final audit | `BLOCKED`, not tamper | Record the missing authorized evidence/audit, then re-run the gate. |

A plan revision can authorize a previously blocked path prospectively for gate
accounting because the cumulative union preserves its accepted revision. It
cannot rewrite the earlier progress chronology or make previously rejected
evidence valid. Tightening a plan cannot erase accepted paths, validations, or
evidence from verified history.

## Security and enforcement boundaries

- The runtime writes only owned `.goal-lock/` state through the existing atomic
  transaction protocol. Delivery writes remain the Agent's responsibility.
- Validation methods are inert identifiers. No shell interpolation, executable
  command field, subprocess dispatch, or embedded runner is added.
- Safe-reader and manifest rules reject path traversal, link traversal, root
  replacement, unsafe aliases, and read races before accepting evidence or a
  gate result.
- The Agent must not execute unplanned work. The runtime does not police the
  host, but unplanned Git-visible changes cannot pass path scope and unplanned
  validation output cannot become authoritative evidence without an exact
  validation reference.
- Non-Git omissions and Git-ignored files remain outside runtime visibility and
  are disclosed rather than presented as enforced scope.
- All authorized work stays local and reversible. Push, remote changes, tags,
  releases, publication, package upload, credentials, paid calls, destructive
  operations, and global configuration require separate explicit user
  authorization and are outside this design.

## Migration and evidence invalidation

Implementation updates the Skill Brief to requirements version 2, adds
`REQ-011`, and updates the affected requirement trace before changing delivery
status. Protocol v2 is the only supported pre-release schema. Repository tests
and fixtures are mechanically rewritten once; production code contains no v1
reader, upgrader, fallback, feature flag, or dual-schema branch.

The public plan schema, evidence schema, completion semantics, reference
contract, and core `SKILL.md` workflow all change. Therefore all existing
behavioral evidence is stale, including the old Task 16 run-5 preparation.
Prior result files may remain as historical bytes only when clearly marked
invalid; none may satisfy the new delivery gate.

After the workflow and schemas are stable, run one final paired matrix of
EVAL-001 through EVAL-013 against the same Agent/settings with and without the
Skill. The first twelve retain their scenario purposes under v2. EVAL-011 must
show ordering: completion initially blocks without current evidence/audit and
later completes after legitimate remediation. EVAL-013 is the no-diffusion
case: the Agent confines work and validation to planned paths and IDs, refuses
an unrelated regression or cleanup sweep, and cannot use unplanned activity as
evidence or completion authority.

Do not prescribe repeated full-matrix reruns, optional result viewers, tuning
passes, minors, cleanup, hardening, or unrelated refactors. A failed paired case
authorizes only its directly affected correction and case rerun before the one
final accepted matrix is sealed.

## Focused verification strategy

Each new deterministic invariant starts with one test that fails because that
invariant is absent, followed by the minimum implementation. Tests should be
organized by invariant, including:

- v2-only schema and mechanical fixture migration;
- graph closure for tasks, paths, risks, validations, and evidence;
- exact validation-reference chronology across plan revisions and adjacent
  goal versions;
- immutable scope-head creation and retention;
- cumulative authority after expansion and later tightening;
- Git initial-dirty, commit, tracked/untracked addition, deletion, rename,
  mode/trackedness, race, unsafe-path, and link behavior;
- non-Git complete-inventory comparison, bound omission/deletion failure, and
  disclosed external-omission limit;
- independent completion failures for path scope, validation trace, and open
  scope blockers; and
- final-gate single-use and failure-bounded follow-up authorization.

During implementation, run only the affected authorized tests for the current
slice. Once all slices and the paired matrix are stable, run the declared final
mandatory full gate once. Do not add optional hardening tasks, opportunistic
cleanup, or unrelated regression passes.

## Acceptance criteria

1. The Skill Brief records requirements version 2 and exact `REQ-011`, with
   affected traces and evidence statuses updated.
2. Runtime and reference contract accept only schema v2; all development
   fixtures are migrated once and no compatibility path exists.
3. A plan with prose verification, orphan authority, unresolved risk, broad
   failure-derived sweep, or untraceable task/path/validation is rejected before
   persistence.
4. Accepted evidence resolves one exact immutable validation tuple and owning
   task; unknown, late, stale, or untraced evidence fails record or replay.
5. Version-1 locking atomically creates one immutable scope baseline and every
   later goal version retains the identical verified `scope_head`.
6. Git delta tests prove initial dirty state, later commits, tracked/untracked
   additions, modifications, deletions, renames, and unsafe links behave as
   specified. Non-Git tests prove the explicit inventory guarantees and limits.
7. Completion independently blocks on any unauthorized delta, invalid
   validation trace, open scope blocker, incomplete task/criterion/evidence,
   or mismatched final audit.
8. A justified plan revision may expand authority without a CR, later
   tightening does not erase accepted activity, and any goal-contract change
   still requires the existing exact CR approval flow.
9. Adjacent-goal carry-forward occurs only for explicitly unaffected criteria;
   all prior evidence remains immutable and affected evidence becomes stale.
10. Development uses affected validations per slice, one failing test per new
    invariant, one final workspace-wide mandatory gate, and no unauthorized
    regression or cleanup sweep.
11. One final paired EVAL-001 through EVAL-013 matrix supplies current behavioral
    evidence, including EVAL-011 remediation ordering and EVAL-013 no diffusion;
    old behavioral evidence supplies no pass status.
12. No implementation introduces a shell runner, host monitor, publication,
    credential use, global configuration, or any write outside the approved
    local reversible boundary.

## Explicitly out of scope

- Optional visualization or evaluation viewers.
- Prompt tuning not required by a failed affected evaluation.
- Numeric token, duration, file-count, or retry budgets.
- Broad hardening, minor improvements, formatting cleanup, dependency changes,
  or refactors unrelated to the invariants above.
- Automatic migration of external protocol v1 workspaces.
- Publishing, pushing, tagging, releasing, registry upload, remote mutation,
  credentialed services, paid evaluation without approval, or global install.
