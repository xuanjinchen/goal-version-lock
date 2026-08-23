import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canonicalBytes, canonicalJson, parseCanonicalJson, sha256 } from '../src/goal-lock/canonical.js';
import {
  GoalLockError,
  approvalPhraseForChange,
  approvalPhraseForGoal,
  normalizeRelativePath,
  validateGoalContract,
  validateLockRecord,
} from '../src/goal-lock/contracts.js';
import { createGoalLockFixture } from './helpers/goal-lock-fixture.js';

test('canonical JSON recursively orders object keys while preserving array order', () => {
  const value = { z: [{ b: 2, a: 1 }, 'last'], a: { z: true, a: false } };

  assert.equal(canonicalJson(value), '{"a":{"a":false,"z":true},"z":[{"a":1,"b":2},"last"]}\n');
});

test('canonical JSON round-trips Unicode as UTF-8 bytes with one final LF', () => {
  const bytes = canonicalBytes({ greeting: '你好😀' });

  assert.deepEqual(bytes, Buffer.from('{"greeting":"你好😀"}\n', 'utf8'));
  assert.deepEqual(parseCanonicalJson(bytes, 'Unicode document'), { greeting: '你好😀' });
  assert.equal(bytes.toString('utf8').endsWith('\n'), true);
  assert.equal(bytes.toString('utf8').endsWith('\n\n'), false);
});

test('canonical JSON produces the stable SHA-256 for hand-derived bytes', () => {
  const bytes = canonicalBytes({ a: 1, b: 2 });

  assert.equal(sha256(bytes), 'e8d38819d39f705646bfb643368eca78f7db476c16471dbc33b941b27326410d');
});

test('canonical JSON rejects values outside the JSON contract', () => {
  const cyclic = {};
  cyclic.self = cyclic;
  const sparse = [];
  sparse[1] = 'present';
  const symbolKeyed = { visible: true };
  symbolKeyed[Symbol('hidden')] = 'hidden';
  const symbolKeyedArray = ['visible'];
  symbolKeyedArray[Symbol('hidden')] = 'hidden';

  for (const value of [NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, undefined, () => {}, Symbol('x'), symbolKeyed, symbolKeyedArray, sparse, new Date(), cyclic]) {
    assert.throws(() => canonicalJson(value), /canonical JSON/i);
  }
});

test('canonical JSON parser rejects noncanonical bytes and invalid UTF-8', () => {
  assert.throws(() => parseCanonicalJson(Buffer.from('{"b":2,"a":1}\n'), 'goal'), /canonical/i);
  assert.throws(() => parseCanonicalJson(Buffer.from([0x7b, 0xff, 0x7d, 0x0a]), 'goal'), /UTF-8|goal/i);
  assert.throws(() => parseCanonicalJson(Buffer.from('\uFEFF{}\n'), 'goal'), /canonical/i);
  assert.throws(() => parseCanonicalJson(Buffer.from('{}\r\n'), 'goal'), /canonical/i);
});

test('goal lock fixture uses an isolated Git repository by default', (testContext) => {
  const fixture = createGoalLockFixture(testContext);

  assert.equal(fixture.now(), '2026-08-23T00:00:00.000Z');
  assert.equal(fixture.pid, 4242);
  assert.equal(fixture.isProcessAlive(1), false);
});

function goalV1() {
  return {
    schema_version: 1,
    goal_id: 'GL-ALPHA',
    goal_version: 1,
    objective: 'Ship a safe lock',
    scope: { in: ['CLI'], out: ['Cloud sync'] },
    non_goals: ['Remote publishing'],
    constraints: [{ id: 'C-001', text: 'Use Node.js' }],
    acceptance_criteria: [{ id: 'AC-001', outcome: 'State is locked', verification: 'Run verification' }],
    authorization_boundary: ['Local workspace only'],
    assumptions: [{ statement: 'Git is installed', confidence: 'medium' }],
    predecessor: null,
    accepted_change_id: null,
  };
}

function lockV1() {
  return {
    schema_version: 1,
    goal_id: 'GL-ALPHA',
    goal_version: 1,
    goal_digest: '1111111111111111111111111111111111111111111111111111111111111111',
    approval_type: 'explicit-version-1',
    proposal_digest: '2222222222222222222222222222222222222222222222222222222222222222',
    approved_at: '2026-08-23T00:00:00Z',
    predecessor_digest: null,
    state_revision: 1,
    progress_head: null,
    change_head: null,
    evidence_heads: {},
    record_digest: 'REPLACE_ME',
  };
}

test('goal contract accepts every required version-one field without mutating input', () => {
  const input = goalV1();
  const validated = validateGoalContract(input);

  assert.deepEqual(validated, input);
  assert.notEqual(validated, input);
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(Object.isFrozen(validated.scope), true);
  assert.equal(input.scope.in[0], 'CLI');
});

