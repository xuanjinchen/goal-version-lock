import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { canonicalBytes } from '../src/goal-lock/canonical.js';
import { createGoalRecord, createProposal } from '../src/goal-lock/contract.js';
import {
  createHistoryRecord,
  inspectGoalStore,
  removeProposal,
  replaceCurrentRecord,
  replaceProposal,
} from '../src/goal-lock/store.js';
import { createGoalLockFixture, goalInput } from './helpers/goal-lock-fixture.js';

test('derives uninitialized, initial-proposed, active, and change-proposed from disk', async (t) => {
  const { root } = await createGoalLockFixture(t);
  assert.equal((await inspectGoalStore(root)).state, 'uninitialized');

  const v1 = createGoalRecord(goalInput(), { version: 1, predecessor: null });
  const initial = createProposal(null, v1);
  await replaceProposal(root, initial);
  assert.equal((await inspectGoalStore(root)).state, 'initial-proposed');

  await createHistoryRecord(root, v1);
  await replaceCurrentRecord(root, v1);
  await removeProposal(root, initial.proposal_digest);
  assert.equal((await inspectGoalStore(root)).state, 'active');

  const v2 = createGoalRecord(goalInput({ non_goals: [] }), {
    version: 2,
    predecessor: { version: 1, digest: v1.digest },
  });
  await replaceProposal(root, createProposal(v1, v2));
  assert.equal((await inspectGoalStore(root)).state, 'change-proposed');
});

test('detects both valid interrupted approval positions', async (t) => {
  const fixture = await activeFixture(t);
  const proposal = await installVersionTwoProposal(fixture);
  await createHistoryRecord(fixture.root, proposal.candidate);
  let snapshot = await inspectGoalStore(fixture.root);
  assert.deepEqual(snapshot.transition, {
    version: 2, history_installed: true, current_installed: false,
  });
  assert.equal(snapshot.state, 'transition-incomplete');
  assert.equal(snapshot.active, null);

  await replaceCurrentRecord(fixture.root, proposal.candidate);
  snapshot = await inspectGoalStore(fixture.root);
  assert.deepEqual(snapshot.transition, {
    version: 2, history_installed: true, current_installed: true,
  });
  assert.equal(snapshot.state, 'transition-incomplete');
  assert.equal(snapshot.active, null);
});

test('fails closed for current tamper, missing history, broken predecessor, and stale proposal', async (t) => {
  for (const arrange of [tamperCurrent, removeHistoryVersion, breakPredecessor, staleProposal]) {
    await t.test(arrange.name, async (subtest) => {
      const fixture = await activeVersionTwoFixture(subtest);
      await arrange(fixture);
      await assert.rejects(inspectGoalStore(fixture.root), (error) => (
        error.code === 'INTEGRITY_FAILURE' && error.exitCode === 4
      ));
    });
  }
});

test('rejects protocol-v2 state without migration', async (t) => {
  const { root } = await createGoalLockFixture(t);
  await mkdir(path.join(root, '.goal-lock'), { recursive: true });
  await writeFile(path.join(root, '.goal-lock', 'lock.json'), '{}\n');
  await assert.rejects(inspectGoalStore(root), (error) => (
    error.code === 'UNSUPPORTED_STATE' && error.exitCode === 4
  ));

  const legacyHistory = await createGoalLockFixture(t);
  await mkdir(path.join(legacyHistory.root, '.goal-lock', 'history', 'goals'), { recursive: true });
  await assert.rejects(inspectGoalStore(legacyHistory.root), (error) => (
    error.code === 'UNSUPPORTED_STATE' && error.exitCode === 4
  ));
});

test('rejects unrecognized root and history entries as integrity failures', async (t) => {
  const fixture = await activeFixture(t);
  await writeFile(path.join(fixture.root, '.goal-lock', 'notes.json'), '{}\n');
  await assert.rejects(inspectGoalStore(fixture.root), (error) => (
    error.code === 'INTEGRITY_FAILURE' && error.exitCode === 4
  ));

  const other = await activeFixture(t);
  await writeFile(path.join(other.root, '.goal-lock', 'history', 'v2.json'), '{}\n');
  await assert.rejects(inspectGoalStore(other.root), (error) => (
    error.code === 'INTEGRITY_FAILURE' && error.exitCode === 4
  ));
});

test('write primitives preserve immutable history and exact proposal deletion', async (t) => {
  const fixture = await activeFixture(t);
  const proposal = await installVersionTwoProposal(fixture);
  await createHistoryRecord(fixture.root, proposal.candidate);
  await assert.rejects(createHistoryRecord(fixture.root, proposal.candidate), (error) => (
    error.code === 'INTEGRITY_FAILURE' && error.exitCode === 4
  ));

  const replacement = createProposal(fixture.current, createGoalRecord(goalInput({ constraints: [] }), {
    version: 2,
    predecessor: { version: 1, digest: fixture.current.digest },
  }));
  await replaceProposal(fixture.root, replacement);
  await assert.rejects(removeProposal(fixture.root, proposal.proposal_digest), (error) => (
    error.code === 'INTEGRITY_FAILURE' && error.exitCode === 4
  ));
  assert.deepEqual(JSON.parse(await readFile(path.join(fixture.root, '.goal-lock', 'proposal.json'), 'utf8')), replacement);
});

async function activeFixture(t) {
  const { root } = await createGoalLockFixture(t);
  const current = createGoalRecord(goalInput(), { version: 1, predecessor: null });
  await createHistoryRecord(root, current);
  await replaceCurrentRecord(root, current);
  return { root, current };
}

async function installVersionTwoProposal(fixture) {
  const candidate = createGoalRecord(goalInput({ non_goals: [] }), {
    version: 2,
    predecessor: { version: 1, digest: fixture.current.digest },
  });
  const proposal = createProposal(fixture.current, candidate);
  await replaceProposal(fixture.root, proposal);
  return proposal;
}

async function activeVersionTwoFixture(t) {
  const fixture = await activeFixture(t);
  const proposal = await installVersionTwoProposal(fixture);
  await createHistoryRecord(fixture.root, proposal.candidate);
  await replaceCurrentRecord(fixture.root, proposal.candidate);
  await removeProposal(fixture.root, proposal.proposal_digest);
  return { root: fixture.root, current: proposal.candidate, previous: fixture.current };
}

async function tamperCurrent(fixture) {
  await writeFile(path.join(fixture.root, '.goal-lock', 'current.json'), canonicalBytes({
    ...fixture.current,
    objective: 'Tampered after approval',
  }));
}

async function removeHistoryVersion(fixture) {
  await rm(path.join(fixture.root, '.goal-lock', 'history', 'v0001.json'));
}

async function breakPredecessor(fixture) {
  await writeFile(path.join(fixture.root, '.goal-lock', 'history', 'v0002.json'), canonicalBytes({
    ...fixture.current,
    predecessor: { version: 1, digest: '0'.repeat(64) },
  }));
}

async function staleProposal(fixture) {
  const staleBase = createGoalRecord(goalInput({ objective: 'A stale parallel base' }), {
    version: 1,
    predecessor: null,
  });
  const staleCandidate = createGoalRecord(goalInput({ objective: 'A stale parallel candidate' }), {
    version: 2,
    predecessor: { version: 1, digest: staleBase.digest },
  });
  await writeFile(
    path.join(fixture.root, '.goal-lock', 'proposal.json'),
    canonicalBytes(createProposal(staleBase, staleCandidate)),
  );
}
