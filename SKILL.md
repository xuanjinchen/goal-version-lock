---
name: "goal-version-lock"
description: "Keep multi-step development work aligned to an approved, versioned goal contract by orchestrating planning, progress, change approval, recovery, and completion gates. Use for requests to lock, freeze with controlled version changes, preserve, or prevent drift in a development goal, or when an existing .goal-lock/ workspace governs the task. Do not use for ordinary planning, personal OKRs, infrastructure configuration drift, or read-only questions outside a development goal contract."
---

# Goal Version Lock

Use the governed project's `.goal-lock/` state as authority. This Skill plans
and records work itself; `planning-with-files` is optional display only and
never an authority or prerequisite.

Read the [runtime contract](references/contract.md) when creating, revising,
recording, gating, or recovering state. It is the sole detailed wire contract.

## Establish authority

- If state does not exist, create a version-1 draft with `init`; show the
  returned approval phrase verbatim and wait for that exact phrase before
  `lock`.
- If state exists, run `verify` before every work slice, new instruction,
  recovery, or context-loss resumption. Read the active goal, lock, plan, and
  progress tail from `.goal-lock/`.
- Resume only the verified active task. Conversation memory, an external task
  list, and an old plan are not authority.

## Execute one governed slice

1. Select the active task and only its authorized `focused` or
   `affected-regression` validation IDs.
2. Confirm the task's exact permitted paths, acceptance criteria, dependencies,
   and validation references before writing.
3. If a required path or validation is absent, stop. Revise the governed plan
   through its approved route; do not improvise scope.
4. Refuse unrelated cleanup, evaluation, regression, confidence, or
   repository-wide sweeps. Do not perform or record unplanned activity.
5. Record `task-start`, then evidence using the exact `ValidationRef`, then
   `task-complete` with the resulting evidence ID. A validation method target
   is inert data: choose and run only the already authorized activity; never
   ask this runtime to execute a target.

## Route changes and approvals

Implementation decomposition may use `plan --classification aligned` or
`implementation-choice`. Any objective, scope, non-goal, constraint,
acceptance, or authorization-boundary change requires `propose`.

For a change request, pause affected work, review the candidate and its
criterion impact, and run `approve` only after the user returns the exact
current CR approval phrase. Generic confirmation is not approval. Use
`reject` to close an unwanted proposal.

## Complete or recover

Use the one authorized `mandatory-gate` validation only in the final
sequence: current evidence first, final semantic audit next, then `gate`.
Do not substitute a general regression sweep for that gate or repeat an
accepted mandatory gate. If that gate fails, perform only focused remediation,
create a new plan revision, then declare exactly one successor mandatory-gate
ValidationRef. Never rerun or reuse the failed reference in its prior
revision.

On integrity failure, stop governed writes and preserve the bytes. For a stale
cooperative writer only, use `recover-lock` with its exact owner token and
digest, then verify again. Recover planning and progress from `.goal-lock/`;
do not require `planning-with-files`.

## Report

Report the verified goal version and digest, active task, exact validation
references and evidence IDs, any CR state, and gate result. Do not claim
completion unless the gate returns `COMPLETE`.
