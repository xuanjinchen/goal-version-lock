import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { link, lstat, mkdir, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { canonicalBytes, canonicalJson, parseCanonicalJson, sha256 } from '../src/goal-lock/canonical.js';
import * as goalContracts from '../src/goal-lock/contracts.js';
import {
  GoalLockError,
  approvalPhraseForChange,
  approvalPhraseForGoal,
  normalizeRelativePath,
  validateGoalContract,
  validateLockRecord,
} from '../src/goal-lock/contracts.js';
import { commitGoalFiles, recoverGoalLock, withGoalLock } from '../src/goal-lock/transaction.js';
import { createGoalLockFixture } from './helpers/goal-lock-fixture.js';

async function goalRepository() {
  return import('../src/goal-lock/repository.js');
}

async function workspaceReader() {
  return import('../src/goal-lock/workspace.js');
}

function independentSha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function installVersionTwo(fixture, changeId = 'CR-0001') {
  const directory = join(fixture.root, '.goal-lock');
  const previousBytes = canonicalBytes(goalV1());
  const goal = {
    ...goalV1(),
    goal_version: 2,
    objective: 'Ship a safely evolved lock',
    predecessor: { goal_version: 1, goal_digest: independentSha256(previousBytes) },
    accepted_change_id: changeId,
  };
  const bytes = canonicalBytes(goal);
  const digest = independentSha256(bytes);
  const change = structuralChange(changeId, { candidateGoal: goal });
  const proposalDigest = change.proposal_digest;
  const changeBytes = canonicalBytes(change);
  await writeFile(join(directory, 'current.json'), bytes);
  await writeFile(join(directory, 'history', 'goals', 'v0002.json'), bytes);
  await mkdir(join(directory, 'changes'), { recursive: true });
  await writeFile(join(directory, 'changes', `${changeId}.json`), changeBytes);
  const lockWithoutDigest = {
    schema_version: 1,
    goal_id: 'GL-ALPHA',
    goal_version: 2,
    goal_digest: digest,
    approval_type: 'explicit-change',
    proposal_digest: proposalDigest,
    approved_at: '2026-08-23T01:00:00.000Z',
    predecessor_digest: independentSha256(previousBytes),
    state_revision: 2,
    progress_head: null,
    change_head: { change_request_id: changeId, digest: independentSha256(changeBytes) },
    evidence_heads: {},
  };
  await writeFile(join(directory, 'lock.json'), canonicalBytes({
    ...lockWithoutDigest,
    record_digest: independentSha256(canonicalBytes(lockWithoutDigest)),
  }));
  return { goal, bytes, digest };
}

async function installNonHeadProposedChangeState(fixture) {
  const directory = join(fixture.root, '.goal-lock');
  const proposed = structuralChange('CR-0001', { status: 'proposed' });
  const terminal = structuralChange('CR-0002', { status: 'rejected' });
  const proposedBytes = canonicalBytes(proposed);
  const terminalBytes = canonicalBytes(terminal);
  await mkdir(join(directory, 'changes'));
  await writeFile(join(directory, 'changes', 'CR-0001.json'), proposedBytes);
  await writeFile(join(directory, 'changes', 'CR-0002.json'), terminalBytes);
  await rewriteTestLock(fixture, (lock) => {
    lock.state_revision += 2;
    lock.change_head = { change_request_id: 'CR-0002', digest: independentSha256(terminalBytes) };
  });
  return { proposedBytes, terminalBytes };
}

async function installVersionThree(fixture, firstChangeStatus) {
  const directory = join(fixture.root, '.goal-lock');
  const versionTwo = await installVersionTwo(fixture);
  const goal = {
    ...versionTwo.goal,
    goal_version: 3,
    objective: 'Ship a three-version safe lock',
    predecessor: { goal_version: 2, goal_digest: versionTwo.digest },
    accepted_change_id: 'CR-0002',
  };
  const bytes = canonicalBytes(goal);
  const digest = independentSha256(bytes);
  const firstChangePath = join(directory, 'changes', 'CR-0001.json');
  const firstChange = parseCanonicalJson(await readFile(firstChangePath), 'first test change');
  firstChange.status = firstChangeStatus;
  const firstChangeBytes = canonicalBytes(firstChange);
  const secondChange = structuralChange('CR-0002', {
    baseGoal: versionTwo.goal,
    candidateGoal: goal,
    status: 'approved',
    recordedAt: '2026-08-23T02:00:00.000Z',
  });
  const secondChangeBytes = canonicalBytes(secondChange);
  await writeFile(join(directory, 'current.json'), bytes);
  await writeFile(join(directory, 'history', 'goals', 'v0003.json'), bytes);
  await writeFile(firstChangePath, firstChangeBytes);
  await writeFile(join(directory, 'changes', 'CR-0002.json'), secondChangeBytes);
  const lockWithoutDigest = {
    schema_version: 1,
    goal_id: goal.goal_id,
    goal_version: 3,
    goal_digest: digest,
    approval_type: 'explicit-change',
    proposal_digest: secondChange.proposal_digest,
    approved_at: '2026-08-23T02:00:00.000Z',
    predecessor_digest: versionTwo.digest,
    state_revision: 3,
    progress_head: null,
    change_head: { change_request_id: 'CR-0002', digest: independentSha256(secondChangeBytes) },
    evidence_heads: {},
  };
  await writeFile(join(directory, 'lock.json'), canonicalBytes({
    ...lockWithoutDigest,
    record_digest: independentSha256(canonicalBytes(lockWithoutDigest)),
  }));
  return { goal, bytes, digest };
}

function activeGoalReference() {
  return {
    goal_id: 'GL-ALPHA',
    goal_version: 1,
    goal_digest: '92d74f6bf766e096e71b949ff57e2d9a12302a4519226d05cf67c2b544babaa6',
  };
}

function structuralPlan() {
  return {
    schema_version: 1,
    goal: activeGoalReference(),
    plan_revision: 1,
    next_task_id: null,
    tasks: [],
    deferred: [],
  };
}

function completePlan(revision = 1) {
  return {
    schema_version: 1,
    goal: activeGoalReference(),
    plan_revision: revision,
    next_task_id: 'TASK-0001',
    tasks: [
      {
        id: 'TASK-0001',
        outcome: 'Implement the locked state transition',
        acceptance_criteria: ['AC-001'],
        dependencies: [],
        permitted_paths: ['src/goal-lock/repository.js'],
        verification: 'Run the focused goal-lock tests',
        status: 'pending',
      },
      {
        id: 'TASK-0002',
        outcome: 'Verify the completed transition',
        acceptance_criteria: ['AC-001'],
        dependencies: ['TASK-0001'],
        permitted_paths: ['tests/goal-lock.test.js'],
        verification: 'Run the complete goal-lock test file',
        status: 'pending',
      },
    ],
    deferred: [{ id: 'TASK-0003', reason: 'Not scheduled in this revision' }],
  };
}

function validateCompletePlan(plan) {
  return goalContracts.validatePlan(plan, activeGoalReference());
}

test('plan public API exports validatePlan with the fixed goal-reference signature', () => {
  assert.equal(typeof goalContracts.validatePlan, 'function');
  assert.equal(Object.hasOwn(goalContracts, 'validatePlanContract'), false);
  assert.deepEqual(goalContracts.validatePlan(completePlan(), activeGoalReference()), completePlan());
});

test('plan contract accepts a complete goal-bound plan without mutating input', () => {
  const input = completePlan();

  const validated = validateCompletePlan(input);

  assert.deepEqual(validated, input);
  assert.notEqual(validated, input);
  assert.equal(Object.isFrozen(validated.tasks[0]), true);
  assert.equal(input.tasks[0].status, 'pending');
});

test('plan contract requires its exact goal reference, revision, and root fields', () => {
  const cases = [
    ['goal.goal_id', (plan) => { plan.goal.goal_id = 'GL-OTHER'; }],
    ['goal.goal_version', (plan) => { plan.goal.goal_version = 2; }],
    ['goal.goal_digest', (plan) => { plan.goal.goal_digest = 'f'.repeat(64); }],
    ['plan_revision', (plan) => { plan.plan_revision = 0; }],
    ['schema_version', (plan) => { plan.schema_version = 2; }],
    ['unknown', (plan) => { plan.unexpected = true; }],
  ];

  for (const [field, mutate] of cases) {
    const input = completePlan();
    mutate(input);
    assert.throws(() => validateCompletePlan(input), new RegExp(field, 'i'), field);
  }
});

test('plan contract enforces unique stable task references and criterion coverage', () => {
  const cases = [
    ['duplicate task', (plan) => { plan.tasks[1].id = 'TASK-0001'; }],
    ['duplicate deferred task', (plan) => { plan.deferred.push({ id: 'TASK-0003', reason: 'Duplicate' }); }],
    ['scheduled and deferred task', (plan) => { plan.deferred[0].id = 'TASK-0002'; }],
    ['acceptance criteria required', (plan) => { plan.tasks[0].acceptance_criteria = []; }],
    ['dependency exists', (plan) => { plan.tasks[1].dependencies = ['TASK-9999']; }],
    ['dependency cycle', (plan) => { plan.tasks[0].dependencies = ['TASK-0002']; }],
    ['deferred reason', (plan) => { plan.deferred[0].reason = ' '; }],
  ];

  for (const [label, mutate] of cases) {
    const input = completePlan();
    mutate(input);
    assert.throws(() => validateCompletePlan(input), /task|acceptance|depend|cycle|deferred|reason/i, label);
  }
});

test('plan contract enforces normalized paths, verification text, statuses, and one executable next task', () => {
  const cases = [
    ['normalized path', (plan) => { plan.tasks[0].permitted_paths = ['src\\goal-lock\\repository.js']; }],
    ['verification text', (plan) => { plan.tasks[0].verification = ''; }],
    ['status enum', (plan) => { plan.tasks[0].status = 'started'; }],
    ['next task exists', (plan) => { plan.next_task_id = 'TASK-9999'; }],
    ['next task is executable', (plan) => { plan.tasks[0].status = 'complete'; }],
    ['next task required', (plan) => { plan.next_task_id = null; }],
  ];

  for (const [label, mutate] of cases) {
    const input = completePlan();
    mutate(input);
    assert.throws(() => validateCompletePlan(input), /path|verification|status|next_task_id|executable/i, label);
  }

  const noExecutableTask = completePlan();
  noExecutableTask.tasks[0].status = 'complete';
  noExecutableTask.tasks[1].status = 'complete';
  noExecutableTask.next_task_id = null;
  assert.deepEqual(validateCompletePlan(noExecutableTask), noExecutableTask);
});

test('plan executable dependencies must all be complete before selecting the next task', () => {
  const waiting = completePlan();
  waiting.next_task_id = 'TASK-0002';
  waiting.tasks[1].status = 'pending';
  assert.throws(() => validateCompletePlan(waiting), /next_task_id|depend|executable/i);

  const ready = completePlan();
  ready.next_task_id = 'TASK-0002';
  ready.tasks[0].status = 'complete';
  ready.tasks[1].status = 'pending';
  assert.deepEqual(validateCompletePlan(ready), ready);
});

function planCandidate(outcome = 'Implement the locked state transition') {
  const plan = completePlan();
  plan.tasks[0].outcome = outcome;
  return {
    next_task_id: plan.next_task_id,
    tasks: plan.tasks,
    deferred: plan.deferred,
  };
}

function changeCandidate() {
  const goal = goalV1();
  return {
    objective: 'Ship a safer lock',
    scope: goal.scope,
    non_goals: goal.non_goals,
    constraints: goal.constraints,
    acceptance_criteria: [{ id: 'AC-001', outcome: 'State remains safely locked', verification: 'Run verification' }],
    authorization_boundary: goal.authorization_boundary,
    assumptions: goal.assumptions,
  };
}

function changeProposalInput(overrides = {}) {
  return {
    candidate: changeCandidate(),
    changes: [
      { field: 'objective', before: 'Ship a safe lock', after: 'Ship a safer lock' },
      {
        field: 'acceptance_criteria',
        before: [{ id: 'AC-001', outcome: 'State is locked', verification: 'Run verification' }],
        after: [{ id: 'AC-001', outcome: 'State remains safely locked', verification: 'Run verification' }],
      },
    ],
    rationale: 'Strengthen the accepted safety outcome',
    affected_tasks: ['TASK-0001'],
    affected_criteria: ['AC-001'],
    risks: ['Existing implementation may need revision'],
    validation: ['Run the complete goal-lock test file'],
    rollback: ['Reject the proposal and keep version one'],
    ...overrides,
  };
}

const CHANGE_CANDIDATE_DIGEST = 'e2757e366e6229d0b8be1698a457ed61788bb11534da8671447c5eb78bd2db79';
const CHANGE_PROPOSAL_DIGEST = '3cbab5b6bf74c7b173fef5e628f946f295e209d3e62fbc3954b52339b981ee88';
const CHANGE_RECORD_DIGEST = '9c71174dc8aeb3cedb2577670d386bdfa18949c65fe4e6820c784b7884342660';

function expectedChangeRequest(overrides = {}) {
  return {
    schema_version: 1,
    id: 'CR-0001',
    status: 'proposed',
    base_goal: activeGoalReference(),
    candidate_goal: {
      schema_version: 1,
      goal_id: 'GL-ALPHA',
      goal_version: 2,
      ...changeCandidate(),
      predecessor: { goal_version: 1, goal_digest: activeGoalReference().goal_digest },
      accepted_change_id: 'CR-0001',
    },
    candidate_digest: CHANGE_CANDIDATE_DIGEST,
    proposal_digest: CHANGE_PROPOSAL_DIGEST,
    changes: changeProposalInput().changes,
    rationale: 'Strengthen the accepted safety outcome',
    affected_tasks: ['TASK-0001'],
    affected_criteria: ['AC-001'],
    risks: ['Existing implementation may need revision'],
    validation: ['Run the complete goal-lock test file'],
    rollback: ['Reject the proposal and keep version one'],
    approval_phrase: 'APPROVE CR-0001 GOAL VERSION 2 3cbab5b6bf74',
    recorded_at: '2026-08-23T00:00:00.000Z',
    ...overrides,
  };
}

async function createChangeProposalFixture(testContext) {
  const fixture = createGoalLockFixture(testContext);
  const repository = await goalRepository();
  await repository.initializeGoal(fixture.root, goalV1(), fixture);
  await repository.lockInitialGoal(fixture.root, 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766', fixture);
  await repository.revisePlan(fixture.root, planCandidate(), 'aligned', fixture);
  return { fixture, repository };
}

test('change proposal derives one exact canonical request and advances only the lock integrity index', async (testContext) => {
  const { fixture, repository } = await createChangeProposalFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  const preservedPaths = ['current.json', 'plan.json', 'progress.jsonl', 'history/goals/v0001.json'];
  const preserved = new Map(await Promise.all(preservedPaths.map(async (relativePath) => [relativePath, await readFile(join(directory, ...relativePath.split('/')))])));
  const lockBefore = parseCanonicalJson(await readFile(join(directory, 'lock.json')), 'test lock');

  const receipt = await repository.proposeGoalChange(fixture.root, changeProposalInput(), fixture);

  assert.deepEqual(receipt, {
    state: 'CHANGE_PENDING',
    change_request_id: 'CR-0001',
    candidate_goal_version: 2,
    candidate_digest: CHANGE_CANDIDATE_DIGEST,
    proposal_digest: CHANGE_PROPOSAL_DIGEST,
    approval_required: 'APPROVE CR-0001 GOAL VERSION 2 3cbab5b6bf74',
  });
  const changeBytes = await readFile(join(directory, 'changes', 'CR-0001.json'));
  assert.deepEqual(changeBytes, canonicalBytes(expectedChangeRequest()));
  assert.equal(independentSha256(changeBytes), CHANGE_RECORD_DIGEST);
  assert.deepEqual(goalContracts.validateChangeRequest(parseCanonicalJson(changeBytes, 'test change')), expectedChangeRequest());
  assert.equal(Object.isFrozen(goalContracts.validateChangeRequest(expectedChangeRequest()).candidate_goal), true);
  for (const [relativePath, bytes] of preserved) {
    assert.deepEqual(await readFile(join(directory, ...relativePath.split('/'))), bytes, relativePath);
  }
  const lock = parseCanonicalJson(await readFile(join(directory, 'lock.json')), 'test lock');
  assert.equal(lock.state_revision, lockBefore.state_revision + 1);
  assert.deepEqual(lock.progress_head, lockBefore.progress_head);
  assert.deepEqual(lock.evidence_heads, lockBefore.evidence_heads);
  assert.deepEqual(lock.change_head, { change_request_id: 'CR-0001', digest: CHANGE_RECORD_DIGEST });
  const { record_digest: recordDigest, ...withoutDigest } = lock;
  assert.equal(recordDigest, independentSha256(canonicalBytes(withoutDigest)));
  assert.equal((await repository.verifyGoalRepository(fixture.root, fixture)).state, 'CHANGE_PENDING');
});

test('change proposal rejects caller-owned metadata and inexact semantic change claims without mutation', async (testContext) => {
  const { fixture, repository } = await createChangeProposalFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  const lockBefore = await readFile(join(directory, 'lock.json'));
  const cases = [
    ['derived root field', { ...changeProposalInput(), status: 'proposed' }],
    ['derived candidate field', changeProposalInput({ candidate: { ...changeCandidate(), goal_version: 2 } })],
    ['omitted difference', changeProposalInput({ changes: changeProposalInput().changes.slice(0, 1) })],
    ['extra unchanged claim', changeProposalInput({ changes: [...changeProposalInput().changes, { field: 'scope', before: goalV1().scope, after: goalV1().scope }] })],
    ['wrong before value', changeProposalInput({ changes: [{ field: 'objective', before: 'Wrong base', after: 'Ship a safer lock' }, changeProposalInput().changes[1]] })],
    ['wrong after value', changeProposalInput({ changes: [{ field: 'objective', before: 'Ship a safe lock', after: 'Wrong candidate' }, changeProposalInput().changes[1]] })],
    ['duplicate field', changeProposalInput({ changes: [...changeProposalInput().changes, changeProposalInput().changes[0]] })],
  ];

  for (const [label, input] of cases) {
    await assert.rejects(
      repository.proposeGoalChange(fixture.root, input, fixture),
      (error) => error instanceof GoalLockError && error.kind === 'input',
      label,
    );
  }
  assert.equal(existsSync(join(directory, 'changes')), false);
  assert.deepEqual(await readFile(join(directory, 'lock.json')), lockBefore);
});

test('change proposal normalizes complete semantic claims into stable contract order', async (testContext) => {
  const { fixture, repository } = await createChangeProposalFixture(testContext);
  const reversed = changeProposalInput().changes.toReversed();

  await repository.proposeGoalChange(fixture.root, changeProposalInput({ changes: reversed }), fixture);

  const change = parseCanonicalJson(
    await readFile(join(fixture.root, '.goal-lock', 'changes', 'CR-0001.json')),
    'test change',
  );
  assert.deepEqual(change.changes, changeProposalInput().changes);
  assert.equal(change.proposal_digest, CHANGE_PROPOSAL_DIGEST);
});

test('change proposal requires existing affected task and criterion identifiers', async (testContext) => {
  const { fixture, repository } = await createChangeProposalFixture(testContext);
  for (const [label, overrides] of [
    ['task', { affected_tasks: ['TASK-9999'] }],
    ['criterion', { affected_criteria: ['AC-999'] }],
    ['unsafe task', { affected_tasks: ['../TASK-0001'] }],
  ]) {
    await assert.rejects(
      repository.proposeGoalChange(fixture.root, changeProposalInput(overrides), fixture),
      (error) => error instanceof GoalLockError && error.kind === 'input',
      label,
    );
  }
  assert.equal(existsSync(join(fixture.root, '.goal-lock', 'changes')), false);
});

test('change proposal refuses draft, tampered, stale, and change-pending repository state', async (testContext) => {
  const draft = createGoalLockFixture(testContext);
  const repository = await goalRepository();
  await repository.initializeGoal(draft.root, goalV1(), draft);
  await assert.rejects(
    repository.proposeGoalChange(draft.root, changeProposalInput(), draft),
    (error) => error instanceof GoalLockError && error.kind === 'state',
  );

  const tampered = await createChangeProposalFixture(testContext);
  await writeFile(join(tampered.fixture.root, '.goal-lock', 'current.json'), canonicalBytes({ ...goalV1(), objective: 'Tampered objective' }));
  await assert.rejects(
    tampered.repository.proposeGoalChange(tampered.fixture.root, changeProposalInput(), tampered.fixture),
    (error) => error instanceof GoalLockError && error.kind === 'integrity',
  );

  const stale = await createChangeProposalFixture(testContext);
  await stale.repository.recordGoalEvent(stale.fixture.root, evidenceInput({ state: 'stale' }), stale.fixture);
  await assert.rejects(
    stale.repository.proposeGoalChange(stale.fixture.root, changeProposalInput(), stale.fixture),
    (error) => error instanceof GoalLockError && error.kind === 'state',
  );

  const pending = await createChangeProposalFixture(testContext);
  await pending.repository.proposeGoalChange(pending.fixture.root, changeProposalInput(), pending.fixture);
  const firstBytes = await readFile(join(pending.fixture.root, '.goal-lock', 'changes', 'CR-0001.json'));
  await assert.rejects(
    pending.repository.proposeGoalChange(pending.fixture.root, changeProposalInput(), pending.fixture),
    (error) => error instanceof GoalLockError && error.kind === 'state',
  );
  assert.deepEqual(await readFile(join(pending.fixture.root, '.goal-lock', 'changes', 'CR-0001.json')), firstBytes);
  assert.equal(existsSync(join(pending.fixture.root, '.goal-lock', 'changes', 'CR-0002.json')), false);
});

test('change proposal transaction rolls back the request when lock-head installation fails', async (testContext) => {
  const { fixture, repository } = await createChangeProposalFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  const lockBefore = await readFile(join(directory, 'lock.json'));
  fixture.transactionFaults.install = ({ target }) => {
    if (target === '.goal-lock/lock.json') throw new Error('change-lock-install-failure');
  };

  await assert.rejects(
    repository.proposeGoalChange(fixture.root, changeProposalInput(), fixture),
    /change-lock-install-failure/,
  );

  assert.equal(existsSync(join(directory, 'changes', 'CR-0001.json')), false);
  assert.deepEqual(await readFile(join(directory, 'lock.json')), lockBefore);
  assert.deepEqual((await readdir(directory)).filter((name) => name.includes('.stage') || name.includes('.backup')), []);
});

test('rejects change by replacing only status and advancing the lock integrity index', async (testContext) => {
  const { fixture, repository } = await createChangeProposalFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  await repository.proposeGoalChange(fixture.root, changeProposalInput(), fixture);
  const proposed = parseCanonicalJson(await readFile(join(directory, 'changes', 'CR-0001.json')), 'test change');
  const lockBefore = parseCanonicalJson(await readFile(join(directory, 'lock.json')), 'test lock');
  const preservedPaths = ['current.json', 'plan.json', 'progress.jsonl', 'history/goals/v0001.json'];
  const preserved = new Map(await Promise.all(preservedPaths.map(async (relativePath) => [relativePath, await readFile(join(directory, ...relativePath.split('/')))])));

  const receipt = await repository.rejectGoalChange(fixture.root, 'CR-0001', 'The stronger outcome is not authorized', fixture);

  assert.deepEqual(receipt, {
    state: 'LOCKED',
    change_request_id: 'CR-0001',
    status: 'rejected',
    reason: 'The stronger outcome is not authorized',
  });
  const rejectedBytes = await readFile(join(directory, 'changes', 'CR-0001.json'));
  assert.equal(independentSha256(rejectedBytes), 'b7755ab94f6f90dcb89ced9622a22524b2e57744f0f46b3d8cb729f3650c773f');
  const rejected = parseCanonicalJson(rejectedBytes, 'test rejected change');
  assert.deepEqual(rejected, { ...proposed, status: 'rejected' });
  assert.equal(Object.hasOwn(rejected, 'reason'), false);
  for (const [relativePath, bytes] of preserved) {
    assert.deepEqual(await readFile(join(directory, ...relativePath.split('/'))), bytes, relativePath);
  }
  const lock = parseCanonicalJson(await readFile(join(directory, 'lock.json')), 'test lock');
  assert.equal(lock.state_revision, lockBefore.state_revision + 1);
  assert.deepEqual(lock.progress_head, lockBefore.progress_head);
  assert.deepEqual(lock.evidence_heads, lockBefore.evidence_heads);
  assert.deepEqual(lock.change_head, {
    change_request_id: 'CR-0001',
    digest: 'b7755ab94f6f90dcb89ced9622a22524b2e57744f0f46b3d8cb729f3650c773f',
  });
  assert.equal((await repository.verifyGoalRepository(fixture.root, fixture)).state, 'LOCKED');
});

test('rejects change refusal for unknown, terminal, unsafe, or invalidly reasoned requests without mutation', async (testContext) => {
  const { fixture, repository } = await createChangeProposalFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  await repository.proposeGoalChange(fixture.root, changeProposalInput(), fixture);
  const proposedBefore = await readFile(join(directory, 'changes', 'CR-0001.json'));
  const lockBefore = await readFile(join(directory, 'lock.json'));
  const cases = [
    ['unknown', 'CR-0002', 'Reject an unknown request'],
    ['unsafe', '../CR-0001', 'Reject an unsafe request'],
    ['empty reason', 'CR-0001', ''],
    ['untrimmed reason', 'CR-0001', ' not concise '],
    ['overlong reason', 'CR-0001', 'x'.repeat(501)],
  ];
  for (const [label, changeRequestId, reason] of cases) {
    await assert.rejects(
      repository.rejectGoalChange(fixture.root, changeRequestId, reason, fixture),
      (error) => error instanceof GoalLockError && ['input', 'state'].includes(error.kind),
      label,
    );
  }
  assert.deepEqual(await readFile(join(directory, 'changes', 'CR-0001.json')), proposedBefore);
  assert.deepEqual(await readFile(join(directory, 'lock.json')), lockBefore);

  await repository.rejectGoalChange(fixture.root, 'CR-0001', 'Do not change the accepted outcome', fixture);
  const terminalBefore = await readFile(join(directory, 'changes', 'CR-0001.json'));
  const terminalLockBefore = await readFile(join(directory, 'lock.json'));
  await assert.rejects(
    repository.rejectGoalChange(fixture.root, 'CR-0001', 'Reject it again', fixture),
    (error) => error instanceof GoalLockError && error.kind === 'state',
  );
  assert.deepEqual(await readFile(join(directory, 'changes', 'CR-0001.json')), terminalBefore);
  assert.deepEqual(await readFile(join(directory, 'lock.json')), terminalLockBefore);
});

test('rejects change then allocates the next safely scanned change request ID', async (testContext) => {
  const { fixture, repository } = await createChangeProposalFixture(testContext);
  await repository.proposeGoalChange(fixture.root, changeProposalInput(), fixture);
  await repository.rejectGoalChange(fixture.root, 'CR-0001', 'Keep the current acceptance outcome', fixture);

  const receipt = await repository.proposeGoalChange(fixture.root, changeProposalInput(), fixture);

  assert.equal(receipt.change_request_id, 'CR-0002');
  assert.equal(parseCanonicalJson(
    await readFile(join(fixture.root, '.goal-lock', 'changes', 'CR-0001.json')),
    'first change',
  ).status, 'rejected');
  assert.equal(parseCanonicalJson(
    await readFile(join(fixture.root, '.goal-lock', 'changes', 'CR-0002.json')),
    'second change',
  ).status, 'proposed');
});

test('rejects change transaction rollback restores the exact proposed request and lock head', async (testContext) => {
  const { fixture, repository } = await createChangeProposalFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  await repository.proposeGoalChange(fixture.root, changeProposalInput(), fixture);
  const proposedBefore = await readFile(join(directory, 'changes', 'CR-0001.json'));
  const lockBefore = await readFile(join(directory, 'lock.json'));
  fixture.transactionFaults.install = ({ target }) => {
    if (target === '.goal-lock/lock.json') throw new Error('reject-lock-install-failure');
  };

  await assert.rejects(
    repository.rejectGoalChange(fixture.root, 'CR-0001', 'Keep the accepted outcome', fixture),
    /reject-lock-install-failure/,
  );

  assert.deepEqual(await readFile(join(directory, 'changes', 'CR-0001.json')), proposedBefore);
  assert.deepEqual(await readFile(join(directory, 'lock.json')), lockBefore);
  assert.equal((await repository.verifyGoalRepository(fixture.root, fixture)).state, 'CHANGE_PENDING');
});

test('rejects change when the proposed request is not the terminal lock head', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const repository = await goalRepository();
  await repository.initializeGoal(fixture.root, goalV1(), fixture);
  await repository.lockInitialGoal(fixture.root, 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766', fixture);
  const before = await installNonHeadProposedChangeState(fixture);
  const lockBefore = await readFile(join(fixture.root, '.goal-lock', 'lock.json'));

  await assert.rejects(
    repository.rejectGoalChange(fixture.root, 'CR-0001', 'Reject the non-head request', fixture),
    (error) => error instanceof GoalLockError && error.kind === 'integrity',
  );

  assert.deepEqual(await readFile(join(fixture.root, '.goal-lock', 'changes', 'CR-0001.json')), before.proposedBytes);
  assert.deepEqual(await readFile(join(fixture.root, '.goal-lock', 'changes', 'CR-0002.json')), before.terminalBytes);
  assert.deepEqual(await readFile(join(fixture.root, '.goal-lock', 'lock.json')), lockBefore);
});

function refreshTestChange(record) {
  record.candidate_digest = independentSha256(canonicalBytes(record.candidate_goal));
  const {
    status: _status,
    proposal_digest: _proposalDigest,
    approval_phrase: _approvalPhrase,
    ...payload
  } = record;
  record.proposal_digest = independentSha256(canonicalBytes(payload));
  record.approval_phrase = `APPROVE ${record.id} GOAL VERSION ${record.candidate_goal.goal_version} ${record.proposal_digest.slice(0, 12)}`;
  return record;
}

async function rewriteTestChange(fixture, mutate) {
  const changePath = join(fixture.root, '.goal-lock', 'changes', 'CR-0001.json');
  const change = parseCanonicalJson(await readFile(changePath), 'test change');
  mutate(change);
  const bytes = canonicalBytes(change);
  await writeFile(changePath, bytes);
  await rewriteTestLock(fixture, (lock) => {
    lock.change_head = { change_request_id: 'CR-0001', digest: independentSha256(bytes) };
  });
}

test('change verification fails closed for malformed identity, digest, base, candidate, coverage, phrase, references, and head state', async (testContext) => {
  const cases = [
    ['ID mismatch', (change) => { change.id = 'CR-0002'; }],
    ['candidate digest', (change) => { change.candidate_digest = 'f'.repeat(64); }],
    ['proposal digest', (change) => { change.proposal_digest = 'f'.repeat(64); }],
    ['approval phrase', (change) => { change.approval_phrase = 'APPROVE CR-0001 GOAL VERSION 2 ffffffffffff'; }],
    ['unsupported status', (change) => { change.status = 'open'; }],
    ['unknown envelope field', (change) => { change.rejection_reason = 'not part of the fixed contract'; }],
    ['stale base', (change) => {
      change.base_goal.goal_id = 'GL-BETA';
      change.candidate_goal.goal_id = 'GL-BETA';
      refreshTestChange(change);
    }],
    ['skipped candidate version', (change) => {
      change.candidate_goal.goal_version = 3;
      change.candidate_goal.predecessor.goal_version = 2;
      refreshTestChange(change);
    }],
    ['omitted semantic difference', (change) => {
      change.changes = change.changes.slice(0, 1);
      refreshTestChange(change);
    }],
    ['unknown affected task', (change) => {
      change.affected_tasks = ['TASK-9999'];
      refreshTestChange(change);
    }],
    ['unknown affected criterion', (change) => {
      change.affected_criteria = ['AC-999'];
      refreshTestChange(change);
    }],
  ];

  for (const [label, mutate] of cases) {
    const { fixture, repository } = await createChangeProposalFixture(testContext);
    await repository.proposeGoalChange(fixture.root, changeProposalInput(), fixture);
    await rewriteTestChange(fixture, mutate);

    const verification = await repository.verifyGoalRepository(fixture.root, fixture);

    assert.equal(verification.state, 'TAMPERED', label);
  }

  for (const [label, arrange] of [
    ['filename gap', async (fixture) => rename(
      join(fixture.root, '.goal-lock', 'changes', 'CR-0001.json'),
      join(fixture.root, '.goal-lock', 'changes', 'CR-0002.json'),
    )],
    ['head mismatch', async (fixture) => rewriteTestLock(fixture, (lock) => {
      lock.change_head.digest = 'f'.repeat(64);
    })],
  ]) {
    const { fixture, repository } = await createChangeProposalFixture(testContext);
    await repository.proposeGoalChange(fixture.root, changeProposalInput(), fixture);
    await arrange(fixture);
    assert.equal((await repository.verifyGoalRepository(fixture.root, fixture)).state, 'TAMPERED', label);
  }
});

test('change verification rejects a proposed request that is not the terminal lock head', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const repository = await goalRepository();
  await repository.initializeGoal(fixture.root, goalV1(), fixture);
  await repository.lockInitialGoal(fixture.root, 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766', fixture);
  await installNonHeadProposedChangeState(fixture);

  const verification = await repository.verifyGoalRepository(fixture.root, fixture);

  assert.equal(verification.state, 'TAMPERED');
});

async function proposeChangeForApproval(testContext, overrides = {}, withEvidence = false) {
  const { fixture, repository } = await createChangeProposalFixture(testContext);
  if (withEvidence) await repository.recordGoalEvent(fixture.root, evidenceInput(), fixture);
  const receipt = await repository.proposeGoalChange(
    fixture.root,
    changeProposalInput(overrides),
    fixture,
  );
  return { fixture, repository, receipt };
}

test('exact change approval rejects generic, inexact, stale, competing, and tampered proposals', async (testContext) => {
  for (const approval of [
    'APPROVE',
    'APPROVE CR-0002 GOAL VERSION 2 3cbab5b6bf74',
    'APPROVE CR-0001 GOAL VERSION 3 3cbab5b6bf74',
    'APPROVE CR-0001 GOAL VERSION 2 ffffffffffff',
    'approve cr-0001 goal version 2 3cbab5b6bf74',
    ' APPROVE CR-0001 GOAL VERSION 2 3cbab5b6bf74',
  ]) {
    const { fixture, repository } = await proposeChangeForApproval(testContext);
    await assert.rejects(
      repository.approveGoalChange(fixture.root, 'CR-0001', approval, fixture),
      (error) => error instanceof GoalLockError && error.kind === 'approval',
      approval,
    );
  }

  const stale = await proposeChangeForApproval(testContext);
  await stale.repository.rejectGoalChange(stale.fixture.root, 'CR-0001', 'Keep the accepted outcome', stale.fixture);
  await assert.rejects(
    stale.repository.approveGoalChange(stale.fixture.root, 'CR-0001', stale.receipt.approval_required, stale.fixture),
    (error) => error instanceof GoalLockError && error.kind === 'approval',
  );

  const tampered = await proposeChangeForApproval(testContext);
  await writeFile(
    join(tampered.fixture.root, '.goal-lock', 'changes', 'CR-0001.json'),
    canonicalBytes({ ...expectedChangeRequest(), rationale: 'Tampered request bytes' }),
  );
  await assert.rejects(
    tampered.repository.approveGoalChange(tampered.fixture.root, 'CR-0001', tampered.receipt.approval_required, tampered.fixture),
    (error) => error instanceof GoalLockError && error.kind === 'integrity',
  );

  for (const [label, mutate] of [
    ['stale base digest', (change) => {
      change.base_goal.goal_digest = 'f'.repeat(64);
      change.candidate_goal.predecessor.goal_digest = 'f'.repeat(64);
      refreshTestChange(change);
    }],
    ['skipped candidate version', (change) => {
      change.candidate_goal.goal_version = 3;
      change.candidate_goal.predecessor.goal_version = 2;
      refreshTestChange(change);
    }],
  ]) {
    const changed = await proposeChangeForApproval(testContext);
    await rewriteTestChange(changed.fixture, mutate);
    await assert.rejects(
      changed.repository.approveGoalChange(changed.fixture.root, 'CR-0001', changed.receipt.approval_required, changed.fixture),
      (error) => error instanceof GoalLockError && error.kind === (label === 'stale base digest' ? 'approval' : 'integrity'),
      label,
    );
  }

  const competing = createGoalLockFixture(testContext);
  const competingRepository = await goalRepository();
  await competingRepository.initializeGoal(competing.root, goalV1(), competing);
  await competingRepository.lockInitialGoal(competing.root, 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766', competing);
  await installNonHeadProposedChangeState(competing);
  await assert.rejects(
    competingRepository.approveGoalChange(competing.root, 'CR-0001', 'APPROVE CR-0001 GOAL VERSION 2 3cbab5b6bf74', competing),
    (error) => error instanceof GoalLockError && error.kind === 'integrity',
  );

  const wrongId = await proposeChangeForApproval(testContext);
  await assert.rejects(
    wrongId.repository.approveGoalChange(wrongId.fixture.root, 'CR-0002', wrongId.receipt.approval_required, wrongId.fixture),
    (error) => error instanceof GoalLockError && error.kind === 'approval',
  );
  assert.equal((await wrongId.repository.verifyGoalRepository(wrongId.fixture.root, wrongId.fixture)).state, 'CHANGE_PENDING');
});

test('exact change approval atomically installs the candidate, archives the plan, and selectively invalidates', async (testContext) => {
  const { fixture, repository, receipt } = await proposeChangeForApproval(testContext, {}, true);
  const directory = join(fixture.root, '.goal-lock');
  const priorGoal = await readFile(join(directory, 'current.json'));
  const priorPlan = await readFile(join(directory, 'plan.json'));
  const priorEvidence = await readFile(join(directory, 'evidence', 'AC-001', 'EVID-0001.json'));
  const priorLock = parseCanonicalJson(await readFile(join(directory, 'lock.json')), 'prior lock');
  const result = await repository.approveGoalChange(fixture.root, 'CR-0001', receipt.approval_required, fixture);

  assert.deepEqual(result, { state: 'LOCKED', goal_version: 2 });
  const current = parseCanonicalJson(await readFile(join(directory, 'current.json')), 'current v2');
  assert.deepEqual(current, expectedChangeRequest().candidate_goal);
  assert.deepEqual(await readFile(join(directory, 'history', 'goals', 'v0002.json')), canonicalBytes(current));
  assert.deepEqual(await readFile(join(directory, 'history', 'goals', 'v0001.json')), priorGoal);
  assert.deepEqual(await readFile(join(directory, 'history', 'plans', 'v0001-r0001.json')), priorPlan);
  assert.deepEqual(await readFile(join(directory, 'evidence', 'AC-001', 'EVID-0001.json')), priorEvidence);

  const plan = parseCanonicalJson(await readFile(join(directory, 'plan.json')), 'v2 plan');
  assert.equal(plan.goal.goal_version, 2);
  assert.equal(plan.plan_revision, 1);
  assert.equal(plan.tasks.find((task) => task.id === 'TASK-0001').status, 'stale');
  assert.equal(plan.tasks.find((task) => task.id === 'TASK-0002').status, 'pending');
  assert.equal(plan.next_task_id, null);
  const staleEvidence = parseCanonicalJson(await readFile(join(directory, 'evidence', 'AC-001', 'EVID-0002.json')), 'stale evidence');
  assert.equal(staleEvidence.state, 'stale');
  assert.equal(staleEvidence.goal.goal_version, 2);
  assert.equal(staleEvidence.plan_revision, 1);
  assert.equal(staleEvidence.supersedes, 'EVID-0001');
  const progress = (await readFile(join(directory, 'progress.jsonl'), 'utf8'))
    .trim().split('\n').map((line) => parseCanonicalJson(Buffer.from(`${line}\n`), 'progress event'));
  assert.deepEqual(progress.slice(-4).map((event) => event.event_type), [
    'plan-revision', 'goal-change', 'verification-result', 'evidence-invalidation',
  ]);
  const approved = parseCanonicalJson(await readFile(join(directory, 'changes', 'CR-0001.json')), 'approved request');
  assert.equal(approved.status, 'approved');
  const lock = parseCanonicalJson(await readFile(join(directory, 'lock.json')), 'v2 lock');
  assert.equal(lock.goal_version, 2);
  assert.equal(lock.state_revision, priorLock.state_revision + 1);
  assert.equal(lock.predecessor_digest, independentSha256(priorGoal));
  assert.equal(lock.proposal_digest, receipt.proposal_digest);
  assert.deepEqual(lock.change_head, { change_request_id: 'CR-0001', digest: independentSha256(canonicalBytes(approved)) });
  assert.equal(lock.evidence_heads['AC-001'].evidence_id, 'EVID-0002');
  assert.equal((await repository.verifyGoalRepository(fixture.root, fixture)).state, 'LOCKED');
  await assert.rejects(
    repository.approveGoalChange(fixture.root, 'CR-0001', receipt.approval_required, fixture),
    (error) => error instanceof GoalLockError && error.kind === 'approval',
  );
});

test('selective invalidation retains unaffected task status across the new goal plan', async (testContext) => {
  const { fixture, repository } = await createChangeProposalFixture(testContext);
  await repository.recordGoalEvent(fixture.root, progressInput('Started before the change', {
    event_type: 'task-start',
    evidence_refs: [],
  }), fixture);
  const receipt = await repository.proposeGoalChange(fixture.root, changeProposalInput({
    affected_tasks: [],
    affected_criteria: [],
  }), fixture);

  await repository.approveGoalChange(fixture.root, 'CR-0001', receipt.approval_required, fixture);

  const plan = parseCanonicalJson(await readFile(join(fixture.root, '.goal-lock', 'plan.json')), 'retained task plan');
  assert.equal(plan.tasks.find((task) => task.id === 'TASK-0001').status, 'in_progress');
  assert.equal(plan.next_task_id, 'TASK-0001');
  assert.equal((await repository.verifyGoalRepository(fixture.root, fixture)).state, 'LOCKED');
});

test('selective invalidation preserves unaffected plan and evidence state and creates an empty revision without a prior plan', async (testContext) => {
  for (const [label, affectedTasks, affectedCriteria, expectTaskStale, expectEvidenceStale] of [
    ['none', [], [], false, false],
    ['task only', ['TASK-0001'], [], true, false],
    ['evidence only', [], ['AC-001'], false, true],
    ['all affected', ['TASK-0001'], ['AC-001'], true, true],
  ]) {
    const { fixture, repository, receipt } = await proposeChangeForApproval(testContext, {
      affected_tasks: affectedTasks,
      affected_criteria: affectedCriteria,
    }, true);
    await repository.approveGoalChange(fixture.root, 'CR-0001', receipt.approval_required, fixture);
    const directory = join(fixture.root, '.goal-lock');
    const plan = parseCanonicalJson(await readFile(join(directory, 'plan.json')), `${label} plan`);
    assert.equal(plan.tasks.find((task) => task.id === 'TASK-0001').status, expectTaskStale ? 'stale' : 'pending', label);
    assert.equal(existsSync(join(directory, 'evidence', 'AC-001', 'EVID-0002.json')), expectEvidenceStale, label);
    assert.equal((await repository.verifyGoalRepository(fixture.root, fixture)).state, 'LOCKED', label);
  }

  const fixture = createGoalLockFixture(testContext);
  const repository = await goalRepository();
  await repository.initializeGoal(fixture.root, goalV1(), fixture);
  await repository.lockInitialGoal(fixture.root, 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766', fixture);
  const receipt = await repository.proposeGoalChange(fixture.root, changeProposalInput({
    affected_tasks: [],
    affected_criteria: [],
  }), fixture);
  await repository.approveGoalChange(fixture.root, 'CR-0001', receipt.approval_required, fixture);
  const plan = parseCanonicalJson(await readFile(join(fixture.root, '.goal-lock', 'plan.json')), 'empty v2 plan');
  assert.equal(plan.goal.goal_version, 2);
  assert.equal(plan.plan_revision, 1);
  assert.deepEqual(plan.tasks, []);
  assert.equal((await repository.verifyGoalRepository(fixture.root, fixture)).state, 'LOCKED');
});

test('exact change approval rolls back every installed file when any installation fails', async (testContext) => {
  const targets = [
    '.goal-lock/history/goals/v0001.json',
    '.goal-lock/current.json',
    '.goal-lock/history/goals/v0002.json',
    '.goal-lock/history/plans/v0001-r0001.json',
    '.goal-lock/plan.json',
    '.goal-lock/evidence/AC-001/EVID-0001.json',
    '.goal-lock/evidence/AC-001/EVID-0002.json',
    '.goal-lock/progress.jsonl',
    '.goal-lock/changes/CR-0001.json',
    '.goal-lock/lock.json',
  ];
  for (const target of targets) {
    const { fixture, repository, receipt } = await proposeChangeForApproval(testContext, {}, true);
    const before = await readFile(join(fixture.root, '.goal-lock', 'current.json'));
    fixture.transactionFaults.finalReadBack = ({ targets: committed }) => {
      if (!committed.includes(target)) throw new Error(`approval target missing from commit at ${target}`);
      throw new Error(`approval final verification failure at ${target}`);
    };
    await assert.rejects(
      repository.approveGoalChange(fixture.root, 'CR-0001', receipt.approval_required, fixture),
      new RegExp(`approval final verification failure at ${target.replace(/[.]/g, '\\.')}`),
      target,
    );
    assert.deepEqual(await readFile(join(fixture.root, '.goal-lock', 'current.json')), before, target);
    assert.equal((await repository.verifyGoalRepository(fixture.root, fixture)).state, 'CHANGE_PENDING', target);
  }
});

const PLAN_REVISION_EVENT_DIGEST = 'bdda7b3968a011b2229bb86936f21a2d51e9a070a992dcd573c91c4bb61e4b72';
const SECOND_PLAN_REVISION_EVENT_DIGEST = '9bcd19d7bb31cbac67b8de8749da59f6e8fb5617c4f87c6fa5574e77ce43bea1';
const FOCUSED_RESULT_EVENT_DIGEST = 'a0e6791495980eb553a5802b0baf094c3f5ab84f52f78c6028b6762e46963093';
const FULL_RESULT_EVENT_DIGEST = 'acf5a53569b61201d417c4463bf21149df52078ec809a94a0c33a5f679c9f142';
const PLAN_REVISION_EVENT_LINE = '{"event_digest":"bdda7b3968a011b2229bb86936f21a2d51e9a070a992dcd573c91c4bb61e4b72","event_id":"EVT-000001","event_type":"plan-revision","evidence_refs":[],"goal":{"goal_digest":"92d74f6bf766e096e71b949ff57e2d9a12302a4519226d05cf67c2b544babaa6","goal_id":"GL-ALPHA","goal_version":1},"plan_revision":1,"previous_event_digest":null,"recorded_at":"2026-08-23T00:00:00.000Z","schema_version":1,"summary":"Recorded plan revision 1","task_id":null}\n';
const SECOND_PLAN_REVISION_EVENT_LINE = '{"event_digest":"9bcd19d7bb31cbac67b8de8749da59f6e8fb5617c4f87c6fa5574e77ce43bea1","event_id":"EVT-000002","event_type":"plan-revision","evidence_refs":[],"goal":{"goal_digest":"92d74f6bf766e096e71b949ff57e2d9a12302a4519226d05cf67c2b544babaa6","goal_id":"GL-ALPHA","goal_version":1},"plan_revision":2,"previous_event_digest":"bdda7b3968a011b2229bb86936f21a2d51e9a070a992dcd573c91c4bb61e4b72","recorded_at":"2026-08-23T00:00:00.000Z","schema_version":1,"summary":"Recorded plan revision 2","task_id":null}\n';
const FOCUSED_RESULT_EVENT_LINE = '{"event_digest":"a0e6791495980eb553a5802b0baf094c3f5ab84f52f78c6028b6762e46963093","event_id":"EVT-000002","event_type":"verification-result","evidence_refs":[],"goal":{"goal_digest":"92d74f6bf766e096e71b949ff57e2d9a12302a4519226d05cf67c2b544babaa6","goal_id":"GL-ALPHA","goal_version":1},"plan_revision":1,"previous_event_digest":"bdda7b3968a011b2229bb86936f21a2d51e9a070a992dcd573c91c4bb61e4b72","recorded_at":"2026-08-23T00:00:00.000Z","schema_version":1,"summary":"Focused tests passed","task_id":"TASK-0001"}\n';
const FULL_RESULT_EVENT_LINE = '{"event_digest":"acf5a53569b61201d417c4463bf21149df52078ec809a94a0c33a5f679c9f142","event_id":"EVT-000003","event_type":"verification-result","evidence_refs":[],"goal":{"goal_digest":"92d74f6bf766e096e71b949ff57e2d9a12302a4519226d05cf67c2b544babaa6","goal_id":"GL-ALPHA","goal_version":1},"plan_revision":1,"previous_event_digest":"a0e6791495980eb553a5802b0baf094c3f5ab84f52f78c6028b6762e46963093","recorded_at":"2026-08-23T00:00:00.000Z","schema_version":1,"summary":"Full tests passed","task_id":"TASK-0001"}\n';

function progressInput(summary = 'Focused tests passed', overrides = {}) {
  return {
    kind: 'progress',
    event_type: 'verification-result',
    task_id: 'TASK-0001',
    summary,
    evidence_refs: [],
    ...overrides,
  };
}

function evidenceInput(overrides = {}) {
  return {
    kind: 'evidence',
    acceptance_criterion_id: 'AC-001',
    task_id: 'TASK-0001',
    method: 'node --test tests/goal-lock.test.js',
    observed_result: 'Focused tests passed',
    artifact_refs: ['reports/focused.txt', 'src/goal-lock/repository.js'],
    workspace_fingerprint: 'a'.repeat(64),
    state: 'pass',
    supersedes: null,
    ...overrides,
  };
}

const FIRST_EVIDENCE_DIGEST = '5bdd5f99d1f3043cd6922e97b9a15551e9dbf2c0163f57110008929c961c13cd';
const FIRST_EVIDENCE_BYTES = '{"acceptance_criterion_id":"AC-001","artifact_refs":["reports/focused.txt","src/goal-lock/repository.js"],"evidence_id":"EVID-0001","goal":{"goal_digest":"92d74f6bf766e096e71b949ff57e2d9a12302a4519226d05cf67c2b544babaa6","goal_id":"GL-ALPHA","goal_version":1},"method":"node --test tests/goal-lock.test.js","observed_result":"Focused tests passed","plan_revision":1,"recorded_at":"2026-08-23T00:00:00.000Z","schema_version":1,"state":"pass","supersedes":null,"task_id":"TASK-0001","workspace_fingerprint":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}\n';
const FIRST_EVIDENCE_EVENT_DIGEST = '9a5a639ffb4eabf33adaf67230359d49a89e38cac4c1c0d9f9ec58d1c7c2555c';
const FIRST_EVIDENCE_EVENT_LINE = '{"event_digest":"9a5a639ffb4eabf33adaf67230359d49a89e38cac4c1c0d9f9ec58d1c7c2555c","event_id":"EVT-000002","event_type":"verification-result","evidence_refs":["EVID-0001"],"goal":{"goal_digest":"92d74f6bf766e096e71b949ff57e2d9a12302a4519226d05cf67c2b544babaa6","goal_id":"GL-ALPHA","goal_version":1},"plan_revision":1,"previous_event_digest":"bdda7b3968a011b2229bb86936f21a2d51e9a070a992dcd573c91c4bb61e4b72","recorded_at":"2026-08-23T00:00:00.000Z","schema_version":1,"summary":"Recorded evidence AC-001/EVID-0001 sha256:5bdd5f99d1f3043cd6922e97b9a15551e9dbf2c0163f57110008929c961c13cd as pass","task_id":"TASK-0001"}\n';

async function createProgressFixture(testContext) {
  const fixture = createGoalLockFixture(testContext);
  const repository = await goalRepository();
  await repository.initializeGoal(fixture.root, goalV1(), fixture);
  await repository.lockInitialGoal(fixture.root, 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766', fixture);
  await repository.revisePlan(fixture.root, planCandidate(), 'aligned', fixture);
  await repository.recordGoalEvent(fixture.root, progressInput(), fixture);
  await repository.recordGoalEvent(fixture.root, progressInput('Full tests passed'), fixture);
  return { fixture, repository };
}

function withEventDigest(event, previousEventDigest) {
  const { event_digest: _eventDigest, ...payload } = event;
  payload.previous_event_digest = previousEventDigest;
  return {
    ...payload,
    event_digest: independentSha256(canonicalBytes(payload)),
  };
}

async function rewriteTestProgressLedger(fixture, descriptors) {
  let previousEventDigest = null;
  const events = descriptors.map((descriptor, index) => {
    const payload = {
      schema_version: 1,
      event_id: `EVT-${String(index + 1).padStart(6, '0')}`,
      recorded_at: '2026-08-23T00:00:00.000Z',
      goal: activeGoalReference(),
      plan_revision: 1,
      task_id: null,
      event_type: 'plan-revision',
      summary: `Test event ${index + 1}`,
      evidence_refs: [],
      ...descriptor,
      previous_event_digest: previousEventDigest,
    };
    const event = {
      ...payload,
      event_digest: independentSha256(canonicalBytes(payload)),
    };
    previousEventDigest = event.event_digest;
    return event;
  });
  await writeFile(
    join(fixture.root, '.goal-lock', 'progress.jsonl'),
    Buffer.concat(events.map((event) => canonicalBytes(event))),
  );
  await rewriteTestLock(fixture, (lock) => {
    lock.state_revision = events.length + 1;
    lock.progress_head = {
      event_id: events.at(-1).event_id,
      digest: events.at(-1).event_digest,
    };
  });
  return events;
}

async function rewriteTestPlan(fixture, mutate) {
  const planPath = join(fixture.root, '.goal-lock', 'plan.json');
  const plan = parseCanonicalJson(await readFile(planPath), 'test plan');
  mutate(plan);
  await writeFile(planPath, canonicalBytes(plan));
}

test('plan revision creates revision 1 and its automatic progress event in one state revision', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const { initializeGoal, lockInitialGoal, revisePlan } = await goalRepository();
  await initializeGoal(fixture.root, goalV1(), fixture);
  await lockInitialGoal(fixture.root, 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766', fixture);
  const directory = join(fixture.root, '.goal-lock');
  const currentBefore = await readFile(join(directory, 'current.json'));
  const historyBefore = await readFile(join(directory, 'history', 'goals', 'v0001.json'));

  const receipt = await revisePlan(fixture.root, planCandidate(), 'aligned', fixture);

  assert.deepEqual(receipt, {
    state: 'LOCKED',
    goal_id: 'GL-ALPHA',
    goal_version: 1,
    goal_digest: activeGoalReference().goal_digest,
    plan_revision: 1,
    classification: 'aligned',
  });
  assert.deepEqual(await readFile(join(directory, 'plan.json')), canonicalBytes(completePlan(1)));
  assert.equal(existsSync(join(directory, 'history', 'plans')), false);
  assert.deepEqual(await readFile(join(directory, 'current.json')), currentBefore);
  assert.deepEqual(await readFile(join(directory, 'history', 'goals', 'v0001.json')), historyBefore);
  assert.deepEqual(await readFile(join(directory, 'progress.jsonl')), Buffer.from(PLAN_REVISION_EVENT_LINE));
  const lock = parseCanonicalJson(await readFile(join(directory, 'lock.json')), 'test lock');
  assert.equal(lock.state_revision, 2);
  assert.deepEqual(lock.progress_head, { event_id: 'EVT-000001', digest: PLAN_REVISION_EVENT_DIGEST });
  assert.equal(lock.change_head, null);
  assert.deepEqual(lock.evidence_heads, {});
  const { record_digest: recordDigest, ...lockWithoutDigest } = lock;
  assert.equal(recordDigest, independentSha256(canonicalBytes(lockWithoutDigest)));
});

test('plan revision archives each replaced plan byte-for-byte and preserves earlier archives', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const { initializeGoal, lockInitialGoal, revisePlan, verifyGoalRepository } = await goalRepository();
  await initializeGoal(fixture.root, goalV1(), fixture);
  await lockInitialGoal(fixture.root, 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766', fixture);
  const directory = join(fixture.root, '.goal-lock');
  await revisePlan(fixture.root, planCandidate('First implementation'), 'aligned', fixture);
  const revisionOneBytes = await readFile(join(directory, 'plan.json'));

  await revisePlan(fixture.root, planCandidate('Aligned refinement'), 'aligned', fixture);
  const revisionTwoBytes = await readFile(join(directory, 'plan.json'));
  const archivedRevisionOne = await readFile(join(directory, 'history', 'plans', 'v0001-r0001.json'));
  assert.deepEqual(archivedRevisionOne, revisionOneBytes);

  await revisePlan(fixture.root, planCandidate('Implementation choice'), 'implementation-choice', fixture);

  assert.deepEqual(await readFile(join(directory, 'history', 'plans', 'v0001-r0001.json')), archivedRevisionOne);
  assert.deepEqual(await readFile(join(directory, 'history', 'plans', 'v0001-r0002.json')), revisionTwoBytes);
  assert.deepEqual(await readFile(join(directory, 'plan.json')), canonicalBytes({
    ...completePlan(3),
    tasks: [{ ...completePlan(3).tasks[0], outcome: 'Implementation choice' }, completePlan(3).tasks[1]],
  }));
  const events = (await readFile(join(directory, 'progress.jsonl'), 'utf8')).trimEnd().split('\n').map(JSON.parse);
  assert.deepEqual(events.map((event) => [event.event_id, event.event_type, event.plan_revision]), [
    ['EVT-000001', 'plan-revision', 1],
    ['EVT-000002', 'plan-revision', 2],
    ['EVT-000003', 'plan-revision', 3],
  ]);
  const lock = parseCanonicalJson(await readFile(join(directory, 'lock.json')), 'test lock');
  assert.equal(lock.state_revision, 4);
  assert.deepEqual(lock.progress_head, { event_id: 'EVT-000003', digest: events[2].event_digest });
  assert.equal((await verifyGoalRepository(fixture.root, fixture)).state, 'LOCKED');
});

test('plan revision rejects unsupported classifications and caller-owned envelope fields', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const { initializeGoal, lockInitialGoal, revisePlan } = await goalRepository();
  await initializeGoal(fixture.root, goalV1(), fixture);
  await lockInitialGoal(fixture.root, 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766', fixture);
  const directory = join(fixture.root, '.goal-lock');

  await assert.rejects(
    revisePlan(fixture.root, planCandidate(), 'goal-change', fixture),
    (error) => error instanceof GoalLockError && error.kind === 'input',
  );
  await assert.rejects(
    revisePlan(fixture.root, { ...planCandidate(), plan_revision: 9 }, 'aligned', fixture),
    (error) => error instanceof GoalLockError && error.kind === 'input',
  );

  assert.equal(existsSync(join(directory, 'plan.json')), false);
  assert.equal(parseCanonicalJson(await readFile(join(directory, 'lock.json'))).state_revision, 1);
});

test('plan revision task status requires every first-plan task to begin pending', async (testContext) => {
  const { initializeGoal, lockInitialGoal, revisePlan } = await goalRepository();
  const cases = [
    ['in_progress', 'TASK-0001'],
    ['blocked', null],
    ['complete', 'TASK-0002'],
    ['stale', null],
  ];
  for (const [status, nextTaskId] of cases) {
    const fixture = createGoalLockFixture(testContext);
    await initializeGoal(fixture.root, goalV1(), fixture);
    await lockInitialGoal(fixture.root, 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766', fixture);
    const candidate = planCandidate();
    candidate.tasks[0].status = status;
    candidate.next_task_id = nextTaskId;

    await assert.rejects(
      revisePlan(fixture.root, candidate, 'aligned', fixture),
      (error) => error instanceof GoalLockError && error.kind === 'input',
      status,
    );
    assert.equal(existsSync(join(fixture.root, '.goal-lock', 'plan.json')), false, status);
  }
});

test('plan revision task status preserves shared tasks and requires new tasks to begin pending', async (testContext) => {
  const { initializeGoal, lockInitialGoal, revisePlan } = await goalRepository();
  const cases = [
    ['shared in_progress', (candidate) => { candidate.tasks[0].status = 'in_progress'; }],
    ['shared blocked', (candidate) => { candidate.tasks[0].status = 'blocked'; candidate.next_task_id = null; }],
    ['shared complete', (candidate) => { candidate.tasks[0].status = 'complete'; candidate.next_task_id = 'TASK-0002'; }],
    ['shared stale', (candidate) => { candidate.tasks[0].status = 'stale'; candidate.next_task_id = null; }],
    ['new complete', (candidate) => {
      candidate.tasks.push({
        id: 'TASK-0004',
        outcome: 'Bypass the progress ledger',
        acceptance_criteria: ['AC-001'],
        dependencies: [],
        permitted_paths: ['src/goal-lock/repository.js'],
        verification: 'Run the focused goal-lock tests',
        status: 'complete',
      });
    }],
  ];
  for (const [label, mutate] of cases) {
    const fixture = createGoalLockFixture(testContext);
    await initializeGoal(fixture.root, goalV1(), fixture);
    await lockInitialGoal(fixture.root, 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766', fixture);
    await revisePlan(fixture.root, planCandidate(), 'aligned', fixture);
    const candidate = planCandidate('Refined implementation');
    mutate(candidate);

    await assert.rejects(
      revisePlan(fixture.root, candidate, 'aligned', fixture),
      (error) => error instanceof GoalLockError && error.kind === 'input',
      label,
    );
  }
});

test('plan revision task status carries an already completed shared task without a new completion event', async (testContext) => {
  const { fixture, repository } = await createPlannedFixture(testContext);
  await installTestEvidence(fixture);
  await repository.recordGoalEvent(fixture.root, progressInput('Started implementation', { event_type: 'task-start' }), fixture);
  await repository.recordGoalEvent(fixture.root, progressInput('Completed implementation', {
    event_type: 'task-complete',
    evidence_refs: ['EVID-0001'],
  }), fixture);
  const current = parseCanonicalJson(await readFile(join(fixture.root, '.goal-lock', 'plan.json')), 'test plan');
  const candidate = {
    next_task_id: current.next_task_id,
    tasks: current.tasks.map((task) => task.id === 'TASK-0001'
      ? { ...task, outcome: 'Refined completed implementation' }
      : task),
    deferred: current.deferred,
  };

  await repository.revisePlan(fixture.root, candidate, 'aligned', fixture);

  const revised = parseCanonicalJson(await readFile(join(fixture.root, '.goal-lock', 'plan.json')), 'test plan');
  assert.equal(revised.tasks[0].status, 'complete');
  assert.equal(revised.next_task_id, 'TASK-0002');
  assert.equal((await repository.verifyGoalRepository(fixture.root, fixture)).state, 'LOCKED');
});

test('plan revision rejects wrong bindings, skipped revisions, and changed goal versions', async (testContext) => {
  const { initializeGoal, lockInitialGoal, revisePlan } = await goalRepository();
  const cases = [
    ['wrong goal reference', (plan) => { plan.goal.goal_digest = 'f'.repeat(64); }],
    ['skipped revision', (plan) => { plan.plan_revision = 3; }],
    ['changed goal version', (plan) => { plan.goal.goal_version = 2; }],
  ];
  for (const [label, tamper] of cases) {
    const fixture = createGoalLockFixture(testContext);
    await initializeGoal(fixture.root, goalV1(), fixture);
    await lockInitialGoal(fixture.root, 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766', fixture);
    await revisePlan(fixture.root, planCandidate(), 'aligned', fixture);
    const planPath = join(fixture.root, '.goal-lock', 'plan.json');
    const plan = parseCanonicalJson(await readFile(planPath), 'test plan');
    tamper(plan);
    await writeFile(planPath, canonicalBytes(plan));

    await assert.rejects(
      revisePlan(fixture.root, planCandidate(), 'aligned', fixture),
      (error) => error instanceof GoalLockError && error.kind === 'integrity',
      label,
    );
  }
});

test('plan revision rejects criteria outside the goal without changing accepted state', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const { initializeGoal, lockInitialGoal, revisePlan } = await goalRepository();
  await initializeGoal(fixture.root, goalV1(), fixture);
  await lockInitialGoal(fixture.root, 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766', fixture);
  const candidate = planCandidate();
  candidate.tasks[0].acceptance_criteria = ['AC-002'];
  const lockBefore = await readFile(join(fixture.root, '.goal-lock', 'lock.json'));

  await assert.rejects(
    revisePlan(fixture.root, candidate, 'aligned', fixture),
    (error) => error instanceof GoalLockError && error.kind === 'input',
  );

  assert.equal(existsSync(join(fixture.root, '.goal-lock', 'plan.json')), false);
  assert.deepEqual(await readFile(join(fixture.root, '.goal-lock', 'lock.json')), lockBefore);
});

test('plan revision rejects draft, tampered, and change-pending repositories', async (testContext) => {
  const { initializeGoal, lockInitialGoal, proposeGoalChange, revisePlan } = await goalRepository();

  const draft = createGoalLockFixture(testContext);
  await initializeGoal(draft.root, goalV1(), draft);
  await assert.rejects(
    revisePlan(draft.root, planCandidate(), 'aligned', draft),
    (error) => error instanceof GoalLockError && error.kind === 'state',
  );

  const tampered = createGoalLockFixture(testContext);
  await initializeGoal(tampered.root, goalV1(), tampered);
  await lockInitialGoal(tampered.root, 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766', tampered);
  await writeFile(join(tampered.root, '.goal-lock', 'current.json'), canonicalBytes({ ...goalV1(), objective: 'Tampered objective' }));
  await assert.rejects(
    revisePlan(tampered.root, planCandidate(), 'aligned', tampered),
    (error) => error instanceof GoalLockError && error.kind === 'integrity',
  );

  const pending = createGoalLockFixture(testContext);
  await initializeGoal(pending.root, goalV1(), pending);
  await lockInitialGoal(pending.root, 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766', pending);
  await proposeGoalChange(pending.root, changeProposalInput({ affected_tasks: [] }), pending);
  await assert.rejects(
    revisePlan(pending.root, planCandidate(), 'aligned', pending),
    (error) => error instanceof GoalLockError && error.kind === 'state',
  );
});

test('plan revision rejects unsupported change status as tampered state', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const { initializeGoal, lockInitialGoal, revisePlan, verifyGoalRepository } = await goalRepository();
  await initializeGoal(fixture.root, goalV1(), fixture);
  await lockInitialGoal(fixture.root, 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766', fixture);
  await mkdir(join(fixture.root, '.goal-lock', 'changes'));
  await writeFile(join(fixture.root, '.goal-lock', 'changes', 'CR-0001.json'), canonicalBytes({
    ...structuralChange(),
    status: 'open',
  }));

  assert.equal((await verifyGoalRepository(fixture.root, fixture)).state, 'TAMPERED');
  await assert.rejects(
    revisePlan(fixture.root, planCandidate(), 'aligned', fixture),
    (error) => error instanceof GoalLockError && error.kind === 'integrity',
  );
});

test('plan revision refuses a baseline replaced after semantic verification', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const { initializeGoal, lockInitialGoal, revisePlan } = await goalRepository();
  await initializeGoal(fixture.root, goalV1(), fixture);
  await lockInitialGoal(fixture.root, 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766', fixture);
  const directory = join(fixture.root, '.goal-lock');
  const lockBefore = await readFile(join(directory, 'lock.json'));
  let armed = false;
  let rootReads = 0;
  fixture.workspaceFaults = {};
  fixture.workspaceFaults.beforeVerifyInputs = () => {
    if (armed) return;
    armed = true;
    fixture.workspaceFaults.afterDirectoryRead = async ({ relativePath }) => {
      if (relativePath !== '.goal-lock') return;
      rootReads += 1;
      if (rootReads === 2) {
        await writeFile(join(directory, 'current.json'), canonicalBytes({
          ...goalV1(),
          objective: 'Directly replaced after verification',
        }));
      }
    };
  };

  await assert.rejects(
    revisePlan(fixture.root, planCandidate(), 'aligned', fixture),
    (error) => error instanceof GoalLockError && error.kind === 'integrity',
  );

  assert.equal(rootReads, 2);
  assert.equal(existsSync(join(directory, 'plan.json')), false);
  assert.equal(existsSync(join(directory, 'progress.jsonl')), false);
  assert.deepEqual(await readFile(join(directory, 'lock.json')), lockBefore);
});

test('plan revision progress event rolls back with the plan and lock after an install failure', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const { initializeGoal, lockInitialGoal, revisePlan } = await goalRepository();
  await initializeGoal(fixture.root, goalV1(), fixture);
  await lockInitialGoal(fixture.root, 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766', fixture);
  const directory = join(fixture.root, '.goal-lock');
  const lockBefore = await readFile(join(directory, 'lock.json'));
  fixture.transactionFaults.install = () => { throw new Error('injected plan install failure'); };

  await assert.rejects(
    revisePlan(fixture.root, planCandidate(), 'aligned', fixture),
    /injected plan install failure/,
  );

  assert.equal(existsSync(join(directory, 'plan.json')), false);
  assert.equal(existsSync(join(directory, 'progress.jsonl')), false);
  assert.equal(existsSync(join(directory, 'history', 'plans')), false);
  assert.deepEqual(await readFile(join(directory, 'lock.json')), lockBefore);
});

test('progress ledger public contract validates the exact envelope, prior link, and own digest', () => {
  assert.equal(typeof goalContracts.validateProgressEvent, 'function');
  const event = JSON.parse(PLAN_REVISION_EVENT_LINE);

  assert.deepEqual(goalContracts.validateProgressEvent(event, null), event);
  assert.equal(Object.isFrozen(goalContracts.validateProgressEvent(event, null).goal), true);

  const wrongLink = { ...event, previous_event_digest: 'f'.repeat(64) };
  assert.throws(() => goalContracts.validateProgressEvent(wrongLink, null), /previous_event_digest/i);
  const wrongDigest = { ...event, event_digest: 'f'.repeat(64) };
  assert.throws(() => goalContracts.validateProgressEvent(wrongDigest, null), /event_digest/i);
  const unknownType = { ...event, event_type: 'finished' };
  assert.throws(() => goalContracts.validateProgressEvent(unknownType, null), /event_type/i);
  const callerField = { ...event, kind: 'progress' };
  assert.throws(() => goalContracts.validateProgressEvent(callerField, null), /unknown|field/i);
});

test('progress ledger verification rejects a plan with no automatic plan-revision event', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const { initializeGoal, lockInitialGoal, verifyGoalRepository } = await goalRepository();
  await initializeGoal(fixture.root, goalV1(), fixture);
  await lockInitialGoal(fixture.root, 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766', fixture);
  await writeFile(join(fixture.root, '.goal-lock', 'plan.json'), canonicalBytes(structuralPlan()));

  assert.equal((await verifyGoalRepository(fixture.root, fixture)).state, 'TAMPERED');
});

test('progress ledger records literal canonical bytes with sequential IDs and digest links', async (testContext) => {
  const { fixture, repository } = await createProgressFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');

  assert.deepEqual(
    await readFile(join(directory, 'progress.jsonl')),
    Buffer.from(PLAN_REVISION_EVENT_LINE + FOCUSED_RESULT_EVENT_LINE + FULL_RESULT_EVENT_LINE),
  );
  const lock = parseCanonicalJson(await readFile(join(directory, 'lock.json')), 'test lock');
  assert.equal(lock.state_revision, 4);
  assert.deepEqual(lock.progress_head, { event_id: 'EVT-000003', digest: FULL_RESULT_EVENT_DIGEST });
  assert.equal(lock.change_head, null);
  assert.deepEqual(lock.evidence_heads, {});
  const { record_digest: recordDigest, ...lockWithoutDigest } = lock;
  assert.equal(recordDigest, independentSha256(canonicalBytes(lockWithoutDigest)));
  const verified = await repository.verifyGoalRepository(fixture.root, fixture);
  assert.equal(verified.state, 'LOCKED');
  assert.equal(verified.evidence.optional.progress_events, 3);
});

test('progress ledger rejects caller envelope overrides and unknown task or evidence references without appending', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const { initializeGoal, lockInitialGoal, revisePlan, recordGoalEvent } = await goalRepository();
  await initializeGoal(fixture.root, goalV1(), fixture);
  await lockInitialGoal(fixture.root, 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766', fixture);
  await revisePlan(fixture.root, planCandidate(), 'aligned', fixture);
  const directory = join(fixture.root, '.goal-lock');
  const ledgerBefore = await readFile(join(directory, 'progress.jsonl'));
  const lockBefore = await readFile(join(directory, 'lock.json'));

  const cases = [
    progressInput('Caller timestamp', { recorded_at: '2026-08-23T02:00:00.000Z' }),
    progressInput('Caller ID', { event_id: 'EVT-999999' }),
    progressInput('Unknown task', { task_id: 'TASK-9999' }),
    progressInput('Unknown evidence', { evidence_refs: ['EVID-9999'] }),
    progressInput('Malformed evidence list', { evidence_refs: null }),
    progressInput('Undefined evidence entry', { evidence_refs: [undefined] }),
  ];
  for (const input of cases) {
    await assert.rejects(
      recordGoalEvent(fixture.root, input, fixture),
      (error) => error instanceof GoalLockError && ['input', 'state'].includes(error.kind),
    );
  }

  assert.deepEqual(await readFile(join(directory, 'progress.jsonl')), ledgerBefore);
  assert.deepEqual(await readFile(join(directory, 'lock.json')), lockBefore);
});

test('progress ledger verification rejects deletion, insertion, reordering, rewriting, duplicate IDs, truncation, and missing final LF', async (testContext) => {
  const tamperCases = [
    ['deletion', (lines) => [lines[0], lines[2]]],
    ['insertion', (lines) => [lines[0], lines[2], lines[1], lines[2]]],
    ['reordering', (lines) => [lines[0], lines[2], lines[1]]],
    ['rewriting', (lines) => {
      const rewritten = JSON.parse(lines[1]);
      rewritten.summary = 'Rewritten result';
      return [lines[0], canonicalBytes(rewritten).toString('utf8'), lines[2]];
    }],
    ['duplicate ID', (lines) => {
      const duplicate = JSON.parse(lines[2]);
      duplicate.event_id = 'EVT-000002';
      return [lines[0], lines[1], canonicalBytes(withEventDigest(duplicate, FOCUSED_RESULT_EVENT_DIGEST)).toString('utf8')];
    }],
    ['truncation', (lines) => lines.slice(0, 2)],
    ['missing final LF', (lines) => [lines[0], lines[1], lines[2].slice(0, -1)]],
  ];

  for (const [label, tamper] of tamperCases) {
    const { fixture, repository } = await createProgressFixture(testContext);
    const ledgerPath = join(fixture.root, '.goal-lock', 'progress.jsonl');
    const lines = [PLAN_REVISION_EVENT_LINE, FOCUSED_RESULT_EVENT_LINE, FULL_RESULT_EVENT_LINE];
    await writeFile(ledgerPath, Buffer.from(tamper(lines).join('')));

    const result = await repository.verifyGoalRepository(fixture.root, fixture);
    assert.equal(result.state, 'TAMPERED', label);
  }
});

test('progress ledger verification rejects a validly redigested cross-version event chain', async (testContext) => {
  const { fixture, repository } = await createProgressFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  const first = JSON.parse(PLAN_REVISION_EVENT_LINE);
  const second = JSON.parse(FOCUSED_RESULT_EVENT_LINE);
  second.goal = { goal_id: 'GL-ALPHA', goal_version: 2, goal_digest: 'f'.repeat(64) };
  const redigestedSecond = withEventDigest(second, PLAN_REVISION_EVENT_DIGEST);
  const third = withEventDigest(JSON.parse(FULL_RESULT_EVENT_LINE), redigestedSecond.event_digest);
  await writeFile(join(directory, 'progress.jsonl'), Buffer.concat([
    canonicalBytes(first),
    canonicalBytes(redigestedSecond),
    canonicalBytes(third),
  ]));
  await rewriteTestLock(fixture, (lock) => {
    lock.progress_head = { event_id: 'EVT-000003', digest: third.event_digest };
  });

  assert.equal((await repository.verifyGoalRepository(fixture.root, fixture)).state, 'TAMPERED');
});

test('progress ledger requires plan-revision to be the single first event for each plan revision', async (testContext) => {
  const cases = [
    ['first bound event is not lifecycle', [
      { plan_revision: 1 },
      { plan_revision: 2, event_type: 'verification-result', task_id: 'TASK-0001' },
      { plan_revision: 2 },
    ]],
    ['duplicate lifecycle event', [
      { plan_revision: 1 },
      { plan_revision: 1 },
    ]],
  ];
  for (const [label, descriptors] of cases) {
    const { fixture, repository } = await createPlannedFixture(testContext);
    if (descriptors.some((descriptor) => descriptor.plan_revision === 2)) {
      await repository.revisePlan(fixture.root, planCandidate('Revision two'), 'aligned', fixture);
    }
    await rewriteTestProgressLedger(fixture, descriptors);

    assert.equal((await repository.verifyGoalRepository(fixture.root, fixture)).state, 'TAMPERED', label);
  }
});

test('progress ledger requires a lifecycle event for every archived plan revision', async (testContext) => {
  const { fixture, repository } = await createPlannedFixture(testContext);
  await repository.revisePlan(fixture.root, planCandidate('Revision two'), 'aligned', fixture);
  await rewriteTestProgressLedger(fixture, [{ plan_revision: 2 }]);

  assert.equal((await repository.verifyGoalRepository(fixture.root, fixture)).state, 'TAMPERED');
});

test('progress ledger chronology rejects older revision task events after the next lifecycle event', async (testContext) => {
  const { fixture, repository } = await createPlannedFixture(testContext);
  await installTestEvidence(fixture);
  await repository.recordGoalEvent(fixture.root, progressInput('Started implementation', { event_type: 'task-start' }), fixture);
  await repository.recordGoalEvent(fixture.root, progressInput('Completed implementation', {
    event_type: 'task-complete',
    evidence_refs: ['EVID-0001'],
  }), fixture);
  const revisionOne = parseCanonicalJson(await readFile(join(fixture.root, '.goal-lock', 'plan.json')), 'test plan');
  await repository.revisePlan(fixture.root, {
    next_task_id: revisionOne.next_task_id,
    tasks: revisionOne.tasks,
    deferred: revisionOne.deferred,
  }, 'aligned', fixture);
  await rewriteTestProgressLedger(fixture, [
    { plan_revision: 1 },
    { plan_revision: 2 },
    { plan_revision: 1, event_type: 'task-start', task_id: 'TASK-0001' },
    {
      plan_revision: 1,
      event_type: 'task-complete',
      task_id: 'TASK-0001',
      evidence_refs: ['EVID-0001'],
    },
  ]);

  assert.equal((await repository.verifyGoalRepository(fixture.root, fixture)).state, 'TAMPERED');
});

test('task status replay rejects task-complete while the task is pending', async (testContext) => {
  const { fixture, repository } = await createPlannedFixture(testContext);
  await installTestEvidence(fixture);
  await rewriteTestPlan(fixture, (plan) => {
    plan.tasks[0].status = 'complete';
    plan.next_task_id = 'TASK-0002';
  });
  await rewriteTestProgressLedger(fixture, [
    {},
    { event_type: 'task-complete', task_id: 'TASK-0001', evidence_refs: ['EVID-0001'] },
  ]);

  assert.equal((await repository.verifyGoalRepository(fixture.root, fixture)).state, 'TAMPERED');
});

test('task status replay rejects repeated task-start transitions', async (testContext) => {
  const { fixture, repository } = await createPlannedFixture(testContext);
  await rewriteTestPlan(fixture, (plan) => { plan.tasks[0].status = 'in_progress'; });
  await rewriteTestProgressLedger(fixture, [
    {},
    { event_type: 'task-start', task_id: 'TASK-0001' },
    { event_type: 'task-start', task_id: 'TASK-0001' },
  ]);

  assert.equal((await repository.verifyGoalRepository(fixture.root, fixture)).state, 'TAMPERED');
});

test('task status replay rejects blocker while the task is pending', async (testContext) => {
  const { fixture, repository } = await createPlannedFixture(testContext);
  await rewriteTestPlan(fixture, (plan) => {
    plan.tasks[0].status = 'blocked';
    plan.next_task_id = null;
  });
  await rewriteTestProgressLedger(fixture, [
    {},
    { event_type: 'blocker', task_id: 'TASK-0001' },
  ]);

  assert.equal((await repository.verifyGoalRepository(fixture.root, fixture)).state, 'TAMPERED');
});

test('task status replay must equal the status stored in the plan record', async (testContext) => {
  const { fixture, repository } = await createPlannedFixture(testContext);
  await rewriteTestProgressLedger(fixture, [
    {},
    { event_type: 'task-start', task_id: 'TASK-0001' },
  ]);

  assert.equal((await repository.verifyGoalRepository(fixture.root, fixture)).state, 'TAMPERED');
});

async function installTestEvidence(fixture, evidenceId = 'EVID-0001') {
  const repository = await goalRepository();
  const receipt = await repository.recordGoalEvent(fixture.root, evidenceInput(), fixture);
  assert.equal(receipt.evidence_id, evidenceId);
}

async function createPlannedFixture(testContext) {
  const fixture = createGoalLockFixture(testContext);
  const repository = await goalRepository();
  await repository.initializeGoal(fixture.root, goalV1(), fixture);
  await repository.lockInitialGoal(fixture.root, 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766', fixture);
  await repository.revisePlan(fixture.root, planCandidate(), 'aligned', fixture);
  return { fixture, repository };
}

async function createTwoCriterionFixture(testContext, { sharedTask = false } = {}) {
  const fixture = createGoalLockFixture(testContext);
  const repository = await goalRepository();
  const goal = goalV1();
  goal.acceptance_criteria.push({
    id: 'AC-002',
    outcome: 'Independent verification is retained',
    verification: 'Inspect the second evidence chain',
  });
  await repository.initializeGoal(fixture.root, goal, fixture);
  await repository.lockInitialGoal(fixture.root, approvalPhraseForGoal(goal), fixture);
  const candidate = planCandidate();
  if (sharedTask) candidate.tasks[0].acceptance_criteria = ['AC-001', 'AC-002'];
  else candidate.tasks[1].acceptance_criteria = ['AC-002'];
  await repository.revisePlan(fixture.root, candidate, 'aligned', fixture);
  return { fixture, repository };
}

test('evidence public API validates the fixed complete envelope without mutating input', () => {
  assert.equal(typeof goalContracts.validateEvidence, 'function');
  assert.equal(Object.hasOwn(goalContracts, 'validateEvidenceContract'), false);
  const input = structuralEvidence();
  const original = structuredClone(input);

  const validated = goalContracts.validateEvidence(input, activeGoalReference());

  assert.deepEqual(validated, original);
  assert.deepEqual(input, original);
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(Object.isFrozen(validated.goal), true);
  assert.equal(Object.isFrozen(validated.artifact_refs), true);
});

test('evidence contract rejects invalid envelope, bindings, method, result, artifacts, fingerprint, state, and supersedes', () => {
  const cases = [
    ['schema', (record) => { record.schema_version = 2; }],
    ['evidence ID', (record) => { record.evidence_id = 'EVID-1'; }],
    ['criterion ID', (record) => { record.acceptance_criterion_id = 'AC-1'; }],
    ['goal ID', (record) => { record.goal.goal_id = 'GL-OTHER'; }],
    ['goal version', (record) => { record.goal.goal_version = 2; }],
    ['goal digest', (record) => { record.goal.goal_digest = 'f'.repeat(64); }],
    ['plan revision', (record) => { record.plan_revision = 0; }],
    ['task ID', (record) => { record.task_id = 'TASK-1'; }],
    ['method', (record) => { record.method = ' manual '; }],
    ['observed result', (record) => { record.observed_result = ''; }],
    ['unsafe artifact', (record) => { record.artifact_refs = ['../secret.txt']; }],
    ['duplicate artifact', (record) => { record.artifact_refs = ['reports/result.txt', 'reports/result.txt']; }],
    ['workspace fingerprint', (record) => { record.workspace_fingerprint = 'A'.repeat(64); }],
    ['state', (record) => { record.state = 'passed'; }],
    ['supersedes', (record) => { record.supersedes = 'EVID-1'; }],
    ['recorded at', (record) => { record.recorded_at = '2026-02-30T00:00:00Z'; }],
    ['unknown field', (record) => { record.digest = 'b'.repeat(64); }],
  ];
  for (const [label, mutate] of cases) {
    const record = structuralEvidence();
    mutate(record);
    assert.throws(() => goalContracts.validateEvidence(record, activeGoalReference()), GoalLockError, label);
  }

  assert.throws(
    () => goalContracts.validateEvidence(structuralEvidence(), { ...activeGoalReference(), plan_revision: 1 }),
    GoalLockError,
  );
  for (const state of ['pass', 'fail', 'stale']) {
    assert.equal(goalContracts.validateEvidence({ ...structuralEvidence(), state }, activeGoalReference()).state, state);
  }
  assert.equal(goalContracts.validateEvidence({
    ...structuralEvidence('EVID-0002'),
    supersedes: 'EVID-0001',
  }, activeGoalReference()).supersedes, 'EVID-0001');
});

test('evidence recording creates literal canonical evidence, one linked event, and both lock heads atomically', async (testContext) => {
  const { fixture, repository } = await createPlannedFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  const planBefore = await readFile(join(directory, 'plan.json'));
  const currentBefore = await readFile(join(directory, 'current.json'));
  const historyBefore = await readFile(join(directory, 'history', 'goals', 'v0001.json'));

  const receipt = await repository.recordGoalEvent(fixture.root, evidenceInput(), fixture);

  assert.deepEqual(receipt, {
    state: 'LOCKED',
    evidence_id: 'EVID-0001',
    evidence_digest: FIRST_EVIDENCE_DIGEST,
    acceptance_criterion_id: 'AC-001',
    event_id: 'EVT-000002',
    event_digest: FIRST_EVIDENCE_EVENT_DIGEST,
    goal_id: 'GL-ALPHA',
    goal_version: 1,
    plan_revision: 1,
    task_id: 'TASK-0001',
  });
  assert.deepEqual(
    await readFile(join(directory, 'evidence', 'AC-001', 'EVID-0001.json')),
    Buffer.from(FIRST_EVIDENCE_BYTES),
  );
  assert.deepEqual(
    await readFile(join(directory, 'progress.jsonl')),
    Buffer.from(PLAN_REVISION_EVENT_LINE + FIRST_EVIDENCE_EVENT_LINE),
  );
  assert.deepEqual(await readFile(join(directory, 'plan.json')), planBefore);
  assert.deepEqual(await readFile(join(directory, 'current.json')), currentBefore);
  assert.deepEqual(await readFile(join(directory, 'history', 'goals', 'v0001.json')), historyBefore);
  assert.equal(existsSync(join(directory, 'history', 'plans')), false);
  const lock = parseCanonicalJson(await readFile(join(directory, 'lock.json')), 'test lock');
  assert.equal(lock.state_revision, 3);
  assert.deepEqual(lock.progress_head, { event_id: 'EVT-000002', digest: FIRST_EVIDENCE_EVENT_DIGEST });
  assert.equal(lock.change_head, null);
  assert.deepEqual(lock.evidence_heads, {
    'AC-001': { evidence_id: 'EVID-0001', digest: FIRST_EVIDENCE_DIGEST },
  });
  const { record_digest: recordDigest, ...lockWithoutDigest } = lock;
  assert.equal(recordDigest, independentSha256(canonicalBytes(lockWithoutDigest)));
  assert.equal((await repository.verifyGoalRepository(fixture.root, fixture)).state, 'LOCKED');
});

test('evidence IDs and supersession are contiguous per criterion while preserving other criterion heads', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const repository = await goalRepository();
  const goal = goalV1();
  goal.acceptance_criteria.push({
    id: 'AC-002',
    outcome: 'Independent verification is retained',
    verification: 'Inspect the second evidence chain',
  });
  await repository.initializeGoal(fixture.root, goal, fixture);
  await repository.lockInitialGoal(fixture.root, approvalPhraseForGoal(goal), fixture);
  const candidate = planCandidate();
  candidate.tasks[1].acceptance_criteria = ['AC-002'];
  await repository.revisePlan(fixture.root, candidate, 'aligned', fixture);

  const firstA = await repository.recordGoalEvent(fixture.root, evidenceInput(), fixture);
  const firstB = await repository.recordGoalEvent(fixture.root, evidenceInput({
    acceptance_criterion_id: 'AC-002',
    task_id: 'TASK-0002',
    method: 'Inspect the second criterion manually',
    observed_result: 'The independent criterion failed',
    artifact_refs: [],
    workspace_fingerprint: 'b'.repeat(64),
    state: 'fail',
  }), fixture);
  const headBAfterFirst = parseCanonicalJson(
    await readFile(join(fixture.root, '.goal-lock', 'lock.json')),
    'test lock',
  ).evidence_heads['AC-002'];
  const secondA = await repository.recordGoalEvent(fixture.root, evidenceInput({
    method: 'Review the criterion without a command',
    observed_result: 'The former passing evidence is now stale',
    artifact_refs: ['reports/manual-review.txt'],
    workspace_fingerprint: 'c'.repeat(64),
    state: 'stale',
    supersedes: 'EVID-0001',
  }), fixture);

  assert.equal(firstA.evidence_id, 'EVID-0001');
  assert.equal(firstB.evidence_id, 'EVID-0001');
  assert.equal(secondA.evidence_id, 'EVID-0002');
  assert.equal(parseCanonicalJson(
    await readFile(join(fixture.root, '.goal-lock', 'evidence', 'AC-001', 'EVID-0002.json')),
    'test evidence',
  ).supersedes, 'EVID-0001');
  const lock = parseCanonicalJson(await readFile(join(fixture.root, '.goal-lock', 'lock.json')), 'test lock');
  assert.deepEqual(lock.evidence_heads['AC-002'], headBAfterFirst);
  assert.equal(lock.evidence_heads['AC-001'].evidence_id, 'EVID-0002');
  const verified = await repository.verifyGoalRepository(fixture.root, fixture);
  assert.equal(verified.state, 'LOCKED');
  assert.equal(verified.evidence.latest['AC-001'].state, 'stale');
  assert.equal(verified.evidence.latest['AC-002'].state, 'fail');
});

test('evidence references reject a task-complete backed only by another task criterion', async (testContext) => {
  const { fixture, repository } = await createTwoCriterionFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  await repository.recordGoalEvent(fixture.root, evidenceInput({
    acceptance_criterion_id: 'AC-002',
    task_id: 'TASK-0002',
  }), fixture);
  await repository.recordGoalEvent(
    fixture.root,
    progressInput('Started task one', { event_type: 'task-start' }),
    fixture,
  );
  const planBefore = await readFile(join(directory, 'plan.json'));
  const ledgerBefore = await readFile(join(directory, 'progress.jsonl'));
  const lockBefore = await readFile(join(directory, 'lock.json'));

  await assert.rejects(
    repository.recordGoalEvent(fixture.root, progressInput('Cross-owned completion', {
      event_type: 'task-complete',
      evidence_refs: ['EVID-0001'],
    }), fixture),
    (error) => error instanceof GoalLockError && error.kind === 'input',
  );

  assert.deepEqual(await readFile(join(directory, 'plan.json')), planBefore);
  assert.deepEqual(await readFile(join(directory, 'progress.jsonl')), ledgerBefore);
  assert.deepEqual(await readFile(join(directory, 'lock.json')), lockBefore);
});

test('evidence references reject a bare ID shared by two criteria of the same task', async (testContext) => {
  const { fixture, repository } = await createTwoCriterionFixture(testContext, { sharedTask: true });
  const directory = join(fixture.root, '.goal-lock');
  await repository.recordGoalEvent(fixture.root, evidenceInput(), fixture);
  await repository.recordGoalEvent(fixture.root, evidenceInput({
    acceptance_criterion_id: 'AC-002',
  }), fixture);
  assert.equal((await repository.verifyGoalRepository(fixture.root, fixture)).state, 'LOCKED');
  await repository.recordGoalEvent(
    fixture.root,
    progressInput('Started shared task', { event_type: 'task-start' }),
    fixture,
  );
  const planBefore = await readFile(join(directory, 'plan.json'));
  const ledgerBefore = await readFile(join(directory, 'progress.jsonl'));
  const lockBefore = await readFile(join(directory, 'lock.json'));

  await assert.rejects(
    repository.recordGoalEvent(fixture.root, progressInput('Ambiguous completion', {
      event_type: 'task-complete',
      evidence_refs: ['EVID-0001'],
    }), fixture),
    (error) => error instanceof GoalLockError && error.kind === 'input',
  );

  assert.deepEqual(await readFile(join(directory, 'plan.json')), planBefore);
  assert.deepEqual(await readFile(join(directory, 'progress.jsonl')), ledgerBefore);
  assert.deepEqual(await readFile(join(directory, 'lock.json')), lockBefore);
});

test('evidence references reject task-null ambiguity for overlapping criterion-local IDs', async (testContext) => {
  const { fixture, repository } = await createTwoCriterionFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  await repository.recordGoalEvent(fixture.root, evidenceInput(), fixture);
  await repository.recordGoalEvent(fixture.root, evidenceInput({
    acceptance_criterion_id: 'AC-002',
    task_id: 'TASK-0002',
  }), fixture);
  const ledgerBefore = await readFile(join(directory, 'progress.jsonl'));
  const lockBefore = await readFile(join(directory, 'lock.json'));

  await assert.rejects(
    repository.recordGoalEvent(fixture.root, progressInput('Ambiguous audit reference', {
      task_id: null,
      evidence_refs: ['EVID-0001'],
    }), fixture),
    (error) => error instanceof GoalLockError && error.kind === 'input',
  );

  assert.deepEqual(await readFile(join(directory, 'progress.jsonl')), ledgerBefore);
  assert.deepEqual(await readFile(join(directory, 'lock.json')), lockBefore);
});

test('evidence references resolve an overlapping bare ID uniquely through the owning task', async (testContext) => {
  const { fixture, repository } = await createTwoCriterionFixture(testContext);
  await repository.recordGoalEvent(fixture.root, evidenceInput(), fixture);
  await repository.recordGoalEvent(fixture.root, evidenceInput({
    acceptance_criterion_id: 'AC-002',
    task_id: 'TASK-0002',
  }), fixture);
  await repository.recordGoalEvent(
    fixture.root,
    progressInput('Started task one', { event_type: 'task-start' }),
    fixture,
  );

  await repository.recordGoalEvent(fixture.root, progressInput('Uniquely owned completion', {
    event_type: 'task-complete',
    evidence_refs: ['EVID-0001'],
  }), fixture);

  const plan = parseCanonicalJson(
    await readFile(join(fixture.root, '.goal-lock', 'plan.json')),
    'test plan',
  );
  assert.equal(plan.tasks[0].status, 'complete');
  assert.equal((await repository.verifyGoalRepository(fixture.root, fixture)).state, 'LOCKED');
});

test('evidence replay rejects a re-digested cross-owned task-complete reference', async (testContext) => {
  const { fixture, repository } = await createTwoCriterionFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  await repository.recordGoalEvent(fixture.root, evidenceInput({
    acceptance_criterion_id: 'AC-002',
    task_id: 'TASK-0002',
  }), fixture);
  await repository.recordGoalEvent(
    fixture.root,
    progressInput('Started task one', { event_type: 'task-start' }),
    fixture,
  );
  const ledgerPath = join(directory, 'progress.jsonl');
  const ledgerBefore = await readFile(ledgerPath);
  const events = ledgerBefore.toString('utf8').trimEnd().split('\n').map(JSON.parse);
  const terminal = events.at(-1);
  const payload = {
    schema_version: 1,
    event_id: 'EVT-000004',
    recorded_at: '2026-08-23T00:00:00.000Z',
    goal: terminal.goal,
    plan_revision: 1,
    task_id: 'TASK-0001',
    event_type: 'task-complete',
    summary: 'Cross-owned completion injected into the ledger',
    evidence_refs: ['EVID-0001'],
    previous_event_digest: terminal.event_digest,
  };
  const injected = {
    ...payload,
    event_digest: independentSha256(canonicalBytes(payload)),
  };
  await writeFile(ledgerPath, Buffer.concat([ledgerBefore, canonicalBytes(injected)]));
  await rewriteTestPlan(fixture, (plan) => {
    plan.tasks[0].status = 'complete';
    plan.next_task_id = 'TASK-0002';
  });
  await rewriteTestLock(fixture, (lock) => {
    lock.state_revision += 1;
    lock.progress_head = { event_id: injected.event_id, digest: injected.event_digest };
  });

  const result = await repository.verifyGoalRepository(fixture.root, fixture);

  assert.equal(result.state, 'TAMPERED');
});

test('evidence recording rejects derived fields, unknown bindings, and inexact supersession without partial state', async (testContext) => {
  const { fixture, repository } = await createPlannedFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  const initialCases = [
    evidenceInput({ evidence_id: 'EVID-9999' }),
    evidenceInput({ recorded_at: '2026-08-23T01:00:00.000Z' }),
    evidenceInput({ acceptance_criterion_id: 'AC-999' }),
    evidenceInput({ task_id: 'TASK-9999' }),
    evidenceInput({ supersedes: 'EVID-0001' }),
  ];
  for (const input of initialCases) {
    await assert.rejects(
      repository.recordGoalEvent(fixture.root, input, fixture),
      (error) => error instanceof GoalLockError && error.kind === 'input',
    );
  }
  assert.equal(existsSync(join(directory, 'evidence')), false);
  const ledgerBeforeFirst = await readFile(join(directory, 'progress.jsonl'));
  const lockBeforeFirst = await readFile(join(directory, 'lock.json'));
  assert.deepEqual(await readFile(join(directory, 'progress.jsonl')), ledgerBeforeFirst);
  assert.deepEqual(await readFile(join(directory, 'lock.json')), lockBeforeFirst);

  await repository.recordGoalEvent(fixture.root, evidenceInput(), fixture);
  const firstBytes = await readFile(join(directory, 'evidence', 'AC-001', 'EVID-0001.json'));
  const ledgerBeforeSecond = await readFile(join(directory, 'progress.jsonl'));
  const lockBeforeSecond = await readFile(join(directory, 'lock.json'));
  for (const supersedes of [null, 'EVID-0002', 'EVID-9999']) {
    await assert.rejects(
      repository.recordGoalEvent(fixture.root, evidenceInput({ supersedes, state: 'fail' }), fixture),
      (error) => error instanceof GoalLockError && error.kind === 'input',
    );
  }
  assert.deepEqual(await readFile(join(directory, 'evidence', 'AC-001', 'EVID-0001.json')), firstBytes);
  assert.equal(existsSync(join(directory, 'evidence', 'AC-001', 'EVID-0002.json')), false);
  assert.deepEqual(await readFile(join(directory, 'progress.jsonl')), ledgerBeforeSecond);
  assert.deepEqual(await readFile(join(directory, 'lock.json')), lockBeforeSecond);
});

test('evidence transaction rolls back the new file, event, head, and directories after a late install failure', async (testContext) => {
  const { fixture, repository } = await createPlannedFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  const planBefore = await readFile(join(directory, 'plan.json'));
  const ledgerBefore = await readFile(join(directory, 'progress.jsonl'));
  const lockBefore = await readFile(join(directory, 'lock.json'));
  fixture.transactionFaults.install = ({ target }) => {
    if (target === '.goal-lock/lock.json') throw new Error('injected evidence head install failure');
  };

  await assert.rejects(
    repository.recordGoalEvent(fixture.root, evidenceInput(), fixture),
    /injected evidence head install failure/,
  );

  assert.equal(existsSync(join(directory, 'evidence')), false);
  assert.deepEqual(await readFile(join(directory, 'plan.json')), planBefore);
  assert.deepEqual(await readFile(join(directory, 'progress.jsonl')), ledgerBefore);
  assert.deepEqual(await readFile(join(directory, 'lock.json')), lockBefore);
});

test('evidence immutable predecessors remain read-only transaction inputs during supersession', async (testContext) => {
  const { fixture, repository } = await createPlannedFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  await repository.recordGoalEvent(fixture.root, evidenceInput(), fixture);
  const firstPath = join(directory, 'evidence', 'AC-001', 'EVID-0001.json');
  const replacement = canonicalBytes({
    ...parseCanonicalJson(await readFile(firstPath), 'test evidence'),
    observed_result: 'Foreign replacement during the transaction',
  });
  const ledgerBefore = await readFile(join(directory, 'progress.jsonl'));
  const lockBefore = await readFile(join(directory, 'lock.json'));
  let replaced = false;
  fixture.transactionFaults.stageWrite = async ({ target }) => {
    if (!replaced && target === '.goal-lock/evidence/AC-001/EVID-0002.json') {
      replaced = true;
      await writeFile(firstPath, replacement);
    }
  };

  await assert.rejects(
    repository.recordGoalEvent(fixture.root, evidenceInput({
      state: 'fail',
      observed_result: 'Second observation failed',
      supersedes: 'EVID-0001',
    }), fixture),
    (error) => error instanceof GoalLockError && error.kind === 'integrity',
  );

  assert.equal(replaced, true);
  assert.deepEqual(await readFile(firstPath), replacement);
  assert.equal(existsSync(join(directory, 'evidence', 'AC-001', 'EVID-0002.json')), false);
  assert.deepEqual(await readFile(join(directory, 'progress.jsonl')), ledgerBefore);
  assert.deepEqual(await readFile(join(directory, 'lock.json')), lockBefore);
});

async function createEvidenceHistoryFixture(testContext) {
  const planned = await createPlannedFixture(testContext);
  await planned.repository.recordGoalEvent(planned.fixture.root, evidenceInput(), planned.fixture);
  await planned.repository.recordGoalEvent(planned.fixture.root, evidenceInput({
    method: 'Run the focused tests again',
    observed_result: 'Focused tests failed',
    artifact_refs: ['reports/failed.txt'],
    workspace_fingerprint: 'b'.repeat(64),
    state: 'fail',
    supersedes: 'EVID-0001',
  }), planned.fixture);
  await planned.repository.recordGoalEvent(planned.fixture.root, evidenceInput({
    method: 'Review the superseded result manually',
    observed_result: 'Evidence is stale after review',
    artifact_refs: [],
    workspace_fingerprint: 'c'.repeat(64),
    state: 'stale',
    supersedes: 'EVID-0002',
  }), planned.fixture);
  return planned;
}

test('evidence verification rejects links, gaps, edits, path mismatches, unknown refs, supersession, event, and head tampering', async (testContext) => {
  const cases = [
    ['linked record', async (fixture, directory) => {
      await link(
        join(directory, 'evidence', 'AC-001', 'EVID-0001.json'),
        join(fixture.root, 'linked-evidence.json'),
      );
    }],
    ['ordinal gap', async (_fixture, directory) => {
      await unlink(join(directory, 'evidence', 'AC-001', 'EVID-0002.json'));
    }],
    ['historical edit', async (_fixture, directory) => {
      const target = join(directory, 'evidence', 'AC-001', 'EVID-0001.json');
      const record = parseCanonicalJson(await readFile(target), 'test evidence');
      record.observed_result = 'Edited historical evidence';
      await writeFile(target, canonicalBytes(record));
    }],
    ['path ID mismatch', async (fixture, directory) => {
      const target = join(directory, 'evidence', 'AC-001', 'EVID-0003.json');
      const record = parseCanonicalJson(await readFile(target), 'test evidence');
      record.evidence_id = 'EVID-0002';
      const bytes = canonicalBytes(record);
      await writeFile(target, bytes);
      await rewriteTestLock(fixture, (lock) => {
        lock.evidence_heads['AC-001'].digest = independentSha256(bytes);
      });
    }],
    ['unknown criterion', async (fixture, directory) => {
      await rename(join(directory, 'evidence', 'AC-001'), join(directory, 'evidence', 'AC-999'));
      for (const name of await readdir(join(directory, 'evidence', 'AC-999'))) {
        const target = join(directory, 'evidence', 'AC-999', name);
        const record = parseCanonicalJson(await readFile(target), 'test evidence');
        record.acceptance_criterion_id = 'AC-999';
        await writeFile(target, canonicalBytes(record));
      }
      const latestBytes = await readFile(join(directory, 'evidence', 'AC-999', 'EVID-0003.json'));
      await rewriteTestLock(fixture, (lock) => {
        delete lock.evidence_heads['AC-001'];
        lock.evidence_heads['AC-999'] = {
          evidence_id: 'EVID-0003',
          digest: independentSha256(latestBytes),
        };
      });
    }],
    ['unknown task', async (fixture, directory) => {
      const target = join(directory, 'evidence', 'AC-001', 'EVID-0003.json');
      const record = parseCanonicalJson(await readFile(target), 'test evidence');
      record.task_id = 'TASK-9999';
      const bytes = canonicalBytes(record);
      await writeFile(target, bytes);
      await rewriteTestLock(fixture, (lock) => {
        lock.evidence_heads['AC-001'].digest = independentSha256(bytes);
      });
    }],
    ['invalid supersession', async (fixture, directory) => {
      const target = join(directory, 'evidence', 'AC-001', 'EVID-0003.json');
      const record = parseCanonicalJson(await readFile(target), 'test evidence');
      record.supersedes = 'EVID-0001';
      const bytes = canonicalBytes(record);
      await writeFile(target, bytes);
      await rewriteTestLock(fixture, (lock) => {
        lock.evidence_heads['AC-001'].digest = independentSha256(bytes);
      });
    }],
    ['missing evidence event', async (fixture, directory) => {
      await writeFile(join(directory, 'progress.jsonl'), Buffer.from(PLAN_REVISION_EVENT_LINE));
      await rewriteTestLock(fixture, (lock) => {
        lock.progress_head = { event_id: 'EVT-000001', digest: PLAN_REVISION_EVENT_DIGEST };
      });
    }],
    ['nonterminal head', async (fixture, directory) => {
      const firstBytes = await readFile(join(directory, 'evidence', 'AC-001', 'EVID-0001.json'));
      await rewriteTestLock(fixture, (lock) => {
        lock.evidence_heads['AC-001'] = {
          evidence_id: 'EVID-0001',
          digest: independentSha256(firstBytes),
        };
      });
    }],
    ['missing head', async (fixture) => {
      await rewriteTestLock(fixture, (lock) => { delete lock.evidence_heads['AC-001']; });
    }],
  ];
  for (const [label, tamper] of cases) {
    const { fixture, repository } = await createEvidenceHistoryFixture(testContext);
    const directory = join(fixture.root, '.goal-lock');
    await tamper(fixture, directory);

    const result = await repository.verifyGoalRepository(fixture.root, fixture);

    assert.equal(result.state, 'TAMPERED', label);
  }
});

test('task status task-start moves only pending tasks to in_progress without revising or archiving the plan', async (testContext) => {
  const { fixture, repository } = await createPlannedFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');

  await repository.recordGoalEvent(fixture.root, progressInput('Started implementation', {
    event_type: 'task-start',
  }), fixture);

  const plan = parseCanonicalJson(await readFile(join(directory, 'plan.json')), 'test plan');
  assert.equal(plan.plan_revision, 1);
  assert.equal(plan.tasks[0].status, 'in_progress');
  assert.equal(plan.tasks[1].status, 'pending');
  assert.equal(existsSync(join(directory, 'history', 'plans')), false);
  await assert.rejects(
    repository.recordGoalEvent(fixture.root, progressInput('Start twice', { event_type: 'task-start' }), fixture),
    (error) => error instanceof GoalLockError && error.kind === 'state',
  );
});

test('task status task-complete requires an in_progress task and existing evidence', async (testContext) => {
  const { fixture, repository } = await createPlannedFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  await installTestEvidence(fixture);

  await assert.rejects(
    repository.recordGoalEvent(fixture.root, progressInput('Completed too early', {
      event_type: 'task-complete',
      evidence_refs: ['EVID-0001'],
    }), fixture),
    (error) => error instanceof GoalLockError && error.kind === 'state',
  );
  await repository.recordGoalEvent(fixture.root, progressInput('Started implementation', { event_type: 'task-start' }), fixture);
  const beforeMissingEvidence = await readFile(join(directory, 'progress.jsonl'));
  await assert.rejects(
    repository.recordGoalEvent(fixture.root, progressInput('Completed without evidence', {
      event_type: 'task-complete',
    }), fixture),
    (error) => error instanceof GoalLockError && error.kind === 'input',
  );
  assert.deepEqual(await readFile(join(directory, 'progress.jsonl')), beforeMissingEvidence);

  await repository.recordGoalEvent(fixture.root, progressInput('Completed with evidence', {
    event_type: 'task-complete',
    evidence_refs: ['EVID-0001'],
  }), fixture);
  const plan = parseCanonicalJson(await readFile(join(directory, 'plan.json')), 'test plan');
  assert.equal(plan.plan_revision, 1);
  assert.equal(plan.tasks[0].status, 'complete');
  assert.equal(plan.next_task_id, 'TASK-0002');
  await assert.rejects(
    repository.recordGoalEvent(fixture.root, progressInput('Complete twice', {
      event_type: 'task-complete',
      evidence_refs: ['EVID-0001'],
    }), fixture),
    (error) => error instanceof GoalLockError && error.kind === 'state',
  );
});

test('task status blocker moves only an in_progress task to blocked', async (testContext) => {
  const { fixture, repository } = await createPlannedFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');

  await assert.rejects(
    repository.recordGoalEvent(fixture.root, progressInput('Blocked before start', { event_type: 'blocker' }), fixture),
    (error) => error instanceof GoalLockError && error.kind === 'state',
  );
  await repository.recordGoalEvent(fixture.root, progressInput('Started implementation', { event_type: 'task-start' }), fixture);
  await repository.recordGoalEvent(fixture.root, progressInput('Blocked on external decision', { event_type: 'blocker' }), fixture);

  const plan = parseCanonicalJson(await readFile(join(directory, 'plan.json')), 'test plan');
  assert.equal(plan.tasks[0].status, 'blocked');
  assert.equal(plan.next_task_id, null);
});

test('task status audit events never silently complete the active task', async (testContext) => {
  const { fixture, repository } = await createPlannedFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  await repository.recordGoalEvent(fixture.root, progressInput('Started implementation', { event_type: 'task-start' }), fixture);

  await assert.rejects(
    repository.recordGoalEvent(fixture.root, progressInput('Caller lifecycle event', {
      event_type: 'plan-revision',
      task_id: null,
    }), fixture),
    (error) => error instanceof GoalLockError && error.kind === 'input',
  );
  for (const eventType of ['verification-result', 'goal-change', 'evidence-invalidation', 'recovery', 'final-audit']) {
    await repository.recordGoalEvent(fixture.root, progressInput(`Recorded ${eventType}`, {
      event_type: eventType,
      task_id: eventType === 'verification-result' ? 'TASK-0001' : null,
    }), fixture);
    const plan = parseCanonicalJson(await readFile(join(directory, 'plan.json')), 'test plan');
    assert.equal(plan.tasks[0].status, 'in_progress', eventType);
    assert.equal(plan.plan_revision, 1, eventType);
  }
});

test('task status event rolls back the plan, ledger, and lock together after an install failure', async (testContext) => {
  const { fixture, repository } = await createPlannedFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  const planBefore = await readFile(join(directory, 'plan.json'));
  const ledgerBefore = await readFile(join(directory, 'progress.jsonl'));
  const lockBefore = await readFile(join(directory, 'lock.json'));
  fixture.transactionFaults.install = () => { throw new Error('injected task status install failure'); };

  await assert.rejects(
    repository.recordGoalEvent(fixture.root, progressInput('Started implementation', { event_type: 'task-start' }), fixture),
    /injected task status install failure/,
  );

  assert.deepEqual(await readFile(join(directory, 'plan.json')), planBefore);
  assert.deepEqual(await readFile(join(directory, 'progress.jsonl')), ledgerBefore);
  assert.deepEqual(await readFile(join(directory, 'lock.json')), lockBefore);
});

test('progress ledger append refuses a raced replacement and preserves the replacing bytes', async (testContext) => {
  const { fixture, repository } = await createPlannedFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  const ledgerPath = join(directory, 'progress.jsonl');
  const lockBefore = await readFile(join(directory, 'lock.json'));
  const replacement = Buffer.concat([await readFile(ledgerPath), Buffer.from('{"foreign":true}\n')]);
  let armed = false;
  let rootReads = 0;
  fixture.workspaceFaults = {
    beforeVerifyInputs: () => {
      if (armed) return;
      armed = true;
      fixture.workspaceFaults.afterDirectoryRead = async ({ relativePath }) => {
        if (relativePath !== '.goal-lock') return;
        rootReads += 1;
        if (rootReads === 2) await writeFile(ledgerPath, replacement);
      };
    },
  };

  await assert.rejects(
    repository.recordGoalEvent(fixture.root, progressInput(), fixture),
    (error) => error instanceof GoalLockError && error.kind === 'integrity',
  );

  assert.equal(rootReads, 2);
  assert.deepEqual(await readFile(ledgerPath), replacement);
  assert.deepEqual(await readFile(join(directory, 'lock.json')), lockBefore);
});

function structuralProgressEvent(eventId = 'EVT-000001', eventDigest = '1'.repeat(64)) {
  return {
    schema_version: 1,
    event_id: eventId,
    recorded_at: '2026-08-23T01:00:00.000Z',
    goal: activeGoalReference(),
    plan_revision: 1,
    task_id: null,
    event_type: 'plan-revision',
    summary: 'Plan created',
    evidence_refs: [],
    previous_event_digest: null,
    event_digest: eventDigest,
  };
}

function structuralChange(changeId = 'CR-0001', options = {}) {
  const baseGoal = options.baseGoal ?? goalV1();
  const baseReference = {
    goal_id: baseGoal.goal_id,
    goal_version: baseGoal.goal_version,
    goal_digest: independentSha256(canonicalBytes(baseGoal)),
  };
  const candidateGoal = options.candidateGoal ?? {
    ...baseGoal,
    goal_version: baseGoal.goal_version + 1,
    objective: 'Ship an evolved safe lock',
    predecessor: { goal_version: baseGoal.goal_version, goal_digest: baseReference.goal_digest },
    accepted_change_id: changeId,
  };
  const changes = [{ field: 'objective', before: baseGoal.objective, after: candidateGoal.objective }];
  const payload = {
    schema_version: 1,
    id: changeId,
    base_goal: baseReference,
    candidate_goal: candidateGoal,
    candidate_digest: independentSha256(canonicalBytes(candidateGoal)),
    changes,
    rationale: 'Evolve the approved goal',
    affected_tasks: [],
    affected_criteria: [],
    risks: [],
    validation: ['Run verification'],
    rollback: ['Restore version one'],
    recorded_at: options.recordedAt ?? '2026-08-23T01:00:00.000Z',
  };
  const proposalDigest = independentSha256(canonicalBytes(payload));
  return {
    ...payload,
    status: options.status ?? 'approved',
    proposal_digest: proposalDigest,
    approval_phrase: `APPROVE ${changeId} GOAL VERSION ${candidateGoal.goal_version} ${proposalDigest.slice(0, 12)}`,
  };
}

function structuralEvidence(evidenceId = 'EVID-0001', criterionId = 'AC-001') {
  return {
    schema_version: 1,
    evidence_id: evidenceId,
    acceptance_criterion_id: criterionId,
    goal: activeGoalReference(),
    plan_revision: 1,
    task_id: 'TASK-0001',
    method: 'Run verification',
    observed_result: 'Verification passed',
    artifact_refs: ['reports/result.txt'],
    workspace_fingerprint: '3'.repeat(64),
    state: 'pass',
    supersedes: null,
    recorded_at: '2026-08-23T01:00:00.000Z',
  };
}

async function rewriteTestLock(fixture, mutate) {
  const lockPath = join(fixture.root, '.goal-lock', 'lock.json');
  const lock = parseCanonicalJson(await readFile(lockPath), 'test lock');
  delete lock.record_digest;
  mutate(lock);
  lock.record_digest = independentSha256(canonicalBytes(lock));
  await writeFile(lockPath, canonicalBytes(lock));
}

async function optionalBytes(target) {
  try {
    return await readFile(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

test('initializes goal draft as the only initial repository record', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const draft = goalV1();
  const expectedCurrent = Buffer.from('{"acceptance_criteria":[{"id":"AC-001","outcome":"State is locked","verification":"Run verification"}],"accepted_change_id":null,"assumptions":[{"confidence":"medium","statement":"Git is installed"}],"authorization_boundary":["Local workspace only"],"constraints":[{"id":"C-001","text":"Use Node.js"}],"goal_id":"GL-ALPHA","goal_version":1,"non_goals":["Remote publishing"],"objective":"Ship a safe lock","predecessor":null,"schema_version":1,"scope":{"in":["CLI"],"out":["Cloud sync"]}}\n');
  const { initializeGoal } = await goalRepository();

  const result = await initializeGoal(fixture.root, draft, fixture);

  assert.deepEqual(result, {
    state: 'DRAFT',
    goal_id: 'GL-ALPHA',
    goal_version: 1,
    goal_digest: '92d74f6bf766e096e71b949ff57e2d9a12302a4519226d05cf67c2b544babaa6',
    approval_required: 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766',
  });
  assert.deepEqual(await readFile(join(fixture.root, '.goal-lock', 'current.json')), expectedCurrent);
  assert.equal(await optionalBytes(join(fixture.root, '.goal-lock', 'lock.json')), null);
  assert.equal(await optionalBytes(join(fixture.root, '.goal-lock', 'history', 'goals', 'v0001.json')), null);
  assert.deepEqual(await readdir(join(fixture.root, '.goal-lock')), ['current.json']);
});

test('initializes goal draft validates before creating goal-lock state', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const invalid = goalV1();
  invalid.goal_version = 2;
  const { initializeGoal } = await goalRepository();

  await assert.rejects(initializeGoal(fixture.root, invalid, fixture), (error) => error instanceof GoalLockError && error.code === 'INVALID_CONTRACT');

  assert.equal(existsSync(join(fixture.root, '.goal-lock')), false);
});

test('initializes goal draft refuses pre-existing non-empty or linked goal-lock directories', async (testContext) => {
  const { initializeGoal } = await goalRepository();
  const occupied = createGoalLockFixture(testContext);
  const occupiedDirectory = join(occupied.root, '.goal-lock');
  const sentinel = join(occupiedDirectory, 'foreign.json');
  await mkdir(occupiedDirectory);
  await writeFile(sentinel, 'foreign bytes');

  await assert.rejects(initializeGoal(occupied.root, goalV1(), occupied), /goal-lock|initial|state/i);
  assert.deepEqual(await readFile(sentinel), Buffer.from('foreign bytes'));

  const linked = createGoalLockFixture(testContext);
  const externalDirectory = join(linked.root, 'external-goal-lock');
  const externalSentinel = join(externalDirectory, 'foreign.json');
  await mkdir(externalDirectory);
  await writeFile(externalSentinel, 'linked foreign bytes');
  try {
    await symlink(externalDirectory, join(linked.root, '.goal-lock'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EACCES', 'EPERM', 'ENOTSUP'].includes(error?.code)) {
      testContext.skip(`directory links unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  await assert.rejects(initializeGoal(linked.root, goalV1(), linked), /goal-lock|link|directory|state/i);
  assert.deepEqual(await readFile(externalSentinel), Buffer.from('linked foreign bytes'));
});

test('initializes goal draft refuses a repeated initialization without changing bytes', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const { initializeGoal } = await goalRepository();
  await initializeGoal(fixture.root, goalV1(), fixture);
  const currentPath = join(fixture.root, '.goal-lock', 'current.json');
  const before = await readFile(currentPath);

  await assert.rejects(initializeGoal(fixture.root, goalV1(), fixture), /goal-lock|initial|state/i);

  assert.deepEqual(await readFile(currentPath), before);
  assert.deepEqual(await readdir(join(fixture.root, '.goal-lock')), ['current.json']);
});

test('initializes goal draft preserves an empty goal-lock directory created after preflight', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const { initializeGoal } = await goalRepository();
  const directory = join(fixture.root, '.goal-lock');
  fixture.transactionFaults.beforeGoalLockMkdir = async () => { await mkdir(directory); };
  fixture.transactionFaults.install = () => { throw new Error('install failure'); };

  await assert.rejects(initializeGoal(fixture.root, goalV1(), fixture), /install failure/);

  assert.equal(existsSync(directory), true);
  assert.deepEqual(await readdir(directory), []);
});

test('version 1 lock rejects every approval other than the exact current phrase', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const { initializeGoal, lockInitialGoal } = await goalRepository();
  await initializeGoal(fixture.root, goalV1(), fixture);
  const approvals = [
    'APPROVE GOAL',
    'approve goal gl-alpha version 1 92d74f6bf766',
    ' APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766',
    'APPROVE GOAL GL-BETA VERSION 1 92d74f6bf766',
    'APPROVE GOAL GL-ALPHA VERSION 2 92d74f6bf766',
    'APPROVE GOAL GL-ALPHA VERSION 1 000000000000',
  ];

  for (const approval of approvals) {
    await assert.rejects(lockInitialGoal(fixture.root, approval, fixture), /approval|approve|confirmation/i);
    assert.equal(await optionalBytes(join(fixture.root, '.goal-lock', 'lock.json')), null);
    assert.equal(await optionalBytes(join(fixture.root, '.goal-lock', 'history', 'goals', 'v0001.json')), null);
  }
});

test('version 1 lock records the exact approved current bytes in immutable history', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const { initializeGoal, lockInitialGoal } = await goalRepository();
  await initializeGoal(fixture.root, goalV1(), fixture);
  const currentPath = join(fixture.root, '.goal-lock', 'current.json');
  const current = await readFile(currentPath);

  await lockInitialGoal(fixture.root, 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766', fixture);

  const lock = parseCanonicalJson(await readFile(join(fixture.root, '.goal-lock', 'lock.json')), 'lock');
  const { record_digest, ...lockWithoutDigest } = lock;
  assert.deepEqual(lockWithoutDigest, {
    schema_version: 1,
    goal_id: 'GL-ALPHA',
    goal_version: 1,
    goal_digest: '92d74f6bf766e096e71b949ff57e2d9a12302a4519226d05cf67c2b544babaa6',
    approval_type: 'explicit-version-1',
    proposal_digest: '92d74f6bf766e096e71b949ff57e2d9a12302a4519226d05cf67c2b544babaa6',
    approved_at: '2026-08-23T00:00:00.000Z',
    predecessor_digest: null,
    state_revision: 1,
    progress_head: null,
    change_head: null,
    evidence_heads: {},
  });
  assert.equal(record_digest, sha256(canonicalBytes(lockWithoutDigest)));
  assert.deepEqual(validateLockRecord(lock), lock);
  assert.deepEqual(await readFile(currentPath), current);
  assert.deepEqual(await readFile(join(fixture.root, '.goal-lock', 'history', 'goals', 'v0001.json')), current);

  const lockBytes = await readFile(join(fixture.root, '.goal-lock', 'lock.json'));
  await assert.rejects(lockInitialGoal(fixture.root, 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766', fixture), /lock|state|initial/i);
  assert.deepEqual(await readFile(join(fixture.root, '.goal-lock', 'lock.json')), lockBytes);
});

test('version 1 lock rolls back lock and history when either installation fails', async (testContext) => {
  const { initializeGoal, lockInitialGoal } = await goalRepository();

  for (const failedInstallation of [0, 1]) {
    const fixture = createGoalLockFixture(testContext);
    await initializeGoal(fixture.root, goalV1(), fixture);
    const currentPath = join(fixture.root, '.goal-lock', 'current.json');
    const current = await readFile(currentPath);
    let installations = 0;
    fixture.transactionFaults.install = () => {
      if (installations++ === failedInstallation) throw new Error(`install-${failedInstallation}`);
    };

    await assert.rejects(lockInitialGoal(fixture.root, 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766', fixture), new RegExp(`install-${failedInstallation}`));

    assert.deepEqual(await readFile(currentPath), current);
    assert.equal(await optionalBytes(join(fixture.root, '.goal-lock', 'lock.json')), null);
    assert.equal(await optionalBytes(join(fixture.root, '.goal-lock', 'history', 'goals', 'v0001.json')), null);
  }
});

test('version 1 lock rolls back when current draft ownership changes during final verification', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const { initializeGoal, lockInitialGoal } = await goalRepository();
  await initializeGoal(fixture.root, goalV1(), fixture);
  const currentPath = join(fixture.root, '.goal-lock', 'current.json');
  const externallyEdited = goalV1();
  externallyEdited.objective = 'Edited outside the writer protocol';
  const editedBytes = canonicalBytes(externallyEdited);
  fixture.transactionFaults.finalReadBack = async () => { await writeFile(currentPath, editedBytes); };

  await assert.rejects(lockInitialGoal(fixture.root, 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766', fixture), /ownership|current|digest|transaction/i);

  assert.deepEqual(await readFile(currentPath), editedBytes);
  assert.equal(await optionalBytes(join(fixture.root, '.goal-lock', 'lock.json')), null);
  assert.equal(await optionalBytes(join(fixture.root, '.goal-lock', 'history', 'goals', 'v0001.json')), null);
});

test('safe workspace reads only stable regular files and real directories', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  const currentPath = join(directory, 'current.json');
  const currentBytes = Buffer.from('{"safe":true}\n');
  await mkdir(directory);
  await writeFile(currentPath, currentBytes);
  const { createWorkspaceReader } = await workspaceReader();
  const reader = await createWorkspaceReader(fixture.root, fixture);

  const current = await reader.readFile('.goal-lock/current.json');
  const goalLock = await reader.readDirectory('.goal-lock');

  assert.deepEqual(current.bytes, currentBytes);
  assert.equal(current.digest, '7eeccb134911ebae5c9ab93e29604540babeda8e0f5a634d92fc0a1d3dc45c52');
  assert.deepEqual(goalLock.names, ['current.json']);
  await reader.verifyInputs();
});

test('safe workspace rejects root escapes, links, hard links, and non-files', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  const currentPath = join(directory, 'current.json');
  const hardLinkPath = join(directory, 'hard-link.json');
  await mkdir(directory);
  await writeFile(currentPath, '{}\n');
  await link(currentPath, hardLinkPath);
  const { createWorkspaceReader } = await workspaceReader();
  const reader = await createWorkspaceReader(fixture.root, fixture);

  await assert.rejects(reader.readFile('../outside.json'), (error) => error instanceof GoalLockError && error.kind === 'integrity');
  await assert.rejects(reader.readFile('.goal-lock'), (error) => error instanceof GoalLockError && error.kind === 'integrity');
  await assert.rejects(reader.readFile('.goal-lock/current.json'), (error) => error instanceof GoalLockError && error.kind === 'integrity');

  const externalDirectory = join(fixture.root, 'external-directory');
  const linkedDirectory = join(directory, 'linked-directory');
  await mkdir(externalDirectory);
  try {
    await symlink(externalDirectory, linkedDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EACCES', 'EPERM', 'ENOTSUP'].includes(error?.code)) return;
    throw error;
  }
  await assert.rejects(reader.readDirectory('.goal-lock/linked-directory'), (error) => error instanceof GoalLockError && error.kind === 'integrity');
});

test('safe workspace detects file replacement during read and changed final inputs', async (testContext) => {
  const raced = createGoalLockFixture(testContext);
  const racedDirectory = join(raced.root, '.goal-lock');
  const racedPath = join(racedDirectory, 'current.json');
  const replacementPath = join(racedDirectory, 'replacement.json');
  await mkdir(racedDirectory);
  await writeFile(racedPath, '{"version":1}\n');
  await writeFile(replacementPath, '{"version":2}\n');
  raced.workspaceFaults = {
    afterFileRead: async ({ relativePath }) => {
      if (relativePath === '.goal-lock/current.json') {
        await rename(racedPath, join(racedDirectory, 'detached.json'));
        await rename(replacementPath, racedPath);
      }
    },
  };
  const { createWorkspaceReader } = await workspaceReader();
  const racedReader = await createWorkspaceReader(raced.root, raced);

  await assert.rejects(racedReader.readFile('.goal-lock/current.json'), (error) => error instanceof GoalLockError && error.kind === 'integrity');

  const changed = createGoalLockFixture(testContext);
  const changedDirectory = join(changed.root, '.goal-lock');
  const changedPath = join(changedDirectory, 'current.json');
  await mkdir(changedDirectory);
  await writeFile(changedPath, '{"version":1}\n');
  const changedReader = await createWorkspaceReader(changed.root, changed);
  await changedReader.readFile('.goal-lock/current.json');
  await writeFile(changedPath, '{"version":9}\n');

  await assert.rejects(changedReader.verifyInputs(), (error) => error instanceof GoalLockError && error.kind === 'integrity');
});

test('safe workspace rejects repository root replacement after parent validation', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const detachedRoot = `${fixture.root}-detached`;
  await mkdir(join(fixture.root, '.goal-lock'));
  await writeFile(join(fixture.root, '.goal-lock', 'current.json'), '{"owner":"original"}\n');
  let replaced = false;
  fixture.workspaceFaults = {
    afterParentValidation: async ({ relativePath }) => {
      if (relativePath !== '.goal-lock/current.json' || replaced) return;
      replaced = true;
      await rename(fixture.root, detachedRoot);
      await mkdir(join(fixture.root, '.goal-lock'), { recursive: true });
      await writeFile(join(fixture.root, '.goal-lock', 'current.json'), '{"owner":"replacement"}\n');
    },
  };
  const { createWorkspaceReader } = await workspaceReader();
  const reader = await createWorkspaceReader(fixture.root, fixture);

  try {
    await assert.rejects(reader.readFile('.goal-lock/current.json'), (error) => error instanceof GoalLockError && error.kind === 'integrity');
  } finally {
    await rm(detachedRoot, { force: true, recursive: true });
  }
});

test('safe workspace rejects parent replacement after parent validation', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  const detachedDirectory = join(fixture.root, 'detached-goal-lock');
  await mkdir(directory);
  await writeFile(join(directory, 'current.json'), '{"owner":"original"}\n');
  let replaced = false;
  fixture.workspaceFaults = {
    afterParentValidation: async ({ relativePath }) => {
      if (relativePath !== '.goal-lock/current.json' || replaced) return;
      replaced = true;
      await rename(directory, detachedDirectory);
      await mkdir(directory);
      await writeFile(join(directory, 'current.json'), '{"owner":"replacement"}\n');
    },
  };
  const { createWorkspaceReader } = await workspaceReader();
  const reader = await createWorkspaceReader(fixture.root, fixture);

  await assert.rejects(reader.readFile('.goal-lock/current.json'), (error) => error instanceof GoalLockError && error.kind === 'integrity');
});

test('safe workspace preserves the first trusted snapshot when a path is read twice', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const history = join(fixture.root, '.goal-lock', 'history');
  await mkdir(join(history, 'goals'), { recursive: true });
  const { createWorkspaceReader } = await workspaceReader();
  const reader = await createWorkspaceReader(fixture.root, fixture);
  await reader.readDirectory('.goal-lock/history');
  await mkdir(join(history, 'plans'));

  await assert.rejects(reader.readDirectory('.goal-lock/history'), (error) => error instanceof GoalLockError && error.kind === 'integrity');
});

test('safe workspace final verification rejects a replaced nested parent around the same file inode', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const history = join(fixture.root, '.goal-lock', 'history');
  const goals = join(history, 'goals');
  const detachedGoals = join(history, 'detached-goals');
  const target = join(goals, 'v0001.json');
  await mkdir(goals, { recursive: true });
  await writeFile(target, '{"version":1}\n');
  const { createWorkspaceReader } = await workspaceReader();
  const reader = await createWorkspaceReader(fixture.root, fixture);
  await reader.readFile('.goal-lock/history/goals/v0001.json');
  const before = await lstat(target, { bigint: true });

  await rename(goals, detachedGoals);
  await mkdir(goals);
  await rename(join(detachedGoals, 'v0001.json'), target);
  await rm(detachedGoals, { recursive: true });
  const after = await lstat(target, { bigint: true });
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);

  await assert.rejects(reader.verifyInputs(), (error) => error instanceof GoalLockError && error.kind === 'integrity');
});

test('verifies goal history for draft and locked version one without adopting observed bytes', async (testContext) => {
  const draftFixture = createGoalLockFixture(testContext);
  const { initializeGoal, lockInitialGoal, verifyGoalRepository } = await goalRepository();
  await initializeGoal(draftFixture.root, goalV1(), draftFixture);

  const draft = await verifyGoalRepository(draftFixture.root, draftFixture);

  assert.equal(draft.state, 'DRAFT');
  assert.equal(draft.evidence.goal.goal_digest, '92d74f6bf766e096e71b949ff57e2d9a12302a4519226d05cf67c2b544babaa6');
  assert.deepEqual(draft.evidence.inputs.map((entry) => entry.path), ['.goal-lock', '.goal-lock/current.json']);

  const lockedFixture = createGoalLockFixture(testContext);
  await initializeGoal(lockedFixture.root, goalV1(), lockedFixture);
  await lockInitialGoal(lockedFixture.root, 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766', lockedFixture);

  const locked = await verifyGoalRepository(lockedFixture.root, lockedFixture);

  assert.equal(locked.state, 'LOCKED');
  assert.deepEqual(locked.evidence.goal, {
    goal_id: 'GL-ALPHA',
    goal_version: 1,
    goal_digest: '92d74f6bf766e096e71b949ff57e2d9a12302a4519226d05cf67c2b544babaa6',
  });
  assert.equal(locked.evidence.inputs.find((entry) => entry.path === '.goal-lock/lock.json').digest, '748352cc02a42cbc0563e176a0a3bbf733531689dcb9aac17fa7c16b85745df5');
});

test('verifies goal history fails closed for missing current lock or history files', async (testContext) => {
  const { initializeGoal, lockInitialGoal, verifyGoalRepository } = await goalRepository();
  for (const missingPath of ['current.json', 'lock.json', 'history/goals/v0001.json']) {
    const fixture = createGoalLockFixture(testContext);
    await initializeGoal(fixture.root, goalV1(), fixture);
    await lockInitialGoal(fixture.root, 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766', fixture);
    await unlink(join(fixture.root, '.goal-lock', ...missingPath.split('/')));

    const result = await verifyGoalRepository(fixture.root, fixture);

    assert.equal(result.state, 'TAMPERED', missingPath);
    assert.equal(result.evidence.issues.length, 1, missingPath);
    await assert.rejects(
      verifyGoalRepository(fixture.root, { ...fixture, mutating: true }),
      (error) => error instanceof GoalLockError && error.kind === 'integrity',
      missingPath,
    );
  }
});

test('detects tampering in malformed, noncanonical, and mismatched current or history bytes', async (testContext) => {
  const { initializeGoal, lockInitialGoal, verifyGoalRepository } = await goalRepository();
  const cases = [
    ['malformed current', 'current.json', Buffer.from('{not-json}\n')],
    ['noncanonical current', 'current.json', Buffer.from('{"scope":{},"schema_version":1}\r\n')],
    ['changed current', 'current.json', canonicalBytes({ ...goalV1(), objective: 'Directly edited objective' })],
    ['mismatched history', 'history/goals/v0001.json', canonicalBytes({ ...goalV1(), objective: 'Different archived objective' })],
  ];
  for (const [label, relativePath, bytes] of cases) {
    const fixture = createGoalLockFixture(testContext);
    await initializeGoal(fixture.root, goalV1(), fixture);
    await lockInitialGoal(fixture.root, 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766', fixture);
    await writeFile(join(fixture.root, '.goal-lock', ...relativePath.split('/')), bytes);

    const result = await verifyGoalRepository(fixture.root, fixture);

    assert.equal(result.state, 'TAMPERED', label);
  }
});

test('detects tampering in every goal-bound lock field even with a recomputed record digest', async (testContext) => {
  const { initializeGoal, lockInitialGoal, verifyGoalRepository } = await goalRepository();
  const cases = [
    ['goal_id', (lock) => { lock.goal_id = 'GL-BETA'; }],
    ['goal_version', (lock) => { lock.goal_version = 2; lock.approval_type = 'explicit-change'; lock.predecessor_digest = '3'.repeat(64); }],
    ['goal_digest', (lock) => { lock.goal_digest = '4'.repeat(64); }],
    ['approval_type', (lock) => { lock.goal_version = 2; lock.approval_type = 'explicit-change'; lock.predecessor_digest = '5'.repeat(64); }],
    ['proposal_digest', (lock) => { lock.proposal_digest = '6'.repeat(64); }],
    ['predecessor_digest', (lock) => { lock.goal_version = 2; lock.approval_type = 'explicit-change'; lock.predecessor_digest = '7'.repeat(64); }],
  ];
  for (const [field, mutate] of cases) {
    const fixture = createGoalLockFixture(testContext);
    await initializeGoal(fixture.root, goalV1(), fixture);
    await lockInitialGoal(fixture.root, 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766', fixture);
    const lockPath = join(fixture.root, '.goal-lock', 'lock.json');
    const lock = parseCanonicalJson(await readFile(lockPath), 'test lock');
    delete lock.record_digest;
    mutate(lock);
    lock.record_digest = independentSha256(canonicalBytes(lock));
    await writeFile(lockPath, canonicalBytes(lock));

    const result = await verifyGoalRepository(fixture.root, fixture);

    assert.equal(result.state, 'TAMPERED', field);
  }
});

test('detects tampering in changed lock bytes including timestamp-only changes', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const { initializeGoal, lockInitialGoal, verifyGoalRepository } = await goalRepository();
  await initializeGoal(fixture.root, goalV1(), fixture);
  await lockInitialGoal(fixture.root, 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766', fixture);
  const lockPath = join(fixture.root, '.goal-lock', 'lock.json');
  const lock = parseCanonicalJson(await readFile(lockPath), 'test lock');
  lock.approved_at = '2026-08-23T00:00:01.000Z';
  await writeFile(lockPath, canonicalBytes(lock));

  const result = await verifyGoalRepository(fixture.root, fixture);

  assert.equal(result.state, 'TAMPERED');
  assert.match(result.evidence.issues[0].message, /integrity|lock|digest/i);
});

test('verifies goal history rejects skipped filenames and content-version mismatches', async (testContext) => {
  const { initializeGoal, lockInitialGoal, verifyGoalRepository } = await goalRepository();
  const cases = [
    ['skipped version', async (fixture) => {
      await rename(
        join(fixture.root, '.goal-lock', 'history', 'goals', 'v0001.json'),
        join(fixture.root, '.goal-lock', 'history', 'goals', 'v0002.json'),
      );
    }],
    ['content does not match filename', async (fixture) => {
      const historyPath = join(fixture.root, '.goal-lock', 'history', 'goals', 'v0001.json');
      const wrongVersion = { ...goalV1(), goal_version: 2, predecessor: { goal_version: 1, goal_digest: independentSha256(canonicalBytes(goalV1())) }, accepted_change_id: 'CR-0001' };
      await writeFile(historyPath, canonicalBytes(wrongVersion));
    }],
  ];
  for (const [label, tamper] of cases) {
    const fixture = createGoalLockFixture(testContext);
    await initializeGoal(fixture.root, goalV1(), fixture);
    await lockInitialGoal(fixture.root, 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766', fixture);
    await tamper(fixture);

    const result = await verifyGoalRepository(fixture.root, fixture);

    assert.equal(result.state, 'TAMPERED', label);
  }
});

test('verifies goal history follows predecessor versions, digests, and accepted changes', async (testContext) => {
  const { initializeGoal, lockInitialGoal, verifyGoalRepository } = await goalRepository();
  const valid = createGoalLockFixture(testContext);
  await initializeGoal(valid.root, goalV1(), valid);
  await lockInitialGoal(valid.root, 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766', valid);
  await installVersionTwo(valid);
  assert.equal((await verifyGoalRepository(valid.root, valid)).state, 'LOCKED');

  const cases = [
    ['predecessor.version', (goal) => { goal.predecessor.goal_version = 2; }],
    ['predecessor.digest', (goal) => { goal.predecessor.goal_digest = '8'.repeat(64); }],
    ['accepted_change_id', (goal) => { goal.accepted_change_id = 'CR-0002'; }],
  ];
  for (const [field, tamper] of cases) {
    const fixture = createGoalLockFixture(testContext);
    await initializeGoal(fixture.root, goalV1(), fixture);
    await lockInitialGoal(fixture.root, 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766', fixture);
    const installed = await installVersionTwo(fixture);
    tamper(installed.goal);
    const changedBytes = canonicalBytes(installed.goal);
    const changedDigest = independentSha256(changedBytes);
    const directory = join(fixture.root, '.goal-lock');
    await writeFile(join(directory, 'current.json'), changedBytes);
    await writeFile(join(directory, 'history', 'goals', 'v0002.json'), changedBytes);
    const lockPath = join(directory, 'lock.json');
    const lock = parseCanonicalJson(await readFile(lockPath), 'test lock');
    delete lock.record_digest;
    lock.goal_digest = changedDigest;
    lock.predecessor_digest = installed.goal.predecessor.goal_digest;
    lock.record_digest = independentSha256(canonicalBytes(lock));
    await writeFile(lockPath, canonicalBytes(lock));
    const changePath = join(directory, 'changes', 'CR-0001.json');
    const change = parseCanonicalJson(await readFile(changePath), 'test change');
    change.candidate_digest = changedDigest;
    await writeFile(changePath, canonicalBytes(change));

    const result = await verifyGoalRepository(fixture.root, fixture);

    assert.equal(result.state, 'TAMPERED', field);
  }
});

test('verifies every historical goal is backed by its exact approved change request', async (testContext) => {
  const { initializeGoal, lockInitialGoal, verifyGoalRepository } = await goalRepository();
  const invalid = createGoalLockFixture(testContext);
  await initializeGoal(invalid.root, goalV1(), invalid);
  await lockInitialGoal(invalid.root, 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766', invalid);
  await installVersionThree(invalid, 'rejected');

  assert.equal((await verifyGoalRepository(invalid.root, invalid)).state, 'TAMPERED');

  const valid = createGoalLockFixture(testContext);
  await initializeGoal(valid.root, goalV1(), valid);
  await lockInitialGoal(valid.root, 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766', valid);
  await installVersionThree(valid, 'approved');

  assert.equal((await verifyGoalRepository(valid.root, valid)).state, 'LOCKED');
});

test('verifies goal history preflights optional state and reports a pending change', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const {
    initializeGoal,
    lockInitialGoal,
    proposeGoalChange,
    recordGoalEvent,
    revisePlan,
    verifyGoalRepository,
  } = await goalRepository();
  await initializeGoal(fixture.root, goalV1(), fixture);
  await lockInitialGoal(fixture.root, 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766', fixture);
  const directory = join(fixture.root, '.goal-lock');
  await revisePlan(fixture.root, planCandidate(), 'aligned', fixture);
  await recordGoalEvent(fixture.root, evidenceInput(), fixture);
  await proposeGoalChange(fixture.root, changeProposalInput(), fixture);

  const result = await verifyGoalRepository(fixture.root, fixture);

  assert.equal(result.state, 'CHANGE_PENDING');
  assert.deepEqual(result.evidence.optional, { plan: true, changes: 1, progress_events: 2, evidence_records: 1 });
});

test('detects tampering when optional state is unsafe or noncanonical', async (testContext) => {
  const { initializeGoal, lockInitialGoal, verifyGoalRepository } = await goalRepository();
  const cases = [
    ['plan.json', async (directory) => writeFile(join(directory, 'plan.json'), '{ "schema_version": 1 }\n')],
    ['progress.jsonl', async (directory) => writeFile(join(directory, 'progress.jsonl'), '{bad}\n')],
    ['changes/CR-0001.json', async (directory) => { await mkdir(join(directory, 'changes')); await writeFile(join(directory, 'changes', 'CR-0001.json'), '[]\n'); }],
    ['evidence/AC-001/EVID-0001.json', async (directory) => { await mkdir(join(directory, 'evidence', 'AC-001'), { recursive: true }); await writeFile(join(directory, 'evidence', 'AC-001', 'EVID-0001.json'), '{}\r\n'); }],
  ];
  for (const [label, createInvalid] of cases) {
    const fixture = createGoalLockFixture(testContext);
    await initializeGoal(fixture.root, goalV1(), fixture);
    await lockInitialGoal(fixture.root, 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766', fixture);
    await createInvalid(join(fixture.root, '.goal-lock'));

    const result = await verifyGoalRepository(fixture.root, fixture);

    assert.equal(result.state, 'TAMPERED', label);
  }
});

test('detects tampering in a progress ledger containing invalid UTF-8 bytes', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const { initializeGoal, lockInitialGoal, verifyGoalRepository } = await goalRepository();
  await initializeGoal(fixture.root, goalV1(), fixture);
  await lockInitialGoal(fixture.root, 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766', fixture);
  const prefix = Buffer.from('{"summary":"');
  const suffix = Buffer.from('"}\n');
  await writeFile(join(fixture.root, '.goal-lock', 'progress.jsonl'), Buffer.concat([prefix, Buffer.from([0xff]), suffix]));

  const result = await verifyGoalRepository(fixture.root, fixture);

  assert.equal(result.state, 'TAMPERED');
});

test('detects tampering when lock heads declare missing lifecycle state', async (testContext) => {
  const { initializeGoal, lockInitialGoal, verifyGoalRepository } = await goalRepository();
  const cases = [
    ['progress_head', (lock) => { lock.progress_head = { event_id: 'EVT-000001', digest: '1'.repeat(64) }; }],
    ['change_head', (lock) => { lock.change_head = { change_request_id: 'CR-0001', digest: '2'.repeat(64) }; }],
    ['evidence_heads', (lock) => { lock.evidence_heads = { 'AC-001': { evidence_id: 'EVID-0001', digest: '3'.repeat(64) } }; }],
  ];
  for (const [field, mutate] of cases) {
    const fixture = createGoalLockFixture(testContext);
    await initializeGoal(fixture.root, goalV1(), fixture);
    await lockInitialGoal(fixture.root, 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766', fixture);
    const lockPath = join(fixture.root, '.goal-lock', 'lock.json');
    const lock = parseCanonicalJson(await readFile(lockPath), 'test lock');
    delete lock.record_digest;
    mutate(lock);
    lock.record_digest = independentSha256(canonicalBytes(lock));
    await writeFile(lockPath, canonicalBytes(lock));

    const result = await verifyGoalRepository(fixture.root, fixture);

    assert.equal(result.state, 'TAMPERED', field);
  }
});

test('verifies goal history structurally preflights present plan history', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const { initializeGoal, lockInitialGoal, verifyGoalRepository } = await goalRepository();
  await initializeGoal(fixture.root, goalV1(), fixture);
  await lockInitialGoal(fixture.root, 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766', fixture);
  const directory = join(fixture.root, '.goal-lock');
  await writeFile(join(directory, 'plan.json'), canonicalBytes({ ...structuralPlan(), plan_revision: 2 }));
  await mkdir(join(directory, 'history', 'plans'));
  await writeFile(join(directory, 'history', 'plans', 'v0001-r0001.json'), canonicalBytes(structuralPlan()));
  await writeFile(
    join(directory, 'progress.jsonl'),
    Buffer.from(PLAN_REVISION_EVENT_LINE + SECOND_PLAN_REVISION_EVENT_LINE),
  );
  await rewriteTestLock(fixture, (lock) => {
    lock.state_revision = 3;
    lock.progress_head = { event_id: 'EVT-000002', digest: SECOND_PLAN_REVISION_EVENT_DIGEST };
  });

  const result = await verifyGoalRepository(fixture.root, fixture);

  assert.equal(result.state, 'LOCKED');
  assert.equal(result.evidence.optional.plan, true);
});

test('detects tampering when plan history appears after its structural preflight', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const { initializeGoal, lockInitialGoal, proposeGoalChange, verifyGoalRepository } = await goalRepository();
  await initializeGoal(fixture.root, goalV1(), fixture);
  await lockInitialGoal(fixture.root, 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766', fixture);
  const directory = join(fixture.root, '.goal-lock');
  await proposeGoalChange(fixture.root, changeProposalInput({ affected_tasks: [] }), fixture);
  let injected = false;
  fixture.workspaceFaults = {
    afterFileRead: async ({ relativePath }) => {
      if (relativePath !== '.goal-lock/changes/CR-0001.json' || injected) return;
      injected = true;
      await mkdir(join(directory, 'history', 'plans'));
      await writeFile(join(directory, 'history', 'plans', 'v0001-r0001.json'), '{bad}\n');
    },
  };

  const result = await verifyGoalRepository(fixture.root, fixture);

  assert.equal(result.state, 'TAMPERED');
});

test('detects tampering when lock heads do not match their terminal records', async (testContext) => {
  const { initializeGoal, lockInitialGoal, verifyGoalRepository } = await goalRepository();
  const cases = [
    ['progress_head', async (fixture, directory) => {
      await writeFile(join(directory, 'progress.jsonl'), canonicalBytes(structuralProgressEvent('EVT-000002', '4'.repeat(64))));
      await rewriteTestLock(fixture, (lock) => { lock.progress_head = { event_id: 'EVT-000001', digest: '1'.repeat(64) }; });
    }],
    ['change_head', async (fixture, directory) => {
      await mkdir(join(directory, 'changes'));
      const changeBytes = canonicalBytes(structuralChange('CR-0002'));
      await writeFile(join(directory, 'changes', 'CR-0002.json'), changeBytes);
      await rewriteTestLock(fixture, (lock) => { lock.change_head = { change_request_id: 'CR-0001', digest: independentSha256(changeBytes) }; });
    }],
    ['evidence_heads', async (fixture, directory) => {
      await mkdir(join(directory, 'evidence', 'AC-001'), { recursive: true });
      await rewriteTestLock(fixture, (lock) => { lock.evidence_heads = { 'AC-001': { evidence_id: 'EVID-0001', digest: '3'.repeat(64) } }; });
    }],
  ];
  for (const [field, arrange] of cases) {
    const fixture = createGoalLockFixture(testContext);
    await initializeGoal(fixture.root, goalV1(), fixture);
    await lockInitialGoal(fixture.root, 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766', fixture);
    await arrange(fixture, join(fixture.root, '.goal-lock'));

    const result = await verifyGoalRepository(fixture.root, fixture);

    assert.equal(result.state, 'TAMPERED', field);
  }
});

test('detects tampering in canonical optional objects without required envelopes', async (testContext) => {
  const { initializeGoal, lockInitialGoal, verifyGoalRepository } = await goalRepository();
  const cases = [
    ['plan', async (directory) => writeFile(join(directory, 'plan.json'), canonicalBytes({}))],
    ['progress', async (directory) => writeFile(join(directory, 'progress.jsonl'), canonicalBytes({}))],
    ['change', async (directory) => { await mkdir(join(directory, 'changes')); await writeFile(join(directory, 'changes', 'CR-0001.json'), canonicalBytes({})); }],
    ['evidence', async (directory) => { await mkdir(join(directory, 'evidence', 'AC-001'), { recursive: true }); await writeFile(join(directory, 'evidence', 'AC-001', 'EVID-0001.json'), canonicalBytes({})); }],
  ];
  for (const [artifact, arrange] of cases) {
    const fixture = createGoalLockFixture(testContext);
    await initializeGoal(fixture.root, goalV1(), fixture);
    await lockInitialGoal(fixture.root, 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766', fixture);
    await arrange(join(fixture.root, '.goal-lock'));

    const result = await verifyGoalRepository(fixture.root, fixture);

    assert.equal(result.state, 'TAMPERED', artifact);
  }
});

test('cooperative lock writes canonical owner bytes and removes them after success', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);

  const result = await withGoalLock(fixture.root, 'init', async () => {
    const bytes = await readFile(join(fixture.root, '.goal-lock', '.write-lock.json'));
    assert.deepEqual(bytes, canonicalBytes({
      protocol: 'goal-version-lock-write-v1',
      token: 'deterministic-token',
      pid: 4242,
      command: 'init',
      created_at: '2026-08-23T00:00:00.000Z',
    }));
    return 'committed';
  }, fixture);

  assert.equal(result, 'committed');
  assert.equal(existsSync(join(fixture.root, '.goal-lock', '.write-lock.json')), false);
});

test('cooperative lock rejects a second writer without disturbing the owner', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const lockPath = join(fixture.root, '.goal-lock', '.write-lock.json');

  await withGoalLock(fixture.root, 'first', async () => {
    const ownerBytes = await readFile(lockPath);
    await assert.rejects(
      withGoalLock(fixture.root, 'second', async () => {}, fixture),
      (error) => error instanceof GoalLockError && error.code === 'LOCK_HELD' && error.exitCode === 3,
    );
    assert.deepEqual(await readFile(lockPath), ownerBytes);
  }, fixture);
});

test('cooperative lock cleans up after a failed callback', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const failure = new Error('operation failed');

  await assert.rejects(
    withGoalLock(fixture.root, 'record', async () => { throw failure; }, fixture),
    (error) => error === failure,
  );
  assert.equal(existsSync(join(fixture.root, '.goal-lock', '.write-lock.json')), false);
});

test('cooperative lock release preserves another writer replacement', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const lockPath = join(fixture.root, '.goal-lock', '.write-lock.json');
  const replacement = canonicalBytes({
    protocol: 'goal-version-lock-write-v1',
    token: 'replacement-token',
    pid: 4343,
    command: 'approve',
    created_at: '2026-08-23T00:01:00.000Z',
  });

  await assert.rejects(withGoalLock(fixture.root, 'record', async () => {
    await unlink(lockPath);
    await writeFile(lockPath, replacement, { mode: 0o600 });
  }, fixture), (error) => error instanceof GoalLockError && error.code === 'LOCK_OWNERSHIP');

  assert.deepEqual(await readFile(lockPath), replacement);
});

test('cooperative lock treats malformed existing ownership as integrity failure', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const lockPath = join(fixture.root, '.goal-lock', '.write-lock.json');
  await mkdir(join(fixture.root, '.goal-lock'));
  await writeFile(lockPath, 'not canonical JSON', { mode: 0o600 });

  await assert.rejects(
    withGoalLock(fixture.root, 'init', async () => {}, fixture),
    (error) => error instanceof GoalLockError && error.kind === 'integrity' && error.exitCode === 4,
  );
  assert.equal((await readFile(lockPath, 'utf8')), 'not canonical JSON');
});

test('cooperative lock cleans only its own initialized lock after a write fault', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const failure = new Error('lock write fault');
  fixture.transactionFaults.afterLockWrite = () => { throw failure; };

  await assert.rejects(
    withGoalLock(fixture.root, 'init', async () => {}, fixture),
    (error) => error === failure,
  );
  assert.equal(existsSync(join(fixture.root, '.goal-lock', '.write-lock.json')), false);
});

test('cooperative lock rejects a linked repository root before mutation', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const actualRoot = join(fixture.root, 'actual');
  const linkedRoot = join(fixture.root, 'linked');
  await mkdir(actualRoot);
  await symlink(actualRoot, linkedRoot, 'junction');

  await assert.rejects(
    withGoalLock(linkedRoot, 'init', async () => {}, fixture),
    (error) => error instanceof GoalLockError && error.kind === 'integrity',
  );
  assert.equal(existsSync(join(actualRoot, '.goal-lock')), false);
});

test('cooperative lock rejects semantically invalid canonical owner records', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  const lockPath = join(directory, '.write-lock.json');
  await mkdir(directory);
  await writeFile(lockPath, canonicalBytes({
    protocol: 'goal-version-lock-write-v1',
    token: 'old-owner',
    pid: 1234,
    command: 'record',
    created_at: '2026-02-30T00:00:00.000Z',
  }));

  await assert.rejects(
    withGoalLock(fixture.root, 'init', async () => {}, fixture),
    (error) => error instanceof GoalLockError && error.kind === 'integrity',
  );
});

test('cooperative lock validates owner inputs before creating state', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);

  await assert.rejects(
    withGoalLock(fixture.root, ' ', async () => {}, fixture),
    (error) => error instanceof GoalLockError && error.kind === 'input',
  );
  assert.equal(existsSync(join(fixture.root, '.goal-lock')), false);
});

test('cooperative lock issues a fresh token for each acquisition', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const issued = ['token-one', 'token-two'];
  const observed = [];
  const context = { ...fixture, randomToken: () => issued.shift() };

  for (const command of ['init', 'plan']) {
    await withGoalLock(fixture.root, command, async () => {
      const owner = parseCanonicalJson(await readFile(join(fixture.root, '.goal-lock', '.write-lock.json')));
      observed.push(owner.token);
    }, context);
  }

  assert.deepEqual(observed, ['token-one', 'token-two']);
});

test('cooperative lock age alone never authorizes removal', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  const lockPath = join(directory, '.write-lock.json');
  const oldOwner = canonicalBytes({
    protocol: 'goal-version-lock-write-v1',
    token: 'old-owner',
    pid: 1234,
    command: 'record',
    created_at: '2000-01-01T00:00:00.000Z',
  });
  await mkdir(directory);
  await writeFile(lockPath, oldOwner);

  await assert.rejects(
    withGoalLock(fixture.root, 'init', async () => {}, fixture),
    (error) => error instanceof GoalLockError && error.code === 'LOCK_HELD',
  );
  assert.deepEqual(await readFile(lockPath), oldOwner);
});

test('cooperative lock rejects non-regular and linked lock paths', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  const lockPath = join(directory, '.write-lock.json');
  await mkdir(directory);
  await mkdir(lockPath);

  await assert.rejects(
    withGoalLock(fixture.root, 'init', async () => {}, fixture),
    (error) => error instanceof GoalLockError && error.kind === 'integrity',
  );

  const linkedFixture = createGoalLockFixture(testContext);
  const linkedDirectory = join(linkedFixture.root, '.goal-lock');
  const realDirectory = join(linkedDirectory, 'owner-directory');
  const linkedLockPath = join(linkedDirectory, '.write-lock.json');
  await mkdir(realDirectory, { recursive: true });
  await symlink(realDirectory, linkedLockPath, 'junction');
  await assert.rejects(
    withGoalLock(linkedFixture.root, 'init', async () => {}, linkedFixture),
    (error) => error instanceof GoalLockError && error.kind === 'integrity',
  );
});

test('cooperative lock rejects an external hard-linked existing owner', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  const lockPath = join(directory, '.write-lock.json');
  const externalPath = join(fixture.root, 'external-owner.json');
  const ownerBytes = canonicalBytes({
    protocol: 'goal-version-lock-write-v1', token: 'external-owner', pid: 9999, command: 'record', created_at: '2026-08-22T00:00:00.000Z',
  });
  await mkdir(directory);
  await writeFile(externalPath, ownerBytes);
  await link(externalPath, lockPath);

  await assert.rejects(
    withGoalLock(fixture.root, 'init', async () => {}, fixture),
    (error) => error instanceof GoalLockError && error.kind === 'integrity',
  );
  assert.deepEqual(await readFile(lockPath), ownerBytes);
  assert.equal((await lstat(lockPath, { bigint: true })).nlink, 2n);
});

test('cooperative lock release refuses an external hard link added by its callback', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const lockPath = join(fixture.root, '.goal-lock', '.write-lock.json');
  const externalPath = join(fixture.root, 'external-owner.json');

  await assert.rejects(withGoalLock(fixture.root, 'record', async () => {
    await link(lockPath, externalPath);
  }, fixture), (error) => error instanceof GoalLockError && error.kind === 'integrity');

  assert.equal(existsSync(lockPath), true);
  assert.equal(existsSync(externalPath), true);
  assert.equal((await lstat(lockPath, { bigint: true })).nlink, 2n);
});

test('transaction completes every target preflight before creating files', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);

  await assert.rejects(commitGoalFiles(fixture.root, [
    { target: '.goal-lock/current.json', expected: { kind: 'absent' }, content: Buffer.from('current') },
    { target: '.goal-lock/plan.json', expected: { kind: 'sha256', digest: '1'.repeat(64) }, content: Buffer.from('plan') },
  ], fixture), (error) => error instanceof GoalLockError && error.kind === 'integrity');

  assert.equal(existsSync(join(fixture.root, '.goal-lock')), false);
});

test('transaction rejects expected-absent ownership without changing the target', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const target = join(fixture.root, '.goal-lock', 'current.json');
  const original = Buffer.from('accepted-current');
  await mkdir(join(fixture.root, '.goal-lock'));
  await writeFile(target, original);

  await assert.rejects(commitGoalFiles(fixture.root, [
    { target: '.goal-lock/current.json', expected: { kind: 'absent' }, content: Buffer.from('replacement') },
  ], fixture), (error) => error instanceof GoalLockError && error.kind === 'integrity');
  assert.deepEqual(await readFile(target), original);
});

test('transaction creates an expected-absent target through a cleaned same-directory stage', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const content = canonicalBytes({ schema_version: 1 });

  const receipt = await commitGoalFiles(fixture.root, [
    { target: '.goal-lock/current.json', expected: { kind: 'absent' }, content },
  ], fixture);

  assert.deepEqual(await readFile(join(fixture.root, '.goal-lock', 'current.json')), content);
  assert.deepEqual(await readdir(join(fixture.root, '.goal-lock')), ['current.json']);
  assert.deepEqual(receipt, { warnings: [] });
});

test('transaction retains target identity when exact bytes are a final ownership precondition', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  const currentPath = join(directory, 'current.json');
  const current = canonicalBytes({ goal: 'draft' });
  await mkdir(directory);
  await writeFile(currentPath, current);
  const before = await lstat(currentPath, { bigint: true });

  await commitGoalFiles(fixture.root, [
    { target: '.goal-lock/current.json', expected: { kind: 'sha256', digest: sha256(current) }, content: current },
    { target: '.goal-lock/lock.json', expected: { kind: 'absent' }, content: canonicalBytes({ state: 'locked' }) },
  ], fixture);

  const after = await lstat(currentPath, { bigint: true });
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.deepEqual(await readFile(currentPath), current);
});

test('transaction replaces only the target with the exact expected digest', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  const target = join(directory, 'current.json');
  const original = canonicalBytes({ version: 1 });
  const replacement = canonicalBytes({ version: 2 });
  await mkdir(directory);
  await writeFile(target, original);

  const receipt = await commitGoalFiles(fixture.root, [
    { target: '.goal-lock/current.json', expected: { kind: 'sha256', digest: sha256(original) }, content: replacement },
  ], fixture);

  assert.deepEqual(await readFile(target), replacement);
  assert.deepEqual(await readdir(directory), ['current.json']);
  assert.deepEqual(receipt, { warnings: [] });
});

test('transaction rejects duplicate targets during preflight', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);

  await assert.rejects(commitGoalFiles(fixture.root, [
    { target: '.goal-lock/current.json', expected: { kind: 'absent' }, content: Buffer.from('one') },
    { target: '.goal-lock/current.json', expected: { kind: 'absent' }, content: Buffer.from('two') },
  ], fixture), (error) => error instanceof GoalLockError && error.kind === 'integrity');

  assert.equal(existsSync(join(fixture.root, '.goal-lock')), false);
});

test('transaction rejects unknown entry fields before mutation', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);

  await assert.rejects(commitGoalFiles(fixture.root, [
    { target: '.goal-lock/current.json', expected: { kind: 'absent' }, content: Buffer.from('current'), extra: true },
  ], fixture), (error) => error instanceof GoalLockError && error.kind === 'input');

  assert.equal(existsSync(join(fixture.root, '.goal-lock')), false);
});

test('transaction rejects escaping and internal ownership targets', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const unsafeTargets = [
    'current.json',
    '.goal-lock/../outside.json',
    '.goal-lock\\current.json',
    join(fixture.root, '.goal-lock', 'current.json'),
    '.goal-lock/.write-lock.json',
    '.goal-lock/.current.example.0.stage',
    '.goal-lock/.current.example.0.backup',
  ];

  for (const target of unsafeTargets) {
    await assert.rejects(commitGoalFiles(fixture.root, [
      { target, expected: { kind: 'absent' }, content: Buffer.from('unsafe') },
    ], fixture), (error) => error instanceof GoalLockError && error.kind === 'integrity');
    assert.equal(existsSync(join(fixture.root, '.goal-lock')), false);
  }
});

test('transaction rejects internal ownership artifact names in ancestor segments', async (testContext) => {
  const targets = [
    '.goal-lock/.write-lock.json/child.json',
    '.goal-lock/.current.example.0.stage/child.json',
    '.goal-lock/.current.example.0.backup/child.json',
    '.goal-lock/.current.example.0.detached/child.json',
  ];

  for (const target of targets) {
    const fixture = createGoalLockFixture(testContext);
    await assert.rejects(commitGoalFiles(fixture.root, [
      { target, expected: { kind: 'absent' }, content: Buffer.from('unsafe') },
    ], fixture), (error) => error instanceof GoalLockError && error.kind === 'integrity');
    assert.equal(existsSync(join(fixture.root, '.goal-lock')), false);
  }
});

test('transaction rejects linked target parents before mutation', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  const external = join(fixture.root, 'external');
  await mkdir(directory);
  await mkdir(external);
  await symlink(external, join(directory, 'history'), 'junction');

  await assert.rejects(commitGoalFiles(fixture.root, [
    { target: '.goal-lock/history/goals/v0001.json', expected: { kind: 'absent' }, content: Buffer.from('history') },
  ], fixture), (error) => error instanceof GoalLockError && error.kind === 'integrity');
  assert.deepEqual(await readdir(external), []);
});

test('transaction stage write failure removes only directories it created', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const evidenceDirectory = join(fixture.root, '.goal-lock', 'evidence');
  const createdDirectory = join(evidenceDirectory, 'AC-001');
  const failure = new Error('stage write failed');
  await mkdir(evidenceDirectory, { recursive: true });
  fixture.transactionFaults.stageWrite = () => { throw failure; };

  await assert.rejects(commitGoalFiles(fixture.root, [
    { target: '.goal-lock/evidence/AC-001/EVID-0001.json', expected: { kind: 'absent' }, content: Buffer.from('evidence') },
  ], fixture), (error) => error === failure);

  assert.equal(existsSync(createdDirectory), false);
  assert.equal(existsSync(evidenceDirectory), true);
  assert.deepEqual(await readdir(evidenceDirectory), []);
});

test('transaction detach failure preserves the original and removes owned artifacts', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  const target = join(directory, 'current.json');
  const original = Buffer.from('accepted');
  const failure = new Error('detach failed');
  await mkdir(directory);
  await writeFile(target, original);
  fixture.transactionFaults.detach = () => { throw failure; };

  await assert.rejects(commitGoalFiles(fixture.root, [
    { target: '.goal-lock/current.json', expected: { kind: 'sha256', digest: sha256(original) }, content: Buffer.from('candidate') },
  ], fixture), (error) => error === failure);

  assert.deepEqual(await readFile(target), original);
  assert.deepEqual(await readdir(directory), ['current.json']);
});

test('transaction install failure restores the detached original', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  const target = join(directory, 'current.json');
  const original = Buffer.from('accepted');
  const failure = new Error('install failed');
  await mkdir(directory);
  await writeFile(target, original);
  fixture.transactionFaults.install = () => { throw failure; };

  await assert.rejects(commitGoalFiles(fixture.root, [
    { target: '.goal-lock/current.json', expected: { kind: 'sha256', digest: sha256(original) }, content: Buffer.from('candidate') },
  ], fixture), (error) => error === failure);

  assert.deepEqual(await readFile(target), original);
  assert.deepEqual(await readdir(directory), ['current.json']);
});

test('transaction read-back failure rolls back a verified installation', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  const target = join(directory, 'current.json');
  const original = Buffer.from('accepted');
  const failure = new Error('read-back mismatch');
  await mkdir(directory);
  await writeFile(target, original);
  fixture.transactionFaults.readBack = () => { throw failure; };

  await assert.rejects(commitGoalFiles(fixture.root, [
    { target: '.goal-lock/current.json', expected: { kind: 'sha256', digest: sha256(original) }, content: Buffer.from('candidate') },
  ], fixture), (error) => error === failure);

  assert.deepEqual(await readFile(target), original);
  assert.deepEqual(await readdir(directory), ['current.json']);
});

test('transaction restores the original when the installed target disappears during verification', async (testContext) => {
  for (const phase of ['readBack', 'finalReadBack']) {
    const fixture = createGoalLockFixture(testContext);
    const directory = join(fixture.root, '.goal-lock');
    const target = join(directory, 'current.json');
    const original = Buffer.from('accepted');
    await mkdir(directory);
    await writeFile(target, original);
    fixture.transactionFaults[phase] = async () => { await unlink(target); };

    await assert.rejects(commitGoalFiles(fixture.root, [
      { target: '.goal-lock/current.json', expected: { kind: 'sha256', digest: sha256(original) }, content: Buffer.from('candidate') },
    ], fixture), (error) => error instanceof Error && !(error instanceof AggregateError));

    assert.deepEqual(await readFile(target), original);
    assert.deepEqual(await readdir(directory), ['current.json']);
  }
});

test('transaction final read-back detects a changed installed target', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  const target = join(directory, 'current.json');
  const original = Buffer.from('accepted');
  const foreign = Buffer.from('changed-after-install');
  await mkdir(directory);
  await writeFile(target, original);
  fixture.transactionFaults.finalReadBack = async () => {
    await unlink(target);
    await writeFile(target, foreign);
  };

  await assert.rejects(commitGoalFiles(fixture.root, [
    { target: '.goal-lock/current.json', expected: { kind: 'sha256', digest: sha256(original) }, content: Buffer.from('candidate') },
  ], fixture), AggregateError);

  assert.deepEqual(await readFile(target), foreign);
  assert.equal((await readdir(directory)).filter((name) => name.endsWith('.backup')).length, 1);
});

test('transaction rolls back touched targets in reverse order', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const rollbackOrder = [];
  fixture.transactionFaults.readBack = ({ index }) => {
    if (index === 1) throw new Error('second read-back failed');
  };
  fixture.transactionFaults.rollback = ({ index }) => { rollbackOrder.push(index); };

  await assert.rejects(commitGoalFiles(fixture.root, [
    { target: '.goal-lock/current.json', expected: { kind: 'absent' }, content: Buffer.from('current') },
    { target: '.goal-lock/plan.json', expected: { kind: 'absent' }, content: Buffer.from('plan') },
  ], fixture), /second read-back failed/);

  assert.deepEqual(rollbackOrder, [1, 0]);
  assert.equal(existsSync(join(fixture.root, '.goal-lock')), false);
});

test('transaction preserves foreign replacement and owned recovery backup when rollback is uncertain', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  const target = join(directory, 'current.json');
  const original = Buffer.from('accepted');
  const foreign = Buffer.from('foreign-writer');
  await mkdir(directory);
  await writeFile(target, original);
  fixture.transactionFaults.readBack = async () => {
    await unlink(target);
    await writeFile(target, foreign);
    throw new Error('raced read-back');
  };

  await assert.rejects(commitGoalFiles(fixture.root, [
    { target: '.goal-lock/current.json', expected: { kind: 'sha256', digest: sha256(original) }, content: Buffer.from('candidate') },
  ], fixture), AggregateError);

  assert.deepEqual(await readFile(target), foreign);
  const recoveryArtifacts = (await readdir(directory)).filter((name) => name.endsWith('.backup'));
  assert.equal(recoveryArtifacts.length, 1);
  assert.deepEqual(await readFile(join(directory, recoveryArtifacts[0])), original);
});

test('transaction deletes a target only with its exact expected digest', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  const target = join(directory, 'plan.json');
  const original = Buffer.from('plan');
  await mkdir(directory);
  await writeFile(target, original);

  await commitGoalFiles(fixture.root, [
    { target: '.goal-lock/plan.json', expected: { kind: 'sha256', digest: sha256(original) }, content: null },
  ], fixture);

  assert.equal(existsSync(target), false);
  assert.deepEqual(await readdir(directory), []);
});

test('transaction rejects a stale expected digest without producing stages', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  const target = join(directory, 'current.json');
  const original = Buffer.from('accepted');
  await mkdir(directory);
  await writeFile(target, original);

  await assert.rejects(commitGoalFiles(fixture.root, [
    { target: '.goal-lock/current.json', expected: { kind: 'sha256', digest: 'a'.repeat(64) }, content: Buffer.from('candidate') },
  ], fixture), (error) => error instanceof GoalLockError && error.kind === 'integrity');

  assert.deepEqual(await readFile(target), original);
  assert.deepEqual(await readdir(directory), ['current.json']);
});

test('recover removes an exact canonical lock only after its process is dead', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  const lockPath = join(directory, '.write-lock.json');
  const lockBytes = canonicalBytes({
    protocol: 'goal-version-lock-write-v1',
    token: 'stale-owner',
    pid: 9999,
    command: 'record',
    created_at: '2026-08-22T00:00:00.000Z',
  });
  await mkdir(directory);
  await writeFile(lockPath, lockBytes);

  const receipt = await recoverGoalLock(fixture.root, {
    owner_token: 'stale-owner',
    lock_digest: sha256(lockBytes),
  }, fixture);

  assert.deepEqual(receipt, {
    recovered: true,
    pid: 9999,
    command: 'record',
    created_at: '2026-08-22T00:00:00.000Z',
  });
  assert.equal(Object.hasOwn(receipt, 'token'), false);
  assert.equal(existsSync(lockPath), false);
});

test('recover refuses an externally hard-linked lock', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  const lockPath = join(directory, '.write-lock.json');
  const externalPath = join(fixture.root, 'external-owner.json');
  const lockBytes = canonicalBytes({
    protocol: 'goal-version-lock-write-v1', token: 'stale-owner', pid: 9999, command: 'record', created_at: '2026-08-22T00:00:00.000Z',
  });
  await mkdir(directory);
  await writeFile(externalPath, lockBytes);
  await link(externalPath, lockPath);

  await assert.rejects(recoverGoalLock(fixture.root, {
    owner_token: 'stale-owner',
    lock_digest: sha256(lockBytes),
  }, fixture), (error) => error instanceof GoalLockError && error.kind === 'integrity');

  assert.deepEqual(await readFile(lockPath), lockBytes);
  assert.equal((await lstat(lockPath, { bigint: true })).nlink, 2n);
});

test('recover rejects a missing lock without creating recovery state', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);

  await assert.rejects(recoverGoalLock(fixture.root, {
    owner_token: 'missing-owner',
    lock_digest: '0'.repeat(64),
  }, fixture), (error) => error instanceof GoalLockError && error.code === 'RECOVERY_LOCK_MISSING');

  assert.equal(existsSync(join(fixture.root, '.goal-lock')), false);
});

test('recover refuses live and inaccessible process states', async (testContext) => {
  for (const isProcessAlive of [
    () => true,
    () => { throw Object.assign(new Error('access denied'), { code: 'EPERM' }); },
  ]) {
    const fixture = createGoalLockFixture(testContext);
    const directory = join(fixture.root, '.goal-lock');
    const lockPath = join(directory, '.write-lock.json');
    const lockBytes = canonicalBytes({
      protocol: 'goal-version-lock-write-v1',
      token: 'current-owner',
      pid: 9999,
      command: 'record',
      created_at: '2026-08-22T00:00:00.000Z',
    });
    await mkdir(directory);
    await writeFile(lockPath, lockBytes);

    await assert.rejects(recoverGoalLock(fixture.root, {
      owner_token: 'current-owner',
      lock_digest: sha256(lockBytes),
    }, { ...fixture, isProcessAlive }), (error) => error instanceof GoalLockError && error.kind === 'integrity');
    assert.deepEqual(await readFile(lockPath), lockBytes);
    assert.deepEqual(await readdir(directory), ['.write-lock.json']);
  }
});

test('recover rejects malformed bytes and mismatched token or digest', async (testContext) => {
  const cases = [
    { bytes: Buffer.from('not canonical'), owner_token: 'owner', lock_digest: sha256(Buffer.from('not canonical')) },
    {
      bytes: canonicalBytes({ protocol: 'goal-version-lock-write-v1', token: 'owner', pid: 9999, command: 'record', created_at: '2026-08-22T00:00:00.000Z' }),
      owner_token: 'wrong-owner',
      lock_digest: null,
    },
    {
      bytes: canonicalBytes({ protocol: 'goal-version-lock-write-v1', token: 'owner', pid: 9999, command: 'record', created_at: '2026-08-22T00:00:00.000Z' }),
      owner_token: 'owner',
      lock_digest: 'f'.repeat(64),
    },
  ];

  for (const recoveryCase of cases) {
    const fixture = createGoalLockFixture(testContext);
    const directory = join(fixture.root, '.goal-lock');
    const lockPath = join(directory, '.write-lock.json');
    await mkdir(directory);
    await writeFile(lockPath, recoveryCase.bytes);
    const lockDigest = recoveryCase.lock_digest ?? sha256(recoveryCase.bytes);

    await assert.rejects(recoverGoalLock(fixture.root, {
      owner_token: recoveryCase.owner_token,
      lock_digest: lockDigest,
    }, fixture), (error) => error instanceof GoalLockError && error.kind === 'integrity');
    assert.deepEqual(await readFile(lockPath), recoveryCase.bytes);
  }
});

test('recover rejects a raced lock identity without disturbing its replacement', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  const lockPath = join(directory, '.write-lock.json');
  const initial = canonicalBytes({
    protocol: 'goal-version-lock-write-v1', token: 'stale-owner', pid: 9999, command: 'record', created_at: '2026-08-22T00:00:00.000Z',
  });
  const replacement = canonicalBytes({
    protocol: 'goal-version-lock-write-v1', token: 'new-owner', pid: 8888, command: 'plan', created_at: '2026-08-23T00:00:00.000Z',
  });
  await mkdir(directory);
  await writeFile(lockPath, initial);
  fixture.transactionFaults.beforeRecoveryDetach = async () => {
    await unlink(lockPath);
    await writeFile(lockPath, replacement);
  };

  await assert.rejects(recoverGoalLock(fixture.root, {
    owner_token: 'stale-owner',
    lock_digest: sha256(initial),
  }, fixture), (error) => error instanceof GoalLockError && error.kind === 'integrity');

  assert.deepEqual(await readFile(lockPath), replacement);
  assert.deepEqual(await readdir(directory), ['.write-lock.json']);
});

test('recover restores the verified lock if its process becomes active before removal', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  const lockPath = join(directory, '.write-lock.json');
  const lockBytes = canonicalBytes({
    protocol: 'goal-version-lock-write-v1', token: 'owner', pid: 9999, command: 'record', created_at: '2026-08-22T00:00:00.000Z',
  });
  let checks = 0;
  await mkdir(directory);
  await writeFile(lockPath, lockBytes);

  await assert.rejects(recoverGoalLock(fixture.root, {
    owner_token: 'owner',
    lock_digest: sha256(lockBytes),
  }, { ...fixture, isProcessAlive: () => { checks += 1; return checks > 1; } }),
  (error) => error instanceof GoalLockError && error.code === 'RECOVERY_PROCESS_ACTIVE');

  assert.equal(checks, 2);
  assert.deepEqual(await readFile(lockPath), lockBytes);
  assert.deepEqual(await readdir(directory), ['.write-lock.json']);
});

test('canonical JSON recursively orders object keys while preserving array order', () => {
  const value = { z: [{ b: 2, a: 1 }, 'last'], a: { z: true, a: false } };

  assert.equal(canonicalJson(value), '{"a":{"a":false,"z":true},"z":[{"a":1,"b":2},"last"]}\n');
});

test('canonical JSON preserves a valid __proto__ JSON key as data', () => {
  const value = JSON.parse('{"a":1,"__proto__":{"safe":true}}');

  assert.equal(canonicalJson(value), '{"__proto__":{"safe":true},"a":1}\n');
  assert.deepEqual(parseCanonicalJson(Buffer.from('{"__proto__":{"safe":true},"a":1}\n'), 'goal'), value);
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

test('canonical JSON parser rejects duplicate keys and missing or repeated terminators', () => {
  assert.throws(() => parseCanonicalJson(Buffer.from('{"a":1,"a":1}\n'), 'goal'), /canonical/i);
  assert.throws(() => parseCanonicalJson(Buffer.from('{"a":1}'), 'goal'), /canonical/i);
  assert.throws(() => parseCanonicalJson(Buffer.from('{"a":1}\n\n'), 'goal'), /canonical/i);
});

test('goal lock fixture uses an isolated Git repository by default', (testContext) => {
  const fixture = createGoalLockFixture(testContext);

  assert.equal(fixture.now(), '2026-08-23T00:00:00.000Z');
  assert.equal(fixture.pid, 4242);
  assert.equal(fixture.isProcessAlive(1), false);
});

test('goal lock fixture initializes Git with the deterministic test identity', (testContext) => {
  const fixture = createGoalLockFixture(testContext);

  assert.equal(execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: fixture.root, encoding: 'utf8' }).trim(), 'true');
  assert.equal(execFileSync('git', ['config', 'user.email'], { cwd: fixture.root, encoding: 'utf8' }).trim(), 'tester@example.invalid');
});

test('goal lock fixture omits Git when explicitly disabled', (testContext) => {
  const fixture = createGoalLockFixture(testContext, { git: false });

  assert.equal(existsSync(join(fixture.root, '.git')), false);
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

test('goal contract validates the semantic boundary of every root field', () => {
  const cases = [
    ['schema_version', (goal) => { goal.schema_version = 2; }],
    ['goal_id', (goal) => { goal.goal_id = 'GL-lowercase'; }],
    ['goal_version', (goal) => { goal.goal_version = 0; }],
    ['objective', (goal) => { goal.objective = ''; }],
    ['scope', (goal) => { goal.scope = null; }],
    ['non_goals', (goal) => { goal.non_goals = [' ']; }],
    ['constraints', (goal) => { goal.constraints = [{ id: '', text: 'Use Node.js' }]; }],
    ['acceptance_criteria', (goal) => { goal.acceptance_criteria = [{ id: 'AC-1', outcome: 'State is locked', verification: 'Run verification' }]; }],
    ['authorization_boundary', (goal) => { goal.authorization_boundary = ['']; }],
    ['assumptions', (goal) => { goal.assumptions = [{ statement: 'Git is installed', confidence: 'certain' }]; }],
    ['predecessor', (goal) => { goal.predecessor = { goal_version: 1, goal_digest: '1111111111111111111111111111111111111111111111111111111111111111' }; }],
    ['accepted_change_id', (goal) => { goal.accepted_change_id = 'CR-0001'; }],
  ];

  for (const [field, change] of cases) {
    const input = goalV1();
    change(input);
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

test('goal contract rejects sparse and property-bearing semantic arrays', () => {
  const sparseScope = goalV1();
  sparseScope.scope.in = [];
  sparseScope.scope.in[1] = 'CLI';
  assert.throws(() => validateGoalContract(sparseScope), /scope\.in/i);

  const decoratedScope = goalV1();
  decoratedScope.scope.in.extra = 'not JSON array data';
  assert.throws(() => validateGoalContract(decoratedScope), /scope\.in/i);
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

test('lock contract validates the semantic boundary of every root field', () => {
  const cases = [
    ['schema_version', (lock) => { lock.schema_version = 2; }],
    ['goal_id', (lock) => { lock.goal_id = 'GL-lowercase'; }],
    ['goal_version', (lock) => { lock.goal_version = 0; }],
    ['goal_digest', (lock) => { lock.goal_digest = 'not-a-digest'; }],
    ['approval_type', (lock) => { lock.approval_type = 'implicit'; }],
    ['proposal_digest', (lock) => { lock.proposal_digest = 'not-a-digest'; }],
    ['approved_at', (lock) => { lock.approved_at = 'not-a-timestamp'; }],
    ['predecessor_digest', (lock) => { lock.predecessor_digest = '1111111111111111111111111111111111111111111111111111111111111111'; }],
    ['state_revision', (lock) => { lock.state_revision = 0; }],
    ['progress_head', (lock) => { lock.progress_head = {}; }],
    ['change_head', (lock) => { lock.change_head = {}; }],
    ['evidence_heads', (lock) => { lock.evidence_heads = { invalid: {} }; }],
    ['record_digest', (lock) => { lock.record_digest = 'not-a-digest'; }],
  ];

  for (const [field, change] of cases) {
    const input = lockV1();
    change(input);
    assert.throws(() => validateLockRecord(input), new RegExp(field));
  }
});

test('lock contract rejects impossible RFC 3339 calendar dates and times', () => {
  for (const approvedAt of ['2026-02-30T00:00:00Z', '2026-08-23T24:00:00Z', '2026-08-23T23:60:00Z', '2026-08-23T23:59:60Z']) {
    const input = lockV1();
    input.approved_at = approvedAt;
    assert.throws(() => validateLockRecord(input), /approved_at/i);
  }
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
