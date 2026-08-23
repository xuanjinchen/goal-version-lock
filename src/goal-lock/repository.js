import { lstat, readdir, readFile, realpath, rmdir } from 'node:fs/promises';
import path from 'node:path';

import { canonicalBytes, parseCanonicalJson, sha256 } from './canonical.js';
import { GoalLockError, normalizeRelativePath, validateGoalContract, validateLockRecord } from './contracts.js';
import { commitGoalFiles, withGoalLock } from './transaction.js';
import { createWorkspaceReader } from './workspace.js';

function stateError(code, message) {
  return new GoalLockError(code, 'state', 3, message);
}

function integrityError(code, message, cause) {
  return new GoalLockError(code, 'integrity', 4, message, cause === undefined ? {} : { cause });
}

function samePath(left, right) {
  const normalize = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
  return normalize(path.resolve(left)) === normalize(path.resolve(right));
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left, right) {
  return sameIdentity(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.nlink === right.nlink;
}

async function optionalLstat(target) {
  try {
    return await lstat(target, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function validateRepositoryRoot(root) {
  const resolved = path.resolve(root);
  let stat;
  try {
    stat = await lstat(resolved, { bigint: true });
  } catch (error) {
    throw integrityError('REPOSITORY_ROOT_INVALID', 'Repository root is unavailable.', error);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory() || !samePath(await realpath(resolved), resolved)) {
    throw integrityError('REPOSITORY_ROOT_INVALID', 'Repository root must be a canonical directory.');
  }
  return resolved;
}

async function preflightInitialGoal(root) {
  const canonicalRoot = await validateRepositoryRoot(root);
  const directory = path.join(canonicalRoot, '.goal-lock');
  const stat = await optionalLstat(directory);
  if (!stat) return { canonicalRoot, directory, directoryWasAbsent: true };
  if (stat.isSymbolicLink() || !stat.isDirectory() || !samePath(await realpath(directory), directory)) {
    throw integrityError('GOAL_LOCK_DIRECTORY_UNSAFE', '.goal-lock must be a real directory without links.');
  }
  if ((await readdir(directory)).length !== 0) {
    throw stateError('GOAL_ALREADY_INITIALIZED', '.goal-lock must be empty before initializing a goal draft.');
  }
  return { canonicalRoot, directory, directoryWasAbsent: false };
}

async function assertDraftDirectory(directory) {
  const stat = await optionalLstat(directory);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory() || !samePath(await realpath(directory), directory)) {
    throw integrityError('GOAL_LOCK_DIRECTORY_UNSAFE', '.goal-lock changed while initializing the goal draft.');
  }
  const names = await readdir(directory);
  if (names.length !== 1 || names[0] !== '.write-lock.json') {
    throw stateError('GOAL_ALREADY_INITIALIZED', '.goal-lock was not empty when the draft writer acquired ownership.');
  }
  return stat;
}

async function removeCreatedEmptyDirectory(directory, expectedIdentity) {
  try {
    const stat = await optionalLstat(directory);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory() || !sameIdentity(stat, expectedIdentity)) return;
    if ((await readdir(directory)).length !== 0) return;
    // 仅在 inode 与本次持锁后观察到的一致且目录为空时回收，避免误删并发创建者的目录。
    await rmdir(directory);
  } catch {
    // 清理无法证明安全时保留现场，由调用方报告原始失败。
  }
}

async function readInitialCurrentGoal(directory) {
  const target = path.join(directory, 'current.json');
  let before;
  try {
    before = await lstat(target, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT') throw stateError('GOAL_DRAFT_MISSING', 'No goal draft is available to lock.');
    throw integrityError('CURRENT_GOAL_UNREADABLE', 'Current goal draft could not be inspected.', error);
  }
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n) {
    throw integrityError('CURRENT_GOAL_UNSAFE', 'Current goal draft must be an unlinked regular file.');
  }

  let bytes;
  let after;
  try {
    bytes = await readFile(target);
    after = await lstat(target, { bigint: true });
  } catch (error) {
    throw integrityError('CURRENT_GOAL_UNREADABLE', 'Current goal draft changed while being read.', error);
  }
  if (!sameSnapshot(before, after)) {
    throw integrityError('CURRENT_GOAL_RACED', 'Current goal draft changed while being read.');
  }

  try {
    const goal = validateGoalContract(parseCanonicalJson(bytes, 'current goal draft'));
    if (goal.goal_version !== 1 || goal.predecessor !== null || goal.accepted_change_id !== null) {
      throw new TypeError('Current goal draft is not version 1.');
    }
    return { bytes, goal, digest: sha256(bytes) };
  } catch (error) {
    throw integrityError('CURRENT_GOAL_INVALID', 'Current goal draft is malformed or invalid.', error);
  }
}

function repositoryIntegrity(code, message, cause) {
  if (cause instanceof GoalLockError && cause.kind === 'integrity') return cause;
  return integrityError(code, message, cause);
}

function plainStructuralObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw integrityError('OPTIONAL_STATE_INVALID', `${label} must be a canonical JSON object.`);
  }
  return value;
}

