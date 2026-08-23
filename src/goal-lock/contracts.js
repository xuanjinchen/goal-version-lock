import { canonicalBytes, sha256, shortFingerprint } from './canonical.js';

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const PROGRESS_EVENT_TYPES = new Set([
  'task-start',
  'task-complete',
  'blocker',
  'verification-result',
  'plan-revision',
  'goal-change',
  'evidence-invalidation',
  'recovery',
  'final-audit',
]);
const IDENTIFIERS = {
  goal_id: /^GL-[A-Z0-9][A-Z0-9-]*$/,
  acceptance_criterion_id: /^AC-[0-9]{3}$/,
  change_request_id: /^CR-[0-9]{4}$/,
  event_id: /^EVT-[0-9]{6}$/,
  evidence_id: /^EVID-[0-9]{4}$/,
  task_id: /^TASK-[0-9]{4}$/,
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
  const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(value);
  if (!match) {
    fail('INVALID_CONTRACT', 'input', 2, `${label} must be an RFC 3339 UTC timestamp`);
  }
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  // Date.parse 会把越界的日历分量滚动到下一日期，锁定契约必须拒绝这种输入。
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1] || hour > 23 || minute > 59 || second > 59) {
    fail('INVALID_CONTRACT', 'input', 2, `${label} must be an RFC 3339 UTC timestamp`);
  }
  return value;
}

