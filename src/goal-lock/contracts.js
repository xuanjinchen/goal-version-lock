import { canonicalBytes, sha256, shortFingerprint } from './canonical.js';

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const IDENTIFIERS = {
  goal_id: /^GL-[A-Z0-9][A-Z0-9-]*$/,
  acceptance_criterion_id: /^AC-[0-9]{3}$/,
  change_request_id: /^CR-[0-9]{4}$/,
  event_id: /^EVT-[0-9]{6}$/,
  evidence_id: /^EVID-[0-9]{4}$/,
};

export class GoalLockError extends Error {
  constructor(code, kind, exitCode, message, options = {}) {
    super(message, options);
    this.name = 'GoalLockError';
    for (const [key, value] of Object.entries({ code, kind, exitCode })) {
      Object.defineProperty(this, key, { configurable: false, enumerable: true, value, writable: false });
    }
  }
}

function fail(code, kind, exitCode, message) {
  throw new GoalLockError(code, kind, exitCode, message);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function plainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    fail('INVALID_CONTRACT', 'input', 2, `${label} must be a plain object`);
  }
  return value;
}

function exactKeys(value, label, keys) {
  plainObject(value, label);
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    const missing = keys.filter((key) => !Object.hasOwn(value, key));
    fail('INVALID_CONTRACT', 'input', 2, `${label} has missing or unknown fields${missing.length ? `: ${missing.join(', ')}` : ''}`);
  }
}

function requiredText(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    fail('INVALID_CONTRACT', 'input', 2, `${label} must be non-empty trimmed text`);
  }
  return value;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail('INVALID_CONTRACT', 'input', 2, `${label} must be a positive integer`);
  }
  return value;
}

function identifier(value, type, label) {
  if (typeof value !== 'string' || !IDENTIFIERS[type].test(value)) {
    fail('INVALID_CONTRACT', 'input', 2, `${label} must be a valid ${type}`);
  }
  return value;
}

function digest(value, label) {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    fail('INVALID_CONTRACT', 'input', 2, `${label} must be a SHA-256 digest`);
  }
  return value;
}

function timestamp(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value) || Number.isNaN(Date.parse(value))) {
    fail('INVALID_CONTRACT', 'input', 2, `${label} must be an RFC 3339 UTC timestamp`);
  }
  return value;
}

function array(value, label, { nonEmpty = false } = {}) {
  if (!Array.isArray(value) || nonEmpty && value.length === 0) {
    fail('INVALID_CONTRACT', 'input', 2, `${label} must be ${nonEmpty ? 'a non-empty ' : 'an '}array`);
  }
  return value;
}

function textArray(value, label, options = {}) {
  return array(value, label, options).map((entry, index) => requiredText(entry, `${label}[${index}]`));
}

function validatePredecessor(value, goalVersion) {
  if (goalVersion === 1) {
    if (value !== null) fail('INVALID_CONTRACT', 'input', 2, 'predecessor must be null for goal_version 1');
    return null;
  }
  exactKeys(value, 'predecessor', ['goal_version', 'goal_digest']);
  if (value.goal_version !== goalVersion - 1) {
    fail('INVALID_CONTRACT', 'input', 2, 'predecessor.goal_version must be exactly goal_version - 1');
  }
  return { goal_version: positiveInteger(value.goal_version, 'predecessor.goal_version'), goal_digest: digest(value.goal_digest, 'predecessor.goal_digest') };
}

export function normalizeRelativePath(value, label = 'path') {
  requiredText(value, label);
  if (value.includes('\u0000') || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.startsWith('//')) {
    fail('UNSAFE_PATH', 'integrity', 4, `${label} must be a safe repository-relative path`);
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail('UNSAFE_PATH', 'integrity', 4, `${label} must not contain empty, dot, or parent segments`);
  }
  if (value === '.goal-lock' || value.startsWith('.goal-lock/')) {
    fail('UNSAFE_PATH', 'integrity', 4, `${label} must not point inside .goal-lock`);
  }
  return value;
}