const STRUCTURAL_IDENTIFIERS = {
  goal: /^GL-[A-Z0-9][A-Z0-9-]*$/,
  criterion: /^AC-[0-9]{3}$/,
  task: /^TASK-[0-9]{4}$/,
  change: /^CR-[0-9]{4}$/,
  event: /^EVT-[0-9]{6}$/,
  evidence: /^EVID-[0-9]{4}$/,
};
const STRUCTURAL_DIGEST = /^[a-f0-9]{64}$/;
const STRUCTURAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function requiredFields(value, label, fields) {
  plainStructuralObject(value, label);
  const missing = fields.filter((field) => !Object.hasOwn(value, field));
  if (missing.length > 0) {
    throw integrityError('OPTIONAL_STATE_INVALID', `${label} is missing required envelope fields.`);
  }
  return value;
}

function structuralIdentifier(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw integrityError('OPTIONAL_STATE_INVALID', `${label} is not a valid identifier.`);
  }
  return value;
}

function structuralDigest(value, label) {
  if (typeof value !== 'string' || !STRUCTURAL_DIGEST.test(value)) {
    throw integrityError('OPTIONAL_STATE_INVALID', `${label} is not a SHA-256 digest.`);
  }
  return value;
}

function structuralText(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw integrityError('OPTIONAL_STATE_INVALID', `${label} must be non-empty trimmed text.`);
  }
  return value;
}

function structuralArray(value, label) {
  if (!Array.isArray(value)) throw integrityError('OPTIONAL_STATE_INVALID', `${label} must be an array.`);
  return value;
}

function structuralPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw integrityError('OPTIONAL_STATE_INVALID', `${label} must be a positive integer.`);
  }
  return value;
}

function structuralTimestamp(value, label) {
  if (typeof value !== 'string' || !STRUCTURAL_TIMESTAMP.test(value)) {
    throw integrityError('OPTIONAL_STATE_INVALID', `${label} must be an RFC 3339 UTC timestamp.`);
  }
  return value;
}

function validateGoalReference(value, label) {
  requiredFields(value, label, ['goal_id', 'goal_version', 'goal_digest']);
  structuralIdentifier(value.goal_id, STRUCTURAL_IDENTIFIERS.goal, `${label}.goal_id`);
  structuralPositiveInteger(value.goal_version, `${label}.goal_version`);
  structuralDigest(value.goal_digest, `${label}.goal_digest`);
}

