# Goal Version Lock Implementation Plan

> Superseded for implementation by [the 2026-08-25 scope-control plan](2026-08-25-goal-version-lock-scope-control.md). This document remains an unchanged historical task record.

> **For Codex:** REQUIRED SUB-SKILL: Use `executing-plans` to execute this plan task-by-task. If the user selects same-session delegation, use `subagent-driven-development` while preserving the ordered TDD and review checkpoints below.

**Goal:** Deliver a standalone `goal-version-lock` Skill that freezes an explicitly approved development goal, versions every approved goal change, maintains its own goal-bound plan and progress evidence, detects tampering and semantic drift, and refuses completion until the active goal's evidence gate passes.

**Architecture:** Keep semantic request classification in `SKILL.md`, where an Agent can compare intent, and keep every deterministic transition in a dependency-free Node.js 22 CLI. The CLI owns only `.goal-lock/`, represents the current goal as canonical JSON attested by SHA-256, separates immutable `goal_version` transitions from archived `plan_revision` transitions, serializes writers with an ownership lock, and uses preflight plus rollback-safe multi-file replacement. `planning-with-files` is optional presentation only; `.goal-lock/current.json`, `lock.json`, and `plan.json` remain authoritative.

**Tech Stack:** Markdown Skill instructions, Node.js 22 ESM standard library, `node:test`, Git CLI for Git workspace fingerprints, and the initialized scaffold's existing validation and delivery gates.

**Approved inputs:** `docs/skill-brief.md` requirements version 1, `docs/decisions.md` DEC-001 through DEC-008, and `docs/superpowers/specs/2026-08-23-goal-version-lock-design.md`.

---

## Fixed implementation contract

Do not change these interfaces during implementation without first updating the design, incrementing `docs/skill-brief.md#Requirements version`, recording the conflict and superseding decision, and restarting from the first affected task.

### Runtime files

```text
.goal-lock/
  current.json
  lock.json
  plan.json
  progress.jsonl
  changes/CR-0001.json
  history/goals/v0001.json
  history/plans/v0001-r0001.json
  evidence/AC-001/EVID-0001.json
```

The authoritative current-state paths are `.goal-lock/current.json`, `.goal-lock/lock.json`, `.goal-lock/plan.json`, and `.goal-lock/progress.jsonl`; all other accepted runtime paths are subordinate history, change, or evidence records under the tree above.

`.goal-lock/.write-lock.json` and transaction recovery artifacts are internal and must never be treated as accepted goal state. All accepted JSON files use sorted object keys, compact JSON, UTF-8, and exactly one trailing LF. `progress.jsonl` uses one canonical JSON object plus LF per event.

### Public module interfaces

`src/goal-lock/canonical.js` exports:

```js
export function canonicalJson(value);
export function canonicalBytes(value);
export function parseCanonicalJson(bytes, label);
export function sha256(bytes);
export function shortFingerprint(digest);
```

`src/goal-lock/contracts.js` exports:

```js
export class GoalLockError extends Error {
  constructor(code, kind, exitCode, message, options = {});
}
export function normalizeRelativePath(value, label);
export function validateGoalContract(value, options);
export function validateLockRecord(value);
export function validatePlan(value, goalReference);
export function validateChangeRequest(value);
export function validateProgressEvent(value, previousDigest);
export function validateEvidence(value, goalReference);
export function approvalPhraseForGoal(goal);
export function approvalPhraseForChange(changeRequest);
```

`src/goal-lock/transaction.js` exports:

```js
export async function withGoalLock(root, command, operation, context);
export async function commitGoalFiles(root, entries, context);
export async function recoverGoalLock(root, proof, context);
```

Each `commitGoalFiles` entry has the exact shape `{ target, expected, content }`. `expected` is `{ kind: 'absent' }` or `{ kind: 'sha256', digest }`; `content` is a `Buffer` or `null`. The module rejects absolute, backslash-containing, linked, junction-backed, traversing, duplicated, or `.goal-lock/`-external targets.

`src/goal-lock/workspace.js` exports:

```js
export async function createWorkspaceReader(root);
export async function gitWorkspaceFingerprint(root);
export async function inventoryWorkspaceFingerprint(root, inventory);
export async function workspaceFingerprint(root, inventory);
```

`src/goal-lock/repository.js` exports:

```js
export async function initializeGoal(root, draft, context);
export async function lockInitialGoal(root, approval, context);
export async function verifyGoalRepository(root, context);
export async function revisePlan(root, candidate, classification, context);
export async function proposeGoalChange(root, proposal, context);
export async function rejectGoalChange(root, crId, reason, context);
export async function approveGoalChange(root, crId, approval, context);
export async function recordGoalEvent(root, input, context);
export async function gateGoalCompletion(root, inventory, context);
```

Every context accepts deterministic test seams only where relevant: `now()`, `randomToken()`, `pid`, `isProcessAlive(pid)`, `runGit(args)`, and `transactionFaults`. Production callers supply real time, `crypto.randomUUID()`, `process.pid`, `process.kill(pid, 0)`, and `execFile('git', ...)`.

`src/goal-lock/cli.js` exports:

```js
export function parseGoalLockArgs(argv);
export function formatGoalLockHelp();
export async function runGoalLockCli(argv, context);
```

The script entry point is `scripts/goal-lock.js`, operates on `process.cwd()`, writes exactly one JSON document to stdout on success, writes exactly one redacted JSON diagnostic to stderr on failure, and sets these exit codes:

| Exit | Meaning |
| ---: | --- |
| `0` | Success or read-only help |
| `2` | CLI usage/input error |
| `3` | Valid input but invalid state transition |
| `4` | Integrity, tamper, or unsafe-path failure |
| `5` | Approval phrase or stale-approval failure |
| `6` | I/O, Git, or rollback/recovery failure |

Supported commands and options are fixed as:

```text
init --input draft.json
lock --approval "APPROVE GOAL GL-EXAMPLE VERSION 1 0123456789ab"
verify
plan --input plan.json --classification aligned
plan --input revised-plan.json --classification implementation-choice
propose --input change-proposal.json
approve --cr CR-0001 --approval "APPROVE CR-0001 GOAL VERSION 2 0123456789ab"
reject --cr CR-0001 --reason "Keep the approved scope"
record --input progress-input.json
gate
gate --inventory inventory.json
recover-lock --owner-token 11111111-1111-4111-8111-111111111111 --lock-digest 0000000000000000000000000000000000000000000000000000000000000000
```

