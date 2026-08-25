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
  risk_id: /^RISK-[0-9]{4}$/,
  task_id: /^TASK-[0-9]{4}$/,
  validation_id: /^VAL-[0-9]{4}$/,
};
const CHANGE_REQUEST_FIELDS = [
  'schema_version',
  'id',
  'status',
  'base_goal',
  'candidate_goal',
  'candidate_digest',
  'proposal_digest',
  'changes',
  'rationale',
  'affected_tasks',
  'criterion_impact',
  'risks',
  'validation',
  'rollback',
  'approval_phrase',
  'recorded_at',
];

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
    fail('INVALID_CONTRACT', 'input', 2, `${label} must contain exact fields; missing or unknown fields${missing.length ? `: ${missing.join(', ')}` : ''}`);
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

function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('INVALID_CONTRACT', 'input', 2, `${label} must be a non-negative integer`);
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

function uniqueIdentifiers(value, label, type) {
  const normalized = array(value, label).map((entry, index) => identifier(entry, type, `${label}[${index}]`));
  if (new Set(normalized).size !== normalized.length) {
    fail('INVALID_CONTRACT', 'input', 2, `${label} must not contain duplicate identifiers`);
  }
  return normalized;
}

function validateGoalReference(value, label = 'goal reference') {
  exactKeys(value, label, ['goal_id', 'goal_version', 'goal_digest']);
  return {
    goal_id: identifier(value.goal_id, 'goal_id', `${label}.goal_id`),
    goal_version: positiveInteger(value.goal_version, `${label}.goal_version`),
    goal_digest: digest(value.goal_digest, `${label}.goal_digest`),
  };
}

function assertGoalReferenceMatches(actual, expected, label) {
  for (const field of ['goal_id', 'goal_version', 'goal_digest']) {
    if (actual[field] !== expected[field]) {
      fail('INVALID_CONTRACT', 'input', 2, `${label}.${field} does not match the expected goal`);
    }
  }
}