function validatePlanEnvelope(value, label) {
  requiredFields(value, label, ['schema_version', 'goal', 'plan_revision', 'next_task_id', 'tasks', 'deferred']);
  if (value.schema_version !== 1) throw integrityError('PLAN_STATE_INVALID', `${label}.schema_version must equal 1.`);
  validateGoalReference(value.goal, `${label}.goal`);
  structuralPositiveInteger(value.plan_revision, `${label}.plan_revision`);
  if (value.next_task_id !== null) structuralIdentifier(value.next_task_id, STRUCTURAL_IDENTIFIERS.task, `${label}.next_task_id`);
  structuralArray(value.tasks, `${label}.tasks`);
  structuralArray(value.deferred, `${label}.deferred`);
  for (const [index, task] of value.tasks.entries()) {
    const taskLabel = `${label}.tasks[${index}]`;
    requiredFields(task, taskLabel, ['id', 'outcome', 'acceptance_criteria', 'dependencies', 'permitted_paths', 'verification', 'status']);
    structuralIdentifier(task.id, STRUCTURAL_IDENTIFIERS.task, `${taskLabel}.id`);
    structuralText(task.outcome, `${taskLabel}.outcome`);
    for (const criterion of structuralArray(task.acceptance_criteria, `${taskLabel}.acceptance_criteria`)) {
      structuralIdentifier(criterion, STRUCTURAL_IDENTIFIERS.criterion, `${taskLabel}.acceptance_criteria`);
    }
    for (const dependency of structuralArray(task.dependencies, `${taskLabel}.dependencies`)) {
      structuralIdentifier(dependency, STRUCTURAL_IDENTIFIERS.task, `${taskLabel}.dependencies`);
    }
    for (const permittedPath of structuralArray(task.permitted_paths, `${taskLabel}.permitted_paths`)) {
      normalizeRelativePath(permittedPath, `${taskLabel}.permitted_paths`);
    }
    structuralText(task.verification, `${taskLabel}.verification`);
    structuralText(task.status, `${taskLabel}.status`);
  }
  for (const [index, deferred] of value.deferred.entries()) {
    const deferredLabel = `${label}.deferred[${index}]`;
    requiredFields(deferred, deferredLabel, ['id', 'reason']);
    structuralIdentifier(deferred.id, STRUCTURAL_IDENTIFIERS.task, `${deferredLabel}.id`);
    structuralText(deferred.reason, `${deferredLabel}.reason`);
  }
  return value;
}

function validateProgressEnvelope(value) {
  const label = 'progress event';
  requiredFields(value, label, ['schema_version', 'event_id', 'recorded_at', 'goal', 'plan_revision', 'task_id', 'event_type', 'summary', 'evidence_refs', 'previous_event_digest', 'event_digest']);
  if (value.schema_version !== 1) throw integrityError('PROGRESS_STATE_INVALID', 'Progress event schema_version must equal 1.');
  structuralIdentifier(value.event_id, STRUCTURAL_IDENTIFIERS.event, `${label}.event_id`);
  structuralTimestamp(value.recorded_at, `${label}.recorded_at`);
  validateGoalReference(value.goal, `${label}.goal`);
  structuralPositiveInteger(value.plan_revision, `${label}.plan_revision`);
  if (value.task_id !== null) structuralIdentifier(value.task_id, STRUCTURAL_IDENTIFIERS.task, `${label}.task_id`);
  structuralText(value.event_type, `${label}.event_type`);
  structuralText(value.summary, `${label}.summary`);
  for (const evidenceId of structuralArray(value.evidence_refs, `${label}.evidence_refs`)) {
    structuralIdentifier(evidenceId, STRUCTURAL_IDENTIFIERS.evidence, `${label}.evidence_refs`);
  }
  if (value.previous_event_digest !== null) structuralDigest(value.previous_event_digest, `${label}.previous_event_digest`);
  structuralDigest(value.event_digest, `${label}.event_digest`);
  return value;
}

