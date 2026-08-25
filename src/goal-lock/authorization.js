import { canonicalBytes, sha256 } from './canonical.js';
import {
  GoalLockError,
  normalizeRelativePath,
  validateChangeRequest,
  validateEvidence,
  validateGoalContract,
  validatePlan,
  validateValidationRef,
} from './contracts.js';

function deny(message) {
  throw new GoalLockError('AUTHORIZATION_DENIED', 'integrity', 4, message);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value) || Object.keys(value).length !== value.length) deny(`${label} must be a dense array`);
  return value;
}

function referenceKey(reference) {
  return [
    reference.goal_id,
    reference.goal_version,
    reference.goal_digest,
    reference.plan_revision,
    reference.validation_id,
  ].join('\u0000');
}

function displayReference(reference) {
  return `${reference.goal_id}/${reference.goal_version}/${reference.plan_revision}/${reference.validation_id}`;
}

function sameReference(left, right) {
  return left.goal_id === right.goal_id
    && left.goal_version === right.goal_version
    && left.goal_digest === right.goal_digest
    && left.plan_revision === right.plan_revision
    && left.validation_id === right.validation_id;
}

function compareReferences(left, right) {
  return left.goal_id.localeCompare(right.goal_id)
    || left.goal_version - right.goal_version
    || left.goal_digest.localeCompare(right.goal_digest)
    || left.plan_revision - right.plan_revision
    || left.validation_id.localeCompare(right.validation_id);
}

function riskKey(goalReference, planRevision, riskId) {
  return `${goalReference.goal_id}\u0000${goalReference.goal_version}\u0000${goalReference.goal_digest}\u0000${planRevision}\u0000${riskId}`;
}

function isSubset(values, permitted) {
  return values.every((value) => permitted.has(value));
}

function validationAllowsPath(validation, path) {
  return validation.affected_paths[0] === '@governed-workspace'
    || validation.affected_paths.includes(path);
}

function goalReferenceFor(goal) {
  return {
    goal_id: goal.goal_id,
    goal_version: goal.goal_version,
    goal_digest: sha256(canonicalBytes(goal)),
  };
}

function goalReferenceFromNode(goal) {
  return {
    goal_id: goal.goal_id,
    goal_version: goal.goal_version,
    goal_digest: goal.goal_digest,
  };
}

function normalizeGoals(goalHistory, changeRecords) {
  const goals = requireArray(goalHistory, 'goalHistory').map((value) => validateGoalContract(value));
  const changes = requireArray(changeRecords, 'changeRecords').map((value) => validateChangeRequest(value));
  let previous = null;
  const goalId = goals[0]?.goal_id;
  const nodes = goals.map((goal, index) => {
    const reference = goalReferenceFor(goal);
    if (goal.goal_id !== goalId || goal.goal_version !== index + 1) {
      deny('Goal history must contain one contiguous goal lineage');
    }
    if (previous !== null
      && (goal.predecessor?.goal_version !== previous.goal_version
        || goal.predecessor?.goal_digest !== previous.goal_digest)) {
      deny(`Goal version ${goal.goal_version} does not bind its predecessor`);
    }
    if (goal.goal_version > 1) {
      const accepted = changes.find((change) => change.id === goal.accepted_change_id);
      if (!accepted
        || accepted.status !== 'approved'
        || accepted.candidate_digest !== reference.goal_digest
        || accepted.base_goal.goal_digest !== previous.goal_digest) {
        deny(`Goal version ${goal.goal_version} does not bind an approved change`);
      }
    }
    previous = reference;
    return {
      ...reference,
      criterion_ids: goal.acceptance_criteria.map(({ id }) => id).sort(),
    };
  });
  if (nodes.length === 0) deny('Goal history must not be empty');
  return nodes;
}

function goalForPlan(goalsByVersion, plan) {
  const goal = goalsByVersion.get(plan.goal.goal_version);
  if (!goal
    || goal.goal_id !== plan.goal.goal_id
    || goal.goal_digest !== plan.goal.goal_digest) {
    deny(`Plan revision ${plan.goal.goal_id}/${plan.goal.goal_version}/${plan.plan_revision} references an unknown goal`);
  }
  return goal;
}