`--input -` is also supported for the single JSON input of `init`, `plan`, `propose`, and `record`. Options cannot be duplicated, combined, or supplied to another command. `--help` is the only global flag and performs no repository reads or writes.

### Approval protocol

- Version 1 exact phrase: `APPROVE GOAL {goal_id} VERSION 1 {first-12-goal-digest}`.
- Change exact phrase: `APPROVE {cr_id} GOAL VERSION {candidate-version} {first-12-proposal-digest}`.
- Matching is byte-for-byte and case-sensitive after the CLI has received one argument value. Generic confirmations, extra whitespace, wrong CR IDs, wrong versions, stale base digests, and wrong fingerprints fail with exit code 5.
- Approval records store the approval kind and proposal digest, never an entire chat transcript and never a claim of authenticated real-world identity.

### Semantic/deterministic boundary

- The Agent reads and verifies the active goal before every work slice, then classifies the new request as `aligned`, `implementation-choice`, `clarification`, `goal-change`, `constraint-change`, `ambiguous`, or `conflicting`.
- Only `aligned` and `implementation-choice` may reach `plan`; the CLI validates references, paths, statuses, dependency cycles, and criterion coverage but never claims to understand user intent.
- `goal-change`, `constraint-change`, and `conflicting` create a proposal. `ambiguous` asks one focused question and performs no affected write. `clarification` records a decision/progress event without editing the goal.
- No plan, progress record, code change, `planning-with-files` document, or generic user confirmation can supersede the active goal contract.

---

### Task 1: Freeze schemas and the pre-implementation behavior baseline

**Files:**

- Create: `references/contract.md`
- Modify: `evals/evals.json`
- Modify: `tests/documentation.test.js`

**Requirements:** REQ-001, REQ-003, REQ-004, REQ-005, REQ-009, REQ-010

- [ ] **Step 1: Write failing documentation contract tests**

Add tests named `goal lock reference defines every persisted artifact` and `initial behavior matrix contains positive negative and boundary cases`. Require `references/contract.md` to define the exact fields, enums, approval grammars, digest rules, exit codes, and command inputs in this plan. Require `evals/evals.json` to contain exactly these first-round cases with `result.status: "not-run"`:

  - `EVAL-001` positive: explicitly ask to lock a multi-step development objective and keep plan/progress locally.
  - `EVAL-002` negative: ask only for an ordinary short implementation plan and do not request drift protection.
  - `EVAL-003` boundary: request a mid-task acceptance-criterion change and answer the generated proposal with generic “确认”.

Assertions must check observable behavior, not headings or fixed keyword matching: EVAL-001 creates a draft and requests exact approval; EVAL-002 does not create `.goal-lock/`; EVAL-003 creates a CR, pauses affected work, and refuses generic approval.

- [ ] **Step 2: Run the focused tests and confirm red**

Run: `node --test --test-name-pattern="goal lock reference|initial behavior matrix" tests/documentation.test.js`

Expected: FAIL because the reference is absent and the eval list is empty.

- [ ] **Step 3: Write the complete reference and eval definitions**

Document JSON field types, stable ID patterns (`GL-[A-Z0-9][A-Z0-9-]*`, `AC-001`, `TASK-0001`, `CR-0001`, `EVT-000001`, `EVID-0001`), timestamp format, safe relative paths, canonicalization, current/history byte equality, plan status transitions, progress digest payload, evidence supersession, and fingerprint rules. Do not describe `planning-with-files` as required or authoritative.

- [ ] **Step 4: Re-run focused validation**

Run: `node --test --test-name-pattern="goal lock reference|initial behavior matrix" tests/documentation.test.js`

Expected: PASS.

Run: `npm run validate`

Expected: PASS with only already-understood `STATE_DIGEST_DRIFT` warnings for intentionally edited initialized artifacts.

- [ ] **Step 5: Commit the frozen contracts**

```powershell
git add references/contract.md evals/evals.json tests/documentation.test.js
git diff --cached --check
git commit -m "test: freeze goal lock behavior contracts"
```

### Task 2: Implement canonical JSON and structural contracts

**Files:**

- Create: `src/goal-lock/canonical.js`
- Create: `src/goal-lock/contracts.js`
- Create: `tests/goal-lock.test.js`
- Create: `tests/helpers/goal-lock-fixture.js`

**Requirements:** REQ-001, REQ-002, REQ-004, REQ-006

- [ ] **Step 1: Add fixture and failing canonicalization tests**

`createGoalLockFixture(testContext, options)` creates an isolated temporary directory, initializes Git only when `options.git !== false`, configures `tester@example.invalid`, and returns deterministic `now`, `randomToken`, `pid`, `isProcessAlive`, and fault seams. Tests must prove key ordering is recursive, array order is retained, Unicode round-trips, output has one LF, the same value has a stable SHA-256, and non-finite numbers, unsafe integers, `undefined`, functions, symbols, sparse arrays, prototypes other than `Object.prototype`/`null`, and cyclic values are rejected.

- [ ] **Step 2: Confirm canonical tests fail**

Run: `node --test --test-name-pattern="canonical" tests/goal-lock.test.js`

Expected: FAIL because `canonical.js` is absent.

- [ ] **Step 3: Implement the smallest canonical encoder**

`canonicalJson(value)` recursively copies arrays and plain objects, sorts keys with ordinal JavaScript string comparison, rejects non-JSON values before `JSON.stringify`, and returns compact JSON plus `\n`. `parseCanonicalJson(bytes, label)` requires valid UTF-8 JSON, parses it, regenerates canonical bytes, and rejects any byte difference.

- [ ] **Step 4: Add failing schema and path tests**

Cover every goal field, unique stable IDs, non-empty trimmed text, non-empty `scope.in`, arrays without duplicate semantic IDs, exact version/predecessor relations, normalized repository-relative artifact paths, no backslashes, no absolute/drive/UNC paths, no `.`/`..`/empty segments, and no path under `.goal-lock/` where a delivery artifact is expected. Cover all plan, lock, CR, event, and evidence enums.

- [ ] **Step 5: Implement contract validators and approval phrase builders**