function validateChangeEnvelope(value, expectedId) {
  const label = 'change request';
  requiredFields(value, label, ['schema_version', 'id', 'status', 'base_goal', 'candidate_goal', 'candidate_digest', 'proposal_digest', 'changes', 'rationale', 'affected_tasks', 'affected_criteria', 'risks', 'validation', 'rollback', 'approval_phrase', 'recorded_at']);
  if (value.schema_version !== 1) throw integrityError('CHANGE_STATE_INVALID', 'Change request schema_version must equal 1.');
  structuralIdentifier(value.id, STRUCTURAL_IDENTIFIERS.change, `${label}.id`);
  if (value.id !== expectedId) throw integrityError('CHANGE_STATE_INVALID', 'Change request ID does not match its filename.');
  structuralText(value.status, `${label}.status`);
  validateGoalReference(value.base_goal, `${label}.base_goal`);
  requiredFields(value.candidate_goal, `${label}.candidate_goal`, ['schema_version', 'goal_id', 'goal_version', 'objective', 'scope', 'non_goals', 'constraints', 'acceptance_criteria', 'authorization_boundary', 'assumptions', 'predecessor', 'accepted_change_id']);
  structuralDigest(value.candidate_digest, `${label}.candidate_digest`);
  structuralDigest(value.proposal_digest, `${label}.proposal_digest`);
  structuralArray(value.changes, `${label}.changes`);
  structuralText(value.rationale, `${label}.rationale`);
  for (const taskId of structuralArray(value.affected_tasks, `${label}.affected_tasks`)) structuralIdentifier(taskId, STRUCTURAL_IDENTIFIERS.task, `${label}.affected_tasks`);
  for (const criterionId of structuralArray(value.affected_criteria, `${label}.affected_criteria`)) structuralIdentifier(criterionId, STRUCTURAL_IDENTIFIERS.criterion, `${label}.affected_criteria`);
  for (const field of ['risks', 'validation', 'rollback']) {
    for (const entry of structuralArray(value[field], `${label}.${field}`)) structuralText(entry, `${label}.${field}`);
  }
  structuralText(value.approval_phrase, `${label}.approval_phrase`);
  structuralTimestamp(value.recorded_at, `${label}.recorded_at`);
  return value;
}

function validateEvidenceEnvelope(value, expectedCriterion, expectedEvidence) {
  const label = 'evidence record';
  requiredFields(value, label, ['schema_version', 'evidence_id', 'acceptance_criterion_id', 'goal', 'plan_revision', 'task_id', 'method', 'observed_result', 'artifact_refs', 'workspace_fingerprint', 'state', 'supersedes', 'recorded_at']);
  if (value.schema_version !== 1) throw integrityError('EVIDENCE_STATE_INVALID', 'Evidence schema_version must equal 1.');
  structuralIdentifier(value.evidence_id, STRUCTURAL_IDENTIFIERS.evidence, `${label}.evidence_id`);
  structuralIdentifier(value.acceptance_criterion_id, STRUCTURAL_IDENTIFIERS.criterion, `${label}.acceptance_criterion_id`);
  if (value.evidence_id !== expectedEvidence || value.acceptance_criterion_id !== expectedCriterion) {
    throw integrityError('EVIDENCE_STATE_INVALID', 'Evidence identifiers do not match their path.');
  }
  validateGoalReference(value.goal, `${label}.goal`);
  structuralPositiveInteger(value.plan_revision, `${label}.plan_revision`);
  structuralIdentifier(value.task_id, STRUCTURAL_IDENTIFIERS.task, `${label}.task_id`);
  structuralText(value.method, `${label}.method`);
  structuralText(value.observed_result, `${label}.observed_result`);
  for (const artifactPath of structuralArray(value.artifact_refs, `${label}.artifact_refs`)) normalizeRelativePath(artifactPath, `${label}.artifact_refs`);
  structuralDigest(value.workspace_fingerprint, `${label}.workspace_fingerprint`);
  structuralText(value.state, `${label}.state`);
  if (value.supersedes !== null) structuralIdentifier(value.supersedes, STRUCTURAL_IDENTIFIERS.evidence, `${label}.supersedes`);
  structuralTimestamp(value.recorded_at, `${label}.recorded_at`);
  return value;
}

async function readCanonicalObject(reader, relativePath, label) {
  const input = await reader.readFile(relativePath);
  try {
    return { ...input, value: plainStructuralObject(parseCanonicalJson(input.bytes, label), label) };
  } catch (error) {
    throw repositoryIntegrity('OPTIONAL_STATE_INVALID', `${label} is malformed or noncanonical.`, error);
  }
}