export function validateGoalContract(value, options = {}) {
  const fields = ['schema_version', 'goal_id', 'goal_version', 'objective', 'scope', 'non_goals', 'constraints', 'acceptance_criteria', 'authorization_boundary', 'assumptions', 'predecessor', 'accepted_change_id'];
  exactKeys(value, 'goal', fields);
  if (value.schema_version !== 1) fail('INVALID_CONTRACT', 'input', 2, 'schema_version must equal 1');
  const goalVersion = positiveInteger(value.goal_version, 'goal_version');
  const goalId = identifier(value.goal_id, 'goal_id', 'goal_id');
  if (options.goal_id !== undefined && options.goal_id !== goalId) fail('INVALID_CONTRACT', 'input', 2, 'goal_id does not match the expected goal');

  exactKeys(value.scope, 'scope', ['in', 'out']);
  const scopeIn = textArray(value.scope.in, 'scope.in', { nonEmpty: true });
  const scopeOut = textArray(value.scope.out, 'scope.out');
  const constraints = array(value.constraints, 'constraints').map((constraint, index) => {
    exactKeys(constraint, `constraints[${index}]`, ['id', 'text']);
    return { id: requiredText(constraint.id, `constraints[${index}].id`), text: requiredText(constraint.text, `constraints[${index}].text`) };
  });
  const criteria = array(value.acceptance_criteria, 'acceptance_criteria').map((criterion, index) => {
    exactKeys(criterion, `acceptance_criteria[${index}]`, ['id', 'outcome', 'verification']);
    return {
      id: identifier(criterion.id, 'acceptance_criterion_id', `acceptance_criteria[${index}].id`),
      outcome: requiredText(criterion.outcome, `acceptance_criteria[${index}].outcome`),
      verification: requiredText(criterion.verification, `acceptance_criteria[${index}].verification`),
    };
  });
  for (const [label, entries] of [['constraints', constraints], ['acceptance_criteria', criteria]]) {
    const ids = new Set();
    for (const entry of entries) {
      if (ids.has(entry.id)) fail('INVALID_CONTRACT', 'input', 2, `${label} contains duplicate ID ${entry.id}`);
      ids.add(entry.id);
    }
  }
  const assumptions = array(value.assumptions, 'assumptions').map((assumption, index) => {
    exactKeys(assumption, `assumptions[${index}]`, ['statement', 'confidence']);
    if (!['high', 'medium', 'low'].includes(assumption.confidence)) fail('INVALID_CONTRACT', 'input', 2, `assumptions[${index}].confidence is invalid`);
    return { statement: requiredText(assumption.statement, `assumptions[${index}].statement`), confidence: assumption.confidence };
  });
  const predecessor = validatePredecessor(value.predecessor, goalVersion);
  if (goalVersion === 1 ? value.accepted_change_id !== null : typeof value.accepted_change_id !== 'string' || !IDENTIFIERS.change_request_id.test(value.accepted_change_id)) {
    fail('INVALID_CONTRACT', 'input', 2, 'accepted_change_id does not match goal_version');
  }

  return deepFreeze({
    schema_version: 1,
    goal_id: goalId,
    goal_version: goalVersion,
    objective: requiredText(value.objective, 'objective'),
    scope: { in: scopeIn, out: scopeOut },
    non_goals: textArray(value.non_goals, 'non_goals'),
    constraints,
    acceptance_criteria: criteria,
    authorization_boundary: textArray(value.authorization_boundary, 'authorization_boundary'),
    assumptions,
    predecessor,
    accepted_change_id: value.accepted_change_id,
  });
}

function nullableHead(value, label, idType, idField) {
  if (value === null) return null;
  exactKeys(value, label, [idField, 'digest']);
  return { [idField]: identifier(value[idField], idType, `${label}.${idField}`), digest: digest(value.digest, `${label}.digest`) };
}