function normalizeEvidenceRecords(evidenceRecords, goalsByVersion, validationsByKey) {
  return requireArray(evidenceRecords, 'evidenceRecords').map((value) => {
    const rawReference = validateValidationRef(value.validation_ref, 'evidence.validation_ref');
    const goal = goalsByVersion.get(rawReference.goal_version);
    if (!goal
      || goal.goal_id !== rawReference.goal_id
      || goal.goal_digest !== rawReference.goal_digest) {
      deny(`Evidence ${value.evidence_id} references an unknown goal`);
    }
    const evidence = validateEvidence(value, goalReferenceFromNode(goal));
    const validation = validationsByKey.get(referenceKey(evidence.validation_ref));
    if (!validation) deny(`Validation reference ${displayReference(evidence.validation_ref)} is unknown`);
    return { evidence, validation };
  });
}

function assertEvidenceCore(validation, evidence, { allowStale = false } = {}) {
  if (!allowStale && evidence.state === 'stale') deny(`Evidence ${evidence.evidence_id} is stale`);
  if (evidence.task_id !== validation.task_id) {
    deny(`Evidence ${evidence.evidence_id} task ${evidence.task_id} does not own its validation`);
  }
  if (!validation.reachable_criterion_ids.includes(evidence.acceptance_criterion_id)) {
    deny(`Evidence ${evidence.evidence_id} criterion ${evidence.acceptance_criterion_id} is not reachable from its validation`);
  }
  for (const path of evidence.artifact_refs) {
    if (!validationAllowsPath(validation, path)) {
      deny(`Evidence ${evidence.evidence_id} artifact path ${path} exceeds validation bounds`);
    }
  }
  for (const path of evidence.failure_paths) {
    if (!validationAllowsPath(validation, path)) {
      deny(`Evidence ${evidence.evidence_id} failure path ${path} exceeds validation bounds`);
    }
  }
}

function assertChronology(graph, evidence, chronology) {
  if (chronology === null || typeof chronology !== 'object' || Array.isArray(chronology)) {
    deny('Evidence chronology must be a plain object');
  }
  const activePlan = graph.plans.at(-1);
  if (chronology.mode === 'write') {
    const active = activePlan && {
      ...activePlan.goal,
      plan_revision: activePlan.plan_revision,
      validation_id: evidence.validation_ref.validation_id,
    };
    if (!active || !sameReference(active, evidence.validation_ref)) {
      deny(`Evidence ${evidence.evidence_id} does not target the active plan revision`);
    }
    return;
  }
  if (chronology.mode !== 'replay') deny('Evidence chronology mode must be write or replay');
  const targetsActivePlan = activePlan
    && activePlan.goal.goal_id === evidence.validation_ref.goal_id
    && activePlan.goal.goal_version === evidence.validation_ref.goal_version
    && activePlan.goal.goal_digest === evidence.validation_ref.goal_digest
    && activePlan.plan_revision === evidence.validation_ref.plan_revision;
  if (targetsActivePlan) return;
  if (typeof chronology.superseded_at !== 'string'
    || evidence.recorded_at >= chronology.superseded_at) {
    deny(`Evidence ${evidence.evidence_id} was recorded after its plan revision was superseded`);
  }
}