async function verifyPlanState(reader, rootNames) {
  const present = rootNames.includes('plan.json');
  if (present) {
    const plan = await readCanonicalObject(reader, '.goal-lock/plan.json', 'goal plan');
    validatePlanEnvelope(plan.value, 'goal plan');
  }
  const historyRoot = await reader.readDirectory('.goal-lock/history');
  if (!historyRoot.names.includes('plans')) return { present };
  const planHistory = await reader.readDirectory('.goal-lock/history/plans');
  for (const name of planHistory.names) {
    if (!/^v[0-9]{4}-r[0-9]{4}\.json$/.test(name)) {
      throw integrityError('PLAN_STATE_INVALID', 'Plan history contains an unexpected entry.');
    }
    const record = await readCanonicalObject(reader, `.goal-lock/history/plans/${name}`, 'plan history record');
    validatePlanEnvelope(record.value, 'plan history record');
    const match = /^v([0-9]{4})-r([0-9]{4})\.json$/.exec(name);
    if (record.value.goal.goal_version !== Number(match[1]) || record.value.plan_revision !== Number(match[2])) {
      throw integrityError('PLAN_STATE_INVALID', 'Plan history envelope does not match its filename.');
    }
  }
  if (!present && planHistory.names.length > 0) {
    throw integrityError('PLAN_STATE_MISSING', 'Current plan is missing after plan history began.');
  }
  return { present };
}

async function verifyChangeState(reader, rootNames, lock) {
  if (!rootNames.includes('changes')) {
    if (lock.change_head !== null) throw integrityError('CHANGE_STATE_MISSING', 'Lock change head requires change state.');
    return { count: 0, pending: false, records: new Map() };
  }
  const directory = await reader.readDirectory('.goal-lock/changes');
  const records = new Map();
  let pending = false;
  for (const name of directory.names) {
    if (!/^CR-[0-9]{4}\.json$/.test(name)) {
      throw integrityError('CHANGE_STATE_INVALID', 'Change state contains an unexpected entry.');
    }
    const record = await readCanonicalObject(reader, `.goal-lock/changes/${name}`, 'change request');
    const changeId = name.slice(0, -5);
    validateChangeEnvelope(record.value, changeId);
    records.set(changeId, record);
    if (record.value.status === 'proposed') pending = true;
  }
  if (lock.change_head !== null) {
    const head = records.get(lock.change_head.change_request_id);
    if (!head || head.digest !== lock.change_head.digest) {
      throw integrityError('CHANGE_HEAD_MISMATCH', 'Lock change head does not match its change request record.');
    }
  }
  return { count: records.size, pending, records };
}

async function verifyProgressLedger(reader, rootNames, lock) {
  if (!rootNames.includes('progress.jsonl')) {
    if (lock.progress_head !== null) throw integrityError('PROGRESS_STATE_MISSING', 'Lock progress head requires a progress ledger.');
    return { count: 0 };
  }
  const input = await reader.readFile('.goal-lock/progress.jsonl');
  if (input.bytes.length === 0 || input.bytes.at(-1) !== 0x0a) {
    throw integrityError('PROGRESS_STATE_INVALID', 'Progress ledger must contain canonical JSON lines.');
  }
  let count = 0;
  let offset = 0;
  let terminal = null;
  while (offset < input.bytes.length) {
    const terminator = input.bytes.indexOf(0x0a, offset);
    const line = input.bytes.subarray(offset, terminator + 1);
    try {
      terminal = validateProgressEnvelope(plainStructuralObject(parseCanonicalJson(line, 'progress event'), 'progress event'));
    } catch (error) {
      throw repositoryIntegrity('PROGRESS_STATE_INVALID', 'Progress ledger contains a malformed or noncanonical event.', error);
    }
    count += 1;
    offset = terminator + 1;
  }
  if (lock.progress_head !== null
    && (terminal.event_id !== lock.progress_head.event_id || terminal.event_digest !== lock.progress_head.digest)) {
    throw integrityError('PROGRESS_HEAD_MISMATCH', 'Lock progress head does not match the terminal progress event.');
  }
  return { count };
}

