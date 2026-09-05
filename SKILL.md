---
name: "goal-version-lock"
description: "Keep development work aligned with an explicitly confirmed stage goal. Use when a development stage must be confirmed, verified before each work slice, or changed through a versioned field-level proposal with exact approval. Return clarification-required when alignment is ambiguous and fail closed on tampered goal history. Do not use for planning, progress tracking, test or regression governance, evidence, audits, completion decisions, personal goals, or configuration drift."
---

# Goal Version Lock

Use the local `.goal-lock/` records to keep each development work slice aligned
with one explicitly confirmed stage goal. The active goal is the only authority
that permits work to continue.

## Goal authority

1. Before each new work slice, run `verify` and use its result as the current
   state. Do not rely on conversation history or an unverified file.
2. When no active authority exists, stop and initialize a goal with `init`.
   Review the generated proposal and approve it with the exact generated phrase
   before continuing.
3. Stop on integrity failure, an unsupported state, or a transition-incomplete
   result. Preserve the records until the state can be verified again.

## Semantic alignment

Compare the intended work semantically with all four active goal fields:
`objective`, `success_criteria`, `constraints`, and `non_goals`. Keyword overlap
is not sufficient. Determine whether the request changes what success means,
what is required, or what is explicitly excluded.

Return exactly one of these outcomes:

- `aligned`: no active goal field changes. Include the active version and digest,
  then allow the requested work slice to continue.
- `goal-change-required`: one or more goal fields clearly change. List every
  changed field and materialize a complete next-version proposal. Do not allow
  changed work to continue while the proposal is pending.
- `clarification-required`: the request has both an aligned and a goal-changing
  interpretation. Ask one focused question and write no proposal or accepted
  state.

## Goal changes

For a clear change, present the complete candidate and field-level differences.
Accept only the exact approval phrase generated for the current proposal. After
approval, run `verify`, confirm the next consecutive version and its predecessor
chain, and only then allow the changed work slice to continue. A generic
confirmation never authorizes a change.

## Persisted authority

The authoritative records are:

- `.goal-lock/current.json` for the active goal;
- `.goal-lock/history/vNNNN.json` for immutable version history;
- `.goal-lock/proposal.json` for a pending, non-authoritative proposal.

Each user goal input contains exactly `objective`, `success_criteria`,
`constraints`, and `non_goals`. The runtime binds accepted records to canonical
bytes and a SHA-256 digest. Any tampered current record, history record, digest,
predecessor, or proposal fails closed.

The supported commands are `init`, `propose`, `approve`, `verify`, and `status`.
This Skill routes semantic alignment only; it does not assign responsibility for
other development workflows.
