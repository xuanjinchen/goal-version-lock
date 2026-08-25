import { lstat, readdir, readFile, realpath, rmdir } from 'node:fs/promises';
import path from 'node:path';

import { canonicalBytes, parseCanonicalJson, sha256 } from './canonical.js';
import {
  GoalLockError,
  approvalPhraseForChange,
  validateChangeRequest,
  validateEvidence,
  validateGoalContract,
  validateLockRecord,
  validatePlan,
  validateProgressEvent,
} from './contracts.js';
import {
  assertEvidenceAuthorized,
  buildAuthorizationGraph,
  deriveScopeBlockers,
  resolveValidationRef,
} from './authorization.js';
import { commitGoalFiles, withGoalLock } from './transaction.js';
import {
  computeWorkspaceDelta,
  captureWorkspaceManifest,
  createScopeBaseline,
  createWorkspaceReader,
  verifyScopeBaseline,
  workspaceFingerprint,
  workspaceFingerprintFromManifest,
} from './workspace.js';

const ACTIVE_WRITE = Symbol('active goal writer');
const RETURN_VERIFIED_SNAPSHOT = Symbol('return verified repository snapshot');
const TASK_STATUS_TRANSITIONS = Object.freeze({
  'task-start': Object.freeze({ from: 'pending', to: 'in_progress' }),
  'task-complete': Object.freeze({ from: 'in_progress', to: 'complete' }),
  blocker: Object.freeze({ from: 'in_progress', to: 'blocked' }),
});
const GOAL_SEMANTIC_FIELDS = Object.freeze([
  'objective',
  'scope',
  'non_goals',
  'constraints',
  'acceptance_criteria',
  'authorization_boundary',
  'assumptions',
]);

function stateError(code, message) {
  return new GoalLockError(code, 'state', 3, message);
}

function approvalError(code, message) {
  return new GoalLockError(code, 'approval', 5, message);
}