async function verifyEvidenceState(reader, rootNames, lock) {
  if (!rootNames.includes('evidence')) {
    if (Object.keys(lock.evidence_heads).length > 0) throw integrityError('EVIDENCE_STATE_MISSING', 'Lock evidence heads require evidence state.');
    return { count: 0 };
  }
  const evidenceRoot = await reader.readDirectory('.goal-lock/evidence');
  let count = 0;
  const records = new Map();
  for (const criterion of evidenceRoot.names) {
    if (!/^AC-[0-9]{3}$/.test(criterion)) {
      throw integrityError('EVIDENCE_STATE_INVALID', 'Evidence state contains an unexpected criterion directory.');
    }
    const criterionDirectory = await reader.readDirectory(`.goal-lock/evidence/${criterion}`);
    for (const name of criterionDirectory.names) {
      if (!/^EVID-[0-9]{4}\.json$/.test(name)) {
        throw integrityError('EVIDENCE_STATE_INVALID', 'Evidence state contains an unexpected record.');
      }
      const record = await readCanonicalObject(reader, `.goal-lock/evidence/${criterion}/${name}`, 'evidence record');
      const evidenceId = name.slice(0, -5);
      validateEvidenceEnvelope(record.value, criterion, evidenceId);
      records.set(`${criterion}/${evidenceId}`, record.digest);
      count += 1;
    }
  }
  for (const [criterion, head] of Object.entries(lock.evidence_heads)) {
    if (records.get(`${criterion}/${head.evidence_id}`) !== head.digest) {
      throw integrityError('EVIDENCE_HEAD_MISMATCH', 'Lock evidence head does not match its evidence record.');
    }
  }
  return { count };
}

async function readCurrentGoal(reader) {
  const input = await reader.readFile('.goal-lock/current.json');
  try {
    return { ...input, goal: validateGoalContract(parseCanonicalJson(input.bytes, 'current goal')) };
  } catch (error) {
    throw repositoryIntegrity('CURRENT_GOAL_INVALID', 'Current goal is malformed, noncanonical, or invalid.', error);
  }
}

async function readLock(reader) {
  const input = await reader.readFile('.goal-lock/lock.json');
  try {
    return { ...input, lock: validateLockRecord(parseCanonicalJson(input.bytes, 'goal lock')) };
  } catch (error) {
    throw repositoryIntegrity('GOAL_LOCK_INVALID', 'Goal lock is malformed, noncanonical, or invalid.', error);
  }
}

async function verifyGoalHistory(reader, current, lock) {
  const historyDirectory = await reader.readDirectory('.goal-lock/history');
  if (!historyDirectory.names.includes('goals')
    || historyDirectory.names.some((name) => name !== 'goals' && name !== 'plans')) {
    throw integrityError('GOAL_HISTORY_INVALID', 'Goal history contains missing or unexpected state.');
  }
  const goalsDirectory = await reader.readDirectory('.goal-lock/history/goals');
  const expectedNames = Array.from(
    { length: lock.goal_version },
    (_, index) => `v${String(index + 1).padStart(4, '0')}.json`,
  );
  if (goalsDirectory.names.length !== expectedNames.length
    || goalsDirectory.names.some((name, index) => name !== expectedNames[index])) {
    throw integrityError('GOAL_HISTORY_INVALID', 'Goal history versions must be contiguous and complete.');
  }

  let predecessor = null;
  let activeHistory = null;
  for (let index = 0; index < expectedNames.length; index += 1) {
    const version = index + 1;
    const input = await reader.readFile(`.goal-lock/history/goals/${expectedNames[index]}`);
    let goal;
    try {
      goal = validateGoalContract(parseCanonicalJson(input.bytes, `goal history version ${version}`), { goal_id: lock.goal_id });
    } catch (error) {
      throw repositoryIntegrity('GOAL_HISTORY_INVALID', 'Goal history contains malformed or invalid content.', error);
    }
    if (goal.goal_version !== version) {
      throw integrityError('GOAL_HISTORY_VERSION_MISMATCH', 'Goal history content does not match its filename.');
    }
    if (version > 1 && (goal.predecessor.goal_version !== version - 1 || goal.predecessor.goal_digest !== predecessor.digest)) {
      throw integrityError('GOAL_HISTORY_CHAIN_BROKEN', 'Goal history predecessor chain is broken.');
    }
    predecessor = { digest: input.digest, goal };
    activeHistory = input;
  }

  if (!activeHistory.bytes.equals(current.bytes)) {
    throw integrityError('CURRENT_HISTORY_MISMATCH', 'Current goal bytes do not match active goal history.');
  }
  return predecessor;
}

