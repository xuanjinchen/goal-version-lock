# goal\-version\-lock

Objective: Keep development work aligned to an approved versioned goal contract by gating goal changes\, planning\, progress evidence\, and completion\.

Initialized: 2026\-08\-23
License: Apache\-2\.0

## Start Here

Read `docs/skill-brief.md` first. Treat the latest user requirement as authoritative, update conflicts before implementation, and keep optional tracks disabled until evidence justifies them.

Then use `docs/mature-skill-development-design.md` for principles and `docs/mature-skill-development-plan.md` for the task sequence.

## Development

1. Replace draft acceptance criteria with measurable requirements.
2. Write a failing deterministic test before implementation.
3. Fix positive, negative, and boundary behavior evaluations before tuning the Skill.
4. Record enabled, disabled, or blocked tracks with evidence.
5. Review the complete diff and untracked deliverables before completion.

## Evidence

Use only field-specific, repository-relative Evidence Contract v1 references:

- `artifact:path#sha256` means `artifact:<path>#sha256:<64 lowercase hex digest>`.
- `path:` means `path:<path>` for delivery implementation.
- `eval:` means `eval:<evaluation-id>[,<evaluation-id>...]` for delivery verification, such as `eval:EVAL-001,EVAL-002`.

Enabled tracks, prompt budgets, evaluation results, and capability claims use `artifact:` evidence. Disabled tracks record a reason. Blocked tracks use `required:<work>;impact:<delivery-impact>` plus an unblock condition.

The deterministic Gate validates the recorded contract. It does not run an Agent or prove that a model actually produced the claimed result.

## Validation

Run `npm run check` during development. When state, Brief, evaluations, and delivery traces are ready, run `npm run gate:delivery` before declaring the Skill mature.