/** 根据已验证历史构建唯一、纯数据且深冻结的授权图。 */
export function buildAuthorizationGraph({ goalHistory, planRecords, evidenceRecords, changeRecords }) {
  const goals = normalizeGoals(goalHistory, changeRecords);
  const goalsByVersion = new Map(goals.map((goal) => [goal.goal_version, goal]));
  const permittedPaths = new Set();
  const planKeys = new Set();
  const validationsByKey = new Map();
  const risksByKey = new Map();
  const internalPlans = [];

  for (const rawPlan of requireArray(planRecords, 'planRecords')) {
    for (const rawTask of rawPlan?.tasks ?? []) {
      if (!Array.isArray(rawTask.acceptance_criteria) || rawTask.acceptance_criteria.length === 0) {
        deny(`Plan task ${rawTask.id} must own a goal criterion`);
      }
    }
    const boundGoal = goalsByVersion.get(rawPlan?.goal?.goal_version);
    if (!boundGoal) deny('Plan references an unknown goal');
    const plan = validatePlan(rawPlan, goalReferenceFromNode(boundGoal));
    const goal = goalForPlan(goalsByVersion, plan);
    const planKey = `${goal.goal_id}/${goal.goal_version}/${plan.plan_revision}`;
    if (planKeys.has(planKey)) deny(`Plan revision ${planKey} is duplicated`);
    planKeys.add(planKey);
    const criterionSet = new Set(goal.criterion_ids);
    const taskNodes = [];
    const planValidationKeys = [];
    const planRiskKeys = [];

    for (const task of plan.tasks) {
      if (!isSubset(task.acceptance_criteria, criterionSet)) {
        deny(`Plan task ${task.id} must own a goal criterion`);
      }
      const ownedCriteria = new Set(task.acceptance_criteria);
      // 累计集合只做历史并集；后续计划收紧不得抹去已接受修订曾授予的路径。
      for (const path of task.permitted_paths) permittedPaths.add(path);
      const taskValidationRefs = [];
      for (const validation of task.validations) {
        const reference = {
          goal_id: goal.goal_id,
          goal_version: goal.goal_version,
          goal_digest: goal.goal_digest,
          plan_revision: plan.plan_revision,
          validation_id: validation.id,
        };
        const key = referenceKey(reference);
        if (validationsByKey.has(key)) deny(`Validation tuple ${displayReference(reference)} is duplicated`);
        if (!isSubset(validation.criterion_ids, ownedCriteria)) {
          deny(`Validation ${validation.id} does not reach an owning task criterion`);
        }
        const node = {
          validation_ref: reference,
          task_id: task.id,
          kind: validation.kind,
          method: { ...validation.method },
          affected_paths: [...validation.affected_paths].sort(),
          criterion_ids: [...validation.criterion_ids].sort(),
          risk_ids: [...validation.risk_ids].sort(),
          reachable_criterion_ids: [],
          evidence_ids: [],
          owned_criterion_ids: [...task.acceptance_criteria].sort(),
          plan_risk_prefix: `${riskKey(goal, plan.plan_revision, '')}`,
        };
        validationsByKey.set(key, node);
        planValidationKeys.push(key);
        taskValidationRefs.push(reference);
      }
      taskNodes.push({
        task_id: task.id,
        criterion_ids: [...task.acceptance_criteria].sort(),
        permitted_paths: [...task.permitted_paths].sort(),
        validation_refs: taskValidationRefs.sort(compareReferences),
      });
    }

    for (const risk of plan.risks) {
      const key = riskKey(goal, plan.plan_revision, risk.id);
      risksByKey.set(key, {
        goal,
        plan_revision: plan.plan_revision,
        risk_id: risk.id,
        source: structuredClone(risk.source),
        affected_paths: [...risk.affected_paths].sort(),
        consumer_validation_keys: [],
        reachable_criterion_ids: [],
      });
      planRiskKeys.push(key);
    }
    for (const validationKey of planValidationKeys) {
      const validation = validationsByKey.get(validationKey);
      for (const riskId of validation.risk_ids) {
        const risk = risksByKey.get(`${validation.plan_risk_prefix}${riskId}`);
        if (!risk) deny(`Validation ${validation.validation_ref.validation_id} references an unknown risk ${riskId}`);
        risk.consumer_validation_keys.push(validationKey);
      }
    }
    const workspaceMandatoryCount = planValidationKeys
      .map((key) => validationsByKey.get(key))
      .filter((validation) => validation.kind === 'mandatory-gate'
        && validation.affected_paths[0] === '@governed-workspace').length;
    if (workspaceMandatoryCount > 1) deny(`Plan revision ${planKey} declares more than one workspace mandatory gate`);
    internalPlans.push({
      goal: { goal_id: goal.goal_id, goal_version: goal.goal_version, goal_digest: goal.goal_digest },
      plan_revision: plan.plan_revision,
      tasks: taskNodes.sort((left, right) => left.task_id.localeCompare(right.task_id)),
      risk_keys: planRiskKeys,
      validation_keys: planValidationKeys,
    });
  }

  internalPlans.sort((left, right) => left.goal.goal_version - right.goal.goal_version
    || left.plan_revision - right.plan_revision);
  const revisionsByGoal = new Map();
  for (const plan of internalPlans) {
    const revisions = revisionsByGoal.get(plan.goal.goal_version) ?? [];
    revisions.push(plan.plan_revision);
    revisionsByGoal.set(plan.goal.goal_version, revisions);
  }
  for (const [goalVersion, revisions] of revisionsByGoal) {
    if (revisions.some((revision, index) => revision !== index + 1)) {
      deny(`Goal version ${goalVersion} plan revisions are not contiguous`);
    }
  }
  if (internalPlans.length === 0) deny('Plan history must not be empty');
  if (internalPlans.at(-1).goal.goal_version !== goals.at(-1).goal_version) {
    deny('The active goal has no active plan revision');
  }

  const normalizedEvidence = normalizeEvidenceRecords(evidenceRecords, goalsByVersion, validationsByKey);
  const evidenceBySource = new Map();
  for (const { evidence, validation } of normalizedEvidence) {
    const key = `${referenceKey(evidence.validation_ref)}\u0000${evidence.evidence_id}`;
    if (evidenceBySource.has(key)) deny(`Evidence ${evidence.evidence_id} is duplicated for its validation`);
    evidenceBySource.set(key, evidence);
    if (evidence.state !== 'stale') validation.evidence_ids.push(evidence.evidence_id);
  }
  for (const validation of validationsByKey.values()) {
    if (validation.kind === 'mandatory-gate' && validation.evidence_ids.length > 1) {
      deny(`Mandatory validation ${displayReference(validation.validation_ref)} already has an accepted result`);
    }
  }

  const resolving = new Set();
  const resolved = new Set();
  // 失败本身不扩权；只有闭合的“失败验证证据→风险→消费者验证”边可传递既有 criterion 追踪。
  function resolveRisk(node) {
    const nodeKey = `risk:${riskKey(node.goal, node.plan_revision, node.risk_id)}`;
    if (resolving.has(nodeKey)) deny('Authorization risk graph contains a cycle');
    if (resolved.has(nodeKey)) return node.reachable_criterion_ids;
    resolving.add(nodeKey);
    let reachable;
    if (node.source.kind === 'criterion') {
      reachable = [node.source.criterion_id];
      for (const validationKey of node.consumer_validation_keys) {
        const consumer = validationsByKey.get(validationKey);
        if (!consumer.owned_criterion_ids.includes(node.source.criterion_id)) {
          deny(`Risk ${node.risk_id} criterion is not owned by its consuming task`);
        }
      }
    } else {
      const sourceValidation = validationsByKey.get(referenceKey(node.source.validation_ref));
      const sourceEvidence = evidenceBySource.get(`${referenceKey(node.source.validation_ref)}\u0000${node.source.evidence_id}`);
      if (!sourceValidation
        || !sourceEvidence
        || sourceEvidence.state !== 'fail'
        || sourceEvidence.failure_paths.length === 0) {
        deny(`Risk ${node.risk_id} does not resolve verified failing evidence`);
      }
      if (!isSubset(node.affected_paths, new Set(sourceEvidence.failure_paths))) {
        deny(`Risk ${node.risk_id} expands beyond verified failure paths`);
      }
      reachable = resolveValidation(sourceValidation);
    }
    if (node.consumer_validation_keys.length === 0) deny(`Risk ${node.risk_id} has no consuming validation`);
    for (const validationKey of node.consumer_validation_keys) {
      const consumer = validationsByKey.get(validationKey);
      if (!isSubset(consumer.affected_paths, new Set(node.affected_paths))) {
        deny(`Validation ${consumer.validation_ref.validation_id} expands beyond risk ${node.risk_id}`);
      }
    }
    node.reachable_criterion_ids = [...new Set(reachable)].sort();
    resolving.delete(nodeKey);
    resolved.add(nodeKey);
    return node.reachable_criterion_ids;
  }

  function resolveValidation(node) {
    const key = referenceKey(node.validation_ref);
    const nodeKey = `validation:${key}`;
    if (resolving.has(nodeKey)) deny('Authorization risk graph contains a cycle');
    if (resolved.has(nodeKey)) return node.reachable_criterion_ids;
    resolving.add(nodeKey);
    const reachable = new Set(node.criterion_ids);
    for (const riskId of node.risk_ids) {
      const risk = risksByKey.get(`${node.plan_risk_prefix}${riskId}`);
      for (const criterionId of resolveRisk(risk)) reachable.add(criterionId);
    }
    if (reachable.size === 0 || !isSubset([...reachable], new Set(node.owned_criterion_ids))) {
      deny(`Validation ${node.validation_ref.validation_id} does not reach an owning task criterion`);
    }
    node.reachable_criterion_ids = [...reachable].sort();
    resolving.delete(nodeKey);
    resolved.add(nodeKey);
    return node.reachable_criterion_ids;
  }

  for (const validation of validationsByKey.values()) resolveValidation(validation);
  for (const risk of risksByKey.values()) resolveRisk(risk);
  for (const { evidence, validation } of normalizedEvidence) {
    assertEvidenceCore(validation, evidence, { allowStale: true });
  }

  const validations = [...validationsByKey.values()]
    .sort((left, right) => compareReferences(left.validation_ref, right.validation_ref))
    .map(({ owned_criterion_ids: _owned, plan_risk_prefix: _prefix, ...node }) => ({
      ...node,
      evidence_ids: [...new Set(node.evidence_ids)].sort(),
    }));
  const riskEdges = [...risksByKey.values()]
    .sort((left, right) => left.goal.goal_version - right.goal.goal_version
      || left.plan_revision - right.plan_revision
      || left.risk_id.localeCompare(right.risk_id))
    .map((risk) => ({
      risk_ref: {
        goal_id: risk.goal.goal_id,
        goal_version: risk.goal.goal_version,
        goal_digest: risk.goal.goal_digest,
        plan_revision: risk.plan_revision,
        risk_id: risk.risk_id,
      },
      source: risk.source,
      affected_paths: risk.affected_paths,
      consumer_validation_refs: risk.consumer_validation_keys
        .map((key) => validationsByKey.get(key).validation_ref)
        .sort(compareReferences),
      reachable_criterion_ids: risk.reachable_criterion_ids,
    }));
  const plans = internalPlans.map(({ risk_keys: riskKeys, validation_keys: validationKeys, ...plan }) => ({
    ...plan,
    risk_ids: riskKeys.map((key) => risksByKey.get(key).risk_id).sort(),
    validation_refs: validationKeys.map((key) => validationsByKey.get(key).validation_ref).sort(compareReferences),
  }));
  const graphWithoutDigest = {
    schema_version: 2,
    goals,
    plans,
    validations,
    risk_edges: riskEdges,
    cumulative_permitted_paths: [...permittedPaths].sort(),
  };
  return deepFreeze({
    ...graphWithoutDigest,
    digest: sha256(canonicalBytes(graphWithoutDigest)),
  });
}