test('goal contract permits an empty acceptance-criteria array when no criterion is declared', () => {
  const input = goalV1();
  input.acceptance_criteria = [];

  assert.deepEqual(validateGoalContract(input).acceptance_criteria, []);
});

test('goal contract names each missing required field', () => {
  for (const field of ['schema_version', 'goal_id', 'goal_version', 'objective', 'scope', 'non_goals', 'constraints', 'acceptance_criteria', 'authorization_boundary', 'assumptions', 'predecessor', 'accepted_change_id']) {
    const input = goalV1();
    delete input[field];
    assert.throws(() => validateGoalContract(input), new RegExp(field));
  }
});

test('goal contract rejects duplicate semantic IDs and untrimmed required text without echoing objective', () => {
  const duplicateCriterion = goalV1();
  duplicateCriterion.acceptance_criteria.push({ id: 'AC-001', outcome: 'Another result', verification: 'Another command' });
  assert.throws(() => validateGoalContract(duplicateCriterion), /acceptance_criteria.*AC-001/i);

  const untrimmed = goalV1();
  untrimmed.objective = ' private objective ';
  assert.throws(
    () => validateGoalContract(untrimmed),
    (error) => error instanceof GoalLockError && /objective/i.test(error.message) && !error.message.includes('private objective'),
  );
});

test('goal contract enforces scope, version, predecessor, and accepted-change relations', () => {
  const emptyScope = goalV1();
  emptyScope.scope.in = [];
  assert.throws(() => validateGoalContract(emptyScope), /scope\.in/i);

  const invalidV1Predecessor = goalV1();
  invalidV1Predecessor.predecessor = { goal_version: 1, goal_digest: '1111111111111111111111111111111111111111111111111111111111111111' };
  assert.throws(() => validateGoalContract(invalidV1Predecessor), /predecessor/i);

  const invalidV2 = goalV1();
  invalidV2.goal_version = 2;
  invalidV2.predecessor = { goal_version: 2, goal_digest: '1111111111111111111111111111111111111111111111111111111111111111' };
  invalidV2.accepted_change_id = 'CR-0001';
  assert.throws(() => validateGoalContract(invalidV2), /predecessor\.goal_version/i);
});

test('relative artifact paths normalize only safe repository-relative paths', () => {
  assert.equal(normalizeRelativePath('reports/final.json', 'artifact'), 'reports/final.json');
  for (const value of ['reports\\final.json', '/etc/passwd', 'C:/work/file', '\\\\server\\share', 'a//b', './report', 'a/../report', '.goal-lock/current.json', 'a\u0000b']) {
    assert.throws(() => normalizeRelativePath(value, 'artifact'), /artifact|path/i);
  }
});

test('lock contract validates initial heads and the digest of every field except record_digest', () => {
  const input = lockV1();
  input.record_digest = '9829d201bd2c1d769712f66032544acc1d34f78ce92b6cc63c44305053b88f0f';
  const validated = validateLockRecord(input);

  assert.deepEqual(validated, input);
  assert.equal(Object.isFrozen(validated.evidence_heads), true);
});

test('lock contract rejects malformed enums, heads, and record digests', () => {
  const badApproval = lockV1();
  badApproval.approval_type = 'approved';
  assert.throws(() => validateLockRecord(badApproval), /approval_type/i);

  const badHead = lockV1();
  badHead.progress_head = { event_id: 'EVT-1', digest: '1111111111111111111111111111111111111111111111111111111111111111' };
  assert.throws(() => validateLockRecord(badHead), /progress_head\.event_id/i);

  const badDigest = lockV1();
  badDigest.record_digest = '1111111111111111111111111111111111111111111111111111111111111111';
  assert.throws(() => validateLockRecord(badDigest), /record_digest/i);
});

test('approval phrase builders bind the stable identifiers and digest fingerprints', () => {
  const goal = goalV1();
  assert.equal(approvalPhraseForGoal(goal), 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766');
  assert.equal(
    approvalPhraseForChange({ id: 'CR-0001', candidate_goal: { goal_version: 2 }, proposal_digest: 'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd' }),
    'APPROVE CR-0001 GOAL VERSION 2 abcdefabcdef',
  );
});

test('goal lock errors expose immutable classification metadata', () => {
  const error = new GoalLockError('INVALID_INPUT', 'input', 2, 'Invalid field');

  assert.equal(error.code, 'INVALID_INPUT');
  assert.equal(error.kind, 'input');
  assert.equal(error.exitCode, 2);
  assert.throws(() => { error.code = 'OTHER'; }, TypeError);
});
