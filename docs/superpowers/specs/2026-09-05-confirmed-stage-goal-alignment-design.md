# Confirmed Stage Goal Alignment Design

**Date:** 2026-09-05
**Status:** Approved on 2026-09-06
**Requirements:** version 3
**Audience:** implementers and reviewers of `goal-version-lock`

This design replaces the 2026-08-23 goal-lock design and the 2026-08-25
schema-v2 scope-control design for all future implementation work. Those files
remain historical records only.

The Skill Brief remains `draft` until implementation and delivery evidence are
complete; that delivery status is separate from approval of this design.

## Single product objective

`goal-version-lock` has exactly one responsibility:

> Keep the current development task aligned with the explicitly confirmed
> stage goal.

The Skill does not decide how to plan the work, record progress, select tests,
prove completion, or manage delivery evidence. Those concerns may be handled
by the Agent or another workflow, but they cannot become authority inside this
Skill.

## Problem

Long-running development tasks receive follow-up instructions, implementation
discoveries, and context changes. Without a durable confirmed goal, an Agent
can silently treat a new request as an extension or replacement and continue
work against a different outcome.

The existing implementation attempts to prevent that problem by governing
planning, progress, paths, validations, evidence, recovery, and completion.
Those mechanisms create several parallel authorities and make the product much
larger than the goal-alignment problem. The replacement design removes those
responsibilities and keeps only a versioned confirmed-stage-goal state machine.

## Goals

- Give execution authority only to an explicitly approved stage goal.
- Keep a canonical, digest-bound history of every approved goal version.
- Continue immediately when a requested task is aligned with the active goal.
- Stop before execution when a request clearly changes a goal field.
- Require a field-level proposal and exact approval phrase before a changed
  goal becomes active.
- Return `clarification-required` without changing state when alignment cannot
  be determined safely.
- Fail closed when current state is modified or the version chain is broken.

## Non-goals

- Planning tasks, phases, dependencies, or implementation paths.
- Recording work progress, status events, notes, or resumable task context.
- Authorizing files, commands, validations, tests, evaluations, or regressions.
- Collecting evidence, auditing deliverables, or deciding that work is
  complete.
- Monitoring the host, sandboxing an Agent, or intercepting filesystem writes.
- Integrating with or depending on `planning-with-files`.
- Migrating or maintaining compatibility with the existing protocol-v2 state.
- Publishing, releasing, installing global hooks, or mutating remote systems.

## Chosen architecture

The product is split into four narrow runtime boundaries and one Skill-level
semantic boundary.

| Boundary | Responsibility |
| --- | --- |
| Goal contract | Validate the four user-controlled fields, derive version metadata, canonicalize JSON, compute SHA-256 digests, and produce field-level differences. It performs no I/O. |
| Goal store | Read and verify `.goal-lock/`, enforce immutable history, and perform same-directory atomic single-file replacement. It does not judge task meaning. |
| State machine | Implement `init`, `propose`, and `approve` transitions after store verification. It owns no planning or completion state. |
| CLI | Parse the five public commands and emit stable machine-readable outcomes. It contains no business rules beyond argument handling. |
| `SKILL.md` | Compare the requested work with the verified active contract and return `aligned`, `goal-change-required`, or `clarification-required`. It cannot rewrite the goal directly. |

No authorization graph, plan repository, evidence repository, completion gate,
workspace manifest, audit subsystem, or transaction journal remains in the
target architecture.

## Goal contract

Every accepted goal version has exactly these fields:

```json
{
  "objective": "Deliver the observable outcome for this stage.",
  "success_criteria": ["The stage outcome can be observed."],
  "constraints": ["Preserve the stated boundary."],
  "non_goals": ["Do not add unrelated capabilities."],
  "version": 1,
  "digest": "64 lowercase hexadecimal characters",
  "predecessor": null
}
```

For version 2 and later, `predecessor` is:

```json
{
  "version": 1,
  "digest": "the exact predecessor digest"
}
```

The four user-controlled fields are `objective`, `success_criteria`,
`constraints`, and `non_goals`. `version`, `predecessor`, and `digest` are
derived and cannot be supplied as user authority.

Contract rules:

- `objective` is a non-empty trimmed string.
- Each list contains unique, non-empty trimmed strings and preserves the
  confirmed order.
- Unknown keys are rejected.
- Version numbers are positive consecutive integers.
- Version 1 has a null predecessor; every later version points to the exact
  immediately preceding version and digest.
- `digest` is SHA-256 over canonical UTF-8 JSON containing all fields except
  `digest`, including derived `version` and `predecessor`.