export function validateLockRecord(value) {
  const fields = ['schema_version', 'goal_id', 'goal_version', 'goal_digest', 'approval_type', 'proposal_digest', 'approved_at', 'predecessor_digest', 'state_revision', 'progress_head', 'change_head', 'evidence_heads', 'record_digest'];
  exactKeys(value, 'lock', fields);
  if (value.schema_version !== 1) fail('INVALID_CONTRACT', 'input', 2, 'schema_version must equal 1');
  const goalVersion = positiveInteger(value.goal_version, 'goal_version');
  const predecessorDigest = value.predecessor_digest;
  if (goalVersion === 1 ? predecessorDigest !== null : predecessorDigest === null) fail('INVALID_CONTRACT', 'input', 2, 'predecessor_digest does not match goal_version');
  if (predecessorDigest !== null) digest(predecessorDigest, 'predecessor_digest');
  if (!['explicit-version-1', 'explicit-change'].includes(value.approval_type)) fail('INVALID_CONTRACT', 'input', 2, 'approval_type is invalid');
  if (goalVersion === 1 && value.approval_type !== 'explicit-version-1') fail('INVALID_CONTRACT', 'input', 2, 'approval_type does not match goal_version');
  if (goalVersion > 1 && value.approval_type !== 'explicit-change') fail('INVALID_CONTRACT', 'input', 2, 'approval_type does not match goal_version');
  plainObject(value.evidence_heads, 'evidence_heads');
  const evidenceHeads = {};
  for (const [criterionId, head] of Object.entries(value.evidence_heads)) {
    identifier(criterionId, 'acceptance_criterion_id', 'evidence_heads key');
    exactKeys(head, `evidence_heads.${criterionId}`, ['evidence_id', 'digest']);
    evidenceHeads[criterionId] = {
      evidence_id: identifier(head.evidence_id, 'evidence_id', `evidence_heads.${criterionId}.evidence_id`),
      digest: digest(head.digest, `evidence_heads.${criterionId}.digest`),
    };
  }
  const normalized = {
    schema_version: 1,
    goal_id: identifier(value.goal_id, 'goal_id', 'goal_id'),
    goal_version: goalVersion,
    goal_digest: digest(value.goal_digest, 'goal_digest'),
    approval_type: value.approval_type,
    proposal_digest: digest(value.proposal_digest, 'proposal_digest'),
    approved_at: timestamp(value.approved_at, 'approved_at'),
    predecessor_digest: predecessorDigest,
    state_revision: positiveInteger(value.state_revision, 'state_revision'),
    progress_head: nullableHead(value.progress_head, 'progress_head', 'event_id', 'event_id'),
    change_head: nullableHead(value.change_head, 'change_head', 'change_request_id', 'change_request_id'),
    evidence_heads: evidenceHeads,
    record_digest: digest(value.record_digest, 'record_digest'),
  };
  // record_digest 是锁记录自身的防篡改边界，因此只排除它本身参与摘要。
  const { record_digest: suppliedDigest, ...withoutDigest } = normalized;
  if (sha256(canonicalBytes(withoutDigest)) !== suppliedDigest) fail('INTEGRITY_FAILURE', 'integrity', 4, 'record_digest does not match the lock record');
  return deepFreeze(normalized);
}

export function approvalPhraseForGoal(goal) {
  const normalized = validateGoalContract(goal);
  if (normalized.goal_version !== 1) fail('INVALID_CONTRACT', 'input', 2, 'goal_version must be 1 for initial approval');
  return `APPROVE GOAL ${normalized.goal_id} VERSION 1 ${shortFingerprint(sha256(canonicalBytes(normalized)))}`;
}

export function approvalPhraseForChange(changeRequest) {
  plainObject(changeRequest, 'change request');
  const id = identifier(changeRequest.id, 'change_request_id', 'change request.id');
  plainObject(changeRequest.candidate_goal, 'change request.candidate_goal');
  const goalVersion = positiveInteger(changeRequest.candidate_goal.goal_version, 'change request.candidate_goal.goal_version');
  if (goalVersion === 1) fail('INVALID_CONTRACT', 'input', 2, 'change request candidate version must exceed 1');
  return `APPROVE ${id} GOAL VERSION ${goalVersion} ${shortFingerprint(digest(changeRequest.proposal_digest, 'change request.proposal_digest'))}`;
}