`GoalLockError` has immutable `code`, `kind`, and `exitCode`. Validators return deeply frozen normalized values and never mutate caller input. Error messages name fields and IDs but do not echo objective text, approval text, or file contents.

- [ ] **Step 6: Run and commit**

Run: `node --test tests/goal-lock.test.js`

Expected: PASS for canonical and contract suites.

```powershell
git add src/goal-lock/canonical.js src/goal-lock/contracts.js tests/goal-lock.test.js tests/helpers/goal-lock-fixture.js
git diff --cached --check
git commit -m "feat: add canonical goal lock contracts"
```

### Task 3: Implement cooperative ownership and rollback-safe replacement

**Files:**

- Create: `src/goal-lock/transaction.js`
- Modify: `tests/goal-lock.test.js`

**Requirements:** REQ-002, REQ-008

- [ ] **Step 1: Write failing ownership tests**

Test exclusive creation of `.goal-lock/.write-lock.json`, canonical owner bytes, token uniqueness, rejection of a second writer, release only by the acquiring token, preservation of another writer's replacement lock, and cleanup after a successful or failed callback. Assert that lock age alone never authorizes removal.

- [ ] **Step 2: Run the ownership tests and confirm red**

Run: `node --test --test-name-pattern="cooperative lock" tests/goal-lock.test.js`

Expected: FAIL because transaction support is absent.

- [ ] **Step 3: Implement `withGoalLock`**

Use `mkdir('.goal-lock', { recursive: true })`, `open(lockPath, 'wx', 0o600)`, a canonical owner record `{ protocol: 'goal-version-lock-write-v1', token, pid, command, created_at }`, handle `sync()`, read-back digest verification, and token/digest checks immediately before release. Treat an existing non-regular file, symlink, malformed lock, or ownership change as an integrity failure.

- [ ] **Step 4: Write failing transaction and fault-injection tests**

Cover all-preflight-before-write, expected-absent and expected-digest ownership, duplicate and escaping targets, linked parents, stage write failure, detach failure, install failure, read-back mismatch, reverse-order rollback, non-clobbering recovery evidence, and cleanup of only directories created by the transaction.

- [ ] **Step 5: Implement `commitGoalFiles`**

Keep stages and backups beside each target, use exclusive stage creation, `sync`, atomic rename/link operations supported by the platform, read-back SHA-256 verification, reverse-order rollback, and conservative retention of recovery artifacts whenever ownership cannot be proven. Add concise Simplified Chinese comments only at the non-obvious ownership/race boundaries required by the repository comment policy.

- [ ] **Step 6: Write failing conditional recovery tests**

Require exact owner token, exact lock-file digest, canonical lock bytes, a dead PID result, and unchanged lock identity. Test live, inaccessible, malformed, missing, wrong-token, wrong-digest, and raced-lock rejection.

- [ ] **Step 7: Implement and verify recovery**

`recoverGoalLock` uses injected `isProcessAlive` in tests and `process.kill(pid, 0)` in production. `ESRCH` means dead; success, `EPERM`, or any indeterminate result means do not recover. Return a recovery receipt without exposing the token.

Run: `node --test --test-name-pattern="cooperative lock|transaction|recover" tests/goal-lock.test.js`

Expected: PASS.

- [ ] **Step 8: Commit transaction support**

```powershell
git add src/goal-lock/transaction.js tests/goal-lock.test.js
git diff --cached --check
git commit -m "feat: protect goal lock state transitions"
```

### Task 4: Create and explicitly lock goal version 1

**Files:**

- Create: `src/goal-lock/repository.js`
- Modify: `tests/goal-lock.test.js`

**Requirements:** REQ-001, REQ-002, REQ-008

- [ ] **Step 1: Write failing draft initialization tests**

Test absent-to-draft creation, canonical `current.json`, no `lock.json`, no history, returned exact approval phrase, full preflight before `.goal-lock/` creation, refusal to initialize a non-empty or linked `.goal-lock/`, and idempotent failure without changing existing bytes.

- [ ] **Step 2: Confirm red**

Run: `node --test --test-name-pattern="initializes goal draft" tests/goal-lock.test.js`

Expected: FAIL because repository transitions are absent.

- [ ] **Step 3: Implement `initializeGoal`**

Accept a version-1 goal contract with `predecessor: null` and `accepted_change_id: null`, validate it fully, commit only `current.json`, and return `{ state: 'DRAFT', goal_id, goal_version: 1, goal_digest, approval_required }`.

- [ ] **Step 4: Write failing version-1 lock tests**

Test generic confirmation, wrong case, whitespace, ID, version, and fingerprint rejection; exact approval success; atomic creation of `lock.json` and `history/goals/v0001.json`; byte equality between current and history; second-lock refusal; and rollback when either file installation fails.

- [ ] **Step 5: Implement `lockInitialGoal`**

Re-read and canonical-verify `current.json` under the writer lock, compare the exact phrase, create lock metadata with `approval_type: 'explicit-version-1'`, full goal digest, timestamp, `proposal_digest` equal to the goal digest, and `predecessor_digest: null`, then atomically write lock and history without rewriting current.

- [ ] **Step 6: Run and commit**

Run: `node --test --test-name-pattern="goal draft|version 1" tests/goal-lock.test.js`

Expected: PASS.

```powershell
git add src/goal-lock/repository.js tests/goal-lock.test.js
git diff --cached --check
git commit -m "feat: lock initial goal version"
```

### Task 5: Verify the complete goal repository fail-closed

**Files:**

- Create: `src/goal-lock/workspace.js`
- Modify: `src/goal-lock/repository.js`
- Modify: `tests/goal-lock.test.js`

**Requirements:** REQ-002, REQ-006

- [ ] **Step 1: Write failing safe-reader and integrity tests**

Cover regular-file and directory identity, links/junctions, file replacement during read, malformed/noncanonical JSON, changed current bytes, changed lock bytes, missing current/lock/history, mismatched history bytes, skipped version filenames, broken `predecessor.version`/digest, incorrect `accepted_change_id`, and a history file whose content does not match its filename.

- [ ] **Step 2: Confirm red**

Run: `node --test --test-name-pattern="safe workspace|verifies goal history|detects tampering" tests/goal-lock.test.js`

Expected: FAIL because complete verification is absent.

- [ ] **Step 3: Implement `createWorkspaceReader` and goal-chain verification**