/** 按目标、版本、摘要、计划修订与验证 ID 的完整五元组解析不可变验证节点。 */
export function resolveValidationRef(graph, validationRef) {
  const reference = validateValidationRef(validationRef);
  const validation = graph.validations.find((candidate) => sameReference(candidate.validation_ref, reference));
  if (!validation) deny(`Validation reference ${displayReference(reference)} is unknown`);
  return validation;
}

/** 只检查惰性验证标识及其证据边界，不解释或执行 method.target。 */
export function assertEvidenceAuthorized(graph, evidence, chronology) {
  const rawReference = validateValidationRef(evidence.validation_ref, 'evidence.validation_ref');
  const normalized = validateEvidence(evidence, goalReferenceFromNode(rawReference));
  const validation = resolveValidationRef(graph, normalized.validation_ref);
  assertEvidenceCore(validation, normalized);
  assertChronology(graph, normalized, chronology);
  if (validation.kind === 'mandatory-gate'
    && validation.evidence_ids.length > 0
    && !validation.evidence_ids.includes(normalized.evidence_id)) {
    deny(`Mandatory validation ${displayReference(normalized.validation_ref)} already has an accepted result`);
  }
  return normalized;
}

/** 从实际差异与累计路径并集派生阻塞项，不另建可变范围账本。 */
export function deriveScopeBlockers(graph, deltaPaths) {
  const permitted = new Set(graph.cumulative_permitted_paths);
  const unauthorized = new Set();
  for (const [index, value] of requireArray(deltaPaths, 'deltaPaths').entries()) {
    const path = normalizeRelativePath(value, `deltaPaths[${index}]`);
    if (!permitted.has(path)) unauthorized.add(path);
  }
  return deepFreeze([...unauthorized].sort().map((path) => ({ kind: 'unauthorized-delta', path })));
}
