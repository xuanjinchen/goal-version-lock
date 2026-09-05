# Delivery Report

Complete this report only with evidence produced by the implemented Skill and its evaluations.

<!-- scaffold-contract:delivery-report:v1 -->
```json
{
  "schema_version": 1,
  "requirements": [
    {
      "id": "REQ-001",
      "implementation": "path:src/goal-lock/state-machine.js",
      "verification": "eval:EVAL-001,EVAL-003",
      "status": "pass"
    },
    {
      "id": "REQ-002",
      "implementation": "path:SKILL.md",
      "verification": "eval:EVAL-001,EVAL-002,EVAL-004",
      "status": "pass"
    },
    {
      "id": "REQ-003",
      "implementation": "path:src/goal-lock/contract.js",
      "verification": "eval:EVAL-002,EVAL-003",
      "status": "pass"
    },
    {
      "id": "REQ-004",
      "implementation": "path:src/goal-lock/store.js",
      "verification": "eval:EVAL-003",
      "status": "pass"
    },
    {
      "id": "REQ-005",
      "implementation": "path:SKILL.md",
      "verification": "eval:EVAL-001,EVAL-002,EVAL-003,EVAL-004",
      "status": "pass"
    }
  ],
  "capability_claims": []
}
```