Open files through handles, compare named/opened identities before and after reads, reject links and root escapes, capture input digests, and support a final `verifyInputs()` pass. `verifyGoalRepository` returns `DRAFT`, `LOCKED`, `CHANGE_PENDING`, or `TAMPERED` plus structured evidence; it throws on integrity failure for mutating callers and never adopts observed bytes.

- [ ] **Step 4: Add plan, CR, ledger, and evidence verification hooks**

At this stage, missing optional files are allowed only when their lifecycle has not started. Present files must already be canonical and structurally valid. Later tasks fill in reference and chain validation through internal functions `verifyPlanState`, `verifyChangeState`, `verifyProgressLedger`, and `verifyEvidenceState` in `repository.js`.

- [ ] **Step 5: Run and commit**

Run: `node --test --test-name-pattern="safe workspace|goal history|tampering" tests/goal-lock.test.js`

Expected: PASS.

```powershell
git add src/goal-lock/workspace.js src/goal-lock/repository.js tests/goal-lock.test.js
git diff --cached --check
git commit -m "feat: verify locked goal integrity"
```

### Task 6: Add standalone goal-bound planning and plan revisions

**Files:**

- Modify: `src/goal-lock/contracts.js`
- Modify: `src/goal-lock/repository.js`
- Modify: `tests/goal-lock.test.js`

**Requirements:** REQ-003, REQ-005, REQ-006, REQ-009

- [ ] **Step 1: Write failing plan contract tests**

Require a current goal reference `{ goal_id, goal_version, goal_digest }`, positive `plan_revision`, unique task IDs, at least one acceptance-criterion reference per scheduled task, existing dependencies, an acyclic dependency graph, normalized permitted paths/surfaces, valid verification text, a single `next_task_id` referencing an executable non-complete task, and task status in the approved enum. Deferred items remain inside the goal and have stable IDs plus reasons.

- [ ] **Step 2: Write failing plan transition tests**

Test first plan revision 1, aligned revision 2, implementation-choice revision 3, byte-for-byte archive of the replaced plan, immutable prior archives, rejection of unsupported classification values, wrong goal references, skipped revisions, a changed goal version, acceptance criteria outside the goal, any proposed CR, and any attempt to plan while draft or tampered.

- [ ] **Step 3: Confirm red**

Run: `node --test --test-name-pattern="plan contract|plan revision" tests/goal-lock.test.js`

Expected: FAIL.

- [ ] **Step 4: Implement `revisePlan`**

The CLI, not caller input, supplies the current goal reference and next revision. Candidate input contains only `next_task_id`, `tasks`, and `deferred`. First creation writes `plan.json`; replacement atomically archives the exact prior bytes to `history/plans/vNNNN-rNNNN.json` and installs the newly canonical plan. Goal bytes and `goal_version` remain unchanged.

- [ ] **Step 5: Extend repository verification**

Verify current plan binding, archive filename/content agreement, no revision gaps among archived plans, archive immutability, and the rule that the current plan revision is exactly one greater than the latest archived revision. A missing plan is a valid locked-but-unplanned state but can never pass completion.

- [ ] **Step 6: Run and commit**

Run: `node --test --test-name-pattern="plan" tests/goal-lock.test.js`

Expected: PASS.

```powershell
git add src/goal-lock/contracts.js src/goal-lock/repository.js tests/goal-lock.test.js
git diff --cached --check
git commit -m "feat: add standalone goal-bound planning"
```

### Task 7: Add the append-only digest-chained progress ledger

**Files:**

- Modify: `src/goal-lock/contracts.js`
- Modify: `src/goal-lock/repository.js`
- Modify: `tests/goal-lock.test.js`

**Requirements:** REQ-005, REQ-006

- [ ] **Step 1: Write failing progress tests**

Test automatic sequential `EVT-000001` IDs, canonical line bytes, version/digest/revision binding, `previous_event_digest: null` for the first event, each later link, and own digest calculated over the event without its `event_digest` field. Cover deletion, insertion, reordering, rewriting, duplicate ID, truncation, missing final LF, cross-version events, and unknown task/evidence references.

- [ ] **Step 2: Write failing task-status transition tests**

`task-start` moves only `pending` to `in_progress`; `task-complete` moves only `in_progress` to `complete` and requires evidence references; `blocker` moves an active task to `blocked`; `verification-result`, `plan-revision`, `goal-change`, `evidence-invalidation`, `recovery`, and `final-audit` do not silently complete tasks. Each plan update and ledger append is one transaction.

- [ ] **Step 3: Confirm red**

Run: `node --test --test-name-pattern="progress ledger|task status" tests/goal-lock.test.js`

Expected: FAIL.

- [ ] **Step 4: Implement progress recording**

`recordGoalEvent` accepts `{ kind: 'progress', event_type, task_id, summary, evidence_refs }`. It derives IDs, goal/plan references, timestamp, and digests; caller input cannot override them. Replacing the full ledger file is allowed only when the expected prior SHA-256 matches, and the new bytes must have the exact prior bytes as a prefix.

- [ ] **Step 5: Integrate automatic lifecycle events**

Plan replacement appends `plan-revision`; change approval later appends `goal-change` and `evidence-invalidation`; lock recovery returns a receipt that the Agent may record after verification. Do not write events for failed or rolled-back transitions.

- [ ] **Step 6: Run and commit**

Run: `node --test --test-name-pattern="progress|task status" tests/goal-lock.test.js`

Expected: PASS.

```powershell
git add src/goal-lock/contracts.js src/goal-lock/repository.js tests/goal-lock.test.js
git diff --cached --check
git commit -m "feat: record digest-chained goal progress"
```

### Task 8: Add immutable acceptance evidence and supersession

**Files:**

- Modify: `src/goal-lock/contracts.js`
- Modify: `src/goal-lock/repository.js`
- Modify: `tests/goal-lock.test.js`

**Requirements:** REQ-006, REQ-007

- [ ] **Step 1: Write failing evidence tests**

Test monotonic per-criterion `EVID-0001` IDs; immutable files; criterion, goal, digest, plan, and task binding; states `pass`, `fail`, and `stale`; required verification command/manual method and observed result; normalized artifact references; workspace fingerprint format; and exact `supersedes` linkage to the preceding latest evidence when one exists.

- [ ] **Step 2: Confirm red**

Run: `node --test --test-name-pattern="evidence" tests/goal-lock.test.js`