function array(value, label, { nonEmpty = false } = {}) {
  if (!Array.isArray(value) || nonEmpty && value.length === 0) {
    fail('INVALID_CONTRACT', 'input', 2, `${label} must be ${nonEmpty ? 'a non-empty ' : 'an '}array`);
  }
  // map 会跳过空洞且忽略附加属性；两者都不能静默进入已锁定的语义数组。
  if (Object.keys(value).length !== value.length) {
    fail('INVALID_CONTRACT', 'input', 2, `${label} must not contain holes or non-index properties`);
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

export function validatePlan(value, goalReference) {
  const fields = ['schema_version', 'goal', 'plan_revision', 'next_task_id', 'tasks', 'deferred'];
  exactKeys(value, 'plan', fields);
  if (value.schema_version !== 1) fail('INVALID_CONTRACT', 'input', 2, 'schema_version must equal 1');

  exactKeys(goalReference, 'goal reference', ['goal_id', 'goal_version', 'goal_digest']);
  const expectedGoal = {
    goal_id: identifier(goalReference.goal_id, 'goal_id', 'goal reference.goal_id'),
    goal_version: positiveInteger(goalReference.goal_version, 'goal reference.goal_version'),
    goal_digest: digest(goalReference.goal_digest, 'goal reference.goal_digest'),
  };
  exactKeys(value.goal, 'goal', ['goal_id', 'goal_version', 'goal_digest']);
  const goal = {
    goal_id: identifier(value.goal.goal_id, 'goal_id', 'goal.goal_id'),
    goal_version: positiveInteger(value.goal.goal_version, 'goal.goal_version'),
    goal_digest: digest(value.goal.goal_digest, 'goal.goal_digest'),
  };
  if (goal.goal_id !== expectedGoal.goal_id) fail('INVALID_CONTRACT', 'input', 2, 'goal.goal_id does not match the current goal');
  if (goal.goal_version !== expectedGoal.goal_version) fail('INVALID_CONTRACT', 'input', 2, 'goal.goal_version does not match the current goal');
  if (goal.goal_digest !== expectedGoal.goal_digest) fail('INVALID_CONTRACT', 'input', 2, 'goal.goal_digest does not match the current goal');

  const taskIds = new Set();
  const tasks = array(value.tasks, 'tasks').map((task, index) => {
    const label = `tasks[${index}]`;
    exactKeys(task, label, ['id', 'outcome', 'acceptance_criteria', 'dependencies', 'permitted_paths', 'verification', 'status']);
    const id = identifier(task.id, 'task_id', `${label}.id`);
    if (taskIds.has(id)) fail('INVALID_CONTRACT', 'input', 2, `tasks contains duplicate task ID ${id}`);
    taskIds.add(id);
    const acceptanceCriteria = array(task.acceptance_criteria, `${label}.acceptance_criteria`, { nonEmpty: true })
      .map((criterionId) => identifier(criterionId, 'acceptance_criterion_id', `${label}.acceptance_criteria`));
    const uniqueCriteria = new Set(acceptanceCriteria);
    if (uniqueCriteria.size !== acceptanceCriteria.length) fail('INVALID_CONTRACT', 'input', 2, `${label}.acceptance_criteria contains duplicates`);
    const dependencies = array(task.dependencies, `${label}.dependencies`)
      .map((dependencyId) => identifier(dependencyId, 'task_id', `${label}.dependencies`));
    if (new Set(dependencies).size !== dependencies.length) fail('INVALID_CONTRACT', 'input', 2, `${label}.dependencies contains duplicates`);
    const permittedPaths = array(task.permitted_paths, `${label}.permitted_paths`)
      .map((permittedPath) => normalizeRelativePath(permittedPath, `${label}.permitted_paths`));
    if (new Set(permittedPaths).size !== permittedPaths.length) fail('INVALID_CONTRACT', 'input', 2, `${label}.permitted_paths contains duplicates`);
    if (!['pending', 'in_progress', 'blocked', 'complete', 'stale'].includes(task.status)) {
      fail('INVALID_CONTRACT', 'input', 2, `${label}.status is invalid`);
    }
    return {
      id,
      outcome: requiredText(task.outcome, `${label}.outcome`),
      acceptance_criteria: acceptanceCriteria,
      dependencies,
      permitted_paths: permittedPaths,
      verification: requiredText(task.verification, `${label}.verification`),
      status: task.status,
    };
  });

  for (const task of tasks) {
    for (const dependencyId of task.dependencies) {
      if (!taskIds.has(dependencyId)) fail('INVALID_CONTRACT', 'input', 2, `task ${task.id} dependency does not exist`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const dependenciesByTask = new Map(tasks.map((task) => [task.id, task.dependencies]));
  function visit(taskId) {
    if (visiting.has(taskId)) fail('INVALID_CONTRACT', 'input', 2, 'task dependency cycle is not permitted');
    if (visited.has(taskId)) return;
    // 三色遍历在接受计划前封闭依赖图，避免自引用和跨多任务环被执行顺序掩盖。
    visiting.add(taskId);
    for (const dependencyId of dependenciesByTask.get(taskId)) visit(dependencyId);
    visiting.delete(taskId);
    visited.add(taskId);
  }
  for (const task of tasks) visit(task.id);

  const deferredIds = new Set();
  const deferred = array(value.deferred, 'deferred').map((item, index) => {
    const label = `deferred[${index}]`;
    exactKeys(item, label, ['id', 'reason']);
    const id = identifier(item.id, 'task_id', `${label}.id`);
    if (taskIds.has(id)) fail('INVALID_CONTRACT', 'input', 2, `${label}.id duplicates a scheduled task`);
    if (deferredIds.has(id)) fail('INVALID_CONTRACT', 'input', 2, `deferred contains duplicate task ID ${id}`);
    deferredIds.add(id);
    return { id, reason: requiredText(item.reason, `${label}.reason`) };
  });

  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  // 状态可执行还要求全部前置任务已完成，不能把等待依赖的任务选为下一步。
  const executableIds = new Set(tasks
    .filter((task) => ['pending', 'in_progress'].includes(task.status)
      && task.dependencies.every((dependencyId) => tasksById.get(dependencyId).status === 'complete'))
    .map((task) => task.id));
  let nextTaskId = null;
  if (value.next_task_id !== null) {
    nextTaskId = identifier(value.next_task_id, 'task_id', 'next_task_id');
    if (!executableIds.has(nextTaskId)) fail('INVALID_CONTRACT', 'input', 2, 'next_task_id must reference an executable non-complete task');
  } else if (executableIds.size > 0) {
    fail('INVALID_CONTRACT', 'input', 2, 'next_task_id is required while an executable task remains');
  }

  return deepFreeze({
    schema_version: 1,
    goal,
    plan_revision: positiveInteger(value.plan_revision, 'plan_revision'),
    next_task_id: nextTaskId,
    tasks,
    deferred,
  });
}

/** 证据沿袭只接受完整不可变封装，并精确绑定调用方已验证的目标版本。 */
export function validateEvidence(value, goalReference) {
  const fields = ['schema_version', 'evidence_id', 'acceptance_criterion_id', 'goal', 'plan_revision', 'task_id', 'method', 'observed_result', 'artifact_refs', 'workspace_fingerprint', 'state', 'supersedes', 'recorded_at'];
  exactKeys(value, 'evidence', fields);
  if (value.schema_version !== 1) fail('INVALID_CONTRACT', 'input', 2, 'schema_version must equal 1');

  exactKeys(goalReference, 'goal reference', ['goal_id', 'goal_version', 'goal_digest']);
  const expectedGoal = {
    goal_id: identifier(goalReference.goal_id, 'goal_id', 'goal reference.goal_id'),
    goal_version: positiveInteger(goalReference.goal_version, 'goal reference.goal_version'),
    goal_digest: digest(goalReference.goal_digest, 'goal reference.goal_digest'),
  };
  exactKeys(value.goal, 'evidence.goal', ['goal_id', 'goal_version', 'goal_digest']);
  const goal = {
    goal_id: identifier(value.goal.goal_id, 'goal_id', 'evidence.goal.goal_id'),
    goal_version: positiveInteger(value.goal.goal_version, 'evidence.goal.goal_version'),
    goal_digest: digest(value.goal.goal_digest, 'evidence.goal.goal_digest'),
  };
  if (goal.goal_id !== expectedGoal.goal_id) fail('INVALID_CONTRACT', 'input', 2, 'evidence.goal.goal_id does not match the expected goal');
  if (goal.goal_version !== expectedGoal.goal_version) fail('INVALID_CONTRACT', 'input', 2, 'evidence.goal.goal_version does not match the expected goal');
  if (goal.goal_digest !== expectedGoal.goal_digest) fail('INVALID_CONTRACT', 'input', 2, 'evidence.goal.goal_digest does not match the expected goal');

  const artifactRefs = array(value.artifact_refs, 'evidence.artifact_refs')
    .map((artifactPath, index) => normalizeRelativePath(artifactPath, `evidence.artifact_refs[${index}]`));
  if (new Set(artifactRefs).size !== artifactRefs.length) {
    fail('INVALID_CONTRACT', 'input', 2, 'evidence.artifact_refs contains duplicates');
  }
  if (!['pass', 'fail', 'stale'].includes(value.state)) {
    fail('INVALID_CONTRACT', 'input', 2, 'evidence.state is invalid');
  }
  const supersedes = value.supersedes === null
    ? null
    : identifier(value.supersedes, 'evidence_id', 'evidence.supersedes');
  return deepFreeze({
    schema_version: 1,
    evidence_id: identifier(value.evidence_id, 'evidence_id', 'evidence.evidence_id'),
    acceptance_criterion_id: identifier(value.acceptance_criterion_id, 'acceptance_criterion_id', 'evidence.acceptance_criterion_id'),
    goal,
    plan_revision: positiveInteger(value.plan_revision, 'evidence.plan_revision'),
    task_id: identifier(value.task_id, 'task_id', 'evidence.task_id'),
    method: requiredText(value.method, 'evidence.method'),
    observed_result: requiredText(value.observed_result, 'evidence.observed_result'),
    artifact_refs: artifactRefs,
    workspace_fingerprint: digest(value.workspace_fingerprint, 'evidence.workspace_fingerprint'),
    state: value.state,
    supersedes,
    recorded_at: timestamp(value.recorded_at, 'evidence.recorded_at'),
  });
}

/** 验证进度事件的完整封装、自身摘要及其与前一事件摘要的精确链接。 */
export function validateProgressEvent(value, previousDigest) {
  const fields = ['schema_version', 'event_id', 'recorded_at', 'goal', 'plan_revision', 'task_id', 'event_type', 'summary', 'evidence_refs', 'previous_event_digest', 'event_digest'];
  exactKeys(value, 'progress event', fields);
  if (value.schema_version !== 1) fail('INVALID_CONTRACT', 'input', 2, 'schema_version must equal 1');

  exactKeys(value.goal, 'progress event.goal', ['goal_id', 'goal_version', 'goal_digest']);
  const goal = {
    goal_id: identifier(value.goal.goal_id, 'goal_id', 'progress event.goal.goal_id'),
    goal_version: positiveInteger(value.goal.goal_version, 'progress event.goal.goal_version'),
    goal_digest: digest(value.goal.goal_digest, 'progress event.goal.goal_digest'),
  };
  const taskId = value.task_id === null
    ? null
    : identifier(value.task_id, 'task_id', 'progress event.task_id');
  if (!PROGRESS_EVENT_TYPES.has(value.event_type)) {
    fail('INVALID_CONTRACT', 'input', 2, 'progress event.event_type is invalid');
  }
  if (['task-start', 'task-complete', 'blocker'].includes(value.event_type) && taskId === null) {
    fail('INVALID_CONTRACT', 'input', 2, 'progress event.task_id is required for task status events');
  }
  const evidenceRefs = array(value.evidence_refs, 'progress event.evidence_refs')
    .map((evidenceId, index) => identifier(evidenceId, 'evidence_id', `progress event.evidence_refs[${index}]`));
  if (new Set(evidenceRefs).size !== evidenceRefs.length) {
    fail('INVALID_CONTRACT', 'input', 2, 'progress event.evidence_refs contains duplicates');
  }
  if (value.event_type === 'task-complete' && evidenceRefs.length === 0) {
    fail('INVALID_CONTRACT', 'input', 2, 'task-complete requires evidence_refs');
  }
  const expectedPreviousDigest = previousDigest === null
    ? null
    : digest(previousDigest, 'previous digest');
  const suppliedPreviousDigest = value.previous_event_digest === null
    ? null
    : digest(value.previous_event_digest, 'progress event.previous_event_digest');
  if (suppliedPreviousDigest !== expectedPreviousDigest) {
    fail('INTEGRITY_FAILURE', 'integrity', 4, 'progress event.previous_event_digest does not match the previous event');
  }

  const normalized = {
    schema_version: 1,
    event_id: identifier(value.event_id, 'event_id', 'progress event.event_id'),
    recorded_at: timestamp(value.recorded_at, 'progress event.recorded_at'),
    goal,
    plan_revision: positiveInteger(value.plan_revision, 'progress event.plan_revision'),
    task_id: taskId,
    event_type: value.event_type,
    summary: requiredText(value.summary, 'progress event.summary'),
    evidence_refs: evidenceRefs,
    previous_event_digest: suppliedPreviousDigest,
    event_digest: digest(value.event_digest, 'progress event.event_digest'),
  };
  // 事件摘要覆盖规范化载荷和前链指针，仅排除摘要字段本身。
  const { event_digest: suppliedDigest, ...digestPayload } = normalized;
  if (sha256(canonicalBytes(digestPayload)) !== suppliedDigest) {
    fail('INTEGRITY_FAILURE', 'integrity', 4, 'progress event.event_digest does not match the event payload');
  }
  return deepFreeze(normalized);
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
