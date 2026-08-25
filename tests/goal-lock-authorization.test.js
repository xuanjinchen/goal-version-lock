import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertEvidenceAuthorized,
  buildAuthorizationGraph,
  deriveScopeBlockers,
  resolveValidationRef,
} from '../src/goal-lock/authorization.js';
import { canonicalBytes, sha256 } from '../src/goal-lock/canonical.js';

const HEX = '1'.repeat(64);

function goal() {
  return {
    schema_version: 2,
    goal_id: 'GL-AUTH',
    goal_version: 1,
    objective: 'Keep authorization closed',
    scope: { in: ['Authorization graph'], out: [] },
    non_goals: [],
    constraints: [],
    acceptance_criteria: [{ id: 'AC-001', outcome: 'Authority is traced', verification: 'Focused test passes' }],
    authorization_boundary: ['Only planned paths'],
    assumptions: [],
    predecessor: null,
    accepted_change_id: null,
  };
}

function goalReference() {
  const value = goal();
  return {
    goal_id: value.goal_id,
    goal_version: value.goal_version,
    goal_digest: sha256(canonicalBytes(value)),
  };
}

function validationRef(planRevision, validationId = 'VAL-0001') {
  return { ...goalReference(), plan_revision: planRevision, validation_id: validationId };
}

function plans() {
  const reference = goalReference();
  return [{
    schema_version: 2,
    goal: reference,
    plan_revision: 1,
    next_task_id: 'TASK-0001',
    tasks: [{
      id: 'TASK-0001',
      outcome: 'Create the first bounded change',
      acceptance_criteria: ['AC-001'],
      dependencies: [],
      permitted_paths: ['src/a.js'],
      validations: [{
        id: 'VAL-0001',
        kind: 'focused',
        method: { type: 'deterministic-test', target: 'focused-a' },
        affected_paths: ['src/a.js'],
        criterion_ids: ['AC-001'],
        risk_ids: [],
      }],
      status: 'pending',
    }],
    risks: [],
    deferred: [],
  }, {
    schema_version: 2,
    goal: reference,
    plan_revision: 2,
    next_task_id: 'TASK-0001',
    tasks: [{
      id: 'TASK-0001',
      outcome: 'Tighten the current slice without erasing history',
      acceptance_criteria: ['AC-001'],
      dependencies: [],
      permitted_paths: ['src/b.js'],
      validations: [{
        id: 'VAL-0001',
        kind: 'focused',
        method: { type: 'deterministic-test', target: 'focused-b' },
        affected_paths: ['src/b.js'],
        criterion_ids: ['AC-001'],
        risk_ids: [],
      }, {
        id: 'VAL-0002',
        kind: 'affected-regression',
        method: { type: 'deterministic-test', target: 'remediate-a' },
        affected_paths: ['src/a.js'],
        criterion_ids: [],
        risk_ids: ['RISK-0001'],
      }, {
        id: 'VAL-0003',
        kind: 'mandatory-gate',
        method: { type: 'delivery-gate', target: 'final-full-gate' },
        affected_paths: ['@governed-workspace'],
        criterion_ids: ['AC-001'],
        risk_ids: [],
      }],
      status: 'pending',
    }],
    risks: [{
      id: 'RISK-0001',
      statement: 'The first focused validation failed on src/a.js',
      source: {
        kind: 'failed-validation',
        validation_ref: validationRef(1),
        evidence_id: 'EVID-0001',
      },
      affected_paths: ['src/a.js'],
    }],
    deferred: [],
  }];
}

function evidence(overrides = {}) {
  return {
    schema_version: 2,
    evidence_id: 'EVID-0001',
    acceptance_criterion_id: 'AC-001',
    validation_ref: validationRef(1),
    task_id: 'TASK-0001',
    observed_result: 'The focused validation failed',
    artifact_refs: ['src/a.js'],
    workspace_fingerprint: HEX,
    state: 'fail',
    failure_paths: ['src/a.js'],
    supersedes: null,
    derivation: null,
    recorded_at: '2026-08-25T01:00:00.000Z',
    ...overrides,
  };
}

function history(overrides = {}) {
  return {
    goalHistory: [goal()],
    planRecords: plans(),
    evidenceRecords: [
      evidence(),
      evidence({
        evidence_id: 'EVID-0003',
        validation_ref: validationRef(2, 'VAL-0003'),
        observed_result: 'The final full gate passed',
        state: 'pass',
        failure_paths: [],
        recorded_at: '2026-08-25T03:00:00.000Z',
      }),
    ],
    changeRecords: [],
    ...overrides,
  };
}

function mutableHistory() {
  return structuredClone(history());
}

