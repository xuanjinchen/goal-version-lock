import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { canonicalBytes } from '../src/goal-lock/canonical.js';
import { createGoalRecord, createProposal } from '../src/goal-lock/contract.js';
import { createHistoryRecord, replaceCurrentRecord, replaceProposal } from '../src/goal-lock/store.js';
import {
  approveGoal,
  getGoalStatus,
  initializeGoal,
  proposeGoal,
  verifyGoal,
} from '../src/goal-lock/state-machine.js';
import { createGoalLockFixture, goalInput } from './helpers/goal-lock-fixture.js';

test('initial proposal has no authority until exact approval', async (t) => {
  const { root } = await createGoalLockFixture(t);
  const initialized = await initializeGoal(root, goalInput());
  assert.equal(initialized.state, 'initial-proposed');
  assert.equal(initialized.active, null);
  await assert.rejects(
    approveGoal(root, 'confirm'),
    (error) => error.code === 'APPROVAL_REJECTED' && error.exitCode === 5,
  );
  assert.equal((await verifyGoal(root)).active, null);
  const approved = await approveGoal(root, initialized.proposal.approval_phrase);
  assert.deepEqual(approved, {
    state: 'active',
    active: { version: 1, digest: initialized.proposal.candidate_digest },
  });
});

test('returns no-change without creating a new version', async (t) => {
  const fixture = await approvedFixture(t);
  const before = await getGoalStatus(fixture.root);
  const result = await proposeGoal(fixture.root, goalInput());
  assert.deepEqual(result, { state: 'no-change', active: before.active });
  assert.deepEqual(await getGoalStatus(fixture.root), before);
});

test('no-change keeps an existing pending proposal byte-identical', async (t) => {
  const fixture = await approvedFixture(t);
  const pending = await proposeGoal(fixture.root, goalInput({ constraints: [] }));
  const proposalPath = path.join(fixture.root, '.goal-lock', 'proposal.json');
  const beforeBytes = await readFile(proposalPath);

  const result = await proposeGoal(fixture.root, goalInput());

  assert.deepEqual(result, { state: 'no-change', active: fixture.active });
  assert.deepEqual(await readFile(proposalPath), beforeBytes);
  assert.equal((await getGoalStatus(fixture.root)).pending.digest, pending.proposal.proposal_digest);
});

test('requires a field-level next-version proposal and exact phrase', async (t) => {
  const fixture = await approvedFixture(t);
  const proposed = await proposeGoal(fixture.root, goalInput({ non_goals: [] }));
  assert.deepEqual(proposed.proposal.changes, [{
    field: 'non_goals',
    before: ['Do not add XML export'],
    after: [],
  }]);
  assert.equal((await verifyGoal(fixture.root)).active.version, 1);
  await assert.rejects(approveGoal(fixture.root, 'APPROVE GOAL VERSION 2'), /approval/i);
  const approved = await approveGoal(fixture.root, proposed.proposal.approval_phrase);
  assert.equal(approved.active.version, 2);
});

test('same exact approval resumes after either approved write boundary', async (t) => {
  for (const phase of ['afterHistoryCreate', 'afterCurrentReplace']) {
    await t.test(phase, async (subtest) => {
      const fixture = await proposedVersionTwoFixture(subtest);
      const stop = new Error(`stop ${phase}`);
      await assert.rejects(
        approveGoal(fixture.root, fixture.approvalPhrase, {
          storeFaults: { [phase]() { throw stop; } },
        }),
        (error) => error === stop,
      );
      assert.equal((await getGoalStatus(fixture.root)).state, 'transition-incomplete');
      assert.equal(
        (await approveGoal(fixture.root, fixture.approvalPhrase)).active.version,
        2,
      );
    });
  }
});