function verifyLockBindings(current, lock, activeHistory, changeState) {
  if (lock.goal_id !== current.goal.goal_id
    || lock.goal_version !== current.goal.goal_version
    || lock.goal_digest !== current.digest
    || lock.goal_digest !== activeHistory.digest) {
    throw integrityError('GOAL_LOCK_BINDING_MISMATCH', 'Goal lock does not bind the active goal bytes.');
  }
  const predecessorDigest = current.goal.predecessor?.goal_digest ?? null;
  if (lock.predecessor_digest !== predecessorDigest) {
    throw integrityError('GOAL_LOCK_PREDECESSOR_MISMATCH', 'Goal lock predecessor does not match the active goal.');
  }
  if (lock.goal_version === 1 && (lock.approval_type !== 'explicit-version-1' || lock.proposal_digest !== current.digest)) {
    throw integrityError('GOAL_LOCK_APPROVAL_MISMATCH', 'Initial goal lock approval does not bind the approved proposal.');
  }
  if (lock.goal_version > 1) {
    const accepted = changeState.records.get(current.goal.accepted_change_id);
    if (!accepted
      || accepted.value.id !== current.goal.accepted_change_id
      || accepted.value.status !== 'approved'
      || accepted.value.candidate_digest !== current.digest
      || accepted.value.proposal_digest !== lock.proposal_digest) {
      throw integrityError('GOAL_LOCK_CHANGE_MISMATCH', 'Goal lock does not bind the accepted change request.');
    }
  }
}

function verificationEvidence(reader, current, optional, issues = []) {
  return {
    goal: current ? {
      goal_id: current.goal.goal_id,
      goal_version: current.goal.goal_version,
      goal_digest: current.digest,
    } : null,
    inputs: reader?.inputs() ?? [],
    optional,
    issues,
  };
}

/** 验证完整目标仓库；只读调用返回篡改证据，写调用则在同一完整性失败上立即关闭。 */
export async function verifyGoalRepository(root, context = {}) {
  let reader;
  let current = null;
  try {
    reader = await createWorkspaceReader(root, context);
    const goalLockDirectory = await reader.readDirectory('.goal-lock');
    const rootNames = goalLockDirectory.names;
    const allowedNames = new Set(['current.json', 'lock.json', 'plan.json', 'progress.jsonl', 'changes', 'history', 'evidence']);
    if (rootNames.some((name) => !allowedNames.has(name)) || !rootNames.includes('current.json')) {
      throw integrityError('GOAL_REPOSITORY_INVALID', 'Goal repository contains missing or unexpected root state.');
    }
    current = await readCurrentGoal(reader);

    if (!rootNames.includes('lock.json')) {
      if (rootNames.length !== 1 || current.goal.goal_version !== 1) {
        throw integrityError('GOAL_LOCK_MISSING', 'Only a pristine version-one draft may omit the goal lock.');
      }
      await reader.verifyInputs();
      return { state: 'DRAFT', evidence: verificationEvidence(reader, current, { plan: false, changes: 0, progress_events: 0, evidence_records: 0 }) };
    }

    const lockInput = await readLock(reader);
    const planState = await verifyPlanState(reader, rootNames);
    const changeState = await verifyChangeState(reader, rootNames, lockInput.lock);
    const progressState = await verifyProgressLedger(reader, rootNames, lockInput.lock);
    const evidenceState = await verifyEvidenceState(reader, rootNames, lockInput.lock);
    const activeHistory = await verifyGoalHistory(reader, current, lockInput.lock);
    verifyLockBindings(current, lockInput.lock, activeHistory, changeState);
    await reader.verifyInputs();
    const optional = {
      plan: planState.present,
      changes: changeState.count,
      progress_events: progressState.count,
      evidence_records: evidenceState.count,
    };
    return {
      state: changeState.pending ? 'CHANGE_PENDING' : 'LOCKED',
      evidence: verificationEvidence(reader, current, optional),
    };
  } catch (error) {
    const failure = repositoryIntegrity('GOAL_REPOSITORY_TAMPERED', 'Goal repository integrity verification failed.', error);
    if (context.mutating) throw failure;
    return {
      state: 'TAMPERED',
      evidence: verificationEvidence(reader, current, { plan: false, changes: 0, progress_events: 0, evidence_records: 0 }, [{
        code: failure.code,
        message: failure.message,
      }]),
    };
  }
}

