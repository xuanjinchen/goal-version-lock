import { canonicalBytes, sha256 } from './canonical.js';

export const USER_GOAL_FIELDS = Object.freeze([
  'objective', 'success_criteria', 'constraints', 'non_goals',
]);

const GOAL_RECORD_FIELDS = Object.freeze([
  ...USER_GOAL_FIELDS, 'version', 'digest', 'predecessor',
]);

const PROPOSAL_FIELDS = Object.freeze([
  'base', 'candidate', 'changes', 'proposal_digest', 'approval_phrase',
]);

export class GoalLockError extends Error {
  constructor(code, kind, exitCode, message, options = {}) {
    super(message, options);
    this.name = 'GoalLockError';
    this.code = code;
    this.kind = kind;
    this.exitCode = exitCode;
  }
}

function fail(message, options = {}) {
  throw new GoalLockError('GOAL_LOCK_CONTRACT_INVALID', 'contract', 2, message, options);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, expectedFields, label) {
  if (!isPlainObject(value)) fail(`${label} must be a plain object with exact fields`);
  const actual = Object.keys(value).sort();
  const expected = [...expectedFields].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${label} must contain exact fields: ${expectedFields.join(', ')}`);
  }
}

function normalizeTrimmedString(value, label) {
  if (typeof value !== 'string') fail(`${label} must be a string`);
  if (value !== value.trim()) fail(`${label} must already be trimmed`);
  if (value.length === 0) fail(`${label} must be non-empty`);
  return value;
}

function normalizeStringList(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
  const seen = new Set();
  return Object.freeze(value.map((entry, index) => {
    const normalized = normalizeTrimmedString(entry, `${label}[${index}]`);
    if (seen.has(normalized)) fail(`${label} values must be unique`);
    seen.add(normalized);
    return normalized;
  }));
}

function normalizeVersion(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${label} must be a positive safe integer`);
  return value;
}

function normalizeDigest(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    fail(`${label} must be a 64-character lowercase hexadecimal digest`);
  }
  return value;
}

function normalizePredecessor(value, version) {
  if (value === null) {
    if (version !== 1) fail('predecessor is required after version 1');
    return null;
  }
  assertExactKeys(value, ['version', 'digest'], 'predecessor');
  const predecessor = Object.freeze({
    version: normalizeVersion(value.version, 'predecessor.version'),
    digest: normalizeDigest(value.digest, 'predecessor.digest'),
  });
  if (predecessor.version !== version - 1) {
    fail('predecessor.version must be the previous goal version');
  }
  return predecessor;
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function equalCanonical(left, right) {
  return canonicalBytes(left).equals(canonicalBytes(right));
}

function goalReference(goal) {
  return Object.freeze({ version: goal.version, digest: goal.digest });
}

export function normalizeGoalInput(value) {
  assertExactKeys(value, USER_GOAL_FIELDS, 'goal input');
  return deepFreeze({
    objective: normalizeTrimmedString(value.objective, 'objective'),
    success_criteria: normalizeStringList(value.success_criteria, 'success_criteria'),
    constraints: normalizeStringList(value.constraints, 'constraints'),
    non_goals: normalizeStringList(value.non_goals, 'non_goals'),
  });
}

export function createGoalRecord(input, { version, predecessor } = {}) {
  const normalized = normalizeGoalInput(input);
  const recordVersion = normalizeVersion(version, 'version');
  const recordWithoutDigest = deepFreeze({
    ...normalized,
    version: recordVersion,
    predecessor: normalizePredecessor(predecessor, recordVersion),
  });
  // 摘要只绑定记录自身的规范字节，避免把 digest 字段递归哈希进自身。
  return deepFreeze({
    ...recordWithoutDigest,
    digest: sha256(canonicalBytes(recordWithoutDigest)),
  });
}

export function verifyGoalRecord(value) {
  assertExactKeys(value, GOAL_RECORD_FIELDS, 'goal record');
  const expected = createGoalRecord({
    objective: value.objective,
    success_criteria: value.success_criteria,
    constraints: value.constraints,
    non_goals: value.non_goals,
  }, { version: value.version, predecessor: value.predecessor });
  if (value.digest !== expected.digest || !equalCanonical(value, expected)) {
    fail('goal record digest does not match canonical content');
  }
  return expected;
}

export function diffGoalFields(before, after) {
  const verifiedBefore = verifyGoalRecord(before);
  const verifiedAfter = verifyGoalRecord(after);
  return Object.freeze(USER_GOAL_FIELDS.flatMap((field) => (
    equalCanonical(verifiedBefore[field], verifiedAfter[field])
      ? []
      : [Object.freeze({ field, before: verifiedBefore[field], after: verifiedAfter[field] })]
  )));
}

export function createProposal(baseGoal, candidateGoal) {
  const candidate = verifyGoalRecord(candidateGoal);
  let base = null;
  let changes = Object.freeze([]);

  if (baseGoal === null) {
    if (candidate.version !== 1 || candidate.predecessor !== null) {
      fail('initial proposal candidate must be version 1 with no predecessor');
    }
  } else {
    const verifiedBase = verifyGoalRecord(baseGoal);
    base = goalReference(verifiedBase);
    if (!equalCanonical(candidate.predecessor, base) || candidate.version !== verifiedBase.version + 1) {
      fail('candidate must reference the supplied predecessor goal');
    }
    changes = diffGoalFields(verifiedBase, candidate);
  }

  // 提案摘要只覆盖持久化审阅载荷，approval_phrase 再绑定这个摘要。
  const proposalPayload = deepFreeze({ base, candidate, changes });
  const proposalDigest = sha256(canonicalBytes(proposalPayload));
  return deepFreeze({
    ...proposalPayload,
    proposal_digest: proposalDigest,
    approval_phrase: `APPROVE GOAL VERSION ${candidate.version} ${proposalDigest}`,
  });
}

export function verifyProposal(value, baseGoal = null) {
  assertExactKeys(value, PROPOSAL_FIELDS, 'proposal');
  const expected = createProposal(baseGoal, value.candidate);
  if (!equalCanonical(value.base, expected.base)) fail('proposal base does not match supplied predecessor');
  if (!equalCanonical(value.changes, expected.changes)) fail('proposal changes do not match candidate goal');
  if (value.proposal_digest !== expected.proposal_digest) fail('proposal digest does not match canonical content');
  if (value.approval_phrase !== expected.approval_phrase) fail('approval phrase does not match proposal digest');
  if (!equalCanonical(value, expected)) fail('proposal does not match canonical reconstruction');
  return expected;
}