Expected: FAIL.

- [ ] **Step 3: Implement evidence recording**

`recordGoalEvent` accepts `{ kind: 'evidence', acceptance_criterion_id, task_id, method, observed_result, artifact_refs, inventory, state, supersedes }`. It derives the workspace fingerprint inside the governed transaction from Git or the explicit inventory, derives immutable identity and active goal/plan references, writes the evidence file with expected-absent ownership, and appends one `verification-result` event transactionally.

- [ ] **Step 4: Extend verification**

Scan criterion directories in ordinal numeric order, reject gaps, duplicates, linked entries, edits, invalid supersession, evidence for unknown criteria/tasks, and a latest record that contradicts its directory. Historical evidence remains readable but only the latest valid record can satisfy a gate.

- [ ] **Step 5: Run and commit**

Run: `node --test --test-name-pattern="evidence" tests/goal-lock.test.js`

Expected: PASS.

```powershell
git add src/goal-lock/contracts.js src/goal-lock/repository.js tests/goal-lock.test.js
git diff --cached --check
git commit -m "feat: preserve immutable goal evidence"
```

### Task 9: Create and reject stage-one goal change requests

**Files:**

- Modify: `src/goal-lock/contracts.js`
- Modify: `src/goal-lock/repository.js`
- Modify: `tests/goal-lock.test.js`

**Requirements:** REQ-003, REQ-004, REQ-006

- [ ] **Step 1: Write failing proposal tests**

Proposal input has exact keys `{ candidate, changes, rationale, affected_tasks, affected_criteria, risks, validation, rollback }`. The repository derives CR ID, base reference, candidate version, candidate goal metadata, canonical candidate digest, proposal digest, status, and approval phrase. Test stable field-level before/after values, candidate version exactly N+1, no active-goal changes, one open CR per base/candidate, safe IDs, affected references, and no proposal from draft/tampered/stale state.

- [ ] **Step 2: Write failing reject tests**

Test exact open CR selection, non-empty concise reason, immutable proposal fields, status change to `rejected`, active goal/plan/history byte preservation, and refusal to reject an already terminal or unknown CR.

- [ ] **Step 3: Confirm red**

Run: `node --test --test-name-pattern="change proposal|rejects change" tests/goal-lock.test.js`

Expected: FAIL.

- [ ] **Step 4: Implement proposal construction**

The candidate input contains the semantic goal fields only. Derive `goal_id`, `goal_version`, `predecessor`, and `accepted_change_id`; calculate the candidate digest; calculate `proposal_digest` from the entire CR payload without status/approval phrase; then add the exact phrase. `changes` must cover every canonical semantic difference and may not claim an unchanged field changed.

- [ ] **Step 5: Implement rejection as a CR-only transition**

Use expected digest ownership and atomic replacement of `changes/CR-NNNN.json`. Rejection never rewrites goal, lock, plan, progress, history, or evidence.

- [ ] **Step 6: Run and commit**

Run: `node --test --test-name-pattern="change proposal|reject" tests/goal-lock.test.js`

Expected: PASS.

```powershell
git add src/goal-lock/contracts.js src/goal-lock/repository.js tests/goal-lock.test.js
git diff --cached --check
git commit -m "feat: propose controlled goal changes"
```

### Task 10: Apply exact stage-two approval and selective invalidation

**Files:**

- Modify: `src/goal-lock/repository.js`
- Modify: `tests/goal-lock.test.js`

**Requirements:** REQ-004, REQ-006, REQ-008

- [ ] **Step 1: Write failing approval rejection tests**

Reject generic confirmation, wrong ID/version/fingerprint/case/spacing, a proposal whose base digest is stale, skipped candidate versions, a changed CR file, a second approval, and any open competing proposal. Assert exit kind `approval` for phrase/staleness failures and `integrity` for tampered bytes.

- [ ] **Step 2: Write failing successful-transition tests**

Exact approval must atomically:

  1. preserve existing goal history and archive the current plan if needed;
  2. install candidate bytes as `current.json` and identical `history/goals/vNNNN.json`;
  3. install a new lock linked to the predecessor digest and CR proposal digest;
  4. derive plan revision 1 for the new goal, retaining unaffected tasks and marking listed tasks `stale`;
  5. append immutable `stale` evidence records for listed criteria, each superseding its prior latest record;
  6. append `goal-change` and one `evidence-invalidation` event per affected criterion;
  7. change only that CR status to `approved`.

Test no affected evidence, selective task-only, selective evidence-only, all-affected, no prior plan, and injected failure at every installed file with full rollback.

- [ ] **Step 3: Confirm red**

Run: `node --test --test-name-pattern="exact change approval|selective invalidation" tests/goal-lock.test.js`

Expected: FAIL.

- [ ] **Step 4: Implement `approveGoalChange`**

Build all target bytes in memory after a complete locked-state verification, compute expected ownership for every replacement, and make one `commitGoalFiles` call. No partial transition may be reported successful. Re-run `verifyGoalRepository` after commit before returning `{ state: 'LOCKED', goal_version: N + 1 }`.

- [ ] **Step 5: Run and commit**

Run: `node --test --test-name-pattern="change approval|invalidation|predecessor" tests/goal-lock.test.js`

Expected: PASS.

```powershell
git add src/goal-lock/repository.js tests/goal-lock.test.js
git diff --cached --check
git commit -m "feat: apply approved goal versions atomically"
```

### Task 11: Fingerprint workspaces and gate completion

**Files:**

- Modify: `src/goal-lock/workspace.js`
- Modify: `src/goal-lock/repository.js`
- Modify: `tests/goal-lock.test.js`

**Requirements:** REQ-007

- [ ] **Step 1: Write failing Git fingerprint tests**

Hash a canonical manifest containing `mode: 'git'`, HEAD identity (or the empty-tree sentinel for an unborn repository), `git diff --binary HEAD -- .` bytes for tracked changes, and sorted repository-relative names, modes, sizes, and bytes of untracked non-ignored files. Exclude `.git/` internals and `.goal-lock/` bookkeeping only. Test staged, unstaged, deleted, renamed, binary, Unicode, ignored, and untracked files; reject links and input changes during capture.

- [ ] **Step 2: Write failing explicit-inventory tests**