test('builds one immutable graph from cumulative verified authority', () => {
  const graph = buildAuthorizationGraph(history());
  const { digest, ...withoutDigest } = graph;

  assert.deepEqual(graph.cumulative_permitted_paths, ['src/a.js', 'src/b.js']);
  assert.equal(resolveValidationRef(graph, validationRef(1)).task_id, 'TASK-0001');
  assert.equal(resolveValidationRef(graph, validationRef(1)).method.target, 'focused-a');
  assert.equal(resolveValidationRef(graph, validationRef(2)).method.target, 'focused-b');
  assert.deepEqual(deriveScopeBlockers(graph, ['src/extra.js', 'src/a.js']), [{
    kind: 'unauthorized-delta',
    path: 'src/extra.js',
  }]);
  assert.equal(digest, sha256(canonicalBytes(withoutDigest)));
  assert.deepEqual(JSON.parse(JSON.stringify(graph)), graph);
  assert.throws(() => graph.goals[0].criterion_ids.push('AC-999'), TypeError);
});

test('admits evidence only through its exact bounded validation', () => {
  const graph = buildAuthorizationGraph(history({ evidenceRecords: [evidence()] }));
  const admitted = assertEvidenceAuthorized(graph, evidence({
    evidence_id: 'EVID-0002',
    validation_ref: validationRef(2, 'VAL-0002'),
    observed_result: 'The bounded remediation passed',
    state: 'pass',
    failure_paths: [],
    recorded_at: '2026-08-25T02:00:00.000Z',
  }), { mode: 'write' });

  assert.equal(admitted.evidence_id, 'EVID-0002');
  assert.equal(admitted.validation_ref.plan_revision, 2);
  const replayed = assertEvidenceAuthorized(buildAuthorizationGraph(history()), evidence({
    evidence_id: 'EVID-0003',
    validation_ref: validationRef(2, 'VAL-0003'),
    observed_result: 'The final full gate passed',
    state: 'pass',
    failure_paths: [],
    recorded_at: '2026-08-25T03:00:00.000Z',
  }), { mode: 'replay' });
  assert.equal(replayed.evidence_id, 'EVID-0003');
});

