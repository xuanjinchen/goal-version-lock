# Skill Brief

Skill: goal-version-lock

Objective: Keep each development work slice aligned with the explicitly confirmed stage goal.

Initialized: 2026-08-23

License: Apache-2.0

Requirements version: 3

<!-- scaffold-contract:skill-brief:v1 -->
```json
{
  "schema_version": 1,
  "status": "draft",
  "conflicts": [
    {
      "id": "CONFLICT-001",
      "summary": "Requirements version 2 made planning, progress, authorization graphs, workspace scope, evidence, audits, recovery transactions, and completion gates part of the product, while the latest confirmed objective permits only stage-goal alignment.",
      "status": "resolved",
      "resolution": "Requirements version 3 supersedes the protocol-v2 product scope. Future implementation keeps only the confirmed-stage-goal version state machine and does not continue the old Task 10 evaluation matrix."
    }
  ],
  "acceptance_criteria": [
    {
      "id": "REQ-001",
      "requirement": "Only an explicitly confirmed stage-goal version can authorize development execution.",
      "verification": "Focused state-machine tests must prove that an uninitialized or merely proposed goal has no execution authority and that exact approval activates one version.",
      "status": "pending"
    },
    {
      "id": "REQ-002",
      "requirement": "Aligned work may continue, but a clear goal change or semantically ambiguous request cannot be executed silently.",
      "verification": "Behavior scenarios must cover aligned continuation, unapproved drift rejection, and clarification-required without state mutation.",
      "status": "pending"
    },
    {
      "id": "REQ-003",
      "requirement": "A changed goal can become active only after review of complete field-level differences and byte-exact approval of the generated next-version proposal.",
      "verification": "Focused transition tests and the approved-change behavior scenario must bind the phrase to the proposal digest and reject stale or mismatched approval.",
      "status": "pending"
    },
    {
      "id": "REQ-004",
      "requirement": "Modification of current goal bytes or any missing, invalid, or broken history link must fail closed.",
      "verification": "Focused integrity tests must cover current tamper, history tamper, missing versions, invalid digests, broken predecessors, and unsupported legacy state.",
      "status": "pending"
    },
    {
      "id": "REQ-005",
      "requirement": "The Skill must work independently and must not own planning, progress, validation or regression governance, evidence, audits, or completion decisions.",
      "verification": "Architecture and public-surface review must show only init, propose, approve, verify, and status commands and no authoritative state outside the goal, history, and proposal records.",
      "status": "pending"
    }
  ],
  "tracks": {
    "references": {
      "status": "disabled",
      "evidence": "The replacement contract and workflow are narrow enough to remain in SKILL.md and public documentation without a separate runtime reference authority.",
      "unblock_condition": ""
    },
    "scripts": {
      "status": "enabled",
      "evidence": "artifact:src/goal-lock/state-machine.js#sha256:0e3ea568f7b556e6c474e8e1daa2b63998cd713a0d4bbbc0f8f6bdce1c95c262",
      "unblock_condition": ""
    },
    "assets": {
      "status": "disabled",
      "evidence": "The Skill produces structured text and JSON state and requires no reusable media or document assets.",
      "unblock_condition": ""
    },
    "implicit-trigger": {
      "status": "disabled",
      "evidence": "Standard Skill description discovery is sufficient; no global rule, hook, or host-level activation mechanism is part of the confirmed objective.",
      "unblock_condition": ""
    },
    "multi-agent": {
      "status": "disabled",
      "evidence": "The product is a portable standard Skill contract and does not claim formally verified adapters for named Agent platforms.",
      "unblock_condition": ""
    },
    "installer": {
      "status": "disabled",
      "evidence": "A standard Skill directory and local project runtime satisfy the objective without mutating user-level Agent configuration.",
      "unblock_condition": ""
    },
    "open-source-release": {
      "status": "disabled",
      "evidence": "Local repository development is authorized, but public publishing, tags, releases, remote changes, and registry uploads are not requested.",
      "unblock_condition": ""
    }
  },
  "prompt_budget": {
    "limit_tokens": 882,
    "measured_tokens": 626,
    "evidence": "artifact:evals/results/prompt-budget.txt#sha256:986da96e50beaa5ca4e45834d080331fd674f731fb6599878484cc95573d7d70"
  }
}
```

## Target Users and Environment

The target user delegates multi-step development work to an Agent and needs each new work slice checked against one durable, explicitly approved stage goal. The deterministic runtime uses Node.js 22 or newer and writes only local `.goal-lock/` state.

## Trigger Boundaries

Use the Skill when a development stage goal must be confirmed, preserved across follow-up requests, compared with new work, or changed through explicit version approval. Do not invoke it for ordinary planning, progress reporting, test selection, completion review, personal goal tracking, infrastructure configuration drift, or read-only questions that do not establish or use a development stage goal.

## Core Workflow

Create an initial proposal, obtain exact version approval, verify the canonical current/history chain before each work slice, and compare the intended work with the active `objective`, `success_criteria`, `constraints`, and `non_goals`. Continue only when aligned. A clear field change becomes a next-version proposal and remains non-authoritative until its generated phrase is approved exactly. An unclear request returns `clarification-required` without changing state.

## State and Public Surface

Authoritative files are `.goal-lock/current.json` and immutable `.goal-lock/history/vNNNN.json`; `.goal-lock/proposal.json` is non-authoritative. The CLI exposes exactly `init`, `propose`, `approve`, `verify`, and `status`. Accepted goal records contain only `objective`, `success_criteria`, `constraints`, `non_goals`, `version`, `digest`, and `predecessor`.

## Non-Goals and Authorization

The Skill does not plan or record progress, authorize paths or validations, govern tests or regressions, collect evidence, run final audits, decide completion, migrate protocol-v2 state, install global hooks, publish releases, use credentials, or mutate remote systems. It evaluates new user instructions as requests, but only an approved goal version grants execution authority.

## Path Mapping

| Identifier | Repository path |
| --- | --- |
| `SKILL_FILE` | `SKILL.md` |
| `README_FILE` | `README.md` |
| `BRIEF_FILE` | `docs/skill-brief.md` |
| `DECISIONS_FILE` | `docs/decisions.md` |
| `DELIVERY_FILE` | `docs/delivery-report.md` |
| `EVALS_FILE` | `evals/evals.json` |
| `TEST_ROOT` | `tests/` |
| `SOURCE_ROOT` | `src/goal-lock/` and `scripts/goal-lock.js` |
| `RESOURCES_ROOT` | Disabled for requirements version 3 |
| `EVAL_WORKSPACE` | A fresh isolated workspace only when the four approved behavior scenarios are executed |

## Verification Boundary

Development runs only focused tests affected by the current implementation slice. After stable inputs are reached, run the repository `check` once and the delivery gate once. Do not continue the superseded EVAL-006–013 matrix, add broad sweeps, or repeat unchanged regressions.

## Unresolved Conflicts

None. `CONFLICT-001` records the resolved replacement of protocol v2 by the single confirmed-stage-goal responsibility.
