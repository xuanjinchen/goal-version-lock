# Skill Brief

Skill: goal-version-lock

Objective: Keep development work aligned to an approved versioned goal contract by gating goal changes, planning, progress evidence, and completion.

Initialized: 2026-08-23

License: Apache-2.0

Requirements version: 2

<!-- scaffold-contract:skill-brief:v1 -->
```json
{
  "schema_version": 2,
  "status": "draft",
  "conflicts": [],
  "acceptance_criteria": [
    {
      "id": "REQ-001",
      "requirement": "Create a canonical versioned goal contract that records the objective, scope, non-goals, constraints, authorization boundary, and measurable acceptance criteria, and lock version 1 only after explicit user approval.",
      "verification": "Deterministic schema-v2 evidence is pending. Prior EVAL-001/EVAL-007 behavioral bytes are historical and not current; they cannot satisfy delivery.",
      "status": "pending"
    },
    {
      "id": "REQ-002",
      "requirement": "Detect direct modification, missing history, digest mismatch, or broken predecessor chains and fail closed without silently adopting the changed goal.",
      "verification": "Deterministic schema-v2 tamper evidence is pending. Prior EVAL-008 behavioral evidence is historical and not current; it cannot satisfy delivery.",
      "status": "pending"
    },
    {
      "id": "REQ-003",
      "requirement": "Classify new requests as aligned, implementation-only, clarification, goal change, constraint change, ambiguous, or conflicting, and keep implementation-only changes within a plan revision.",
      "verification": "Prior positive, negative, boundary, and conflict evaluations are historical and not current. A schema-v2 paired matrix is required before this requirement can pass.",
      "status": "pending"
    },
    {
      "id": "REQ-004",
      "requirement": "Require a two-stage change request with field-level impact and an approval bound to the CR ID, target version, and proposal fingerprint before creating a new goal version.",
      "verification": "Schema-v2 CLI evidence is pending. All prior behavioral artifacts are historical and not current; they cannot satisfy delivery.",
      "status": "pending"
    },
    {
      "id": "REQ-005",
      "requirement": "Provide standalone goal-bound planning and append-only progress recording without requiring planning-with-files or another planning Skill.",
      "verification": "Prior EVAL-001/EVAL-009 and Task 16 fresh-context results are historical and not current. Schema-v2 lifecycle and paired behavioral evidence are pending.",
      "status": "pending"
    },
    {
      "id": "REQ-006",
      "requirement": "Preserve goal versions, plan revisions, change requests, digest-chained progress events, and immutable evidence lineage, and mark affected tasks and evidence stale after an approved goal change.",
      "verification": "Schema-v2 transition evidence is pending. Prior EVAL-007/EVAL-010 behavioral bytes are historical and not current; they cannot satisfy delivery.",
      "status": "pending"
    },
    {
      "id": "REQ-007",
      "requirement": "Block completion unless the active goal and plan verify, no change request is open, all tasks are terminal, every acceptance criterion has current passing evidence, and the final semantic audit matches the workspace fingerprint.",
      "verification": "Schema-v2 completion-gate evidence is pending. Prior EVAL-011/EVAL-012 results are historical and not current; they cannot satisfy delivery.",
      "status": "pending"
    },
    {
      "id": "REQ-008",
      "requirement": "Use deterministic, dependency-free Node.js 22 commands with preflight validation, cooperative ownership, atomic replacement, read-back verification, rollback, and token-and-digest-bound lock recovery for runtime state changes.",
      "verification": "Deterministic runtime evidence must be revalidated under schema v2. Prior EVAL-008 behavioral evidence is historical and not current; it cannot satisfy delivery.",
      "status": "pending"
    },
    {
      "id": "REQ-009",
      "requirement": "Remain independent of planning-with-files while documenting a non-authoritative optional interoperation contract based on goal ID, version, and digest.",
      "verification": "Prior EVAL-001/EVAL-009 and Task 16 fresh-context results are historical and not current. Schema-v2 dependency, documentation, and paired behavioral evidence are pending.",
      "status": "pending"
    },
    {
      "id": "REQ-010",
      "requirement": "Provide discriminating Skill discovery and behavior covering direct and implicit drift-prevention requests while avoiding ordinary planning and unrelated goal-tracking requests.",
      "verification": "All prior discovery and behavior evaluations are historical and not current. The final schema-v2 paired matrix must include current raw artifacts before this requirement can pass.",
      "status": "pending"
    },
    {
      "id": "REQ-011",
      "requirement": "Every task, changed path, validation, test, evaluation, regression, and accepted evidence must trace to an acceptance criterion, a declared risk, an explicit governed plan revision, or a mandatory delivery gate; untraceable activity is denied.",
      "verification": "Schema-v2 authorization, workspace-delta, evidence-replay, completion-gate, and EVAL-013 evidence must all pass before delivery.",
      "status": "pending"
    }
  ],
  "tracks": {
    "references": {
      "status": "enabled",
      "evidence": "Enabled because the runtime schemas and conditional recovery rules are substantial and should be loaded only when creating, validating, or repairing goal-lock state.",
      "unblock_condition": ""
    },
    "scripts": {
      "status": "enabled",
      "evidence": "Enabled because canonical hashing, version transitions, append-only validation, atomic writes, and completion gates require deterministic behavior across repeated cases.",
      "unblock_condition": ""
    },
    "assets": {
      "status": "disabled",
      "evidence": "The accepted workflow produces structured text and JSON and requires no reusable binary or presentation asset.",
      "unblock_condition": ""
    },
    "implicit-trigger": {
      "status": "disabled",
      "evidence": "Standard Skill description discovery is the approved activation mechanism; no global rule or host hook was requested.",
      "unblock_condition": ""
    },
    "multi-agent": {
      "status": "disabled",
      "evidence": "The approved target is a portable standard Skill contract, not formally verified adapters for multiple named Agent platforms.",
      "unblock_condition": ""
    },
    "installer": {
      "status": "disabled",
      "evidence": "The Skill is delivered through a standard Skill directory and does not need to modify user-level Agent configuration.",
      "unblock_condition": ""
    },
    "open-source-release": {
      "status": "disabled",
      "evidence": "Repository development is authorized, but public publishing, tags, releases, remote changes, and registry uploads were not requested.",
      "unblock_condition": ""
    }
  },
  "prompt_budget": {
    "limit_tokens": null,
    "measured_tokens": null,
    "evidence": ""
  }
}
```