test('fails closed for untraced graph and evidence mutations', () => {
  const cases = [{
    name: 'criterion-less task',
    run() {
      const value = mutableHistory();
      value.planRecords[0].tasks[0].acceptance_criteria = [];
      return () => buildAuthorizationGraph(value);
    },
    want: 'Plan task TASK-0001 must own a goal criterion',
  }, {
    name: 'orphan validation',
    run() {
      const value = mutableHistory();
      value.planRecords[1].tasks[0].validations[0].criterion_ids = ['AC-002'];
      return () => buildAuthorizationGraph(value);
    },
    want: 'Validation VAL-0001 does not reach an owning task criterion',
  }, {
    name: 'orphan risk',
    run() {
      const value = mutableHistory();
      value.planRecords[1].risks.push({
        id: 'RISK-0002',
        statement: 'A declared risk needs a consumer',
        source: { kind: 'criterion', criterion_id: 'AC-001' },
        affected_paths: ['src/b.js'],
      });
      return () => buildAuthorizationGraph(value);
    },
    want: 'Risk RISK-0002 has no consuming validation',
  }, {
    name: 'unknown failed evidence source',
    run() {
      const value = mutableHistory();
      value.planRecords[1].risks[0].source.evidence_id = 'EVID-9999';
      return () => buildAuthorizationGraph(value);
    },
    want: 'Risk RISK-0001 does not resolve verified failing evidence',
  }, {
    name: 'failure-derived affected-path expansion',
    run() {
      const value = mutableHistory();
      value.planRecords[1].risks[0].affected_paths = ['src/b.js'];
      return () => buildAuthorizationGraph(value);
    },
    want: 'Risk RISK-0001 expands beyond verified failure paths',
  }, {
    name: 'cycle',
    run() {
      const value = mutableHistory();
      value.planRecords[1].risks[0].source.validation_ref = validationRef(2, 'VAL-0002');
      value.evidenceRecords[0] = evidence({
        validation_ref: validationRef(2, 'VAL-0002'),
        observed_result: 'The follow-up validation failed',
      });
      return () => buildAuthorizationGraph(value);
    },
    want: 'Authorization risk graph contains a cycle',
  }, {
    name: 'duplicate immutable validation tuple',
    run() {
      const value = mutableHistory();
      value.planRecords.splice(1, 0, structuredClone(value.planRecords[0]));
      return () => buildAuthorizationGraph(value);
    },
    want: 'Plan revision GL-AUTH/1/1 is duplicated',
  }, {
    name: 'unknown evidence',
    run() {
      const graph = buildAuthorizationGraph(history());
      return () => assertEvidenceAuthorized(graph, evidence({
        validation_ref: validationRef(2, 'VAL-9999'),
      }), { mode: 'write' });
    },
    want: 'Validation reference GL-AUTH/1/2/VAL-9999 is unknown',
  }, {
    name: 'late evidence',
    run() {
      const graph = buildAuthorizationGraph(history());
      return () => assertEvidenceAuthorized(graph, evidence({
        evidence_id: 'EVID-0002',
        recorded_at: '2026-08-25T04:00:00.000Z',
      }), { mode: 'replay', superseded_at: '2026-08-25T02:00:00.000Z' });
    },
    want: 'Evidence EVID-0002 was recorded after its plan revision was superseded',
  }, {
    name: 'mandatory gate same-ID mutation',
    run() {
      const graph = buildAuthorizationGraph(history());
      return () => assertEvidenceAuthorized(graph, evidence({
        evidence_id: 'EVID-0003',
        validation_ref: validationRef(2, 'VAL-0003'),
        observed_result: 'The accepted result was changed under the same ID',
        state: 'pass',
        failure_paths: [],
        recorded_at: '2026-08-25T04:00:00.000Z',
      }), { mode: 'write' });
    },
    want: 'Mandatory validation GL-AUTH/1/2/VAL-0003 already has an accepted result',
  }, {
    name: 'mandatory gate replay same-ID mutation',
    run() {
      const graph = buildAuthorizationGraph(history());
      return () => assertEvidenceAuthorized(graph, evidence({
        evidence_id: 'EVID-0003',
        validation_ref: validationRef(2, 'VAL-0003'),
        observed_result: 'The accepted replay bytes were changed under the same ID',
        state: 'pass',
        failure_paths: [],
        recorded_at: '2026-08-25T03:00:00.000Z',
      }), { mode: 'replay' });
    },
    want: 'Mandatory validation GL-AUTH/1/2/VAL-0003 does not match its accepted result',
  }, {
    name: 'malformed replay cutoff',
    run() {
      const graph = buildAuthorizationGraph(history());
      return () => assertEvidenceAuthorized(graph, evidence({
        evidence_id: 'EVID-0002',
      }), { mode: 'replay', superseded_at: 'zzzz' });
    },
    want: 'Evidence chronology superseded_at must be an RFC 3339 UTC timestamp',
  }, {
    name: 'stale evidence',
    run() {
      const graph = buildAuthorizationGraph(history());
      return () => assertEvidenceAuthorized(graph, evidence({
        evidence_id: 'EVID-0002',
        state: 'stale',
        failure_paths: [],
      }), { mode: 'replay', superseded_at: '2026-08-25T02:00:00.000Z' });
    },
    want: 'Evidence EVID-0002 is stale',
  }, {
    name: 'evidence criterion mismatch',
    run() {
      const graph = buildAuthorizationGraph(history());
      return () => assertEvidenceAuthorized(graph, evidence({
        evidence_id: 'EVID-0002',
        acceptance_criterion_id: 'AC-002',
      }), { mode: 'replay', superseded_at: '2026-08-25T02:00:00.000Z' });
    },
    want: 'Evidence EVID-0002 criterion AC-002 is not reachable from its validation',
  }, {
    name: 'evidence task mismatch',
    run() {
      const graph = buildAuthorizationGraph(history());
      return () => assertEvidenceAuthorized(graph, evidence({
        evidence_id: 'EVID-0002',
        task_id: 'TASK-0002',
      }), { mode: 'replay', superseded_at: '2026-08-25T02:00:00.000Z' });
    },
    want: 'Evidence EVID-0002 task TASK-0002 does not own its validation',
  }, {
    name: 'artifact path outside validation',
    run() {
      const graph = buildAuthorizationGraph(history());
      return () => assertEvidenceAuthorized(graph, evidence({
        evidence_id: 'EVID-0002',
        artifact_refs: ['src/b.js'],
      }), { mode: 'replay', superseded_at: '2026-08-25T02:00:00.000Z' });
    },
    want: 'Evidence EVID-0002 artifact path src/b.js exceeds validation bounds',
  }, {
    name: 'failure path outside validation',
    run() {
      const graph = buildAuthorizationGraph(history());
      return () => assertEvidenceAuthorized(graph, evidence({
        evidence_id: 'EVID-0002',
        artifact_refs: [],
        failure_paths: ['src/b.js'],
      }), { mode: 'replay', superseded_at: '2026-08-25T02:00:00.000Z' });
    },
    want: 'Evidence EVID-0002 failure path src/b.js exceeds validation bounds',
  }, {
    name: 'inactive revision for a new write',
    run() {
      const graph = buildAuthorizationGraph(history());
      return () => assertEvidenceAuthorized(graph, evidence({ evidence_id: 'EVID-0002' }), { mode: 'write' });
    },
    want: 'Evidence EVID-0002 does not target the active plan revision',
  }, {
    name: 'mandatory gate reuse',
    run() {
      const graph = buildAuthorizationGraph(history());
      return () => assertEvidenceAuthorized(graph, evidence({
        evidence_id: 'EVID-0004',
        validation_ref: validationRef(2, 'VAL-0003'),
        observed_result: 'The final full gate was repeated',
        state: 'pass',
        failure_paths: [],
        recorded_at: '2026-08-25T04:00:00.000Z',
      }), { mode: 'write' });
    },
    want: 'Mandatory validation GL-AUTH/1/2/VAL-0003 already has an accepted result',
  }];

  for (const { name, run, want } of cases) {
    assert.throws(run(), (error) => {
      assert.equal(error.code, 'AUTHORIZATION_DENIED', name);
      assert.equal(error.message, want, name);
      return true;
    });
  }
});