- Canonical JSON recursively sorts object keys, preserves array order, uses no
  insignificant whitespace, and ends with one newline when stored.

## Persisted state

The authoritative state contains only:

```text
.goal-lock/
  current.json
  history/
    v0001.json
    v0002.json
  proposal.json
```

`current.json` is byte-identical to the newest accepted history record.
History records are immutable and created exclusively; an existing history
path is never overwritten. The filename is the version number padded to at
least four digits.

`proposal.json` is non-authoritative. It records:

```json
{
  "base": null,
  "candidate": {},
  "changes": [],
  "proposal_digest": "64 lowercase hexadecimal characters",
  "approval_phrase": "APPROVE GOAL VERSION 1 followed by the exact proposal digest"
}
```

For a change proposal, `base` contains the active version and digest.
`candidate` is a complete goal contract for the next version. `changes`
contains exactly one entry for each changed user-controlled field:

```json
{
  "field": "constraints",
  "before": ["old value"],
  "after": ["new value"]
}
```

Derived fields do not appear in `changes`. `proposal_digest` is SHA-256 over
the canonical proposal without `proposal_digest` and `approval_phrase`. The
approval phrase is derived from the candidate version and proposal digest.

Replacing a pending proposal is allowed because a proposal has no execution
authority. Replacement uses the same temporary-file, flush, atomic-rename, and
read-back path as every mutable state replacement and invalidates the old
approval phrase. Accepted history and `current.json` are never changed by
`init` or `propose`.

## Derived state machine

The runtime derives, rather than separately persists, these states:

| State | Meaning | Execution authority |
| --- | --- | --- |
| `uninitialized` | No accepted history exists. | None. |
| `initial-proposed` | A valid version-1 proposal exists. | None. |
| `active` | `current.json` equals a complete valid history chain and no change proposal is pending. | The current goal only. |
| `change-proposed` | A valid next-version proposal is based on the current goal. | The current goal remains authoritative. |
| `transition-incomplete` | An exact approval write was interrupted after creating accepted bytes. | None until the same approval is safely resumed. |
| `integrity-failure` | Current bytes, history, proposal bindings, or predecessor links are invalid. | None. |

The state machine does not contain task, plan, progress, validation, evidence,
or completion states.

## Public CLI

The CLI exposes exactly five commands:

### `init`

Accept the four user-controlled fields, validate them, derive a version-1
candidate, write `proposal.json`, and return `initial-proposed` with the exact
approval phrase. It refuses to initialize over accepted state or legacy
protocol-v2 state.

### `propose`

Verify the complete active chain, accept a complete replacement for the four
user-controlled fields, derive version `current.version + 1`, and compute the
field-level differences. If no user-controlled field changed, return
`no-change` and do not create a new version. Otherwise atomically replace
`proposal.json` and return `change-proposed` with the exact approval phrase.

### `approve`

Verify the proposal, recompute its candidate, changes, proposal digest, and
approval phrase, then compare the supplied phrase byte-for-byte. A match
creates the immutable history record exclusively, atomically replaces
`current.json`, and removes `proposal.json`. A mismatch changes nothing.

If interruption leaves the exact proposed history record and/or current record
already installed, retrying the same approval may only finish that same
transition and remove the proposal. Any different partial state fails closed.
This is the only recovery rule; there is no transaction journal or general
repair command.

### `verify`

Read only. Validate canonical bytes, exact keys, every digest, consecutive
versions, predecessor links, current-to-history byte identity, and any proposal
binding. Return the derived state and active goal reference. It never judges
whether a natural-language task is aligned.

### `status`

Read only. Return a concise snapshot: derived state, active version and digest,
and pending proposal version, digest, approval phrase, and field differences
when present. It does not report plans, progress, evidence, tests, or
completion.

All commands emit structured JSON and a nonzero exit code for rejected input,
unsupported legacy state, incomplete transitions, or integrity failure.

## Task-alignment workflow

Before an Agent executes a new work slice under this Skill:

1. Run deterministic state verification.
2. If no approved active goal exists, stop and initialize a proposal.
3. Compare the intended work against all four user-controlled fields of the
   active goal.
4. Return `aligned` only when the work can be completed without changing any
   goal field; continue the task under the active version and digest.
5. Return `goal-change-required` when one or more fields clearly need to
   change; do not execute the changed work. Materialize a complete candidate
   and show the field-level proposal.
6. Return `clarification-required` when the request can reasonably be read as
   either aligned or goal-changing; ask one focused question and do not write a
   proposal until the ambiguity is resolved.