## Target Users and Environment

The target user delegates multi-step development work to an Agent and needs the approved outcome to survive context loss, plan revisions, interruptions, and later requests. The core runtime requires Node.js 22 or newer. Git is preferred for workspace fingerprinting; a non-Git workspace must provide an explicit artifact inventory.

## Trigger Boundaries

Use the Skill when the user asks to lock, freeze with controlled version changes, preserve, or prevent drift in a development goal, or when an existing goal-lock workspace governs the current task. Do not invoke it for ordinary short planning, personal OKR tracking, infrastructure configuration drift, or read-only questions that do not establish or use a development goal contract.

## Core Workflow

Create a draft, obtain explicit version-1 approval, verify before each work slice, plan and record progress against the active digest, route semantic changes through a two-stage CR, invalidate affected evidence after approval, and run a goal-aware completion gate before claiming success.

## Non-Goals and Authorization

The Skill does not authenticate real-world identity, run autonomous loops, install host hooks, replace specialist development workflows, publish releases, change Git remotes, use credentials, or perform paid operations. All filesystem writes are confined to the target project and the development artifacts already authorized by the active plan.

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
| `RESOURCES_ROOT` | `references/` |
| `EVAL_WORKSPACE` | sibling directory `goal-version-lock-evals/` outside this repository |

## Unresolved Conflicts

None. The design explicitly distinguishes plan revisions from approved goal-version changes and defines `planning-with-files` as optional and non-authoritative.