For non-Git roots, require a non-empty sorted-unique inventory of normalized delivery paths. Hash the same name/mode/size/bytes manifest, reject missing, directory, link, escape, duplicate, and changed-during-read entries, and fail if Git is unavailable and inventory is omitted.

- [ ] **Step 3: Implement fingerprint functions**

Use `execFile` argument arrays only, never a shell. Cap Git output and surface a redacted `GOAL_IO_GIT` error. `workspaceFingerprint` prefers Git when `rev-parse --is-inside-work-tree` succeeds; otherwise it validates the explicit inventory.

- [ ] **Step 4: Write failing final-audit and gate matrix tests**

`recordGoalEvent({ kind: 'final-audit', semantic_summary, inventory })` computes the fingerprint itself and appends the audit event. Gate tests independently fail for: invalid goal chain, missing/mismatched plan, any proposed CR, each non-complete task status, missing evidence, fail evidence, stale evidence, old goal/digest evidence, absent final audit, changed fingerprint, broken ledger, and changed inputs during the gate. Include one passing Git case and one passing inventory case.

- [ ] **Step 5: Implement `gateGoalCompletion`**

Return a sorted checklist with one result per gate condition. A pass is bound to the active goal digest and current workspace fingerprint and does not claim code correctness, authenticated identity, or an irreversible terminal state. Any later workspace change causes the next gate to fail until a new semantic audit is recorded.

- [ ] **Step 6: Run and commit**

Run: `node --test --test-name-pattern="fingerprint|completion gate|final audit" tests/goal-lock.test.js`

Expected: PASS.

```powershell
git add src/goal-lock/workspace.js src/goal-lock/repository.js tests/goal-lock.test.js
git diff --cached --check
git commit -m "feat: gate completion on current goal evidence"
```

### Task 12: Expose the complete deterministic CLI

**Files:**

- Create: `src/goal-lock/cli.js`
- Create: `scripts/goal-lock.js`
- Create: `tests/goal-lock-cli.test.js`
- Modify: `package.json`

**Requirements:** REQ-001, REQ-004, REQ-005, REQ-007, REQ-008

- [ ] **Step 1: Write failing parser and help tests**

Cover every command/options combination fixed above, `--input -`, duplicate/unknown/missing/cross-command options, positional input, multiline/empty approval and reason, unsafe CR IDs, invalid classification, and `--help` without loading repository modules. Help must list every command, exit code, exact approval examples, and the fact that cwd is the governed project.

- [ ] **Step 2: Confirm red**

Run: `node --test --test-name-pattern="parses|help" tests/goal-lock-cli.test.js`

Expected: FAIL because the CLI is absent.

- [ ] **Step 3: Implement parser and result delivery**

Parse without third-party packages. Read one bounded UTF-8 JSON document from a safe repo-relative regular file or stdin. Success is `{ ok: true, command, result }`; failure is `{ ok: false, command, error: { code, message } }`. Use the existing `src/output.js#writeOutput` only for stream backpressure; do not import scaffold initialization, validation, transaction, or state modules into runtime goal-lock code.

- [ ] **Step 4: Write failing process integration tests**

Spawn the real script in isolated fixtures for the full lifecycle: init, rejected generic lock, exact lock, plan, task start, evidence, task complete, verify, final audit, and gate. Assert stdout/stderr separation, exit codes 2–6, stdin input, cwd targeting, malformed JSON redaction, read-only help, and no writes outside `.goal-lock/`.

- [ ] **Step 5: Implement command dispatch and entry point**

Inject production context in `scripts/goal-lock.js`, add package script `"goal-lock": "node scripts/goal-lock.js"`, and leave `package.json#files` unchanged because public npm publication is disabled and the scaffold delivery gate requires the existing whitelist.

- [ ] **Step 6: Run and commit**

Run: `node --test tests/goal-lock-cli.test.js`

Expected: PASS.

Run: `npm run check`

Expected: all deterministic tests and repository validation pass; intentional initialized-file edits may still produce documented digest-drift warnings.

```powershell
git add src/goal-lock/cli.js scripts/goal-lock.js tests/goal-lock-cli.test.js package.json
git diff --cached --check
git commit -m "feat: expose goal version lock cli"
```

### Task 13: Write the Agent workflow and user documentation

**Files:**

- Modify: `SKILL.md`
- Modify: `README.md`
- Modify: `references/contract.md`
- Modify: `tests/documentation.test.js`

**Requirements:** REQ-003, REQ-004, REQ-005, REQ-009, REQ-010

- [ ] **Step 1: Write failing Skill routing tests**

Require a discriminating frontmatter description; trigger and non-trigger boundaries; verify-before-work behavior; all seven semantic classifications; the conservative ambiguity rule; exact two-stage approval; standalone plan/progress workflow; final audit/gate; tamper response; context-loss resume; reference-loading conditions; concise output contract; and explicit non-authority of `planning-with-files`.

- [ ] **Step 2: Confirm red against the generated placeholder Skill**

Run: `node --test --test-name-pattern="goal version lock skill|planning-with-files" tests/documentation.test.js`

Expected: FAIL because `SKILL.md` still contains scaffold boilerplate.

- [ ] **Step 3: Replace `SKILL.md` with the executable workflow**

Keep the main Skill concise. It must tell the Agent to:

  - invoke for an explicit drift/version-lock request or an existing `.goal-lock/` workspace, but not ordinary planning, personal OKRs, infrastructure config drift, or read-only questions;
  - run `verify` and re-read current goal/plan before each work slice and before applying new instructions;
  - classify semantically, route plan-only changes to `plan`, and route contract changes to `propose`;
  - display the generated exact approval phrase and never reinterpret generic confirmation;
  - stop goal-governed writes on tamper/integrity errors and offer only evidence-preserving recovery choices;
  - record task/evidence progress and require a final semantic diff audit plus deterministic gate before a completion claim;
  - read `references/contract.md` only when creating, validating, changing, gating, or recovering runtime state.

- [ ] **Step 4: Rewrite README for independent use**

Document Node 22, local Skill-directory loading/copying of `SKILL.md`, `references/`, `scripts/`, and `src/goal-lock/`, CLI examples using fictional paths/IDs, the no-dependency guarantee, recovery safety, optional `planning-with-files` mapping by goal ID/version/digest, and current non-goals. Do not claim formal cross-platform or named-Agent compatibility without evidence.

- [ ] **Step 5: Measure prompt size and run docs checks**