test('integrity and legacy stores reject transitions without changing bytes', async (t) => {
  const operations = [
    {
      name: 'initializeGoal',
      run: (fixture) => initializeGoal(fixture.root, goalInput({ objective: 'Replacement goal' })),
    },
    {
      name: 'proposeGoal',
      run: (fixture) => proposeGoal(fixture.root, goalInput({ non_goals: [] })),
    },
    {
      name: 'approveGoal',
      run: (fixture) => approveGoal(fixture.root, fixture.approvalPhrase ?? 'APPROVE GOAL VERSION 1 missing'),
    },
  ];
  const stores = [
    {
      name: 'integrity failure',
      code: 'INTEGRITY_FAILURE',
      arrange: arrangeCurrentTamper,
    },
    {
      name: 'unsupported legacy state',
      code: 'UNSUPPORTED_STATE',
      arrange: arrangeLegacyState,
    },
  ];

  for (const operation of operations) {
    for (const store of stores) {
      await t.test(`${operation.name} rejects ${store.name}`, async (subtest) => {
        const fixture = await store.arrange(subtest);
        const before = await snapshotGoalLockBytes(fixture.root);
        await assert.rejects(operation.run(fixture), (error) => error.code === store.code && error.exitCode === 4);
        assert.deepEqual(await snapshotGoalLockBytes(fixture.root), before);
      });
    }
  }
});

test('only the same exact approval phrase can finish a transition-incomplete store', async (t) => {
  const fixture = await proposedVersionTwoFixture(t);
  const stop = new Error('stop after history');
  await assert.rejects(
    approveGoal(fixture.root, fixture.approvalPhrase, {
      storeFaults: { afterHistoryCreate() { throw stop; } },
    }),
    stop,
  );
  const before = await snapshotGoalLockBytes(fixture.root);

  await assert.rejects(initializeGoal(fixture.root, goalInput()), /transition/i);
  assert.deepEqual(await snapshotGoalLockBytes(fixture.root), before);
  await assert.rejects(proposeGoal(fixture.root, goalInput({ constraints: [] })), /transition/i);
  assert.deepEqual(await snapshotGoalLockBytes(fixture.root), before);
  await assert.rejects(approveGoal(fixture.root, `${fixture.approvalPhrase} `), /approval/i);
  assert.deepEqual(await snapshotGoalLockBytes(fixture.root), before);

  assert.equal((await approveGoal(fixture.root, fixture.approvalPhrase)).active.version, 2);
});

test('verify and status expose authority plus pending review details only', async (t) => {
  const fixture = await approvedFixture(t);
  const proposed = await proposeGoal(fixture.root, goalInput({ non_goals: [] }));

  assert.deepEqual(await verifyGoal(fixture.root), {
    state: 'change-proposed',
    active: fixture.active,
  });
  assert.deepEqual(await getGoalStatus(fixture.root), {
    state: 'change-proposed',
    active: fixture.active,
    pending: {
      version: 2,
      digest: proposed.proposal.proposal_digest,
      approval_phrase: proposed.proposal.approval_phrase,
      changes: proposed.proposal.changes,
    },
  });
});

async function approvedFixture(t) {
  const { root } = await createGoalLockFixture(t);
  const initialized = await initializeGoal(root, goalInput());
  const approved = await approveGoal(root, initialized.proposal.approval_phrase);
  return { root, active: approved.active };
}

async function proposedVersionTwoFixture(t) {
  const fixture = await approvedFixture(t);
  const proposed = await proposeGoal(fixture.root, goalInput({ non_goals: [] }));
  return { ...fixture, approvalPhrase: proposed.proposal.approval_phrase };
}

async function arrangeCurrentTamper(t) {
  const { root } = await createGoalLockFixture(t);
  const current = createGoalRecord(goalInput(), { version: 1, predecessor: null });
  await createHistoryRecord(root, current);
  await replaceCurrentRecord(root, current);
  const candidate = createGoalRecord(goalInput({ non_goals: [] }), {
    version: 2,
    predecessor: { version: 1, digest: current.digest },
  });
  const proposal = createProposal(current, candidate);
  await replaceProposal(root, proposal);
  await writeFile(path.join(root, '.goal-lock', 'current.json'), canonicalBytes({
    ...current,
    objective: 'Tampered current goal',
  }));
  return { root, approvalPhrase: proposal.approval_phrase };
}

async function arrangeLegacyState(t) {
  const { root } = await createGoalLockFixture(t);
  await mkdir(path.join(root, '.goal-lock'), { recursive: true });
  await writeFile(path.join(root, '.goal-lock', 'lock.json'), '{}\n');
  return { root };
}

async function snapshotGoalLockBytes(root) {
  const directory = path.join(root, '.goal-lock');
  const entries = [];
  await collectFiles(directory, directory, entries);
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return entries;
}

async function collectFiles(root, directory, entries) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(root, target, entries);
      continue;
    }
    entries.push({
      path: path.relative(root, target).replaceAll(path.sep, '/'),
      bytes: await readFile(target, 'utf8'),
    });
  }
}