function uniquePaths(value, label, options = {}) {
  const paths = array(value, label, options)
    .map((entry, index) => normalizeRelativePath(entry, `${label}[${index}]`));
  if (new Set(paths).size !== paths.length) {
    fail('INVALID_CONTRACT', 'input', 2, `${label} contains duplicates`);
  }
  return paths;
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

/** ValidationRef 以五元组固定一次验证的目标、计划修订和不可复用身份。 */
export function validateValidationRef(value, label = 'validation_ref') {
  exactKeys(value, label, ['goal_id', 'goal_version', 'goal_digest', 'plan_revision', 'validation_id']);
  return deepFreeze({
    goal_id: identifier(value.goal_id, 'goal_id', `${label}.goal_id`),
    goal_version: positiveInteger(value.goal_version, `${label}.goal_version`),
    goal_digest: digest(value.goal_digest, `${label}.goal_digest`),
    plan_revision: positiveInteger(value.plan_revision, `${label}.plan_revision`),
    validation_id: identifier(value.validation_id, 'validation_id', `${label}.validation_id`),
  });
}

/** 范围基线摘要覆盖规范化后的完整记录，索引字段只属于 Git 已跟踪文件。 */
export function validateScopeBaseline(value, goalReference) {
  exactKeys(value, 'scope baseline', [
    'schema_version',
    'scope_version',
    'goal',
    'mode',
    'entries',
    'recorded_at',
    'record_digest',
  ]);
  if (value.schema_version !== 2) fail('INVALID_CONTRACT', 'input', 2, 'scope baseline.schema_version must equal 2');
  if (value.scope_version !== 1) fail('INVALID_CONTRACT', 'input', 2, 'scope baseline.scope_version must equal 1');
  if (!['git', 'inventory'].includes(value.mode)) fail('INVALID_CONTRACT', 'input', 2, 'scope baseline.mode is invalid');
  const expectedGoal = validateGoalReference(goalReference);
  const goal = validateGoalReference(value.goal, 'scope baseline.goal');
  assertGoalReferenceMatches(goal, expectedGoal, 'scope baseline.goal');
  const entries = array(value.entries, 'scope baseline.entries').map((entry, index) => {
    const label = `scope baseline.entries[${index}]`;
    exactKeys(entry, label, ['path', 'source', 'mode', 'size', 'digest', 'index_mode', 'index_digest']);
    if (!['tracked', 'untracked', 'inventory'].includes(entry.source)) {
      fail('INVALID_CONTRACT', 'input', 2, `${label}.source is invalid`);
    }
    if (!['100644', '100755'].includes(entry.mode)) fail('INVALID_CONTRACT', 'input', 2, `${label}.mode is invalid`);
    const tracked = entry.source === 'tracked';
    if (tracked) {
      if (!['100644', '100755'].includes(entry.index_mode)) fail('INVALID_CONTRACT', 'input', 2, `${label}.index_mode is invalid`);
      digest(entry.index_digest, `${label}.index_digest`);
    } else if (entry.index_mode !== null || entry.index_digest !== null) {
      fail('INVALID_CONTRACT', 'input', 2, `${label} index fields must be null for untracked or inventory entries`);
    }
    if (value.mode === 'git' ? entry.source === 'inventory' : entry.source !== 'inventory') {
      fail('INVALID_CONTRACT', 'input', 2, `${label}.source does not match scope baseline.mode`);
    }
    return {
      path: normalizeRelativePath(entry.path, `${label}.path`),
      source: entry.source,
      mode: entry.mode,
      size: nonNegativeInteger(entry.size, `${label}.size`),
      digest: digest(entry.digest, `${label}.digest`),
      index_mode: entry.index_mode,
      index_digest: entry.index_digest,
    };
  });
  const paths = entries.map(({ path }) => path);
  if (new Set(paths).size !== paths.length || paths.some((path, index) => index > 0 && paths[index - 1] >= path)) {
    fail('INVALID_CONTRACT', 'input', 2, 'scope baseline.entries must be sorted by unique path');
  }
  const normalized = {
    schema_version: 2,
    scope_version: 1,
    goal,
    mode: value.mode,
    entries,
    recorded_at: timestamp(value.recorded_at, 'scope baseline.recorded_at'),
    record_digest: digest(value.record_digest, 'scope baseline.record_digest'),
  };
  const { record_digest: suppliedDigest, ...withoutDigest } = normalized;
  if (sha256(canonicalBytes(withoutDigest)) !== suppliedDigest) {
    fail('INTEGRITY_FAILURE', 'integrity', 4, 'scope baseline.record_digest does not match the scope baseline');
  }
  return deepFreeze(normalized);
}

export function validateGoalContract(value, options = {}) {
  const fields = ['schema_version', 'goal_id', 'goal_version', 'objective', 'scope', 'non_goals', 'constraints', 'acceptance_criteria', 'authorization_boundary', 'assumptions', 'predecessor', 'accepted_change_id'];
  exactKeys(value, 'goal', fields);
  if (value.schema_version !== 2) fail('INVALID_CONTRACT', 'input', 2, 'schema_version must equal 2');
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
  const criteria = array(value.acceptance_criteria, 'acceptance_criteria', { nonEmpty: true }).map((criterion, index) => {
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
    schema_version: 2,
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
  const fields = ['schema_version', 'goal', 'plan_revision', 'next_task_id', 'tasks', 'risks', 'deferred'];
  exactKeys(value, 'plan', fields);
  if (value.schema_version !== 2) fail('INVALID_CONTRACT', 'input', 2, 'schema_version must equal 2');

  const expectedGoal = validateGoalReference(goalReference);
  const goal = validateGoalReference(value.goal, 'goal');
  assertGoalReferenceMatches(goal, expectedGoal, 'goal');

  const riskIds = new Set();
  const risks = array(value.risks, 'risks').map((risk, index) => {
    const label = `risks[${index}]`;
    exactKeys(risk, label, ['id', 'statement', 'source', 'affected_paths']);
    const id = identifier(risk.id, 'risk_id', `${label}.id`);
    if (riskIds.has(id)) fail('INVALID_CONTRACT', 'input', 2, `risks contains duplicate risk ID ${id}`);
    riskIds.add(id);
    plainObject(risk.source, `${label}.source`);
    let source;
    if (risk.source.kind === 'criterion') {
      exactKeys(risk.source, `${label}.source`, ['kind', 'criterion_id']);
      source = {
        kind: 'criterion',
        criterion_id: identifier(risk.source.criterion_id, 'acceptance_criterion_id', `${label}.source.criterion_id`),
      };
    } else if (risk.source.kind === 'failed-validation') {
      exactKeys(risk.source, `${label}.source`, ['kind', 'validation_ref', 'evidence_id']);
      source = {
        kind: 'failed-validation',
        validation_ref: validateValidationRef(risk.source.validation_ref, `${label}.source.validation_ref`),
        evidence_id: identifier(risk.source.evidence_id, 'evidence_id', `${label}.source.evidence_id`),
      };
    } else {
      fail('INVALID_CONTRACT', 'input', 2, `${label}.source.kind is invalid`);
    }
    return {
      id,
      statement: requiredText(risk.statement, `${label}.statement`),
      source,
      affected_paths: uniquePaths(risk.affected_paths, `${label}.affected_paths`, { nonEmpty: true }),
    };
  });

  const taskIds = new Set();
  const validationIds = new Set();
  const tasks = array(value.tasks, 'tasks', { nonEmpty: true }).map((task, index) => {
    const label = `tasks[${index}]`;
    exactKeys(task, label, ['id', 'outcome', 'acceptance_criteria', 'dependencies', 'permitted_paths', 'validations', 'status']);
    const id = identifier(task.id, 'task_id', `${label}.id`);
    if (taskIds.has(id)) fail('INVALID_CONTRACT', 'input', 2, `tasks contains duplicate task ID ${id}`);
    taskIds.add(id);
    const acceptanceCriteria = uniqueIdentifiers(task.acceptance_criteria, `${label}.acceptance_criteria`, 'acceptance_criterion_id');
    if (acceptanceCriteria.length === 0) fail('INVALID_CONTRACT', 'input', 2, `${label}.acceptance_criteria must be a non-empty array`);
    const dependencies = uniqueIdentifiers(task.dependencies, `${label}.dependencies`, 'task_id');
    const permittedPaths = uniquePaths(task.permitted_paths, `${label}.permitted_paths`);
    const validations = array(task.validations, `${label}.validations`).map((validation, validationIndex) => {
      const validationLabel = `${label}.validations[${validationIndex}]`;
      exactKeys(validation, validationLabel, ['id', 'kind', 'method', 'affected_paths', 'criterion_ids', 'risk_ids']);
      const validationId = identifier(validation.id, 'validation_id', `${validationLabel}.id`);
      if (validationIds.has(validationId)) fail('INVALID_CONTRACT', 'input', 2, `plan contains duplicate validation ID ${validationId}`);
      validationIds.add(validationId);
      if (!['focused', 'affected-regression', 'mandatory-gate'].includes(validation.kind)) {
        fail('INVALID_CONTRACT', 'input', 2, `${validationLabel}.kind is invalid`);
      }
      exactKeys(validation.method, `${validationLabel}.method`, ['type', 'target']);
      if (!['deterministic-test', 'behavior-eval', 'audit', 'manual-review', 'delivery-gate'].includes(validation.method.type)) {
        fail('INVALID_CONTRACT', 'input', 2, `${validationLabel}.method.type is invalid`);
      }
      const rawAffectedPaths = array(validation.affected_paths, `${validationLabel}.affected_paths`, { nonEmpty: true });
      let affectedPaths;
      if (rawAffectedPaths.includes('@governed-workspace')) {
        // 该闭合 token 只代表一次 mandatory gate，不能与任何具体交付路径混合扩权。
        if (validation.kind !== 'mandatory-gate' || rawAffectedPaths.length !== 1) {
          fail('INVALID_CONTRACT', 'input', 2, `${validationLabel}.affected_paths may use @governed-workspace only as the sole mandatory-gate token`);
        }
        affectedPaths = ['@governed-workspace'];
      } else {
        affectedPaths = uniquePaths(rawAffectedPaths, `${validationLabel}.affected_paths`, { nonEmpty: true });
      }
      const criterionIds = uniqueIdentifiers(validation.criterion_ids, `${validationLabel}.criterion_ids`, 'acceptance_criterion_id');
      const validationRiskIds = uniqueIdentifiers(validation.risk_ids, `${validationLabel}.risk_ids`, 'risk_id');
      if (criterionIds.length === 0 && validationRiskIds.length === 0) {
        fail('INVALID_CONTRACT', 'input', 2, `${validationLabel} must trace to at least one criterion or risk`);
      }
      return {
        id: validationId,
        kind: validation.kind,
        method: {
          type: validation.method.type,
          target: requiredText(validation.method.target, `${validationLabel}.method.target`),
        },
        affected_paths: affectedPaths,
        criterion_ids: criterionIds,
        risk_ids: validationRiskIds,
      };
    });
    if (!['pending', 'in_progress', 'blocked', 'complete', 'stale'].includes(task.status)) {
      fail('INVALID_CONTRACT', 'input', 2, `${label}.status is invalid`);
    }
    return {
      id,
      outcome: requiredText(task.outcome, `${label}.outcome`),
      acceptance_criteria: acceptanceCriteria,
      dependencies,
      permitted_paths: permittedPaths,
      validations,
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
    schema_version: 2,
    goal,
    plan_revision: positiveInteger(value.plan_revision, 'plan_revision'),
    next_task_id: nextTaskId,
    tasks,
    risks,
    deferred,
  });
}

/** 证据不再声明独立执行方法，只能引用计划历史中的精确 ValidationRef。 */
export function validateEvidence(value, goalReference) {
  const fields = ['schema_version', 'evidence_id', 'acceptance_criterion_id', 'validation_ref', 'task_id', 'observed_result', 'artifact_refs', 'workspace_fingerprint', 'state', 'failure_paths', 'supersedes', 'derivation', 'recorded_at'];
  exactKeys(value, 'evidence', fields);
  if (value.schema_version !== 2) fail('INVALID_CONTRACT', 'input', 2, 'schema_version must equal 2');

  const expectedGoal = validateGoalReference(goalReference);
  const validationRef = validateValidationRef(value.validation_ref, 'evidence.validation_ref');
  assertGoalReferenceMatches(validationRef, expectedGoal, 'evidence.validation_ref');
  const artifactRefs = uniquePaths(value.artifact_refs, 'evidence.artifact_refs');
  if (!['pass', 'fail', 'stale'].includes(value.state)) {
    fail('INVALID_CONTRACT', 'input', 2, 'evidence.state is invalid');
  }
  const failurePaths = uniquePaths(value.failure_paths, 'evidence.failure_paths');
  if (value.state !== 'fail' && failurePaths.length > 0) {
    fail('INVALID_CONTRACT', 'input', 2, 'evidence.failure_paths must be empty unless state is fail');
  }
  const supersedes = value.supersedes === null
    ? null
    : identifier(value.supersedes, 'evidence_id', 'evidence.supersedes');
  let derivation = null;
  if (value.derivation !== null) {
    exactKeys(value.derivation, 'evidence.derivation', [
      'kind',
      'source_validation_ref',
      'source_evidence_id',
      'source_evidence_digest',
    ]);
    if (!['carry-forward', 'invalidation'].includes(value.derivation.kind)) {
      fail('INVALID_CONTRACT', 'input', 2, 'evidence.derivation.kind is invalid');
    }
    derivation = {
      kind: value.derivation.kind,
      source_validation_ref: validateValidationRef(value.derivation.source_validation_ref, 'evidence.derivation.source_validation_ref'),
      source_evidence_id: identifier(value.derivation.source_evidence_id, 'evidence_id', 'evidence.derivation.source_evidence_id'),
      source_evidence_digest: digest(value.derivation.source_evidence_digest, 'evidence.derivation.source_evidence_digest'),
    };
    if (supersedes !== derivation.source_evidence_id) {
      fail('INVALID_CONTRACT', 'input', 2, 'evidence.derivation must bind the superseded evidence');
    }
    if (derivation.kind === 'invalidation' && value.state !== 'stale') {
      fail('INVALID_CONTRACT', 'input', 2, 'evidence invalidation derivations must be stale');
    }
  }
  return deepFreeze({
    schema_version: 2,
    evidence_id: identifier(value.evidence_id, 'evidence_id', 'evidence.evidence_id'),
    acceptance_criterion_id: identifier(value.acceptance_criterion_id, 'acceptance_criterion_id', 'evidence.acceptance_criterion_id'),
    validation_ref: validationRef,
    task_id: identifier(value.task_id, 'task_id', 'evidence.task_id'),
    observed_result: requiredText(value.observed_result, 'evidence.observed_result'),
    artifact_refs: artifactRefs,
    workspace_fingerprint: digest(value.workspace_fingerprint, 'evidence.workspace_fingerprint'),
    state: value.state,
    failure_paths: failurePaths,
    supersedes,
    derivation,
    recorded_at: timestamp(value.recorded_at, 'evidence.recorded_at'),
  });
}

/** 验证进度事件的完整封装、自身摘要及其与前一事件摘要的精确链接。 */
export function validateProgressEvent(value, previousDigest) {
  const fields = ['schema_version', 'event_id', 'recorded_at', 'goal', 'plan_revision', 'task_id', 'event_type', 'summary', 'evidence_refs', 'previous_event_digest', 'event_digest'];
  exactKeys(value, 'progress event', fields);
  if (value.schema_version !== 2) fail('INVALID_CONTRACT', 'input', 2, 'schema_version must equal 2');

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
    schema_version: 2,
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
  const fields = ['schema_version', 'goal_id', 'goal_version', 'goal_digest', 'approval_type', 'proposal_digest', 'approved_at', 'predecessor_digest', 'state_revision', 'scope_head', 'plan_head', 'progress_head', 'change_head', 'change_heads', 'evidence_heads', 'record_digest'];
  exactKeys(value, 'lock', fields);
  if (value.schema_version !== 2) fail('INVALID_CONTRACT', 'input', 2, 'schema_version must equal 2');
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
  plainObject(value.change_heads, 'change_heads');
  const changeHeads = {};
  for (const [changeRequestId, changeDigest] of Object.entries(value.change_heads)) {
    identifier(changeRequestId, 'change_request_id', 'change_heads key');
    changeHeads[changeRequestId] = digest(changeDigest, `change_heads.${changeRequestId}`);
  }
  let planHead = null;
  if (value.plan_head !== null) {
    exactKeys(value.plan_head, 'plan_head', ['goal_version', 'plan_revision', 'digest']);
    planHead = {
      goal_version: positiveInteger(value.plan_head.goal_version, 'plan_head.goal_version'),
      plan_revision: positiveInteger(value.plan_head.plan_revision, 'plan_head.plan_revision'),
      digest: digest(value.plan_head.digest, 'plan_head.digest'),
    };
  }
  exactKeys(value.scope_head, 'scope_head', ['scope_version', 'digest']);
  if (value.scope_head.scope_version !== 1) fail('INVALID_CONTRACT', 'input', 2, 'scope_head.scope_version must equal 1');
  const normalized = {
    schema_version: 2,
    goal_id: identifier(value.goal_id, 'goal_id', 'goal_id'),
    goal_version: goalVersion,
    goal_digest: digest(value.goal_digest, 'goal_digest'),
    approval_type: value.approval_type,
    proposal_digest: digest(value.proposal_digest, 'proposal_digest'),
    approved_at: timestamp(value.approved_at, 'approved_at'),
    predecessor_digest: predecessorDigest,
    state_revision: positiveInteger(value.state_revision, 'state_revision'),
    scope_head: {
      scope_version: 1,
      digest: digest(value.scope_head.digest, 'scope_head.digest'),
    },
    plan_head: planHead,
    progress_head: nullableHead(value.progress_head, 'progress_head', 'event_id', 'event_id'),
    change_head: nullableHead(value.change_head, 'change_head', 'change_request_id', 'change_request_id'),
    change_heads: changeHeads,
    evidence_heads: evidenceHeads,
    record_digest: digest(value.record_digest, 'record_digest'),
  };
  // record_digest 是锁记录自身的防篡改边界，因此只排除它本身参与摘要。
  const { record_digest: suppliedDigest, ...withoutDigest } = normalized;
  if (sha256(canonicalBytes(withoutDigest)) !== suppliedDigest) fail('INTEGRITY_FAILURE', 'integrity', 4, 'record_digest does not match the lock record');
  return deepFreeze(normalized);
}

export function validateChangeRequest(value) {
  exactKeys(value, 'change request', CHANGE_REQUEST_FIELDS);
  if (value.schema_version !== 2) fail('INVALID_CONTRACT', 'input', 2, 'change request.schema_version must equal 2');
  const id = identifier(value.id, 'change_request_id', 'change request.id');
  if (!['proposed', 'approved', 'rejected', 'superseded'].includes(value.status)) {
    fail('INVALID_CONTRACT', 'input', 2, 'change request.status is invalid');
  }
  exactKeys(value.base_goal, 'change request.base_goal', ['goal_id', 'goal_version', 'goal_digest']);
  const baseGoal = {
    goal_id: identifier(value.base_goal.goal_id, 'goal_id', 'change request.base_goal.goal_id'),
    goal_version: positiveInteger(value.base_goal.goal_version, 'change request.base_goal.goal_version'),
    goal_digest: digest(value.base_goal.goal_digest, 'change request.base_goal.goal_digest'),
  };
  const candidateGoal = validateGoalContract(value.candidate_goal, { goal_id: baseGoal.goal_id });
  if (candidateGoal.goal_version !== baseGoal.goal_version + 1
    || candidateGoal.accepted_change_id !== id
    || candidateGoal.predecessor?.goal_version !== baseGoal.goal_version
    || candidateGoal.predecessor?.goal_digest !== baseGoal.goal_digest) {
    fail('INVALID_CONTRACT', 'input', 2, 'change request candidate metadata does not exactly follow its base goal');
  }
  const candidateDigest = digest(value.candidate_digest, 'change request.candidate_digest');
  if (candidateDigest !== sha256(canonicalBytes(candidateGoal))) {
    fail('INVALID_CONTRACT', 'input', 2, 'change request.candidate_digest does not match candidate_goal');
  }
  const changedFields = new Set();
  const changes = array(value.changes, 'change request.changes', { nonEmpty: true }).map((change, index) => {
    exactKeys(change, `change request.changes[${index}]`, ['field', 'before', 'after']);
    const field = requiredText(change.field, `change request.changes[${index}].field`);
    if (changedFields.has(field)) fail('INVALID_CONTRACT', 'input', 2, 'change request.changes contains a duplicate field');
    changedFields.add(field);
    try {
      canonicalBytes(change.before);
      canonicalBytes(change.after);
    } catch {
      fail('INVALID_CONTRACT', 'input', 2, `change request.changes[${index}] values must be canonical JSON`);
    }
    return { field, before: structuredClone(change.before), after: structuredClone(change.after) };
  });
  exactKeys(value.criterion_impact, 'change request.criterion_impact', ['affected', 'unaffected']);
  const affectedCriteria = uniqueIdentifiers(
    value.criterion_impact.affected,
    'change request.criterion_impact.affected',
    'acceptance_criterion_id',
  );
  const unaffectedCriteria = uniqueIdentifiers(
    value.criterion_impact.unaffected,
    'change request.criterion_impact.unaffected',
    'acceptance_criterion_id',
  );
  const affectedSet = new Set(affectedCriteria);
  if (unaffectedCriteria.some((criterionId) => affectedSet.has(criterionId))) {
    fail('INVALID_CONTRACT', 'input', 2, 'change request.criterion_impact arrays must be disjoint');
  }
  const candidateCriteria = candidateGoal.acceptance_criteria.map(({ id: criterionId }) => criterionId);
  const partition = [...affectedCriteria, ...unaffectedCriteria];
  if (partition.length !== candidateCriteria.length || candidateCriteria.some((criterionId) => !partition.includes(criterionId))) {
    fail('INVALID_CONTRACT', 'input', 2, 'change request.criterion_impact must exhaust every candidate criterion');
  }
  const normalized = {
    schema_version: 2,
    id,
    status: value.status,
    base_goal: baseGoal,
    candidate_goal: candidateGoal,
    candidate_digest: candidateDigest,
    proposal_digest: digest(value.proposal_digest, 'change request.proposal_digest'),
    changes,
    rationale: requiredText(value.rationale, 'change request.rationale'),
    affected_tasks: uniqueIdentifiers(value.affected_tasks, 'change request.affected_tasks', 'task_id'),
    criterion_impact: { affected: affectedCriteria, unaffected: unaffectedCriteria },
    risks: textArray(value.risks, 'change request.risks'),
    validation: textArray(value.validation, 'change request.validation'),
    rollback: textArray(value.rollback, 'change request.rollback'),
    approval_phrase: requiredText(value.approval_phrase, 'change request.approval_phrase'),
    recorded_at: timestamp(value.recorded_at, 'change request.recorded_at'),
  };
  const {
    status: _status,
    proposal_digest: suppliedProposalDigest,
    approval_phrase: _approvalPhrase,
    ...proposalPayload
  } = normalized;
  // proposal_digest 自身不是提案载荷；载荷只排除可变状态与由摘要派生的批准短语。
  if (sha256(canonicalBytes(proposalPayload)) !== suppliedProposalDigest) {
    fail('INTEGRITY_FAILURE', 'integrity', 4, 'change request.proposal_digest does not match the immutable proposal payload');
  }
  if (normalized.approval_phrase !== approvalPhraseForChange(normalized)) {
    fail('INTEGRITY_FAILURE', 'integrity', 4, 'change request.approval_phrase does not bind the proposal');
  }
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