Use the tokenizer available through the loaded `skill-creator` tooling when execution begins; record its exact command/version and SHA-256 output artifact. If no tokenizer is available, use UTF-8 byte and word counts only as diagnostic data and do not mark the prompt-budget contract passed.

Run: `node --test tests/documentation.test.js`

Expected: PASS.

Run: `npm run validate`

Expected: PASS with only documented digest-drift warnings.

- [ ] **Step 6: Commit Skill instructions**

```powershell
git add SKILL.md README.md references/contract.md tests/documentation.test.js
git diff --cached --check
git commit -m "feat: define goal version lock workflow"
```

### Task 14: Execute real behavior evaluations before tuning

**Files:**

- Modify: `evals/evals.json`
- Create: `evals/results/EVAL-001.txt`
- Create: `evals/results/EVAL-002.txt`
- Create: `evals/results/EVAL-003.txt`
- Create after the first round: `evals/results/EVAL-004.txt` through `evals/results/EVAL-012.txt`
- Modify only if evidence requires it: `SKILL.md`

**Requirements:** REQ-002, REQ-003, REQ-004, REQ-005, REQ-006, REQ-007, REQ-010

- [ ] **Step 1: Obtain authorization before any paid or credentialed evaluator call**

Check whether the loaded `skill-creator` offers an already-authorized local evaluation runner. If execution would consume paid model calls, credentials, or an external service, pause and request explicit user authorization. Do not replace real Agent conclusions with string-matching tests and do not mark unrun cases passed.

- [ ] **Step 2: Run the immutable first-round matrix**

Run EVAL-001 through EVAL-003 in isolated temporary repositories with only the prompt, repository instructions, Skill-under-test condition, and standard Agent environment. Preserve raw prompt, output, commands, files produced, timestamps, model identity when available, Skill digest, assertions, and evaluator conclusion. EVAL-002 must leave `.goal-lock/` absent; EVAL-003 must reject generic “确认”.

- [ ] **Step 3: Compare with a no-Skill baseline**

For the same three prompts, run a matched baseline without loading `goal-version-lock`, using the same model and settings. Record useful behavioral gain, false-positive cost, total tokens when available, and duration. Keep evaluation workspaces outside the repository; commit only redacted raw result summaries required by the scaffold Evidence Contract.

- [ ] **Step 4: Tune only from observed failures**

If an assertion fails, make the smallest `SKILL.md` wording/resource-routing correction, add the failure as regression evidence, and rerun only affected cases. Do not modify deterministic CLI behavior to compensate for a semantic prompt issue without a failing deterministic test.

- [ ] **Step 5: Add and run the expanded cases**

Add these exact semantic scenarios, with non-duplicated natural prompts and observable assertions:

  - `EVAL-004` aligned bug fix proceeds without CR;
  - `EVAL-005` implementation-only change creates a plan revision, not a goal version;
  - `EVAL-006` scope change creates a CR and pauses affected work;
  - `EVAL-007` exact approval creates N+1 and preserves history;
  - `EVAL-008` direct current-goal tamper blocks work and completion;
  - `EVAL-009` context-loss resume reads disk state rather than relying on chat memory;
  - `EVAL-010` affected evidence becomes stale after approval;
  - `EVAL-011` missing/stale evidence blocks completion;
  - `EVAL-012` current evidence plus matching semantic audit permits completion.

Map the expanded cases to `positive`, `negative`, or `boundary` as required by the scaffold schema. Record `result.status` only from actual evidence and bind each result to `artifact:evals/results/EVAL-NNN.txt#sha256:{digest}`.

- [ ] **Step 6: Run evaluation contract validation and commit**

Run: `npm run validate`

Expected: PASS with every eval structurally valid and no fabricated pass result.

```powershell
git add evals/evals.json evals/results SKILL.md
git diff --cached --check
git commit -m "test: verify goal lock agent behavior"
```

Omit `SKILL.md` from `git add` when no evidence-driven wording change was needed.

### Task 15: Close deterministic edge cases and verify end to end

**Files:**

- Modify: `tests/goal-lock.test.js`
- Modify: `tests/goal-lock-cli.test.js`
- Modify only for a reproduced failure: `src/goal-lock/*.js`, `scripts/goal-lock.js`, `references/contract.md`, `README.md`

**Requirements:** REQ-001 through REQ-009

- [ ] **Step 1: Add a complete version-change end-to-end test first**

The test creates and locks v1, creates plan r1 then r2, records progress/evidence, proposes v2, rejects generic approval, applies exact approval, checks v1/r1/r2 history, checks selective staleness and progress chain, replans v2, records current evidence/final audit, and passes gate. Restart the CLI process between stages to prove disk-only resume.

- [ ] **Step 2: Add negative end-to-end cases before fixes**

Cover concurrent writers, crash during approval, truncated ledger, manually edited evidence, stale CR base, modified workspace after final audit, non-Git missing inventory, malicious input paths, large input rejection, malformed UTF-8, and stdout/stderr `EPIPE`. Each test must fail for the missing behavior before any implementation correction.

- [ ] **Step 3: Make only the minimal reproduced fixes**

Preserve public signatures and JSON contracts. If a change affects description, core workflow, resource selection, or compatibility wording, mark the corresponding behavior evaluations stale and rerun them under Task 14 rules.

- [ ] **Step 4: Run focused and aggregate gates twice**

Run: `node --test tests/goal-lock.test.js tests/goal-lock-cli.test.js`

Expected: PASS.

Run twice: `npm run check`

Expected: identical pass/skip/fail counts on both runs and no state changes outside test fixtures.

Run: `git diff --check`

Expected: no whitespace errors.

- [ ] **Step 5: Commit edge-case closure**

```powershell
git add tests/goal-lock.test.js tests/goal-lock-cli.test.js
git add src/goal-lock scripts/goal-lock.js references/contract.md README.md
git diff --cached --check
git commit -m "test: cover goal lock lifecycle boundaries"
```

Before committing, unstage any listed implementation/documentation path that did not actually change.

### Task 16: Complete evidence contracts, independent review, and local delivery gate

**Files:**

- Modify: `docs/skill-brief.md`
- Modify: `docs/delivery-report.md`
- Modify: `docs/decisions.md` only for actual superseding decisions
- Modify: `.scaffold/state.json`
- Modify only for review findings: any affected implementation, test, evaluation, or documentation file

