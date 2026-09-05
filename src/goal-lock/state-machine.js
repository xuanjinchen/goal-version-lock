import {
  createGoalRecord,
  createProposal,
  GoalLockError,
  USER_GOAL_FIELDS,
} from './contract.js';
import {
  createHistoryRecord,
  inspectGoalStore,
  removeProposal,
  replaceCurrentRecord,
  replaceProposal,
} from './store.js';

function transitionRejected(message) {
  throw new GoalLockError('INVALID_TRANSITION', 'transition', 3, message);
}

function integrityFailure(message) {
  throw new GoalLockError('INTEGRITY_FAILURE', 'integrity', 4, message);
}

function approvalRejected(message) {
  throw new GoalLockError('APPROVAL_REJECTED', 'approval', 5, message);
}

function activeReference(goal) {
  return goal === null ? null : { version: goal.version, digest: goal.digest };
}

function sameReference(left, right) {
  return left?.version === right?.version && left?.digest === right?.digest;
}

function publicProposal(proposal) {
  return {
    version: proposal.candidate.version,
    candidate_digest: proposal.candidate.digest,
    proposal_digest: proposal.proposal_digest,
    approval_phrase: proposal.approval_phrase,
    changes: proposal.changes,
  };
}

function publicPending(proposal) {
  return {
    version: proposal.candidate.version,
    digest: proposal.proposal_digest,
    approval_phrase: proposal.approval_phrase,
    changes: proposal.changes,
  };
}

function goalFieldsFromProposalBase(proposal) {
  const fields = {};
  for (const field of USER_GOAL_FIELDS) fields[field] = proposal.candidate[field];
  for (const change of proposal.changes) fields[change.field] = change.before;
  return fields;
}

function reconstructProposalBase(snapshot) {
  const baseReference = snapshot.proposal.base;
  if (baseReference === null) return null;
  if (!sameReference(snapshot.history[baseReference.version - 1], baseReference)) {
    throw integrityFailure('Transition proposal base is not installed in goal history.');
  }
  return {
    ...goalFieldsFromProposalBase(snapshot.proposal),
    version: baseReference.version,
    digest: baseReference.digest,
    predecessor: baseReference.version === 1 ? null : snapshot.history[baseReference.version - 2],
  };
}

function recomputeProposal(snapshot) {
  if (snapshot.proposal === null) transitionRejected(`Cannot approve without a pending proposal in ${snapshot.state} transition state.`);
  if (snapshot.state === 'initial-proposed') return createProposal(null, snapshot.proposal.candidate);
  if (snapshot.state === 'change-proposed') return createProposal(snapshot.active, snapshot.proposal.candidate);
  if (snapshot.state === 'transition-incomplete') {
    return createProposal(reconstructProposalBase(snapshot), snapshot.proposal.candidate);
  }
  transitionRejected(`Cannot approve from ${snapshot.state} transition state.`);
}

function assertExactApproval(proposal, approvalPhrase) {
  // 批准短语是唯一授权边界；任何写入前都必须按字节精确匹配当前提案摘要。
  if (approvalPhrase !== proposal.approval_phrase) {
    approvalRejected('Approval phrase does not match the pending goal proposal.');
  }
}

async function completeApprovedProposal(root, proposal, context) {
  await createHistoryRecord(root, proposal.candidate, context);
  await replaceCurrentRecord(root, proposal.candidate, context);
  await removeProposal(root, proposal.proposal_digest, context);
  return { state: 'active', active: activeReference(proposal.candidate) };
}

async function completeInterruptedProposal(root, snapshot, proposal, context) {
  if (snapshot.transition?.history_installed !== true) {
    throw integrityFailure('Transition-incomplete state is missing the exact candidate history record.');
  }
  // 只续写 store 已证明未安装的精确候选字节；不提供通用修复或重建路径。
  if (snapshot.transition.current_installed !== true) {
    await replaceCurrentRecord(root, proposal.candidate, context);
  }
  await removeProposal(root, proposal.proposal_digest, context);
  return { state: 'active', active: activeReference(proposal.candidate) };
}

export async function initializeGoal(root, goalInput) {
  const snapshot = await inspectGoalStore(root);
  if (snapshot.state !== 'uninitialized') {
    transitionRejected(`Cannot initialize goal from ${snapshot.state} transition state.`);
  }

  const candidate = createGoalRecord(goalInput, { version: 1, predecessor: null });
  const proposal = createProposal(null, candidate);
  await replaceProposal(root, proposal);
  return { state: 'initial-proposed', active: null, proposal: publicProposal(proposal) };
}

export async function proposeGoal(root, goalInput) {
  const snapshot = await inspectGoalStore(root);
  if (snapshot.state !== 'active' && snapshot.state !== 'change-proposed') {
    transitionRejected(`Cannot propose goal from ${snapshot.state} transition state.`);
  }

  const active = snapshot.active;
  if (active === null) throw integrityFailure('Active goal authority is unavailable for proposal.');
  const candidate = createGoalRecord(goalInput, {
    version: active.version + 1,
    predecessor: activeReference(active),
  });
  const proposal = createProposal(active, candidate);
  if (proposal.changes.length === 0) {
    // 已有待审提案没有执行权；对齐输入不能为了“无变化”而删除或重写它。
    return { state: 'no-change', active: activeReference(active) };
  }

  await replaceProposal(root, proposal);
  return { state: 'change-proposed', active: activeReference(active), proposal: publicProposal(proposal) };
}

export async function approveGoal(root, approvalPhrase, context = {}) {
  const snapshot = await inspectGoalStore(root);
  const proposal = recomputeProposal(snapshot);
  assertExactApproval(proposal, approvalPhrase);

  if (snapshot.state === 'transition-incomplete') {
    return completeInterruptedProposal(root, snapshot, proposal, context);
  }
  return completeApprovedProposal(root, proposal, context);
}

export async function verifyGoal(root) {
  const snapshot = await inspectGoalStore(root);
  return { state: snapshot.state, active: activeReference(snapshot.active) };
}

export async function getGoalStatus(root) {
  const snapshot = await inspectGoalStore(root);
  return {
    state: snapshot.state,
    active: activeReference(snapshot.active),
    pending: snapshot.proposal === null ? null : publicPending(snapshot.proposal),
  };
}
