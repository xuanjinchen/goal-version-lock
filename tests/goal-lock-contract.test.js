import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalBytes, sha256 } from '../src/goal-lock/canonical.js';
import {
  createGoalRecord, createProposal, diffGoalFields,
  normalizeGoalInput, verifyGoalRecord, verifyProposal,
} from '../src/goal-lock/contract.js';
import { goalInput } from './helpers/goal-lock-fixture.js';

test('derives a canonical version-one record from only the four user fields', () => {
  const record = createGoalRecord(goalInput(), { version: 1, predecessor: null });
  const { digest, ...withoutDigest } = record;
  assert.deepEqual(Object.keys(record).sort(), [
    'constraints', 'digest', 'non_goals', 'objective', 'predecessor',
    'success_criteria', 'version',
  ]);
  assert.equal(digest, sha256(canonicalBytes(withoutDigest)));
  assert.deepEqual(verifyGoalRecord(record), record);
});

test('rejects unknown fields, whitespace, empty entries, and duplicate list values', () => {
  assert.throws(() => normalizeGoalInput({ ...goalInput(), plan: [] }), /exact fields/i);
  assert.throws(() => normalizeGoalInput({ ...goalInput(), objective: ' padded ' }), /trimmed/i);
  assert.throws(() => normalizeGoalInput({ ...goalInput(), constraints: [''] }), /non-empty/i);
  assert.throws(() => normalizeGoalInput({ ...goalInput(), non_goals: ['same', 'same'] }), /unique/i);
});

test('reports one ordered difference per changed user-controlled field', () => {
  const before = createGoalRecord(goalInput(), { version: 1, predecessor: null });
  const after = createGoalRecord(goalInput({
    objective: 'Deliver reviewed CSV and XML exports', non_goals: [],
  }), { version: 2, predecessor: { version: 1, digest: before.digest } });
  assert.deepEqual(diffGoalFields(before, after), [
    { field: 'objective', before: before.objective, after: after.objective },
    { field: 'non_goals', before: before.non_goals, after: after.non_goals },
  ]);
});

test('binds the exact approval phrase to candidate version and proposal digest', () => {
  const candidate = createGoalRecord(goalInput(), { version: 1, predecessor: null });
  const proposal = createProposal(null, candidate);
  assert.equal(proposal.approval_phrase, `APPROVE GOAL VERSION 1 ${proposal.proposal_digest}`);
  assert.deepEqual(verifyProposal(proposal), proposal);
  assert.throws(
    () => verifyProposal({ ...proposal, approval_phrase: `${proposal.approval_phrase} ` }),
    /approval phrase/i,
  );
});