function inputError(code, message) {
  return new GoalLockError(code, 'input', 2, message);
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

function validateChangeEnvelope(value, expectedId) {
  let normalized;
  try {
    normalized = validateChangeRequest(value);
  } catch (error) {
    throw repositoryIntegrity('CHANGE_STATE_INVALID', 'Change request violates the complete change contract.', error);
  }
  if (normalized.id !== expectedId) {
    throw integrityError('CHANGE_STATE_INVALID', 'Change request ID does not match its filename.');
  }
  return normalized;
}

function canonicalValuesEqual(left, right) {
  return canonicalBytes(left).equals(canonicalBytes(right));
}

function validateSemanticChangeCoverage(baseGoal, candidateGoal, changes, createError, { requireOrder = false } = {}) {
  const expected = GOAL_SEMANTIC_FIELDS
    .filter((field) => !canonicalValuesEqual(baseGoal[field], candidateGoal[field]))
    .map((field) => ({ field, before: baseGoal[field], after: candidateGoal[field] }));
  const claims = Array.isArray(changes) ? new Map(changes.map((change) => [change?.field, change])) : new Map();
  let exact = false;
  try {
    exact = changes?.length === expected.length
      && claims.size === changes.length
      && expected.every((difference) => {
        const claim = claims.get(difference.field);
        return claim
          && canonicalValuesEqual(claim.before, difference.before)
          && canonicalValuesEqual(claim.after, difference.after);
      });
  } catch {
    exact = false;
  }
  const ordered = !requireOrder || changes.every((change, index) => change.field === expected[index].field);
  // 每个顶层语义字段落盘时按固定契约顺序出现，漏报、虚报、重复或错配前后值都不能形成可批准提案。
  if (!exact || !ordered || expected.length === 0) throw createError();
  return expected;
}

function deriveCriterionImpact(baseGoal, candidateGoal) {
  const baseCriteria = new Map(baseGoal.acceptance_criteria.map((criterion) => [criterion.id, criterion]));
  const affected = [];
  const unaffected = [];
  for (const criterion of candidateGoal.acceptance_criteria) {
    const prior = baseCriteria.get(criterion.id);
    (prior && canonicalValuesEqual(prior, criterion) ? unaffected : affected).push(criterion.id);
  }
  return { affected, unaffected };
}

function assertCriterionImpactMatches(baseGoal, candidateGoal, supplied, createError) {
  const derived = deriveCriterionImpact(baseGoal, candidateGoal);
  let matches = false;
  try {
    matches = canonicalValuesEqual(supplied, derived);
  } catch {
    matches = false;
  }
  // 候选目标逐项决定唯一分区，调用方不能把新/变更 criterion 伪装成可携带的 unaffected。
  if (!matches) throw createError();
  return derived;
}

async function readCanonicalObject(reader, relativePath, label) {
  const input = await reader.readFile(relativePath);
  try {
    return { ...input, value: plainStructuralObject(parseCanonicalJson(input.bytes, label), label) };
  } catch (error) {
    throw repositoryIntegrity('OPTIONAL_STATE_INVALID', `${label} is malformed or noncanonical.`, error);
  }
}

function validatePlanCriteria(plan, goal) {
  const criterionIds = new Set(goal.acceptance_criteria.map((criterion) => criterion.id));
  const coveredCriteria = new Set();
  for (const task of plan.tasks) {
    if (task.acceptance_criteria.some((criterionId) => !criterionIds.has(criterionId))) {
      throw inputError('INVALID_PLAN_REFERENCE', 'Plan acceptance criteria must belong to the bound goal.');
    }
    for (const criterionId of task.acceptance_criteria) coveredCriteria.add(criterionId);
  }
  if ([...criterionIds].some((criterionId) => !coveredCriteria.has(criterionId))) {
    throw inputError('INVALID_PLAN_REFERENCE', 'Plan tasks must cover every acceptance criterion in the bound goal.');
  }
  return plan;
}

/** 从已核验归档构建唯一授权图；仓库不维护第二份计划、证据或路径权限账本。 */
function repositoryAuthorizationGraph(history, planState, evidenceState, changeState, candidatePlan = null) {
  const planRecords = [
    ...planState.archives.map((record) => record.value),
    ...(planState.current ? [planState.current.value] : []),
    ...(candidatePlan ? [candidatePlan] : []),
  ];
  if (planRecords.length === 0) return null;
  return buildAuthorizationGraph({
    goalHistory: [...history.goals.values()].map((record) => record.goal),
    planRecords,
    evidenceRecords: evidenceState.records.map((record) => record.value),
    changeRecords: [...changeState.records.values()].map((record) => record.value),
  });
}

function assertEvidenceReplayAuthorized(graph, evidenceState, progressState) {
  for (const record of evidenceState.records) {
    const evidence = record.value;
    if (evidence.state === 'stale' && evidence.derivation?.kind === 'invalidation') {
      // stale 派生只证明旧证据失效；其 source 与图边已核验，不能再按“可用证据”规则重放。
      continue;
    }
    const supersedingPlan = progressState.events.find((event) => (
      event.event_type === 'plan-revision'
      && (event.goal.goal_version > evidence.validation_ref.goal_version
        || (event.goal.goal_version === evidence.validation_ref.goal_version
          && event.plan_revision > evidence.validation_ref.plan_revision))
    ));
    assertEvidenceAuthorized(graph, evidence, {
      mode: 'replay',
      superseded_at: supersedingPlan?.recorded_at,
    });
  }
}

function validateRepositoryPlan(value, goalRecord, label) {
  try {
    const plan = validatePlan(value, {
      goal_id: goalRecord.goal.goal_id,
      goal_version: goalRecord.goal.goal_version,
      goal_digest: goalRecord.digest,
    });
    return validatePlanCriteria(plan, goalRecord.goal);
  } catch (error) {
    throw repositoryIntegrity('PLAN_STATE_INVALID', `${label} violates the plan contract.`, error);
  }
}

async function verifyPlanState(reader, rootNames, current, goalHistory) {
  const present = rootNames.includes('plan.json');
  let currentPlan = null;
  let currentRecord = null;
  const archives = [];
  if (present) {
    const plan = await readCanonicalObject(reader, '.goal-lock/plan.json', 'goal plan');
    currentPlan = validateRepositoryPlan(plan.value, current, 'Current plan');
    currentRecord = { ...plan, value: currentPlan };
  }
  const historyRoot = await reader.readDirectory('.goal-lock/history');
  if (!historyRoot.names.includes('plans')) {
    if (currentPlan && currentPlan.plan_revision !== 1) {
      throw integrityError('PLAN_STATE_INVALID', 'A current plan without archives must be revision 1.');
    }
    return { present, current: currentRecord, archives };
  }
  const planHistory = await reader.readDirectory('.goal-lock/history/plans');
  const revisionsByVersion = new Map();
  for (const name of planHistory.names) {
    if (!/^v[0-9]{4}-r[0-9]{4}\.json$/.test(name)) {
      throw integrityError('PLAN_STATE_INVALID', 'Plan history contains an unexpected entry.');
    }
    const record = await readCanonicalObject(reader, `.goal-lock/history/plans/${name}`, 'plan history record');
    const match = /^v([0-9]{4})-r([0-9]{4})\.json$/.exec(name);
    const goalVersion = Number(match[1]);
    const planRevision = Number(match[2]);
    const historicalGoal = goalHistory.get(goalVersion);
    if (!historicalGoal) throw integrityError('PLAN_STATE_INVALID', 'Plan history references an unknown goal version.');
    const validated = validateRepositoryPlan(record.value, historicalGoal, 'Archived plan');
    if (validated.goal.goal_version !== goalVersion || validated.plan_revision !== planRevision) {
      throw integrityError('PLAN_STATE_INVALID', 'Plan history envelope does not match its filename.');
    }
    const revisions = revisionsByVersion.get(goalVersion) ?? [];
    revisions.push(planRevision);
    revisionsByVersion.set(goalVersion, revisions);
    archives.push({ ...record, value: validated, target: `.goal-lock/history/plans/${name}` });
  }
  for (const revisions of revisionsByVersion.values()) {
    revisions.sort((left, right) => left - right);
    if (revisions.some((revision, index) => revision !== index + 1)) {
      throw integrityError('PLAN_STATE_INVALID', 'Archived plan revisions must be contiguous from revision 1.');
    }
  }
  const activeRevisions = revisionsByVersion.get(current.goal.goal_version) ?? [];
  if (!present && activeRevisions.length > 0) {
    throw integrityError('PLAN_STATE_MISSING', 'Current plan is missing after its active plan history began.');
  }
  if (currentPlan && currentPlan.plan_revision !== activeRevisions.length + 1) {
    throw integrityError('PLAN_STATE_INVALID', 'Current plan revision must immediately follow its archived revisions.');
  }
  return { present, current: currentRecord, archives };
}

async function verifyChangeState(reader, rootNames, lock, current, goalHistory) {
  if (!rootNames.includes('changes')) {
    if (lock.change_head !== null) throw integrityError('CHANGE_STATE_MISSING', 'Lock change head requires change state.');
    return { count: 0, pending: false, records: new Map() };
  }
  const directory = await reader.readDirectory('.goal-lock/changes');
  const expectedNames = Array.from(
    { length: directory.names.length },
    (_, index) => `CR-${String(index + 1).padStart(4, '0')}.json`,
  );
  if (expectedNames.length === 0 || directory.names.some((name, index) => name !== expectedNames[index])) {
    throw integrityError('CHANGE_SEQUENCE_INVALID', 'Change request IDs must be unique and contiguous from CR-0001.');
  }
  const records = new Map();
  let open = null;
  for (const name of directory.names) {
    const record = await readCanonicalObject(reader, `.goal-lock/changes/${name}`, 'change request');
    const changeId = name.slice(0, -5);
    const value = validateChangeEnvelope(record.value, changeId);
    const base = goalHistory.get(value.base_goal.goal_version);
    if (!base
      || value.base_goal.goal_id !== base.goal.goal_id
      || value.base_goal.goal_digest !== base.digest) {
      throw integrityError('CHANGE_BASE_MISMATCH', 'Change request base does not bind an accepted goal version.');
    }
    validateSemanticChangeCoverage(base.goal, value.candidate_goal, value.changes, () => (
      integrityError('CHANGE_COVERAGE_INVALID', 'Change request field-level changes do not exactly cover the semantic difference.')
    ), { requireOrder: true });
    assertCriterionImpactMatches(base.goal, value.candidate_goal, value.criterion_impact, () => (
      integrityError('CHANGE_CRITERION_IMPACT_INVALID', 'Change request criterion impact must exactly partition its candidate goal.')
    ));
    if (value.status === 'approved') {
      const acceptedGoal = goalHistory.get(value.candidate_goal.goal_version);
      if (!acceptedGoal || acceptedGoal.digest !== value.candidate_digest || !acceptedGoal.bytes.equals(canonicalBytes(value.candidate_goal))) {
        throw integrityError('CHANGE_CANDIDATE_MISMATCH', 'Approved change request candidate must be an accepted goal version.');
      }
    }
    if (value.status === 'proposed') {
      if (open !== null) throw integrityError('CHANGE_OPEN_DUPLICATE', 'Only one proposed change request may exist.');
      if (value.base_goal.goal_version !== current.goal.goal_version || value.base_goal.goal_digest !== current.digest) {
        throw integrityError('CHANGE_BASE_STALE', 'Proposed change request base must equal the active goal.');
      }
      open = { ...record, value, target: `.goal-lock/changes/${name}` };
    }
    records.set(changeId, { ...record, value, target: `.goal-lock/changes/${name}` });
  }
  const terminalId = `CR-${String(records.size).padStart(4, '0')}`;
  const terminal = records.get(terminalId);
  if (lock.change_head?.change_request_id !== terminalId || lock.change_head?.digest !== terminal.digest) {
    throw integrityError('CHANGE_HEAD_MISMATCH', 'Lock change head must match the terminal change request record.');
  }
  // 唯一 proposed 记录必须同时是数值终项和锁 head，拒绝操作才不会把完整性索引回退到历史 CR。
  if (open !== null && open.value.id !== terminalId) {
    throw integrityError('CHANGE_OPEN_HEAD_MISMATCH', 'The proposed change request must be the terminal lock head.');
  }
  return { count: records.size, pending: open !== null, open, records };
}

function verifyHistoricalChangeBindings(goalHistory, changeState) {
  // 每个非初始目标都反向绑定自己的 approved CR，不能只验证当前 tip 而遗漏中间版本。
  for (const [version, goalRecord] of goalHistory) {
    if (version === 1) continue;
    const predecessor = goalHistory.get(version - 1);
    const accepted = changeState.records.get(goalRecord.goal.accepted_change_id);
    if (!predecessor
      || !accepted
      || accepted.value.status !== 'approved'
      || accepted.value.base_goal.goal_id !== predecessor.goal.goal_id
      || accepted.value.base_goal.goal_version !== predecessor.goal.goal_version
      || accepted.value.base_goal.goal_digest !== predecessor.digest
      || accepted.value.candidate_digest !== goalRecord.digest
      || !accepted.value.candidate_goal.predecessor
      || accepted.value.candidate_goal.predecessor.goal_version !== predecessor.goal.goal_version
      || accepted.value.candidate_goal.predecessor.goal_digest !== predecessor.digest
      || !canonicalBytes(accepted.value.candidate_goal).equals(goalRecord.bytes)) {
      throw integrityError('GOAL_HISTORY_CHANGE_MISMATCH', 'Each noninitial goal version must bind its exact approved change request.');
    }
  }
}

function verifyChangeReferences(changeState, planState) {
  const plans = [planState.current, ...planState.archives].filter(Boolean);
  for (const record of changeState.records.values()) {
    const knownTasks = new Set(plans
      .filter((plan) => plan.value.goal.goal_version === record.value.base_goal.goal_version)
      .flatMap((plan) => plan.value.tasks.map((task) => task.id)));
    if (record.value.affected_tasks.some((taskId) => !knownTasks.has(taskId))) {
      throw integrityError('CHANGE_TASK_UNKNOWN', 'Change request affected tasks must exist in a plan for its base goal.');
    }
  }
}

/** 限制账本绑定只向前推进；跨目标版本仅预留相邻版本入口，具体生命周期由后续任务定义。 */
function verifyProgressChronology(previousEvent, event) {
  if (previousEvent === null) return;
  const previousGoalVersion = previousEvent.goal.goal_version;
  const goalVersion = event.goal.goal_version;
  if (goalVersion < previousGoalVersion || goalVersion > previousGoalVersion + 1) {
    throw integrityError(
      'PROGRESS_CHRONOLOGY_INVALID',
      'Progress event goal versions must advance monotonically without skips.',
    );
  }
  if (goalVersion !== previousGoalVersion) return;
  if (event.plan_revision < previousEvent.plan_revision
    || (event.plan_revision > previousEvent.plan_revision && event.event_type !== 'plan-revision')) {
    throw integrityError(
      'PROGRESS_CHRONOLOGY_INVALID',
      'Progress events cannot return to an earlier plan revision, and revision advances require a lifecycle event.',
    );
  }
}

async function verifyProgressLedger(reader, rootNames, lock, goalHistory, planState, evidenceState, changeState) {
  if (!rootNames.includes('progress.jsonl')) {
    if (lock.progress_head !== null) throw integrityError('PROGRESS_STATE_MISSING', 'Lock progress head requires a progress ledger.');
    if (planState.present) throw integrityError('PROGRESS_STATE_MISSING', 'A current plan requires its automatic progress ledger event.');
    return { count: 0, events: [], input: null, terminal: null };
  }
  const input = await reader.readFile('.goal-lock/progress.jsonl');
  if (input.bytes.length === 0 || input.bytes.at(-1) !== 0x0a) {
    throw integrityError('PROGRESS_STATE_INVALID', 'Progress ledger must contain canonical JSON lines.');
  }
  const plans = new Map(planState.archives.map((archive) => [
    `${archive.value.goal.goal_version}/${archive.value.plan_revision}`,
    archive.value,
  ]));
  if (planState.current) {
    plans.set(
      `${planState.current.value.goal.goal_version}/${planState.current.value.plan_revision}`,
      planState.current.value,
    );
  }
  const eventsByPlan = new Map([...plans.keys()].map((key) => [key, []]));
  let count = 0;
  let offset = 0;
  let terminal = null;
  const events = [];
  while (offset < input.bytes.length) {
    const terminator = input.bytes.indexOf(0x0a, offset);
    const line = input.bytes.subarray(offset, terminator + 1);
    let event;
    try {
      event = validateProgressEvent(
        plainStructuralObject(parseCanonicalJson(line, 'progress event'), 'progress event'),
        terminal?.event_digest ?? null,
      );
    } catch (error) {
      throw repositoryIntegrity('PROGRESS_STATE_INVALID', 'Progress ledger contains a malformed or noncanonical event.', error);
    }
    const expectedId = `EVT-${String(count + 1).padStart(6, '0')}`;
    if (event.event_id !== expectedId) {
      throw integrityError('PROGRESS_SEQUENCE_INVALID', 'Progress event IDs must be unique and contiguous from EVT-000001.');
    }
    const historicalGoal = goalHistory.get(event.goal.goal_version);
    if (!historicalGoal
      || historicalGoal.goal.goal_id !== event.goal.goal_id
      || historicalGoal.digest !== event.goal.goal_digest) {
      throw integrityError('PROGRESS_GOAL_MISMATCH', 'Progress event does not bind a known goal version.');
    }
    const planKey = `${event.goal.goal_version}/${event.plan_revision}`;
    const plan = plans.get(planKey);
    if (!plan) throw integrityError('PROGRESS_PLAN_MISMATCH', 'Progress event does not bind a known plan revision.');
    if (event.task_id !== null && !plan.tasks.some((task) => task.id === event.task_id)) {
      throw integrityError('PROGRESS_TASK_UNKNOWN', 'Progress event references an unknown task.');
    }
    const evidenceCreationMatches = evidenceState.records.filter(
      (record) => evidenceCreationEventMatchesRecord(event, record),
    );
    if (evidenceCreationMatches.length > 1
      || evidenceCreationMatches.length === 0 && !ordinaryEvidenceReferencesResolve(evidenceState, event)) {
      throw integrityError(
        'PROGRESS_EVIDENCE_REFERENCE_INVALID',
        'Progress evidence references must resolve uniquely within the event goal, plan, and task.',
      );
    }
    verifyProgressChronology(terminal, event);
    terminal = event;
    events.push(event);
    eventsByPlan.get(planKey).push(event);
    count += 1;
    offset = terminator + 1;
  }
  if (lock.progress_head === null
    || terminal.event_id !== lock.progress_head.event_id
    || terminal.event_digest !== lock.progress_head.digest) {
    throw integrityError('PROGRESS_HEAD_MISMATCH', 'Lock progress head does not match the terminal progress event.');
  }
  verifyProgressPlanState(plans, eventsByPlan, changeState, planState);
  for (const record of evidenceState.records) {
    const matches = events.filter((event) => evidenceCreationEventMatchesRecord(event, record));
    if (matches.length !== 1) {
      throw integrityError(
        'EVIDENCE_EVENT_MISMATCH',
        'Each immutable evidence record requires exactly one digest-bound verification-result event.',
      );
    }
  }
  return { count, events, input, terminal };
}

function verifyProgressPlanState(plans, eventsByPlan, changeState, planState) {
  const orderedRecords = [...planState.archives, planState.current].filter(Boolean).sort((left, right) => (
    left.value.goal.goal_version - right.value.goal.goal_version
    || left.value.plan_revision - right.value.plan_revision
  ));
  const orderedPlans = orderedRecords.map((record) => record.value);
  let previousStatuses = new Map();
  for (const [planIndex, plan] of orderedPlans.entries()) {
    const planKey = `${plan.goal.goal_version}/${plan.plan_revision}`;
    const planEvents = eventsByPlan.get(planKey);
    const lifecycleCount = planEvents.filter((event) => event.event_type === 'plan-revision').length;
    if (lifecycleCount !== 1 || planEvents[0]?.event_type !== 'plan-revision') {
      throw integrityError(
        'PROGRESS_PLAN_LIFECYCLE_INVALID',
        'Every plan revision requires exactly one plan-revision event as its first bound event.',
      );
    }
    const previousDigest = planIndex === 0 ? null : orderedRecords[planIndex - 1].digest;
    const summaryPattern = new RegExp(
      `^Recorded plan v${String(plan.goal.goal_version).padStart(4, '0')}/r${String(plan.plan_revision).padStart(4, '0')} sha256:[a-f0-9]{64} previous:${previousDigest ?? 'none'}$`,
      'u',
    );
    if (!summaryPattern.test(planEvents[0].summary)) {
      throw integrityError('PROGRESS_PLAN_DIGEST_MISMATCH', 'Plan revision event does not bind its plan and exact predecessor digest.');
    }

    // 新目标版本继承未受影响任务的终态；批准 CR 列出的任务例外地从 stale 开始，首次出现的任务仍从 pending 回放。
    const approvedChange = plan.goal.goal_version > 1
      ? [...changeState.records.values()].find((record) => (
        record.value.status === 'approved'
        && record.value.candidate_digest === plan.goal.goal_digest
      ))
      : null;
    const invalidatedTasks = new Set(approvedChange?.value.affected_tasks ?? []);
    const replayedStatuses = new Map(plan.tasks.map((task) => [
      task.id,
      invalidatedTasks.has(task.id) ? 'stale' : (previousStatuses.get(task.id) ?? 'pending'),
    ]));
    if (plan.goal.goal_version > 1 && plan.plan_revision === 1
      && planEvents.filter((event) => event.event_type === 'goal-change').length !== 1) {
      throw integrityError('PROGRESS_GOAL_CHANGE_INVALID', 'Each approved goal version requires exactly one goal-change event.');
    }
    for (const event of planEvents) {
      const transition = TASK_STATUS_TRANSITIONS[event.event_type];
      if (!transition) continue;
      const status = replayedStatuses.get(event.task_id);
      if (status !== transition.from) {
        throw integrityError(
          'PROGRESS_TASK_TRANSITION_INVALID',
          `${event.event_type} cannot transition task ${event.task_id} from ${status}.`,
        );
      }
      replayedStatuses.set(event.task_id, transition.to);
    }
    if (plan.tasks.some((task) => replayedStatuses.get(task.id) !== task.status)) {
      throw integrityError(
        'PROGRESS_TASK_STATUS_MISMATCH',
        'Replayed task statuses do not match the bound plan revision.',
      );
    }
    previousStatuses = replayedStatuses;
  }
}

// 将每份历史证据摘要固化进事件链；最新 head 之外的旧文件改写也会因此失配。
function evidenceEventSummary(evidence, evidenceDigest) {
  return `Recorded evidence ${evidence.acceptance_criterion_id}/${evidence.evidence_id} sha256:${evidenceDigest} as ${evidence.state}`;
}

function evidenceCreationEventMatchesRecord(event, record) {
  return event.event_type === 'verification-result'
    && event.evidence_refs.length === 1
    && event.evidence_refs[0] === record.value.evidence_id
    && event.summary === evidenceEventSummary(record.value, record.digest)
    && event.recorded_at === record.value.recorded_at
    && event.plan_revision === record.value.validation_ref.plan_revision
    && event.task_id === record.value.task_id
    && event.goal.goal_id === record.value.validation_ref.goal_id
    && event.goal.goal_version === record.value.validation_ref.goal_version
    && event.goal.goal_digest === record.value.validation_ref.goal_digest;
}

function ordinaryEvidenceReferencesResolve(evidenceState, event) {
  if (event.evidence_refs.length === 0) return true;
  if (event.task_id === null) return false;
  // bare ID 只在事件的目标、计划和任务范围内解析；自动证据事件另由 qualified summary 消除歧义。
  return event.evidence_refs.every((evidenceId) => (
    (evidenceState.recordsById.get(evidenceId) ?? []).filter((record) => (
      record.value.validation_ref.goal_id === event.goal.goal_id
      && record.value.validation_ref.goal_version === event.goal.goal_version
      && record.value.validation_ref.goal_digest === event.goal.goal_digest
      && record.value.validation_ref.plan_revision === event.plan_revision
      && record.value.task_id === event.task_id
    )).length === 1
  ));
}

function plansByReference(planState) {
  const plans = new Map(planState.archives.map((archive) => [
    `${archive.value.goal.goal_version}/${archive.value.plan_revision}`,
    archive.value,
  ]));
  if (planState.current) {
    plans.set(
      `${planState.current.value.goal.goal_version}/${planState.current.value.plan_revision}`,
      planState.current.value,
    );
  }
  return plans;
}

async function verifyEvidenceState(reader, rootNames, lock, goalHistory, planState) {
  if (!rootNames.includes('evidence')) {
    if (Object.keys(lock.evidence_heads).length > 0) throw integrityError('EVIDENCE_STATE_MISSING', 'Lock evidence heads require evidence state.');
    return {
      count: 0,
      latestByCriterion: new Map(),
      publicLatest: {},
      records: [],
      recordsById: new Map(),
      recordsByCriterion: new Map(),
    };
  }
  const evidenceRoot = await reader.readDirectory('.goal-lock/evidence');
  if (evidenceRoot.names.length === 0) {
    throw integrityError('EVIDENCE_STATE_INVALID', 'Evidence state must not contain an empty root directory.');
  }
  const plans = plansByReference(planState);
  let count = 0;
  const records = [];
  const latestByCriterion = new Map();
  const recordsById = new Map();
  const recordsByCriterion = new Map();
  for (const criterion of evidenceRoot.names) {
    if (!/^AC-[0-9]{3}$/.test(criterion)) {
      throw integrityError('EVIDENCE_STATE_INVALID', 'Evidence state contains an unexpected criterion directory.');
    }
    const criterionDirectory = await reader.readDirectory(`.goal-lock/evidence/${criterion}`);
    const expectedNames = Array.from(
      { length: criterionDirectory.names.length },
      (_, index) => `EVID-${String(index + 1).padStart(4, '0')}.json`,
    );
    if (expectedNames.length === 0
      || criterionDirectory.names.some((name, index) => name !== expectedNames[index])) {
      throw integrityError(
        'EVIDENCE_SEQUENCE_INVALID',
        'Evidence IDs must be unique and contiguous from EVID-0001 within each criterion directory.',
      );
    }
    const criterionRecords = [];
    for (const [index, name] of criterionDirectory.names.entries()) {
      const record = await readCanonicalObject(reader, `.goal-lock/evidence/${criterion}/${name}`, 'evidence record');
      const evidenceId = name.slice(0, -5);
      const goalRecord = goalHistory.get(record.value.validation_ref?.goal_version);
      if (!goalRecord) {
        throw integrityError('EVIDENCE_GOAL_UNKNOWN', 'Evidence references an unknown goal version.');
      }
      let value;
      try {
        value = validateEvidence(record.value, {
          goal_id: goalRecord.goal.goal_id,
          goal_version: goalRecord.goal.goal_version,
          goal_digest: goalRecord.digest,
        });
      } catch (error) {
        throw repositoryIntegrity('EVIDENCE_STATE_INVALID', 'Evidence record violates the evidence contract.', error);
      }
      if (value.evidence_id !== evidenceId || value.acceptance_criterion_id !== criterion) {
        throw integrityError('EVIDENCE_PATH_MISMATCH', 'Evidence identifiers do not match their directory path.');
      }
      if (!goalRecord.goal.acceptance_criteria.some((candidate) => candidate.id === criterion)) {
        throw integrityError('EVIDENCE_CRITERION_UNKNOWN', 'Evidence references an unknown acceptance criterion.');
      }
      const plan = plans.get(`${value.validation_ref.goal_version}/${value.validation_ref.plan_revision}`);
      const task = plan?.tasks.find((candidate) => candidate.id === value.task_id);
      if (!task || !task.acceptance_criteria.includes(criterion)) {
        throw integrityError('EVIDENCE_TASK_UNKNOWN', 'Evidence task must exist in its bound plan and own the criterion.');
      }
      const expectedSupersedes = index === 0 ? null : `EVID-${String(index).padStart(4, '0')}`;
      if (value.supersedes !== expectedSupersedes) {
        throw integrityError('EVIDENCE_SUPERSESSION_INVALID', 'Evidence must supersede the immediately preceding record for its criterion.');
      }
      const source = criterionRecords.at(-1);
      if (value.derivation !== null) {
        // 派生记录只信任紧邻前驱的已验证字节，避免以自报 source 摘要把旧证据洗成当前证据。
        if (!source
          || !canonicalValuesEqual(value.derivation.source_validation_ref, source.value.validation_ref)
          || value.derivation.source_evidence_id !== source.value.evidence_id
          || value.derivation.source_evidence_digest !== source.digest) {
          throw integrityError('EVIDENCE_DERIVATION_INVALID', 'Evidence derivation must bind the immediately preceding verified record.');
        }
        const sourceReference = value.derivation.source_validation_ref;
        const sourcePlan = plans.get(`${sourceReference.goal_version}/${sourceReference.plan_revision}`);
        const targetPlan = plans.get(`${value.validation_ref.goal_version}/${value.validation_ref.plan_revision}`);
        const sourceTask = sourcePlan?.tasks.find((candidate) => candidate.id === source.value.task_id);
        const targetTask = targetPlan?.tasks.find((candidate) => candidate.id === value.task_id);
        const sourceValidation = sourceTask?.validations.find((candidate) => candidate.id === sourceReference.validation_id);
        const targetValidation = targetTask?.validations.find((candidate) => candidate.id === value.validation_ref.validation_id);
        if (value.validation_ref.goal_version !== sourceReference.goal_version + 1) {
          throw integrityError('EVIDENCE_DERIVATION_INVALID', 'Evidence derivation must cross exactly one adjacent goal version.');
        }
        if (value.derivation.kind === 'carry-forward') {
          const sourceGoal = goalHistory.get(sourceReference.goal_version)?.goal;
          const targetGoal = goalHistory.get(value.validation_ref.goal_version)?.goal;
          const sourceCriterion = sourceGoal?.acceptance_criteria.find((candidate) => candidate.id === criterion);
          const targetCriterion = targetGoal?.acceptance_criteria.find((candidate) => candidate.id === criterion);
          if (!sourceTask
            || !targetTask
            || !sourceValidation
            || !targetValidation
            || value.state !== source.value.state
            || !canonicalValuesEqual(sourceCriterion, targetCriterion)
            || !canonicalValuesEqual(sourceTask, targetTask)
            || !canonicalValuesEqual(sourceValidation, targetValidation)) {
            throw integrityError('EVIDENCE_DERIVATION_INVALID', 'Carry-forward requires byte-identical adjacent criterion, task, and validation definitions.');
          }
        }
      }
      const normalizedRecord = {
        ...record,
        value,
        target: `.goal-lock/evidence/${criterion}/${name}`,
      };
      criterionRecords.push(normalizedRecord);
      records.push(normalizedRecord);
      const idRecords = recordsById.get(evidenceId) ?? [];
      idRecords.push(normalizedRecord);
      recordsById.set(evidenceId, idRecords);
      count += 1;
    }
    recordsByCriterion.set(criterion, criterionRecords);
    latestByCriterion.set(criterion, criterionRecords.at(-1));
  }
  const headCriteria = Object.keys(lock.evidence_heads).sort();
  if (headCriteria.length !== evidenceRoot.names.length
    || headCriteria.some((criterion, index) => criterion !== evidenceRoot.names[index])) {
    throw integrityError('EVIDENCE_HEAD_MISMATCH', 'Lock evidence heads must cover exactly the evidence criterion directories.');
  }
  const publicLatest = {};
  for (const criterion of evidenceRoot.names) {
    const latest = latestByCriterion.get(criterion);
    const head = lock.evidence_heads[criterion];
    if (head.evidence_id !== latest.value.evidence_id || head.digest !== latest.digest) {
      throw integrityError('EVIDENCE_HEAD_MISMATCH', 'Lock evidence head does not match its evidence record.');
    }
    publicLatest[criterion] = { ...latest.value, digest: latest.digest };
  }
  return { count, latestByCriterion, publicLatest, records, recordsById, recordsByCriterion };
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

async function readScopeBaseline(reader, initialGoal, lock) {
  const input = await reader.readFile('.goal-lock/scope.json');
  try {
    const scope = verifyScopeBaseline(
      parseCanonicalJson(input.bytes, 'goal scope baseline'),
      {
        goal_id: initialGoal.goal.goal_id,
        goal_version: 1,
        goal_digest: initialGoal.digest,
      },
    );
    // scope.json 的首版字节只由 lock.scope_head 绑定，后续版本不得重新捕获或改写它。
    if (input.digest !== lock.scope_head.digest) {
      throw integrityError('SCOPE_HEAD_MISMATCH', 'Goal lock scope head does not match the immutable scope baseline.');
    }
    return { ...input, scope };
  } catch (error) {
    throw repositoryIntegrity('SCOPE_BASELINE_INVALID', 'Goal scope baseline is malformed, noncanonical, or does not match the lock head.', error);
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
  const goals = new Map();
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
    predecessor = { bytes: input.bytes, digest: input.digest, goal };
    goals.set(version, predecessor);
    activeHistory = input;
  }

  if (!activeHistory.bytes.equals(current.bytes)) {
    throw integrityError('CURRENT_HISTORY_MISMATCH', 'Current goal bytes do not match active goal history.');
  }
  return { activeHistory: predecessor, goals };
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

function verificationEvidence(reader, current, optional, issues = [], latest = {}) {
  return {
    goal: current ? {
      goal_id: current.goal.goal_id,
      goal_version: current.goal.goal_version,
      goal_digest: current.digest,
    } : null,
    inputs: reader?.inputs() ?? [],
    optional,
    latest,
    issues,
  };
}

/** 验证完整目标仓库及其不可变范围基线；只读调用返回篡改证据，写调用则在同一完整性失败上立即关闭。 */
export async function verifyGoalRepository(root, context = {}) {
  let reader;
  let current = null;
  try {
    reader = await createWorkspaceReader(root, context);
    const goalLockDirectory = await reader.readDirectory('.goal-lock');
    const writerPresent = goalLockDirectory.names.includes('.write-lock.json');
    if (writerPresent !== (context[ACTIVE_WRITE] === true)) {
      throw integrityError('GOAL_REPOSITORY_INVALID', 'Goal repository contains an unexpected cooperative writer.');
    }
    const rootNames = goalLockDirectory.names.filter((name) => name !== '.write-lock.json');
    const allowedNames = new Set(['current.json', 'lock.json', 'scope.json', 'plan.json', 'progress.jsonl', 'changes', 'history', 'evidence']);
    if (rootNames.some((name) => !allowedNames.has(name)) || !rootNames.includes('current.json')) {
      throw integrityError('GOAL_REPOSITORY_INVALID', 'Goal repository contains missing or unexpected root state.');
    }
    current = await readCurrentGoal(reader);

    if (!rootNames.includes('lock.json')) {
      if (rootNames.length !== 1 || current.goal.goal_version !== 1) {
        throw integrityError('GOAL_LOCK_MISSING', 'Only a pristine version-one draft may omit the goal lock.');
      }
      await reader.verifyInputs();
      const result = { state: 'DRAFT', scope: null, evidence: verificationEvidence(reader, current, { plan: false, changes: 0, progress_events: 0, evidence_records: 0 }) };
      return context[RETURN_VERIFIED_SNAPSHOT] === true
        ? { result, reader, current, rootNames, lockInput: null, planState: null, history: null, scope: null }
        : result;
    }

    const lockInput = await readLock(reader);
    const history = await verifyGoalHistory(reader, current, lockInput.lock);
    const scope = await readScopeBaseline(reader, history.goals.get(1), lockInput.lock);
    const changeState = await verifyChangeState(reader, rootNames, lockInput.lock, current, history.goals);
    verifyHistoricalChangeBindings(history.goals, changeState);
    const planState = await verifyPlanState(reader, rootNames, current, history.goals);
    verifyChangeReferences(changeState, planState);
    const evidenceState = await verifyEvidenceState(
      reader,
      rootNames,
      lockInput.lock,
      history.goals,
      planState,
    );
    const authorizationGraph = repositoryAuthorizationGraph(history, planState, evidenceState, changeState);
    const workspaceManifest = await captureWorkspaceManifest(
      root,
      scope.scope.mode === 'inventory' ? scope.scope.entries.map((entry) => entry.path) : null,
      context,
    );
    const scopeBlockers = authorizationGraph
      ? deriveScopeBlockers(authorizationGraph, computeWorkspaceDelta(scope.scope.entries, workspaceManifest.entries).paths)
      : [];
    const progressState = await verifyProgressLedger(
      reader,
      rootNames,
      lockInput.lock,
      history.goals,
      planState,
      evidenceState,
      changeState,
    );
    if (authorizationGraph) assertEvidenceReplayAuthorized(authorizationGraph, evidenceState, progressState);
    verifyLockBindings(current, lockInput.lock, history.activeHistory, changeState);
    await reader.verifyInputs();
    const optional = {
      plan: planState.present,
      changes: changeState.count,
      progress_events: progressState.count,
      evidence_records: evidenceState.count,
    };
    const result = {
      state: changeState.pending ? 'CHANGE_PENDING' : 'LOCKED',
      scope: scope.scope,
      authorization_graph_digest: authorizationGraph?.digest ?? null,
      cumulative_permitted_paths: authorizationGraph?.cumulative_permitted_paths ?? [],
      scope_blockers: scopeBlockers,
      evidence: verificationEvidence(reader, current, optional, [], evidenceState.publicLatest),
    };
    return context[RETURN_VERIFIED_SNAPSHOT] === true
      ? { result, reader, current, rootNames, lockInput, planState, progressState, evidenceState, changeState, history, scope, authorizationGraph }
      : result;
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
      }], { ...context, ...ownership });
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

/** 仅在精确批准后，将版本一范围基线、历史与锁作为同一原子提交安装。 */
export async function lockInitialGoal(root, approval, context = {}) {
  return withGoalLock(root, 'lock', async (ownership) => {
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

    const approvedAt = (context.now ?? (() => new Date().toISOString()))();
    const goalReference = {
      goal_id: current.goal.goal_id,
      goal_version: 1,
      goal_digest: current.digest,
    };
    const manifest = await captureWorkspaceManifest(root, context.inventory ?? null, context);
    const scopeBytes = canonicalBytes(createScopeBaseline(goalReference, manifest, approvedAt));
    const scopeHead = { scope_version: 1, digest: sha256(scopeBytes) };
    const record = {
      schema_version: 2,
      goal_id: current.goal.goal_id,
      goal_version: 1,
      goal_digest: current.digest,
      approval_type: 'explicit-version-1',
      proposal_digest: current.digest,
      approved_at: approvedAt,
      predecessor_digest: null,
      state_revision: 1,
      scope_head: scopeHead,
      progress_head: null,
      change_head: null,
      evidence_heads: {},
    };
    const lock = { ...record, record_digest: sha256(canonicalBytes(record)) };
    validateLockRecord(lock);
    await commitGoalFiles(root, [
      { target: '.goal-lock/current.json', expected: { kind: 'sha256', digest: current.digest }, content: current.bytes },
      { target: '.goal-lock/history/goals/v0001.json', expected: { kind: 'absent' }, content: current.bytes },
      { target: '.goal-lock/scope.json', expected: { kind: 'absent' }, content: scopeBytes },
      { target: '.goal-lock/lock.json', expected: { kind: 'absent' }, content: canonicalBytes(lock) },
    ], { ...context, ...ownership });
    return {
      state: 'LOCKED',
      goal_id: current.goal.goal_id,
      goal_version: 1,
      goal_digest: current.digest,
      scope_digest: scopeHead.digest,
    };
  }, context);
}

function validatePlanCandidate(candidate) {
  if (candidate === null
    || typeof candidate !== 'object'
    || Array.isArray(candidate)
    || (Object.getPrototypeOf(candidate) !== Object.prototype && Object.getPrototypeOf(candidate) !== null)) {
    throw inputError('INVALID_PLAN_INPUT', 'Plan candidate must be an object.');
  }
  const fields = ['next_task_id', 'tasks', 'risks', 'deferred'];
  const keys = Object.keys(candidate);
  if (keys.length !== fields.length || fields.some((field) => !Object.hasOwn(candidate, field))) {
    throw inputError('INVALID_PLAN_INPUT', 'Plan candidate must contain exactly next_task_id, tasks, risks, and deferred.');
  }
  return candidate;
}

function validateChangeProposalInput(input) {
  if (input === null
    || typeof input !== 'object'
    || Array.isArray(input)
    || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) {
    throw inputError('INVALID_CHANGE_INPUT', 'Change proposal input must be an object.');
  }
  const fields = ['candidate', 'changes', 'rationale', 'affected_tasks', 'criterion_impact', 'risks', 'validation', 'rollback'];
  const keys = Object.keys(input);
  if (keys.length !== fields.length || fields.some((field) => !Object.hasOwn(input, field))) {
    throw inputError('INVALID_CHANGE_INPUT', 'Change proposal input contains missing or derived fields.');
  }
  if (input.candidate === null
    || typeof input.candidate !== 'object'
    || Array.isArray(input.candidate)
    || (Object.getPrototypeOf(input.candidate) !== Object.prototype && Object.getPrototypeOf(input.candidate) !== null)) {
    throw inputError('INVALID_CHANGE_INPUT', 'Change candidate must be an object.');
  }
  const candidateKeys = Object.keys(input.candidate);
  if (candidateKeys.length !== GOAL_SEMANTIC_FIELDS.length
    || GOAL_SEMANTIC_FIELDS.some((field) => !Object.hasOwn(input.candidate, field))) {
    throw inputError('INVALID_CHANGE_INPUT', 'Change candidate must contain only semantic goal fields.');
  }
  return input;
}

function proposalPayload(changeRequest) {
  const {
    status: _status,
    proposal_digest: _proposalDigest,
    approval_phrase: _approvalPhrase,
    ...payload
  } = changeRequest;
  return payload;
}

function nextLockForChange(lockInput, changeRequestId, changeDigest) {
  const { record_digest: _recordDigest, ...withoutDigest } = lockInput.lock;
  const nextWithoutDigest = {
    ...withoutDigest,
    state_revision: lockInput.lock.state_revision + 1,
    change_head: { change_request_id: changeRequestId, digest: changeDigest },
  };
  return validateLockRecord({
    ...nextWithoutDigest,
    record_digest: sha256(canonicalBytes(nextWithoutDigest)),
  });
}

function verifiedChangeMutationEntries(snapshot, mutableChangeRequestId = null) {
  const entries = verifiedHistoryEntries(snapshot.current, snapshot.history, snapshot.planState);
  if (snapshot.planState.current) {
    entries.push({
      target: '.goal-lock/plan.json',
      expected: { kind: 'sha256', digest: snapshot.planState.current.digest },
      content: snapshot.planState.current.bytes,
    });
  }
  if (snapshot.progressState.input) {
    entries.push({
      target: '.goal-lock/progress.jsonl',
      expected: { kind: 'sha256', digest: snapshot.progressState.input.digest },
      content: snapshot.progressState.input.bytes,
    });
  }
  for (const record of snapshot.changeState.records.values()) {
    if (record.value.id === mutableChangeRequestId) continue;
    entries.push({
      target: record.target,
      expected: { kind: 'sha256', digest: record.digest },
      content: record.bytes,
    });
  }
  entries.push(...verifiedEvidenceEntries(snapshot.evidenceState));
  return entries;
}

function validateChangeRejectionInput(changeRequestId, reason) {
  if (typeof changeRequestId !== 'string' || !/^CR-[0-9]{4}$/.test(changeRequestId)) {
    throw inputError('INVALID_CHANGE_ID', 'Change rejection requires an exact CR-NNNN identifier.');
  }
  if (typeof reason !== 'string' || reason.length === 0 || reason.trim() !== reason || reason.length > 500) {
    throw inputError('INVALID_REJECTION_REASON', 'Change rejection reason must be non-empty trimmed text of at most 500 characters.');
  }
}

function assertChangeReferencesExist(input, planState) {
  const taskIds = new Set(planState.current?.value.tasks.map((task) => task.id) ?? []);
  if (input.affected_tasks.some((taskId) => !taskIds.has(taskId))) {
    throw inputError('INVALID_CHANGE_REFERENCE', 'Affected tasks must exist in the current plan.');
  }
}

function hasStaleChangeBase(planState, evidenceState) {
  return (planState.current?.value.tasks.some((task) => task.status === 'stale') ?? false)
    || [...evidenceState.latestByCriterion.values()].some((record) => record.value.state === 'stale');
}

function validateGoalEventInput(input) {
  if (input === null
    || typeof input !== 'object'
    || Array.isArray(input)
    || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) {
    throw inputError('INVALID_EVENT_INPUT', 'Goal event input must be an object.');
  }
  const fields = input.kind === 'evidence'
    ? ['kind', 'acceptance_criterion_id', 'validation_ref', 'task_id', 'observed_result', 'artifact_refs', 'inventory', 'state', 'failure_paths', 'supersedes']
    : input.kind === 'final-audit'
      ? ['kind', 'semantic_summary', 'inventory']
      : ['kind', 'event_type', 'task_id', 'summary', 'evidence_refs'];
  const keys = Object.keys(input);
  if (keys.length !== fields.length || fields.some((field) => !Object.hasOwn(input, field))) {
    throw inputError('INVALID_EVENT_INPUT', `Goal ${input.kind === 'evidence' ? 'evidence' : 'progress'} input contains missing or derived fields.`);
  }
  if (!['evidence', 'progress', 'final-audit'].includes(input.kind)) {
    throw inputError('INVALID_EVENT_INPUT', 'Goal event kind must equal evidence, progress, or final-audit.');
  }
  if (input.kind === 'final-audit'
    && (typeof input.semantic_summary !== 'string'
      || input.semantic_summary.length === 0
      || input.semantic_summary.trim() !== input.semantic_summary)) {
    throw inputError('INVALID_EVENT_INPUT', 'Final audit semantic_summary must be non-empty normalized text.');
  }
  if (input.kind === 'progress' && ['plan-revision', 'final-audit'].includes(input.event_type)) {
    // final-audit 与 plan-revision 都携带派生权威状态，只能由各自受控事务构造。
    throw inputError('INVALID_EVENT_INPUT', 'Derived lifecycle events are owned by their repository mutations.');
  }
  return input;
}

function buildProgressEvent(progressState, goalReference, planRevision, input, context, recordedAt) {
  const eventId = `EVT-${String(progressState.count + 1).padStart(6, '0')}`;
  const withoutDigest = {
    schema_version: 2,
    event_id: eventId,
    recorded_at: recordedAt ?? (context.now ?? (() => new Date().toISOString()))(),
    goal: goalReference,
    plan_revision: planRevision,
    task_id: input.task_id,
    event_type: input.event_type,
    summary: input.summary,
    evidence_refs: input.evidence_refs,
    previous_event_digest: progressState.terminal?.event_digest ?? null,
  };
  // 摘要载荷含前链指针，事件摘要字段本身不参与计算。
  let eventDigest;
  try {
    eventDigest = sha256(canonicalBytes(withoutDigest));
  } catch {
    throw inputError('INVALID_EVENT_INPUT', 'Progress event input must contain only canonical JSON values.');
  }
  const event = { ...withoutDigest, event_digest: eventDigest };
  return validateProgressEvent(event, withoutDigest.previous_event_digest);
}

function appendProgressEntry(progressState, event) {
  const priorBytes = progressState.input?.bytes ?? Buffer.alloc(0);
  const nextBytes = Buffer.concat([priorBytes, canonicalBytes(event)]);
  // 全文件替换仍须逐字节保留已验证账本前缀，并绑定此前文件的精确摘要所有权。
  if (!nextBytes.subarray(0, priorBytes.length).equals(priorBytes)) {
    throw integrityError('PROGRESS_PREFIX_MISMATCH', 'Progress ledger replacement did not preserve the verified prefix.');
  }
  return {
    target: '.goal-lock/progress.jsonl',
    expected: progressState.input
      ? { kind: 'sha256', digest: progressState.input.digest }
      : { kind: 'absent' },
    content: nextBytes,
  };
}

function appendProgressEvents(progressState, events) {
  const priorBytes = progressState.input?.bytes ?? Buffer.alloc(0);
  const content = Buffer.concat([priorBytes, ...events.map((event) => canonicalBytes(event))]);
  // 批量事件仍以已验证账本为不可变前缀，批准事务只能在尾部一次性追加其全部派生事件。
  if (!content.subarray(0, priorBytes.length).equals(priorBytes)) {
    throw integrityError('PROGRESS_PREFIX_MISMATCH', 'Progress ledger replacement did not preserve the verified prefix.');
  }
  return {
    target: '.goal-lock/progress.jsonl',
    expected: progressState.input
      ? { kind: 'sha256', digest: progressState.input.digest }
      : { kind: 'absent' },
    content,
  };
}

async function fingerprintAcrossRepositoryRevalidation(root, inventory, reader, context) {
  const before = await workspaceFingerprint(root, inventory, context);
  await reader.verifyInputs();
  const after = await workspaceFingerprint(root, inventory, context);
  // 仓库复验位于两次完整指纹之间，任一侧的 delivery 或 goal 输入变化都不能被签发为同一审计快照。
  if (before !== after) {
    throw integrityError('WORKSPACE_INPUT_CHANGED', 'Workspace inputs changed across repository revalidation.');
  }
  return after;
}

async function authorizedWorkspaceFingerprint(root, inventory, reader, scope, graph, context) {
  const before = await captureWorkspaceManifest(root, inventory ?? null, context);
  await reader.verifyInputs();
  const after = await captureWorkspaceManifest(root, inventory ?? null, context);
  if (before.manifest_digest !== after.manifest_digest) {
    throw integrityError('WORKSPACE_INPUT_CHANGED', 'Workspace inputs changed across authorization revalidation.');
  }
  const blockers = deriveScopeBlockers(graph, computeWorkspaceDelta(scope.entries, after.entries).paths);
  if (blockers.length > 0) {
    throw stateError('WORKSPACE_SCOPE_UNAUTHORIZED', `Workspace delta includes unauthorized path ${blockers[0].path}.`);
  }
  return workspaceFingerprintFromManifest(after);
}

function nextLockForEvent(lockInput, event) {
  const { record_digest: _recordDigest, ...withoutDigest } = lockInput.lock;
  const nextWithoutDigest = {
    ...withoutDigest,
    state_revision: lockInput.lock.state_revision + 1,
    progress_head: { event_id: event.event_id, digest: event.event_digest },
  };
  return validateLockRecord({
    ...nextWithoutDigest,
    record_digest: sha256(canonicalBytes(nextWithoutDigest)),
  });
}

function planRevisionSummary(goalVersion, planRevision, planDigest, previousDigest) {
  return `Recorded plan v${String(goalVersion).padStart(4, '0')}/r${String(planRevision).padStart(4, '0')} sha256:${planDigest} previous:${previousDigest ?? 'none'}`;
}

function nextLockForEvidence(lockInput, event, evidence, evidenceDigest) {
  const { record_digest: _recordDigest, ...withoutDigest } = lockInput.lock;
  const nextWithoutDigest = {
    ...withoutDigest,
    state_revision: lockInput.lock.state_revision + 1,
    progress_head: { event_id: event.event_id, digest: event.event_digest },
    evidence_heads: {
      ...lockInput.lock.evidence_heads,
      [evidence.acceptance_criterion_id]: {
        evidence_id: evidence.evidence_id,
        digest: evidenceDigest,
      },
    },
  };
  // 两个 head 与一次 revision 共享同一摘要载荷，避免任何一个索引单独成为已接受状态。
  return validateLockRecord({
    ...nextWithoutDigest,
    record_digest: sha256(canonicalBytes(nextWithoutDigest)),
  });
}

function verifiedHistoryEntries(current, history, planState) {
  const entries = [{
    target: '.goal-lock/current.json',
    expected: { kind: 'sha256', digest: current.digest },
    content: current.bytes,
  }];
  for (const [goalVersion, goalRecord] of history.goals) {
    entries.push({
      target: `.goal-lock/history/goals/v${String(goalVersion).padStart(4, '0')}.json`,
      expected: { kind: 'sha256', digest: goalRecord.digest },
      content: goalRecord.bytes,
    });
  }
  for (const archive of planState.archives) {
    entries.push({
      target: archive.target,
      expected: { kind: 'sha256', digest: archive.digest },
      content: archive.bytes,
    });
  }
  return entries;
}

function verifiedEvidenceEntries(evidenceState) {
  // 历史证据只作为精确字节所有权输入参与提交，supersession 永不覆盖或重编码旧文件。
  return evidenceState.records.map((record) => ({
    target: record.target,
    expected: { kind: 'sha256', digest: record.digest },
    content: record.bytes,
  }));
}

function nextExecutableTaskId(tasks, currentNextTaskId) {
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const executable = tasks.filter((task) => ['pending', 'in_progress'].includes(task.status)
    && task.dependencies.every((dependencyId) => tasksById.get(dependencyId).status === 'complete'));
  if (executable.some((task) => task.id === currentNextTaskId)) return currentNextTaskId;
  return executable[0]?.id ?? null;
}

function planAfterTaskEvent(plan, eventType, taskId, goal) {
  const transition = TASK_STATUS_TRANSITIONS[eventType];
  if (!transition) return plan;
  const task = plan.tasks.find((candidate) => candidate.id === taskId);
  if (task.status !== transition.from) {
    throw stateError('TASK_STATUS_REJECTED', `${eventType} requires task ${taskId} to be ${transition.from}.`);
  }
  // 任务状态写入当前计划供恢复使用；同 revision 的摘要链保留不可变审计历史。
  const tasks = plan.tasks.map((candidate) => candidate.id === taskId
    ? { ...candidate, status: transition.to }
    : candidate);
  const updated = validatePlan({
    ...plan,
    tasks,
    next_task_id: nextExecutableTaskId(tasks, plan.next_task_id),
  }, plan.goal);
  return validatePlanCriteria(updated, goal);
}

function validatePlanStatusOwnership(plan, priorPlan) {
  const priorStatuses = new Map((priorPlan?.tasks ?? []).map((task) => [task.id, task.status]));
  // 计划修订只描述工作结构；共享任务状态由上一 revision 继承，新任务只能从 pending 开始。
  for (const task of plan.tasks) {
    const expectedStatus = priorStatuses.get(task.id) ?? 'pending';
    if (task.status !== expectedStatus) {
      throw inputError(
        'INVALID_PLAN_STATUS',
        `Plan task ${task.id} must preserve status ${expectedStatus}.`,
      );
    }
  }
  return plan;
}

export async function revisePlan(root, candidate, classification, context = {}) {
  if (!['aligned', 'implementation-only'].includes(classification)) {
    throw inputError('INVALID_CLASSIFICATION', 'Plan classification must be aligned or implementation-only.');
  }
  validatePlanCandidate(candidate);

  return withGoalLock(root, 'plan', async (ownership) => {
    const snapshot = await verifyGoalRepository(root, {
      ...context,
      mutating: true,
      [ACTIVE_WRITE]: true,
      [RETURN_VERIFIED_SNAPSHOT]: true,
    });
    const verification = snapshot.result;
    if (verification.state !== 'LOCKED') {
      throw stateError('PLAN_STATE_REJECTED', `Planning requires LOCKED state, not ${verification.state}.`);
    }

    // 事务预条件必须复用同一验证快照，不能用第二次读取覆盖已信任的基线。
    const { reader, current, lockInput, planState, progressState, evidenceState, changeState, history } = snapshot;
    const priorPlan = planState.current;
    const planRevision = priorPlan ? priorPlan.value.plan_revision + 1 : 1;
    const goalReference = {
      goal_id: current.goal.goal_id,
      goal_version: current.goal.goal_version,
      goal_digest: current.digest,
    };
    const plan = validatePlanStatusOwnership(validatePlanCriteria(validatePlan({
      schema_version: 2,
      goal: goalReference,
      plan_revision: planRevision,
      next_task_id: candidate.next_task_id,
      tasks: candidate.tasks,
      risks: candidate.risks,
      deferred: candidate.deferred,
    }, goalReference), current.goal), priorPlan?.value ?? null);
    try {
      repositoryAuthorizationGraph(history, planState, evidenceState, changeState, plan);
    } catch (error) {
      throw inputError('INVALID_PLAN_AUTHORIZATION', `Plan candidate violates the authorization graph: ${error.message}`);
    }
    const planBytes = canonicalBytes(plan);
    const planDigest = sha256(planBytes);
    const event = buildProgressEvent(progressState, goalReference, planRevision, {
      event_type: 'plan-revision',
      task_id: null,
      summary: planRevisionSummary(current.goal.goal_version, planRevision, planDigest, priorPlan?.digest ?? null),
      evidence_refs: [],
    }, context);

    const entries = verifiedHistoryEntries(current, history, planState);
    if (priorPlan) {
      const archiveTarget = `.goal-lock/history/plans/v${String(current.goal.goal_version).padStart(4, '0')}-r${String(priorPlan.value.plan_revision).padStart(4, '0')}.json`;
      // 当前计划的原始字节只转移到尚不存在的版本化名称，既不重编码也不覆盖历史。
      entries.push({ target: archiveTarget, expected: { kind: 'absent' }, content: priorPlan.bytes });
      entries.push({ target: '.goal-lock/plan.json', expected: { kind: 'sha256', digest: priorPlan.digest }, content: planBytes });
    } else {
      entries.push({ target: '.goal-lock/plan.json', expected: { kind: 'absent' }, content: planBytes });
    }

    entries.push(appendProgressEntry(progressState, event));
    const nextLock = nextLockForEvent(lockInput, event);
    // 新计划、自动生命周期事件与完整性索引只共同推进一次状态 revision。
    entries.push({
      target: '.goal-lock/lock.json',
      expected: { kind: 'sha256', digest: lockInput.digest },
      content: canonicalBytes(nextLock),
    });
    await reader.verifyInputs();
    await commitGoalFiles(root, entries, { ...context, ...ownership });
    return {
      state: 'LOCKED',
      goal_id: current.goal.goal_id,
      goal_version: current.goal.goal_version,
      goal_digest: current.digest,
      plan_revision: planRevision,
      classification,
    };
  }, context);
}

/** 记录一个派生封装的进度事件，并原子更新任务状态、账本和锁索引。 */
export async function recordGoalEvent(root, input, context = {}) {
  validateGoalEventInput(input);
  return withGoalLock(root, 'record', async (ownership) => {
    const snapshot = await verifyGoalRepository(root, {
      ...context,
      mutating: true,
      [ACTIVE_WRITE]: true,
      [RETURN_VERIFIED_SNAPSHOT]: true,
    });
    if (snapshot.result.state !== 'LOCKED') {
      throw stateError('EVENT_STATE_REJECTED', `Progress recording requires LOCKED state, not ${snapshot.result.state}.`);
    }
    const {
      reader,
      current,
      lockInput,
      planState,
      progressState,
      evidenceState,
      history,
    } = snapshot;
    if (!planState.current) throw stateError('EVENT_PLAN_REQUIRED', 'Progress recording requires a current plan.');

    const plan = planState.current.value;
    const goalReference = {
      goal_id: current.goal.goal_id,
      goal_version: current.goal.goal_version,
      goal_digest: current.digest,
    };
    if (input.kind === 'final-audit') {
      const fingerprint = await fingerprintAcrossRepositoryRevalidation(
        root,
        input.inventory,
        reader,
        context,
      );
      const event = buildProgressEvent(progressState, goalReference, plan.plan_revision, {
        event_type: 'final-audit',
        task_id: null,
        summary: `Final audit sha256:${fingerprint}: ${input.semantic_summary}`,
        evidence_refs: [],
      }, context);
      const entries = verifiedHistoryEntries(current, history, planState);
      entries.push({
        target: '.goal-lock/plan.json',
        expected: { kind: 'sha256', digest: planState.current.digest },
        content: planState.current.bytes,
      });
      entries.push(appendProgressEntry(progressState, event));
      entries.push({
        target: '.goal-lock/lock.json',
        expected: { kind: 'sha256', digest: lockInput.digest },
        content: canonicalBytes(nextLockForEvent(lockInput, event)),
      });
      // 已夹持复验的指纹与 progress head 同事务安装，调用方无法注入可信摘要。
      await commitGoalFiles(root, entries, { ...context, ...ownership });
      return {
        state: 'LOCKED',
        event_id: event.event_id,
        event_digest: event.event_digest,
        event_type: event.event_type,
        workspace_fingerprint: fingerprint,
        goal_id: current.goal.goal_id,
        goal_version: current.goal.goal_version,
        goal_digest: current.digest,
        plan_revision: plan.plan_revision,
      };
    }
    if (input.kind === 'evidence') {
      const fingerprint = await authorizedWorkspaceFingerprint(
        root,
        input.inventory,
        reader,
        snapshot.scope.scope,
        snapshot.authorizationGraph,
        context,
      );
      let validation;
      try {
        validation = resolveValidationRef(snapshot.authorizationGraph, input.validation_ref);
      } catch (error) {
        throw inputError('INVALID_EVIDENCE_REFERENCE', `Evidence validation reference is not authorized: ${error.message}`);
      }
      const priorRecords = evidenceState.recordsByCriterion.get(input.acceptance_criterion_id) ?? [];
      const preceding = priorRecords.at(-1)?.value.evidence_id ?? null;
      if (input.supersedes !== preceding) {
        throw inputError(
          'INVALID_EVIDENCE_SUPERSESSION',
          'Evidence supersedes must equal the immediately preceding latest evidence ID.',
        );
      }
      if (priorRecords.length >= 9999) {
        throw stateError('EVIDENCE_SEQUENCE_EXHAUSTED', 'Evidence sequence exhausted its four-digit identifier space.');
      }
      const evidenceId = `EVID-${String(priorRecords.length + 1).padStart(4, '0')}`;
      const recordedAt = (context.now ?? (() => new Date().toISOString()))();
      const evidence = validateEvidence({
        schema_version: 2,
        evidence_id: evidenceId,
        acceptance_criterion_id: input.acceptance_criterion_id,
        validation_ref: validation.validation_ref,
        task_id: input.task_id,
        observed_result: input.observed_result,
        artifact_refs: input.artifact_refs,
        workspace_fingerprint: fingerprint,
        state: input.state,
        failure_paths: input.failure_paths,
        supersedes: input.supersedes,
        derivation: null,
        recorded_at: recordedAt,
      }, goalReference);
      try {
        assertEvidenceAuthorized(snapshot.authorizationGraph, evidence, { mode: 'write' });
      } catch (error) {
        throw inputError('INVALID_EVIDENCE_AUTHORIZATION', `Evidence does not satisfy authorization: ${error.message}`);
      }
      const evidenceBytes = canonicalBytes(evidence);
      const evidenceDigest = sha256(evidenceBytes);
      const event = buildProgressEvent(progressState, goalReference, plan.plan_revision, {
        event_type: 'verification-result',
        task_id: validation.task_id,
        summary: evidenceEventSummary(evidence, evidenceDigest),
        evidence_refs: [evidenceId],
      }, context, recordedAt);
      const nextLock = nextLockForEvidence(lockInput, event, evidence, evidenceDigest);
      const entries = verifiedHistoryEntries(current, history, planState);
      entries.push({
        target: '.goal-lock/plan.json',
        expected: { kind: 'sha256', digest: planState.current.digest },
        content: planState.current.bytes,
      });
      entries.push(...verifiedEvidenceEntries(evidenceState));
      entries.push({
        target: `.goal-lock/evidence/${evidence.acceptance_criterion_id}/${evidenceId}.json`,
        expected: { kind: 'absent' },
        content: evidenceBytes,
      });
      entries.push(appendProgressEntry(progressState, event));
      entries.push({
        target: '.goal-lock/lock.json',
        expected: { kind: 'sha256', digest: lockInput.digest },
        content: canonicalBytes(nextLock),
      });
      // 新证据、关联事件和两个 head 在一次最终复验后共同提交，失败时整体回滚。
      await reader.verifyInputs();
      await commitGoalFiles(root, entries, { ...context, ...ownership });
      return {
        state: 'LOCKED',
        evidence_id: evidenceId,
        evidence_digest: evidenceDigest,
        acceptance_criterion_id: evidence.acceptance_criterion_id,
        event_id: event.event_id,
        event_digest: event.event_digest,
        goal_id: current.goal.goal_id,
        goal_version: current.goal.goal_version,
        plan_revision: evidence.validation_ref.plan_revision,
        task_id: validation.task_id,
      };
    }
    const event = buildProgressEvent(progressState, goalReference, plan.plan_revision, input, context);
    if (event.task_id !== null && !plan.tasks.some((task) => task.id === event.task_id)) {
      throw inputError('INVALID_EVENT_REFERENCE', 'Progress event task_id must reference the current plan.');
    }
    if (!ordinaryEvidenceReferencesResolve(evidenceState, event)) {
      throw inputError(
        'INVALID_EVENT_REFERENCE',
        'Progress event evidence_refs must resolve uniquely within the current goal, plan, and task.',
      );
    }
    const updatedPlan = planAfterTaskEvent(plan, event.event_type, event.task_id, current.goal);
    const updatedPlanBytes = canonicalBytes(updatedPlan);
    const nextLock = nextLockForEvent(lockInput, event);

    // 当前计划、账本和锁共享同一读者快照与一次提交，任一安装失败都会整体回滚。
    const entries = verifiedHistoryEntries(current, history, planState);
    entries.push({
      target: '.goal-lock/plan.json',
      expected: { kind: 'sha256', digest: planState.current.digest },
      content: updatedPlanBytes,
    });
    entries.push(appendProgressEntry(progressState, event));
    entries.push({
      target: '.goal-lock/lock.json',
      expected: { kind: 'sha256', digest: lockInput.digest },
      content: canonicalBytes(nextLock),
    });
    await reader.verifyInputs();
    await commitGoalFiles(root, entries, { ...context, ...ownership });
    return {
      state: 'LOCKED',
      event_id: event.event_id,
      event_digest: event.event_digest,
      event_type: event.event_type,
      goal_id: current.goal.goal_id,
      goal_version: current.goal.goal_version,
      plan_revision: plan.plan_revision,
      task_id: event.task_id,
    };
  }, context);
}

const COMPLETION_CONDITIONS = Object.freeze([
  'active_goal',
  'change_requests',
  'evidence',
  'final_audit',
  'plan',
  'progress_ledger',
  'tasks',
  'workspace_fingerprint',
].sort());

function completionChecklist(results) {
  return COMPLETION_CONDITIONS.map((condition) => ({
    condition,
    passed: results[condition] === true,
  }));
}

function failedRepositoryCondition(code) {
  if (code.startsWith('PLAN_')) return 'plan';
  if (code.startsWith('PROGRESS_')) return 'progress_ledger';
  if (code.startsWith('EVIDENCE_')) return 'evidence';
  if (code.startsWith('CHANGE_')) return 'change_requests';
  return 'active_goal';
}

function auditedFingerprint(event) {
  if (event?.event_type !== 'final-audit') return null;
  const match = /^Final audit sha256:([a-f0-9]{64}): .+$/s.exec(event.summary);
  return match?.[1] ?? null;
}

/** 仅证明当前 goal 状态、证据和语义审计满足门禁，不扩张为代码正确性或不可逆完成声明。 */
export async function gateGoalCompletion(root, inventory, context = {}) {
  const results = Object.fromEntries(COMPLETION_CONDITIONS.map((condition) => [condition, false]));
  const snapshot = await verifyGoalRepository(root, {
    ...context,
    [RETURN_VERIFIED_SNAPSHOT]: true,
  });
  if (!snapshot.result) {
    const issueCode = snapshot.evidence?.issues?.[0]?.code ?? 'GOAL_REPOSITORY_TAMPERED';
    results[failedRepositoryCondition(issueCode)] = false;
    return {
      state: 'BLOCKED',
      goal: snapshot.evidence?.goal ?? null,
      workspace_fingerprint: null,
      checklist: completionChecklist(results),
    };
  }

  const {
    result,
    current,
    planState,
    progressState,
    evidenceState,
    changeState,
    reader,
  } = snapshot;
  results.active_goal = result.state !== 'DRAFT';
  results.change_requests = changeState !== undefined && !changeState.pending;
  results.plan = planState?.current !== null && planState?.current !== undefined;
  results.progress_ledger = progressState !== undefined;
  const plan = planState?.current?.value;
  results.tasks = Boolean(plan) && plan.tasks.every((task) => task.status === 'complete');
  results.evidence = Boolean(plan) && current.goal.acceptance_criteria.every((criterion) => {
    const latest = evidenceState.latestByCriterion.get(criterion.id)?.value;
    return latest?.state === 'pass'
      && latest.goal.goal_id === current.goal.goal_id
      && latest.goal.goal_version === current.goal.goal_version
      && latest.goal.goal_digest === current.digest
      && latest.plan_revision === plan.plan_revision;
  });
  const auditFingerprint = auditedFingerprint(progressState?.terminal);
  results.final_audit = auditFingerprint !== null
    && progressState.terminal.goal.goal_id === current.goal.goal_id
    && progressState.terminal.goal.goal_version === current.goal.goal_version
    && progressState.terminal.goal.goal_digest === current.digest
    && progressState.terminal.plan_revision === plan?.plan_revision;

  let fingerprint = null;
  if (results.active_goal && results.plan && results.progress_ledger) {
    try {
      fingerprint = await fingerprintAcrossRepositoryRevalidation(root, inventory, reader, context);
      results.workspace_fingerprint = results.final_audit && fingerprint === auditFingerprint;
    } catch {
      results.workspace_fingerprint = false;
    }
  }
  const checklist = completionChecklist(results);
  return {
    state: checklist.every((item) => item.passed) ? 'COMPLETE' : 'BLOCKED',
    goal: {
      goal_id: current.goal.goal_id,
      goal_version: current.goal.goal_version,
      goal_digest: current.digest,
    },
    workspace_fingerprint: fingerprint,
    checklist,
  };
}

export async function proposeGoalChange(root, input, context = {}) {
  validateChangeProposalInput(input);
  return withGoalLock(root, 'change-propose', async (ownership) => {
    const snapshot = await verifyGoalRepository(root, {
      ...context,
      mutating: true,
      [ACTIVE_WRITE]: true,
      [RETURN_VERIFIED_SNAPSHOT]: true,
    });
    if (snapshot.result.state !== 'LOCKED') {
      throw stateError('CHANGE_STATE_REJECTED', `Change proposals require LOCKED state, not ${snapshot.result.state}.`);
    }
    const {
      reader,
      current,
      lockInput,
      planState,
      progressState,
      evidenceState,
      changeState,
    } = snapshot;
    if (hasStaleChangeBase(planState, evidenceState)) {
      throw stateError('CHANGE_BASE_STALE', 'Change proposals require a current non-stale goal, plan, and evidence state.');
    }
    if (changeState.count >= 9999) throw stateError('CHANGE_SEQUENCE_EXHAUSTED', 'Change request sequence exhausted its four-digit identifier space.');

    const changeRequestId = `CR-${String(changeState.count + 1).padStart(4, '0')}`;
    const baseGoal = {
      goal_id: current.goal.goal_id,
      goal_version: current.goal.goal_version,
      goal_digest: current.digest,
    };
    let candidateGoal;
    try {
      candidateGoal = validateGoalContract({
        schema_version: 2,
        goal_id: current.goal.goal_id,
        goal_version: current.goal.goal_version + 1,
        ...input.candidate,
        predecessor: { goal_version: current.goal.goal_version, goal_digest: current.digest },
        accepted_change_id: changeRequestId,
      }, { goal_id: current.goal.goal_id });
    } catch (error) {
      throw new GoalLockError('INVALID_CHANGE_INPUT', 'input', 2, 'Change candidate violates the semantic goal contract.', { cause: error });
    }
    const normalizedChanges = validateSemanticChangeCoverage(current.goal, candidateGoal, input.changes, () => (
      inputError('INVALID_CHANGE_COVERAGE', 'Changes must exactly cover every semantic difference.')
    ));
    const criterionImpact = assertCriterionImpactMatches(
      current.goal,
      candidateGoal,
      input.criterion_impact,
      () => inputError('INVALID_CRITERION_IMPACT', 'Criterion impact must exactly partition the candidate goal.'),
    );

    const candidateBytes = canonicalBytes(candidateGoal);
    const candidateDigest = sha256(candidateBytes);
    const incomplete = {
      schema_version: 2,
      id: changeRequestId,
      status: 'proposed',
      base_goal: baseGoal,
      candidate_goal: candidateGoal,
      candidate_digest: candidateDigest,
      proposal_digest: '0'.repeat(64),
      changes: normalizedChanges,
      rationale: input.rationale,
      affected_tasks: input.affected_tasks,
      criterion_impact: criterionImpact,
      risks: input.risks,
      validation: input.validation,
      rollback: input.rollback,
      approval_phrase: 'pending',
      recorded_at: (context.now ?? (() => new Date().toISOString()))(),
    };
    let proposalDigest;
    try {
      proposalDigest = sha256(canonicalBytes(proposalPayload(incomplete)));
    } catch (error) {
      throw new GoalLockError('INVALID_CHANGE_INPUT', 'input', 2, 'Change proposal must contain only canonical JSON values.', { cause: error });
    }
    const approvalRequired = approvalPhraseForChange({
      id: changeRequestId,
      candidate_goal: candidateGoal,
      proposal_digest: proposalDigest,
    });
    let changeRequest;
    try {
      changeRequest = validateChangeRequest({
        ...incomplete,
        proposal_digest: proposalDigest,
        approval_phrase: approvalRequired,
      });
    } catch (error) {
      if (error instanceof GoalLockError && error.kind === 'input') throw error;
      throw new GoalLockError('INVALID_CHANGE_INPUT', 'input', 2, 'Change proposal violates the change request contract.', { cause: error });
    }
    assertChangeReferencesExist(changeRequest, planState);

    const changeBytes = canonicalBytes(changeRequest);
    const changeDigest = sha256(changeBytes);
    const nextLock = nextLockForChange(lockInput, changeRequestId, changeDigest);
    const entries = verifiedChangeMutationEntries(snapshot);
    entries.push({
      target: `.goal-lock/changes/${changeRequestId}.json`,
      expected: { kind: 'absent' },
      content: changeBytes,
    });
    entries.push({
      target: '.goal-lock/lock.json',
      expected: { kind: 'sha256', digest: lockInput.digest },
      content: canonicalBytes(nextLock),
    });
    // 新 CR 与 change_head 共享一次 revision；完整快照作为只读所有权输入，失败时两项一起回滚。
    await reader.verifyInputs();
    await commitGoalFiles(root, entries, { ...context, ...ownership });
    return {
      state: 'CHANGE_PENDING',
      change_request_id: changeRequestId,
      candidate_goal_version: candidateGoal.goal_version,
      candidate_digest: candidateDigest,
      proposal_digest: proposalDigest,
      approval_required: approvalRequired,
    };
  }, context);
}

export async function rejectGoalChange(root, changeRequestId, reason, context = {}) {
  validateChangeRejectionInput(changeRequestId, reason);
  return withGoalLock(root, 'change-reject', async (ownership) => {
    const snapshot = await verifyGoalRepository(root, {
      ...context,
      mutating: true,
      [ACTIVE_WRITE]: true,
      [RETURN_VERIFIED_SNAPSHOT]: true,
    });
    if (!['CHANGE_PENDING', 'LOCKED'].includes(snapshot.result.state)) {
      throw stateError('CHANGE_REJECTION_STATE', `Change rejection requires verified goal state, not ${snapshot.result.state}.`);
    }
    const record = snapshot.changeState.records.get(changeRequestId);
    if (!record) throw stateError('CHANGE_NOT_FOUND', 'The selected change request does not exist.');
    if (snapshot.changeState.open?.value.id !== changeRequestId) {
      throw stateError('CHANGE_NOT_OPEN', 'Only an exact proposed change request may be rejected.');
    }
    if (snapshot.result.state !== 'CHANGE_PENDING') {
      throw stateError('CHANGE_NOT_PENDING', 'The selected change request is not the open repository change.');
    }

    // 拒绝只替换状态；提案字段、摘要、批准短语和记录时间保持逐值不变。
    const rejected = validateChangeRequest({ ...record.value, status: 'rejected' });
    const rejectedBytes = canonicalBytes(rejected);
    const rejectedDigest = sha256(rejectedBytes);
    const nextLock = nextLockForChange(snapshot.lockInput, changeRequestId, rejectedDigest);
    const entries = verifiedChangeMutationEntries(snapshot, changeRequestId);
    entries.push({
      target: record.target,
      expected: { kind: 'sha256', digest: record.digest },
      content: rejectedBytes,
    });
    entries.push({
      target: '.goal-lock/lock.json',
      expected: { kind: 'sha256', digest: snapshot.lockInput.digest },
      content: canonicalBytes(nextLock),
    });
    // CR 状态与 change_head 同属一次原子替换，任一所有权或安装失败都恢复原提案与原锁。
    await snapshot.reader.verifyInputs();
    await commitGoalFiles(root, entries, { ...context, ...ownership });
    return {
      state: 'LOCKED',
      change_request_id: changeRequestId,
      status: 'rejected',
      reason,
    };
  }, context);
}

export async function approveGoalChange(root, changeRequestId, approval, context = {}) {
  return withGoalLock(root, 'change-approve', async (ownership) => {
    let snapshot;
    try {
      snapshot = await verifyGoalRepository(root, {
        ...context,
        mutating: true,
        [ACTIVE_WRITE]: true,
        [RETURN_VERIFIED_SNAPSHOT]: true,
      });
    } catch (error) {
      // 已失效的 base 是过期批准而不是可接受状态；真实摘要或字节破坏仍保留完整性分类。
      if (error instanceof GoalLockError && ['CHANGE_BASE_MISMATCH', 'CHANGE_BASE_STALE'].includes(error.code)) {
        throw approvalError('APPROVAL_STALE', 'Change approval requires a proposal based on the active goal.');
      }
      throw error;
    }
    const proposed = snapshot.changeState.open;
    if (!proposed || snapshot.result.state !== 'CHANGE_PENDING' || proposed.value.id !== changeRequestId) {
      throw approvalError('APPROVAL_STALE', 'Change approval requires one current proposed change request.');
    }
    if (approval !== proposed.value.approval_phrase) {
      throw approvalError('APPROVAL_REJECTED', 'Change approval must exactly match the current proposal confirmation phrase.');
    }

    const {
      current,
      history,
      planState,
      progressState,
      evidenceState,
      lockInput,
      authorizationGraph,
    } = snapshot;
    const candidate = proposed.value.candidate_goal;
    const candidateBytes = canonicalBytes(candidate);
    const candidateDigest = sha256(candidateBytes);
    if (candidateDigest !== proposed.value.candidate_digest) {
      throw integrityError('CHANGE_CANDIDATE_MISMATCH', 'Approved change request candidate bytes do not match its recorded digest.');
    }
    const goalReference = {
      goal_id: candidate.goal_id,
      goal_version: candidate.goal_version,
      goal_digest: candidateDigest,
    };
    const priorPlan = planState.current?.value ?? null;
    const tasks = (priorPlan?.tasks ?? []).map((task) => ({
      ...task,
      status: proposed.value.affected_tasks.includes(task.id) ? 'stale' : task.status,
    }));
    const plan = validatePlanCriteria(validatePlan({
      schema_version: 2,
      goal: goalReference,
      plan_revision: 1,
      next_task_id: nextExecutableTaskId(tasks, null),
      tasks,
      risks: priorPlan?.risks ?? [],
      deferred: priorPlan?.deferred ?? [],
    }, goalReference), candidate);
    const planBytes = canonicalBytes(plan);
    const planDigest = sha256(planBytes);

    const events = [];
    let pendingProgress = { count: progressState.count, terminal: progressState.terminal };
    const appendEvent = (input, recordedAt) => {
      const event = buildProgressEvent(pendingProgress, goalReference, plan.plan_revision, input, context, recordedAt);
      events.push(event);
      pendingProgress = { count: pendingProgress.count + 1, terminal: event };
      return event;
    };
    appendEvent({
      event_type: 'plan-revision',
      task_id: null,
      summary: planRevisionSummary(candidate.goal_version, 1, planDigest, planState.current?.digest ?? null),
      evidence_refs: [],
    });
    appendEvent({
      event_type: 'goal-change',
      task_id: null,
      summary: `Approved goal change ${proposed.value.id}`,
      evidence_refs: [],
    });

    const derivedEvidence = [];
    const affectedCriteria = new Set(proposed.value.criterion_impact.affected);
    const unaffectedCriteria = new Set(proposed.value.criterion_impact.unaffected);
    const sourcePlans = plansByReference(planState);
    for (const criterion of candidate.acceptance_criteria) {
      const criterionId = criterion.id;
      const priorRecords = evidenceState.recordsByCriterion.get(criterionId) ?? [];
      const latest = priorRecords.at(-1);
      if (latest) {
        if (priorRecords.length >= 9999) {
          throw stateError('EVIDENCE_SEQUENCE_EXHAUSTED', 'Evidence sequence exhausted its four-digit identifier space.');
        }
        const task = plan.tasks.find((candidateTask) => (
          candidateTask.id === latest.value.task_id
          && candidateTask.acceptance_criteria.includes(criterionId)
        ));
        if (!task) {
          throw stateError('EVIDENCE_INVALIDATION_TASK_MISSING', 'Affected evidence must retain its owning task in the new plan.');
        }
        const sourceReference = latest.value.validation_ref;
        const sourcePlan = sourcePlans.get(`${sourceReference.goal_version}/${sourceReference.plan_revision}`);
        const sourceTask = sourcePlan?.tasks.find((candidateTask) => candidateTask.id === latest.value.task_id);
        const sourceValidation = sourceTask?.validations.find((validation) => validation.id === sourceReference.validation_id);
        let targetValidation;
        if (affectedCriteria.has(criterionId)) {
          // 受影响失效必须按授权图的准则可达性选靶；复用同一 ID 不代表仍获该准则授权。
          const authorizedTarget = authorizationGraph.validations.find((validation) => (
            validation.validation_ref.goal_version === current.goal.goal_version
            && validation.validation_ref.goal_digest === current.digest
            && validation.validation_ref.plan_revision === priorPlan.plan_revision
            && validation.task_id === task.id
            && validation.reachable_criterion_ids.includes(criterionId)
          ));
          targetValidation = task.validations.find((validation) => validation.id === authorizedTarget?.validation_ref.validation_id);
        } else {
          targetValidation = task.validations.find((validation) => validation.id === sourceReference.validation_id);
        }
        const canCarry = unaffectedCriteria.has(criterionId)
          && sourceTask
          && sourceValidation
          && targetValidation
          && canonicalValuesEqual(sourceTask, task)
          && canonicalValuesEqual(sourceValidation, targetValidation);
        if (!affectedCriteria.has(criterionId) && !canCarry) continue;
        if (!targetValidation) {
          throw stateError('EVIDENCE_INVALIDATION_VALIDATION_MISSING', 'Affected evidence requires a criterion-bound validation in the new plan.');
        }
        const recordedAt = (context.now ?? (() => new Date().toISOString()))();
        const evidence = validateEvidence({
          ...latest.value,
          evidence_id: `EVID-${String(priorRecords.length + 1).padStart(4, '0')}`,
          validation_ref: {
            ...goalReference,
            plan_revision: plan.plan_revision,
            validation_id: targetValidation.id,
          },
          task_id: task.id,
          state: affectedCriteria.has(criterionId) ? 'stale' : latest.value.state,
          supersedes: latest.value.evidence_id,
          derivation: {
            kind: affectedCriteria.has(criterionId) ? 'invalidation' : 'carry-forward',
            source_validation_ref: latest.value.validation_ref,
            source_evidence_id: latest.value.evidence_id,
            source_evidence_digest: latest.digest,
          },
          recorded_at: recordedAt,
        }, goalReference);
        const bytes = canonicalBytes(evidence);
        const digest = sha256(bytes);
        derivedEvidence.push({ criterionId, evidence, bytes, digest });
        appendEvent({
          event_type: 'verification-result',
          task_id: task.id,
          summary: evidenceEventSummary(evidence, digest),
          evidence_refs: [evidence.evidence_id],
        }, recordedAt);
      }
      if (affectedCriteria.has(criterionId)) {
        appendEvent({
          event_type: 'evidence-invalidation',
          task_id: null,
          summary: `Invalidated evidence ${criterionId} for approved goal change ${proposed.value.id}`,
          evidence_refs: [],
        });
      }
    }

    const approved = validateChangeRequest({ ...proposed.value, status: 'approved' });
    const approvedBytes = canonicalBytes(approved);
    const approvedDigest = sha256(approvedBytes);
    const nextEvidenceHeads = { ...lockInput.lock.evidence_heads };
    for (const record of derivedEvidence) {
      nextEvidenceHeads[record.criterionId] = {
        evidence_id: record.evidence.evidence_id,
        digest: record.digest,
      };
    }
    const nextWithoutDigest = {
      schema_version: 2,
      goal_id: candidate.goal_id,
      goal_version: candidate.goal_version,
      goal_digest: candidateDigest,
      approval_type: 'explicit-change',
      proposal_digest: proposed.value.proposal_digest,
      approved_at: (context.now ?? (() => new Date().toISOString()))(),
      predecessor_digest: current.digest,
      state_revision: lockInput.lock.state_revision + 1,
      scope_head: lockInput.lock.scope_head,
      progress_head: { event_id: pendingProgress.terminal.event_id, digest: pendingProgress.terminal.event_digest },
      change_head: { change_request_id: approved.id, digest: approvedDigest },
      evidence_heads: nextEvidenceHeads,
    };
    const nextLock = validateLockRecord({
      ...nextWithoutDigest,
      record_digest: sha256(canonicalBytes(nextWithoutDigest)),
    });

    const entries = [];
    for (const [goalVersion, goalRecord] of history.goals) {
      entries.push({
        target: `.goal-lock/history/goals/v${String(goalVersion).padStart(4, '0')}.json`,
        expected: { kind: 'sha256', digest: goalRecord.digest },
        content: goalRecord.bytes,
      });
    }
    for (const archive of planState.archives) {
      entries.push({ target: archive.target, expected: { kind: 'sha256', digest: archive.digest }, content: archive.bytes });
    }
    entries.push({
      target: '.goal-lock/current.json',
      expected: { kind: 'sha256', digest: current.digest },
      content: candidateBytes,
    });
    entries.push({
      target: `.goal-lock/history/goals/v${String(candidate.goal_version).padStart(4, '0')}.json`,
      expected: { kind: 'absent' },
      content: candidateBytes,
    });
    if (planState.current) {
      entries.push({
        target: `.goal-lock/history/plans/v${String(current.goal.goal_version).padStart(4, '0')}-r${String(priorPlan.plan_revision).padStart(4, '0')}.json`,
        expected: { kind: 'absent' },
        content: planState.current.bytes,
      });
      entries.push({ target: '.goal-lock/plan.json', expected: { kind: 'sha256', digest: planState.current.digest }, content: planBytes });
    } else {
      entries.push({ target: '.goal-lock/plan.json', expected: { kind: 'absent' }, content: planBytes });
    }
    for (const record of evidenceState.records) {
      entries.push({ target: record.target, expected: { kind: 'sha256', digest: record.digest }, content: record.bytes });
    }
    for (const record of derivedEvidence) {
      entries.push({
        target: `.goal-lock/evidence/${record.criterionId}/${record.evidence.evidence_id}.json`,
        expected: { kind: 'absent' },
        content: record.bytes,
      });
    }
    entries.push(appendProgressEvents(progressState, events));
    for (const record of snapshot.changeState.records.values()) {
      entries.push({
        target: record.target,
        expected: { kind: 'sha256', digest: record.digest },
        content: record.value.id === approved.id ? approvedBytes : record.bytes,
      });
    }
    entries.push({ target: '.goal-lock/lock.json', expected: { kind: 'sha256', digest: lockInput.digest }, content: canonicalBytes(nextLock) });

    // 目标、历史、计划、证据、账本、CR 与索引必须共用一次安装；任一文件失败时事务恢复整个已验证快照。
    await snapshot.reader.verifyInputs();
    await commitGoalFiles(root, entries, { ...context, ...ownership });
    const verification = await verifyGoalRepository(root, { ...context, [ACTIVE_WRITE]: true });
    if (verification.state !== 'LOCKED') {
      throw integrityError('APPROVED_CHANGE_VERIFICATION_FAILED', 'Approved goal change did not verify as locked.');
    }
    return { state: 'LOCKED', goal_version: candidate.goal_version };
  }, context);
}
