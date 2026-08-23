# Decisions

Record requirement interpretations and superseding decisions without rewriting history.

<!-- scaffold-contract:decisions:v1 -->
```json
{
  "schema_version": 1,
  "decisions": [
    {
      "id": "DEC-001",
      "status": "active",
      "scope": "Core architecture",
      "decision": "Build goal-version-lock as a standalone Skill with its own goal-bound planning and progress records.",
      "evidence": "The user explicitly approved complete independence from planning-with-files on 2026-08-23.",
      "supersedes": null
    },
    {
      "id": "DEC-002",
      "status": "active",
      "scope": "Version model",
      "decision": "Separate immutable goal_version transitions from mutable, archived plan_revision transitions.",
      "evidence": "The approved design permits implementation-path changes without silently changing observable intent.",
      "supersedes": null
    },
    {
      "id": "DEC-003",
      "status": "active",
      "scope": "Change authorization",
      "decision": "Require a two-stage change request and an approval bound to the CR ID, target version, and proposal fingerprint.",
      "evidence": "The user approved strict versioned locking and the explicit two-stage approval state machine on 2026-08-23.",
      "supersedes": null
    },
    {
      "id": "DEC-004",
      "status": "active",
      "scope": "Deterministic runtime",
      "decision": "Use Node.js 22 standard-library commands for canonical hashing, state transitions, progress validation, workspace fingerprinting, and completion gating.",
      "evidence": "The initialized scaffold already requires Node.js 22, and the accepted integrity guarantees require repeatable mechanical checks.",
      "supersedes": null
    },
    {
      "id": "DEC-005",
      "status": "active",
      "scope": "Runtime ownership and recovery",
      "decision": "Own only .goal-lock state and use preflight, cooperative locks, staged writes, atomic replacement, read-back verification, rollback, and conservative recovery.",
      "evidence": "The approved design requires fail-closed behavior under tampering, crashes, and concurrent access without overwriting unrelated project state.",
      "supersedes": null
    },
    {
      "id": "DEC-006",
      "status": "active",
      "scope": "Planning-with-files relationship",
      "decision": "Document planning-with-files as optional and non-authoritative; do not depend on it, install its hooks, or edit its files in the initial release.",
      "evidence": "Research found useful persistence and attestation ideas but no complete semantic version-lock protocol, and the user requested a new independent Skill.",
      "supersedes": null
    },
    {
      "id": "DEC-007",
      "status": "active",
      "scope": "Enhancement tracks",
      "decision": "Enable references and deterministic scripts; disable assets, global implicit-trigger rules, formal multi-Agent adapters, managed installers, and public release automation.",
      "evidence": "Schemas and deterministic transitions are necessary for the accepted behavior; the remaining tracks are not required or authorized.",
      "supersedes": null
    },
    {
      "id": "DEC-008",
      "status": "active",
      "scope": "Language and compatibility claims",
      "decision": "Use English as the primary Skill execution language and make no formal Agent or operating-system compatibility claim until supported by real execution evidence.",
      "evidence": "English maximizes standard Skill ecosystem portability, while the scaffold forbids unverified compatibility claims.",
      "supersedes": null
    }
  ]
}
```