7. After exact proposal approval, verify the new active version before
   executing work that depends on it.

A new user message is always authoritative as a request to evaluate. It is not
authoritative as a changed execution goal until the exact generated proposal
is approved.

## Semantic decision rules

An implementation detail is aligned when it changes how the confirmed outcome
is produced without changing the objective, success criteria, constraints, or
non-goals. A request is goal-changing when it adds, removes, weakens,
strengthens, or replaces any of those fields.

The Skill must not use keyword matching as the decision rule. It must explain
which field would change and why. If it cannot identify a defensible field
change or prove that no field changes, it returns `clarification-required`.

## Integrity and write model

Every mutating command verifies its accepted input state before writing. Files
are written to a unique temporary file in the destination directory, flushed,
renamed into place, and read back. Immutable history uses exclusive creation,
which also prevents two approvals from silently accepting different bytes for
the same version.

No multi-file transaction protocol is introduced. The order and retry rule are
chosen so an interruption is detectable and cannot grant execution authority:

1. Create the next immutable history file exclusively.
2. Atomically replace `current.json` with those exact bytes.
3. Remove the matching proposal.

Until all three facts agree, ordinary verification does not return `active`.
Only `approve` with the same exact phrase may finish the interrupted
transition.

## Failure behavior

| Condition | Result |
| --- | --- |
| No confirmed goal | `uninitialized` or `initial-proposed`; execution stops. |
| Request matches current goal | `aligned`; execution may continue. |
| Request clearly changes a goal field | `goal-change-required`; changed work stops until proposal approval. |
| Request meaning is ambiguous | `clarification-required`; no state change. |
| Approval phrase differs by any byte | Approval rejected; no accepted state change. |
| Current file differs from latest history | `integrity-failure`; all ordinary execution and mutations stop. |
| Missing, duplicate, nonconsecutive, or digest-invalid history | `integrity-failure`; no normalization or silent repair. |
| Proposal base is not the active goal | Proposal rejected as stale; it grants no authority. |
| Existing protocol-v2 workspace is detected | `unsupported-state`; no migration or compatibility fallback. |

## Compatibility

The replacement is a clean pre-release protocol. It does not read, migrate, or
preserve old `lock.json`, plan, progress, change-request, evidence, scope,
audit, or transaction state. Development fixtures and documentation will be
rewritten for the new contract. External users with old state must archive or
remove it explicitly outside this product before initializing the new protocol.
The CLI provides no archive, removal, or migration command, and the runtime
never guesses how old fields map to the four-field stage goal.

## Focused verification strategy

Implementation uses only evidence that distinguishes the single objective.

### Deterministic unit tests

- Initial proposal and exact version-1 approval.
- Canonical digest and byte-identical current/history records.
- Consecutive predecessor-chain verification.
- Field-level change proposal and exact phrase binding.
- No-change proposal behavior.
- Approval interruption retry for the same candidate only.
- Fail-closed current tamper, history tamper, missing version, broken
  predecessor, stale proposal, and legacy-state rejection.

### Skill behavior scenarios

Exactly four primary scenarios are required before delivery:

1. An aligned implementation request continues under the active version.
2. An unapproved goal-changing request stops and identifies the changed fields.
3. An approved proposal creates the next version before changed work continues.
4. A semantically ambiguous request returns `clarification-required` without a
   state mutation.

During implementation, run only tests affected by the current slice. After
stable inputs are reached, run the repository `check` once and the delivery
gate once. Do not add broad sweeps, optional hardening, repeated full matrices,
unrelated regression runs, or cleanup tasks.

## Acceptance criteria

1. Only an explicitly confirmed stage-goal version can authorize execution.
2. Aligned work continues, while clear goal changes and ambiguous requests
   cannot be executed silently.
3. A goal change creates a new version only after review of a complete
   field-level difference and byte-exact approval of the generated phrase.
4. Current-state tampering or a broken immutable history chain fails closed.
5. The Skill works independently and contains no planning, progress, test
   governance, evidence, audit, or completion authority.

## Implementation impact

The implementation plan must replace, rather than wrap, the old architecture.
It should retain only reusable canonical JSON, SHA-256, validation, and atomic
single-file write primitives whose behavior matches this specification.
Compatibility adapters, deprecated command aliases, parallel schemas, and
unused recovery abstractions must not remain merely to reduce the apparent
size of the refactor.

The new plan will identify the exact files to remove or rewrite, use focused
TDD for deterministic behavior, and preserve unrelated dirty working-tree
files until their ownership is resolved by that plan.