function approvalPhrase(goal, digest) {
  return `APPROVE GOAL ${goal.goal_id} VERSION 1 ${digest.slice(0, 12)}`;
}

export async function initializeGoal(root, draft, context = {}) {
  const goal = validateGoalContract(draft);
  if (goal.goal_version !== 1 || goal.predecessor !== null || goal.accepted_change_id !== null) {
    throw new GoalLockError('INVALID_CONTRACT', 'input', 2, 'Initial goal drafts must be version 1 without a predecessor or accepted change.');
  }
  const preflight = await preflightInitialGoal(root);
  const currentBytes = canonicalBytes(goal);
  const goalDigest = sha256(currentBytes);
  let createdDirectoryIdentity = null;

  try {
    return await withGoalLock(preflight.canonicalRoot, 'init', async (ownership) => {
      const directoryIdentity = await assertDraftDirectory(preflight.directory);
      if (preflight.directoryWasAbsent
        && ownership.goalLockDirectoryCreated
        && sameIdentity(directoryIdentity, ownership.goalLockDirectoryIdentity)) {
        createdDirectoryIdentity = directoryIdentity;
      }
      await commitGoalFiles(preflight.canonicalRoot, [{
        target: '.goal-lock/current.json',
        expected: { kind: 'absent' },
        content: currentBytes,
      }], context);
      return {
        state: 'DRAFT',
        goal_id: goal.goal_id,
        goal_version: 1,
        goal_digest: goalDigest,
        approval_required: approvalPhrase(goal, goalDigest),
      };
    }, context);
  } catch (error) {
    if (preflight.directoryWasAbsent && createdDirectoryIdentity) {
      await removeCreatedEmptyDirectory(preflight.directory, createdDirectoryIdentity);
    }
    throw error;
  }
}

export async function lockInitialGoal(root, approval, context = {}) {
  return withGoalLock(root, 'lock', async () => {
    const directory = path.join(path.resolve(root), '.goal-lock');
    const names = await readdir(directory);
    if (names.some((name) => name !== '.write-lock.json' && name !== 'current.json')) {
      throw stateError('GOAL_NOT_DRAFT', 'Initial goal locking requires an unmodified draft repository state.');
    }
    const current = await readInitialCurrentGoal(directory);
    const expectedApproval = approvalPhrase(current.goal, current.digest);
    if (approval !== expectedApproval) {
      throw stateError('APPROVAL_REJECTED', 'Initial goal approval must exactly match the current draft confirmation phrase.');
    }

    const record = {
      schema_version: 1,
      goal_id: current.goal.goal_id,
      goal_version: 1,
      goal_digest: current.digest,
      approval_type: 'explicit-version-1',
      proposal_digest: current.digest,
      approved_at: (context.now ?? (() => new Date().toISOString()))(),
      predecessor_digest: null,
      state_revision: 1,
      progress_head: null,
      change_head: null,
      evidence_heads: {},
    };
    const lock = { ...record, record_digest: sha256(canonicalBytes(record)) };
    validateLockRecord(lock);
    await commitGoalFiles(root, [
      { target: '.goal-lock/current.json', expected: { kind: 'sha256', digest: current.digest }, content: current.bytes },
      { target: '.goal-lock/lock.json', expected: { kind: 'absent' }, content: canonicalBytes(lock) },
      { target: '.goal-lock/history/goals/v0001.json', expected: { kind: 'absent' }, content: current.bytes },
    ], context);
    return { state: 'LOCKED', goal_id: current.goal.goal_id, goal_version: 1, goal_digest: current.digest };
  }, context);
}
