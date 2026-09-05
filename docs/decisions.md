# Decisions

Record requirement interpretations and superseding decisions without rewriting history.

<!-- scaffold-contract:decisions:v1 -->
```json
{
  "schema_version": 1,
  "decisions": [
    {
      "id": "DEC-001",
      "status": "superseded",
      "scope": "Core architecture",
      "decision": "Build goal-version-lock as a standalone Skill with its own goal-bound planning and progress records.",
      "evidence": "Superseded on 2026-09-05 because the confirmed product objective now excludes planning and progress ownership.",
      "supersedes": null
    },
    {
      "id": "DEC-002",
      "status": "superseded",
      "scope": "Version model",
      "decision": "Separate immutable goal_version transitions from mutable, archived plan_revision transitions.",
      "evidence": "Superseded on 2026-09-05 because the replacement architecture has goal versions only and no plan revision state.",
      "supersedes": null
    },
    {
      "id": "DEC-003",
      "status": "superseded",
      "scope": "Change authorization",
      "decision": "Require a two-stage change request and an approval bound to the CR ID, target version, and proposal fingerprint.",
      "evidence": "Superseded on 2026-09-05 by a smaller field-difference proposal whose exact phrase is bound directly to the next version and proposal digest.",
      "supersedes": null
    },
    {
      "id": "DEC-004",
      "status": "superseded",
      "scope": "Deterministic runtime",
      "decision": "Use Node.js 22 standard-library commands for canonical hashing, state transitions, progress validation, workspace fingerprinting, and completion gating.",
      "evidence": "Superseded on 2026-09-05 because only canonical hashing, goal transitions, and integrity verification remain runtime responsibilities.",
      "supersedes": null
    },
    {
      "id": "DEC-005",
      "status": "superseded",
      "scope": "Runtime ownership and recovery",
      "decision": "Own only .goal-lock state and use preflight, cooperative locks, staged writes, same-filesystem atomic rename, a durable transaction journal, read-back verification, rollback, and conservative recovery.",
      "evidence": "Superseded on 2026-09-05 because the replacement uses immutable exclusive history creation, atomic single-file replacement, read-back verification, and one exact interrupted-approval retry rule without a transaction subsystem.",
      "supersedes": null
    },
    {
      "id": "DEC-006",
      "status": "superseded",
      "scope": "Planning-with-files relationship",
      "decision": "Document planning-with-files as optional and non-authoritative; do not depend on it, install its hooks, or edit its files in the initial release.",
      "evidence": "Superseded on 2026-09-05 because planning is now entirely outside the product rather than an optional interoperation surface.",
      "supersedes": null
    },
    {
      "id": "DEC-007",
      "status": "superseded",
      "scope": "Enhancement tracks",
      "decision": "Enable references and deterministic scripts; disable assets, global implicit-trigger rules, formal multi-Agent adapters, managed installers, and public release automation.",
      "evidence": "Superseded on 2026-09-05 because the reduced contract no longer needs a separate reference track; deterministic scripts remain enabled.",
      "supersedes": null
    },
    {
      "id": "DEC-008",
      "status": "active",
      "scope": "Language and compatibility claims",
      "decision": "Use English as the primary Skill execution language and make no formal Agent or operating-system compatibility claim until supported by real execution evidence.",
      "evidence": "The latest objective does not change the portability or evidence boundary, and unverified compatibility claims remain prohibited.",
      "supersedes": null
    },
    {
      "id": "DEC-009",
      "status": "superseded",
      "scope": "Schema-v2 scope control",
      "decision": "Use one schema-v2 authorization graph, a version-1 scope baseline, inert validation targets, and exact ValidationRef-bound evidence; reject unplanned paths, validations, regressions, and completion activity.",
      "evidence": "Superseded on 2026-09-05 because path, validation, evidence, regression, and completion governance are outside the sole confirmed-stage-goal responsibility.",
      "supersedes": null
    },
    {
      "id": "DEC-010",
      "status": "active",
      "scope": "Confirmed stage goal state machine",
      "decision": "Use one standalone versioned stage-goal state machine: only an exact approved goal version grants execution authority; aligned work continues, clear changes require a field-level next-version proposal and exact phrase approval, ambiguity returns clarification-required, and tampered or broken goal history fails closed. Persist only current.json, immutable history/vNNNN.json records, and non-authoritative proposal.json; expose only init, propose, approve, verify, and status.",
      "evidence": "The user selected and confirmed 方案 A on 2026-09-05, then approved the architecture, state, transition, failure, compatibility, and focused-verification design with the explicit instruction that the project have only one objective: prevent deviation from the confirmed stage goal.",
      "supersedes": "DEC-009"
    }
  ]
}
```
