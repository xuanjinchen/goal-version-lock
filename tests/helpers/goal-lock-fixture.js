import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function activeGoalReference() {
  return {
    goal_id: 'GL-ALPHA',
    goal_version: 1,
    goal_digest: '87f66f9c59ab5aa925a4844c2883ed5008ef1563a6046be74a28b4ed7c250219',
  };
}

export function schemaV2Plan() {
  return {
    schema_version: 2,
    goal: activeGoalReference(),
    plan_revision: 1,
    next_task_id: 'TASK-0001',
    tasks: [{
      id: 'TASK-0001',
      outcome: 'Scope control is enforced',
      acceptance_criteria: ['AC-001'],
      dependencies: [],
      permitted_paths: ['src/goal-lock/contracts.js'],
      validations: [{
        id: 'VAL-0001',
        kind: 'focused',
        method: { type: 'deterministic-test', target: 'goal-lock-contracts-v2' },
        affected_paths: ['src/goal-lock/contracts.js'],
        criterion_ids: ['AC-001'],
        risk_ids: [],
      }],
      status: 'pending',
    }],
    risks: [],
    deferred: [],
  };
}

export function schemaV2Evidence() {
  return {
    schema_version: 2,
    evidence_id: 'EVID-0001',
    acceptance_criterion_id: 'AC-001',
    validation_ref: {
      ...activeGoalReference(),
      plan_revision: 1,
      validation_id: 'VAL-0001',
    },
    task_id: 'TASK-0001',
    observed_result: 'The schema-v2 contract passed',
    artifact_refs: ['src/goal-lock/contracts.js'],
    workspace_fingerprint: '3'.repeat(64),
    state: 'pass',
    failure_paths: [],
    supersedes: null,
    derivation: null,
    recorded_at: '2026-08-23T01:00:00.000Z',
  };
}

export function createGoalLockFixture(testContext, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'goal-lock-'));
  testContext.after(() => rmSync(root, { force: true, recursive: true }));

  if (options.git !== false) {
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'tester@example.invalid'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Goal Lock Tester'], { cwd: root });
  }

  return {
    root,
    now: () => '2026-08-23T00:00:00.000Z',
    randomToken: () => 'deterministic-token',
    pid: 4242,
    isProcessAlive: () => false,
    transactionFaults: {},
  };
}
