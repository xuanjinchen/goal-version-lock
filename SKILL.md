---
name: "goal-version-lock"
description: "Keep multi-step development work aligned to an approved, versioned goal contract by orchestrating planning, progress, change approval, recovery, and completion gates. Use for requests to lock, freeze with controlled version changes, preserve, or prevent drift in a development goal, or when an existing .goal-lock/ workspace governs the task. Do not use for ordinary planning, personal OKRs, infrastructure configuration drift, or read-only questions outside a development goal contract."
---

# Goal Version Lock

Keep Agent decisions and development writes bound to the active goal version. Treat semantic classification as Agent judgment: the CLI validates state and accepted input labels, but does not infer user intent.

## Read runtime details only when needed

Read [`references/contract.md`](references/contract.md) only when creating, validating, changing, gating, or recovering runtime state. Use its exact schemas, identifiers, digest rules, input shapes, exit codes, and recovery conditions instead of reconstructing them from memory.

## Establish or resume authority

Run commands with the governed project as the current working directory. Resolve `scripts/goal-lock.js` from this Skill directory; do not treat the Skill installation directory as the governed project.

If `.goal-lock/` is absent, turn the agreed objective, scope, non-goals, constraints, acceptance criteria, authorization boundary, and explicit assumptions into a version-1 draft. Run `init`, show its `approval_required` value verbatim, and leave the state at `DRAFT` until the user returns that exact phrase.

If `.goal-lock/` exists, run `verify` before doing governed work. Re-read `.goal-lock/current.json`, `.goal-lock/lock.json`, `.goal-lock/plan.json` when present, and the final complete line of `.goal-lock/progress.jsonl`. These artifacts, not conversation memory or an external plan, determine the active goal, next task, and evidence lineage.

### CLI orchestration

| Intent | Command |
| --- | --- |
| Create a version-1 draft | `node scripts/goal-lock.js init --input draft.json` |
| Bind the approved draft | `node scripts/goal-lock.js lock --approval "<exact phrase>"` |
| Verify all governed state | `node scripts/goal-lock.js verify` |
| Create or revise the plan | `node scripts/goal-lock.js plan --input plan.json --classification aligned` |
| Propose a contract change | `node scripts/goal-lock.js propose --input change-proposal.json` |
| Approve the current proposal | `node scripts/goal-lock.js approve --cr CR-0001 --approval "<exact phrase>"` |
| Reject the current proposal | `node scripts/goal-lock.js reject --cr CR-0001 --reason "<reason>"` |
| Append progress or evidence | `node scripts/goal-lock.js record --input event.json` |
| Evaluate completion | `node scripts/goal-lock.js gate` |
| Recover a stale cooperative write lock | `node scripts/goal-lock.js recover-lock --owner-token <uuid> --lock-digest <sha256>` |

Use `--input -` for supported stdin inputs. Treat the single JSON success or error envelope and its process exit code as the command result.

## Verify each work slice

Verification prevents old conversation state from overriding accepted bytes.

| Checkpoint | Required action |
| --- | --- |
| Before every work slice | Run `verify`; re-read `.goal-lock/current.json` and `.goal-lock/plan.json`. |
| Before applying a new instruction | Run `verify`; re-read the current goal and plan, then classify the instruction before any governed write. |
| After context loss | Run `verify`; re-read `current.json`, `lock.json`, `plan.json`, and the progress tail; resume `next_task_id` only when goal ID, version, and digest still bind. |

Do not batch several slices behind one verification. If verification reports `DRAFT`, `CHANGE_PENDING`, `TAMPERED`, or an error, follow that state instead of continuing the previous plan.

## Classify and route instructions

Compare meaning, not keywords, against the entire current contract. When a request could change either implementation or the goal, use the more conservative classification and ask before writing.

| Classification | Semantic test | CLI route |
| --- | --- | --- |
| aligned | Executes the approved plan without changing its contract or implementation choice. | Continue; use `plan --classification aligned` only for a plan revision. |
| implementation-choice | Changes implementation-only decomposition, ordering, or permitted paths while preserving the contract. | Use `plan --classification implementation-choice`; keep the goal version. |
| clarification | Requests missing information without yet choosing a changed outcome or boundary. | Ask, then verify and reclassify before a governed write. |
| goal-change | Changes objective, scope, non-goals, acceptance outcomes, or completion definition. | Use `propose`; pause affected work for exact approval. |
| constraint-change | Adds, removes, or changes a mandatory constraint or authorization boundary. | Use `propose`; pause affected work for exact approval. |
| ambiguous | Has more than one plausible classification or an uncertain contract impact. | Ask; make no governed write until conservative reclassification. |
| conflicting | Directly contradicts the active goal, non-goals, constraints, acceptance criteria, or authorization boundary. | Stop conflicting work; ask whether to propose a goal change. |