**Requirements:** REQ-001 through REQ-010

- [ ] **Step 1: Build the requirement trace before changing statuses**

For each REQ-001 through REQ-010, identify at least one concrete implementation path and the exact passing evaluation IDs. Do not mark a requirement `pass` from unit tests alone when its verification requires Agent behavior. Hash `references/contract.md`, deterministic test output, prompt-budget measurement, and each raw evaluation result with lowercase SHA-256.

- [ ] **Step 2: Update the Brief and delivery report atomically**

Set a requirement to `pass` only when its stated deterministic and behavioral evidence exists. Keep enabled tracks backed by `artifact:path#sha256:digest`; keep disabled tracks with their already-approved reasons. Set a real positive prompt-token limit and measurement evidence. Populate exactly one delivery trace per requirement with `path:` implementation and `eval:` verification references.

- [ ] **Step 3: Run security, privacy, packaging, and comment review**

Run: `npm run audit`

Expected: PASS with no credential, private path/email, unsafe link, forbidden package path, or recovery artifact findings.

Run: `git status --short`

Inspect every tracked diff and every untracked deliverable. Confirm examples use reserved identities, no chat transcript or approval secret is stored, no remote/Tag/Release/package publishing change exists, `package.json#files` remains the scaffold whitelist, and `planning-with-files` is optional. Under `$chinese-code-comments` SCOPED mode, review the full diff for missing maintenance intent, stale narration, misleading security claims, and over-commenting; record that review even if no comment change is needed.

- [ ] **Step 4: Request independent review**

Use an independent review Agent as required by the mature-skill workflow, after obtaining explicit authorization if that review creates an additional paid model call. Give it only the current Brief, approved design, complete diff, untracked file list, and validation output. Ask for requirement gaps, false triggers, unsafe ownership/recovery behavior, digest/fingerprint flaws, invalid completion claims, prompt regressions, and unsupported compatibility claims. Fix every high-severity finding with a new failing test and rerun only affected evals; disposition lower-severity findings in `docs/decisions.md` when they materially affect scope.

- [ ] **Step 5: Perform isolated autonomy reproduction**

In a fresh temporary project and fresh Agent context, load only the local Skill directory and README, then execute EVAL-001's core lifecycle through a passing gate. This is a real Agent evaluation and follows the same paid/credential authorization boundary as Task 14. The reproducer may not use hidden development-session context.

- [ ] **Step 6: Mark ready only after all evidence passes**

Set `docs/skill-brief.md#status` and `.scaffold/state.json#status` to `ready` only when all ten requirements pass, all required evals pass, enabled-track and prompt-budget digests resolve, and review findings are closed. Do not rewrite `.scaffold/state.json#initial_files`; digest-drift warnings intentionally show initialized artifacts evolved.

- [ ] **Step 7: Run the final gates on a stable worktree**

Run: `npm run check`

Run: `npm run audit`

Run: `git diff --check`

Run: `npm run gate:delivery`

Expected: all commands exit 0; delivery gate prints passing evidence for REQ-001 through REQ-010. If paid behavior evidence remains unauthorized or any evidence contract is incomplete, keep status `draft`, do not run or claim the mature delivery gate, and report the exact remaining authorization/evidence blocker.

- [ ] **Step 8: Commit the local mature delivery**

```powershell
git add .scaffold/state.json docs/skill-brief.md docs/delivery-report.md docs/decisions.md
git add SKILL.md README.md references scripts/goal-lock.js src/goal-lock tests/goal-lock.test.js tests/goal-lock-cli.test.js evals/evals.json evals/results package.json
git diff --cached --check
git commit -m "feat: deliver mature goal version lock skill"
git status --short --branch
```

Do not add unchanged paths. Do not push, change `origin`, create a Tag or Release, publish a package, install global configuration, or use credentials; none of those actions are authorized.

---

## Requirement coverage audit

| Requirement | Primary implementation tasks | Deterministic evidence | Behavioral evidence |
| --- | --- | --- | --- |
| REQ-001 | 2, 4, 12 | canonical, init, approval, history, CLI lifecycle | EVAL-001, EVAL-007 |
| REQ-002 | 5, 10, 15 | tamper, missing history, predecessor, rollback | EVAL-008 |
| REQ-003 | 6, 9, 13 | accepted plan classifications and CR structures | EVAL-004, EVAL-005, EVAL-006 |
| REQ-004 | 4, 9, 10, 12 | generic/stale/wrong/exact approval cases | EVAL-003, EVAL-006, EVAL-007 |
| REQ-005 | 6, 7, 12 | plan, task status, digest ledger, process restart | EVAL-001, EVAL-009 |
| REQ-006 | 7, 8, 10 | histories, chains, immutable supersession, staleness | EVAL-007, EVAL-010 |
| REQ-007 | 8, 11 | independent gate failure matrix and two pass cases | EVAL-011, EVAL-012 |
| REQ-008 | 3, 4, 10, 15 | locks, faults, rollback, recovery, process CLI | EVAL-008 |
| REQ-009 | 6, 13 | dependency inspection and isolated core lifecycle | EVAL-001, EVAL-009 |
| REQ-010 | 1, 13, 14 | discovery/document contracts | EVAL-001 through EVAL-006 |

## Completion criteria

- Every deterministic behavior was introduced by a focused failing test and observed passing after the minimum implementation.
- The immutable first behavior matrix predates Skill wording changes; every later behavior pass has raw, digest-bound Agent evidence.
- An exact approval is required for both version 1 and N+1; a generic “确认” never changes the active goal.
- `goal_version` changes only on approved CRs, while `plan_revision` changes only within one locked goal version.
- Direct edits, stale proposals, broken history, progress/evidence tampering, unsafe paths, and uncertain lock ownership fail closed.
- The standalone plan, progress ledger, evidence lineage, and gate operate with no `planning-with-files` files or code present.
- `npm run check`, `npm run audit`, `git diff --check`, and—only when ready—`npm run gate:delivery` pass on the final stable worktree.
- Full diff, untracked delivery, sensitive information, package whitelist, documentation truthfulness, and Chinese code-comment review are complete.
- The repository remains local-only: no remote changes, push, Tag, Release, registry upload, credential use, paid evaluator call without explicit approval, global configuration, host hook, or installer.