Never route objective, scope, non-goal, mandatory-constraint, acceptance, or authorization changes through `plan`. A change in code technique alone is not a goal change unless it alters one of those contract fields.

## Apply exact approvals

Use two distinct stages because proposal review and authorization are not interchangeable:

1. Generate and display the current proposal. For version 1, display `APPROVE GOAL {goal_id} VERSION 1 {first-12-goal-digest}` from `init`. For later versions, run `propose`, explain every field-level `before`/`after` impact, affected task and criterion, risk, validation, and rollback, then display `APPROVE {cr_id} GOAL VERSION {candidate-version} {first-12-proposal-digest}` from `approval_required`.
2. Run `lock` or `approve` only after the user returns the displayed phrase byte-for-byte and case-sensitive. Treat “yes,” “approved,” “确认,” and every other generic confirmation as rejected; never reinterpret generic confirmation as the exact phrase.

Re-run `verify` immediately before applying approval. Reject a stale phrase, wrong CR ID, skipped version, or changed proposal fingerprint and show the newly generated phrase if one exists.

## Plan and record progress

Create `plan` input from the active goal. Bind every task to acceptance criteria, dependencies, repository-relative permitted paths, a verification method, and one `next_task_id`. Revise only implementation decomposition through `plan`; the runtime derives the goal binding and plan revision.

Before starting a task, run `verify`, confirm its dependencies and permitted paths, and append a `task-start` record. Record blockers instead of silently switching tasks. After verification, append current immutable evidence for each owned criterion, then append `task-complete` with those evidence IDs. A summary in chat is not progress evidence.

### Optional `planning-with-files` display

Treat `planning-with-files` as an optional display only; it is not a dependency or authority.

| Display field | Authoritative source |
| --- | --- |
| `goal_id` | `.goal-lock/current.json` |
| `goal_version` | `.goal-lock/lock.json` |
| `goal_digest` | `.goal-lock/lock.json` |

Mirror only those three values for navigation. External task lists cannot replace `current.json`, `lock.json`, `plan.json`, `progress.jsonl`, or evidence records, and conflicts always resolve in favor of verified `.goal-lock/` state.

## Handle integrity failures

On exit code 4, `TAMPERED`, a digest mismatch, missing history, or a broken predecessor chain, stop all goal-governed writes. Do not edit, delete, regenerate, or silently adopt affected `.goal-lock/` bytes.

Offer only evidence-preserving choices: inspect the reported issue read-only; preserve the affected bytes and restore an exact user-selected known-good copy; or, only for a stale `.write-lock.json`, run `recover-lock` with the exact recorded owner token and SHA-256 after verifying no owner is active. Never present cooperative lock recovery as repair for contract or history tampering.

After any authorized recovery, run `verify` and re-read the authoritative state before resuming.

## Audit and gate completion

Before claiming completion:

1. Run `verify` and confirm no change request is open, every task is terminal, and every acceptance criterion has current passing evidence for the active goal digest and plan revision.
2. Perform a final semantic diff audit of the delivered workspace against the objective, scope, non-goals, constraints, authorization boundary, acceptance criteria, plan, and permitted paths. Record a `final-audit` event with the exact Git workspace or explicit non-Git inventory used for fingerprinting.
3. Make no delivery write after that audit. Run `gate` with the same inventory, if any, and claim completion only when the returned state is `COMPLETE` and every checklist item passes.

Treat `gate` as proof of the goal-lock state contract, not independent proof that the implementation is correct. If it returns `BLOCKED`, report the failed checklist entries and continue only through a verified route.

## Report

Keep the handoff concise. Report the active goal ID, version, and digest; instruction classification and any CR state; current or completed task and evidence IDs; validation performed; gate state; and verified blockers. Never replace exact CLI output, approval phrases, or evidence references with an unsupported completion claim.
