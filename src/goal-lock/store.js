import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
  lstat,
} from 'node:fs/promises';
import path from 'node:path';

import { canonicalBytes, parseCanonicalJson } from './canonical.js';
import { GoalLockError, verifyGoalRecord, verifyProposal } from './contract.js';

const GOAL_LOCK_DIRECTORY = '.goal-lock';
const HISTORY_DIRECTORY = 'history';
const CURRENT_FILE = 'current.json';
const PROPOSAL_FILE = 'proposal.json';
const UNSUPPORTED_ROOT_ENTRIES = new Set([
  'lock.json',
  'plan.json',
  'progress.jsonl',
  'scope.json',
  'changes',
  'evidence',
  '.transaction.json',
  '.write-lock.json',
]);
const ALLOWED_ROOT_ENTRIES = new Set([CURRENT_FILE, PROPOSAL_FILE, HISTORY_DIRECTORY]);

function storeError(code, message, cause) {
  return new GoalLockError(code, 'integrity', 4, message, cause === undefined ? {} : { cause });
}

function integrityFailure(message, cause) {
  return storeError('INTEGRITY_FAILURE', message, cause);
}

function unsupportedState(message) {
  return storeError('UNSUPPORTED_STATE', message);
}

function lockPath(root, ...segments) {
  return path.join(root, GOAL_LOCK_DIRECTORY, ...segments);
}

function historyFilename(version) {
  return `v${String(version).padStart(4, '0')}.json`;
}

function sameGoalReference(left, right) {
  return left?.version === right?.version && left?.digest === right?.digest;
}

function sameBytes(left, right) {
  return left !== null && right !== null && left.bytes.equals(right.bytes);
}

function sameRecordBytes(goal, record) {
  return canonicalBytes(goal).equals(record.bytes);
}

function activeReference(record) {
  return { version: record.version, digest: record.digest };
}

async function pathStatus(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw integrityFailure(`Cannot inspect ${target}.`, error);
  }
}

async function assertRealDirectory(target, label) {
  const status = await pathStatus(target);
  if (status === null) return false;
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw integrityFailure(`${label} must be a real directory.`);
  }
  return true;
}

async function assertRegularFile(target, label) {
  const status = await pathStatus(target);
  if (status === null) return null;
  if (status.isSymbolicLink() || !status.isFile()) {
    throw integrityFailure(`${label} must be a regular file.`);
  }
  return status;
}

function verifyCanonicalGoal(bytes, label) {
  try {
    const record = verifyGoalRecord(parseCanonicalJson(bytes, label));
    const verifiedBytes = canonicalBytes(record);
    if (!bytes.equals(verifiedBytes)) {
      throw new Error(`${label} bytes differ from verified canonical goal record`);
    }
    return { record, bytes };
  } catch (error) {
    throw integrityFailure(`${label} is not a valid canonical goal record.`, error);
  }
}

function verifyCanonicalProposal(bytes, baseGoal, label) {
  try {
    const proposal = verifyProposal(parseCanonicalJson(bytes, label), baseGoal);
    const verifiedBytes = canonicalBytes(proposal);
    if (!bytes.equals(verifiedBytes)) {
      throw new Error(`${label} bytes differ from verified canonical proposal`);
    }
    return { proposal, bytes };
  } catch (error) {
    throw integrityFailure(`${label} is not a valid canonical proposal.`, error);
  }
}

async function readCanonicalGoalFile(target, label) {
  const status = await assertRegularFile(target, label);
  if (status === null) return null;
  return verifyCanonicalGoal(await readFile(target), label);
}

async function readProposalFromStore(target, history, current) {
  const status = await assertRegularFile(target, PROPOSAL_FILE);
  if (status === null) return null;
  const bytes = await readFile(target);
  let value;
  try {
    value = parseCanonicalJson(bytes, PROPOSAL_FILE);
  } catch (error) {
    throw integrityFailure('proposal.json is not canonical JSON.', error);
  }

  const candidates = [];
  if (value?.base === null) candidates.push(null);
  for (const entry of history) {
    if (sameGoalReference(value?.base, activeReference(entry.record))) candidates.push(entry.record);
  }
  if (current !== null && sameGoalReference(value?.base, activeReference(current.record))) {
    candidates.push(current.record);
  }

  let lastError;
  for (const baseGoal of candidates) {
    try {
      return verifyCanonicalProposal(bytes, baseGoal, PROPOSAL_FILE);
    } catch (error) {
      lastError = error;
    }
  }
  throw integrityFailure('proposal.json does not bind an available base goal.', lastError);
}

async function listRootEntries(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (UNSUPPORTED_ROOT_ENTRIES.has(entry.name)) {
      throw unsupportedState(`Unsupported protocol-v2 goal-lock entry: ${entry.name}.`);
    }
    if (!ALLOWED_ROOT_ENTRIES.has(entry.name)) {
      throw integrityFailure(`Unrecognized goal-lock entry: ${entry.name}.`);
    }
    if (entry.name === HISTORY_DIRECTORY && !entry.isDirectory()) {
      throw integrityFailure('history must be a real directory.');
    }
    if (entry.name !== HISTORY_DIRECTORY && !entry.isFile()) {
      throw integrityFailure(`${entry.name} must be a regular file.`);
    }
  }
  return entries.map((entry) => entry.name);
}

async function readHistory(directory) {
  const historyPath = path.join(directory, HISTORY_DIRECTORY);
  if (!await assertRealDirectory(historyPath, 'history')) return [];

  const entries = await readdir(historyPath, { withFileTypes: true });
  const versions = [];
  for (const entry of entries) {
    if (entry.name === 'goals' && entry.isDirectory()) {
      throw unsupportedState('Unsupported protocol-v2 goal history directory: history/goals/.');
    }
    if (!entry.isFile()) throw integrityFailure(`Unrecognized history entry: ${entry.name}.`);
    const match = /^v([0-9]{4,})\.json$/.exec(entry.name);
    if (match === null) throw integrityFailure(`Unrecognized history entry: ${entry.name}.`);
    const version = Number(match[1]);
    if (!Number.isSafeInteger(version) || version < 1 || entry.name !== historyFilename(version)) {
      throw integrityFailure(`Invalid history version filename: ${entry.name}.`);
    }
    versions.push({ version, name: entry.name });
  }

  versions.sort((left, right) => left.version - right.version);
  const records = [];
  for (let index = 0; index < versions.length; index += 1) {
    const expectedVersion = index + 1;
    const entry = versions[index];
    if (entry.version !== expectedVersion) {
      throw integrityFailure('Goal history must contain contiguous versions from 1 to N.');
    }
    const goal = await readCanonicalGoalFile(path.join(historyPath, entry.name), `history/${entry.name}`);
    if (goal.record.version !== expectedVersion) {
      throw integrityFailure(`history/${entry.name} record version does not match its filename.`);
    }
    const expectedPredecessor = index === 0 ? null : activeReference(records[index - 1].record);
    if (goal.record.predecessor === null ? expectedPredecessor !== null : !sameGoalReference(goal.record.predecessor, expectedPredecessor)) {
      throw integrityFailure(`history/${entry.name} predecessor does not bind the previous history record.`);
    }
    records.push(goal);
  }
  return records;
}

function uninitializedSnapshot() {
  return {
    state: 'uninitialized',
    active: null,
    proposal: null,
    transition: null,
    history: [],
  };
}

function buildSnapshot(state, { active = null, proposal = null, transition = null, history = [] } = {}) {
  return {
    state,
    active,
    proposal,
    transition,
    history: history.map(({ record }) => activeReference(record)),
  };
}

function deriveSnapshot({ current, proposal, history }) {
  if (history.length === 0 && current === null && proposal === null) return uninitializedSnapshot();

  const head = history.at(-1) ?? null;
  if (proposal !== null && history.length === 0) {
    if (current !== null) throw integrityFailure('Initial proposal cannot coexist with current.json.');
    if (proposal.proposal.base !== null) throw integrityFailure('Initial proposal must not have a base goal.');
    return buildSnapshot('initial-proposed', { proposal: proposal.proposal, history });
  }

  if (head === null) throw integrityFailure('Goal store has current or proposal state without history.');
  if (current === null && proposal === null) throw integrityFailure('Goal store history has no current goal.');

  if (proposal !== null) {
    const candidateVersion = proposal.proposal.candidate.version;
    const candidateHistory = history[candidateVersion - 1] ?? null;
    const candidateInstalled = candidateHistory !== null
      && sameRecordBytes(proposal.proposal.candidate, candidateHistory);
    const predecessor = candidateVersion > 1 ? history[candidateVersion - 2] ?? null : null;
    if (candidateInstalled) {
      const predecessorCurrent = predecessor === null ? current === null : sameBytes(current, predecessor);
      const candidateCurrent = current !== null && sameBytes(current, candidateHistory);
      if (predecessorCurrent || candidateCurrent) {
        return buildSnapshot('transition-incomplete', {
          proposal: proposal.proposal,
          transition: {
            version: candidateVersion,
            history_installed: true,
            current_installed: candidateCurrent,
          },
          history,
        });
      }
    }

    if (current === null || !sameBytes(current, head)) {
      throw integrityFailure('Pending proposal does not align with current goal state.');
    }
    if (!sameGoalReference(proposal.proposal.base, activeReference(current.record))) {
      throw integrityFailure('Pending proposal base must match current.json.');
    }
    return buildSnapshot('change-proposed', { active: current.record, proposal: proposal.proposal, history });
  }

  if (current === null || !sameBytes(current, head)) {
    throw integrityFailure('current.json must be byte-identical to the latest history record.');
  }
  return buildSnapshot('active', { active: current.record, history });
}

export async function inspectGoalStore(root) {
  const directory = lockPath(root);
  if (!await assertRealDirectory(directory, GOAL_LOCK_DIRECTORY)) return uninitializedSnapshot();

  const rootEntries = await listRootEntries(directory);
  const current = rootEntries.includes(CURRENT_FILE)
    ? await readCanonicalGoalFile(path.join(directory, CURRENT_FILE), CURRENT_FILE)
    : null;
  const history = rootEntries.includes(HISTORY_DIRECTORY) ? await readHistory(directory) : [];

  let proposal = null;
  if (rootEntries.includes(PROPOSAL_FILE)) {
    proposal = await readProposalFromStore(path.join(directory, PROPOSAL_FILE), history, current);
  }

  return deriveSnapshot({ current, proposal, history });
}

async function ensureStoreDirectory(root) {
  const directory = lockPath(root);
  await mkdir(directory, { recursive: true });
  if (!await assertRealDirectory(directory, GOAL_LOCK_DIRECTORY)) {
    throw integrityFailure('.goal-lock could not be created.');
  }
  return directory;
}

async function ensureHistoryDirectory(root) {
  const directory = await ensureStoreDirectory(root);
  const historyPath = path.join(directory, HISTORY_DIRECTORY);
  await mkdir(historyPath, { recursive: true });
  if (!await assertRealDirectory(historyPath, 'history')) {
    throw integrityFailure('history could not be created.');
  }
  return historyPath;
}

async function durableReplace(target, bytes) {
  const directory = path.dirname(target);
  const stage = path.join(directory, `.${path.basename(target)}.${randomUUID()}.stage`);
  let handle;
  try {
    // 同目录临时文件加 fsync 后再 rename，保证跨崩溃时只暴露旧文件或完整新文件。
    handle = await open(stage, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(stage, target);
    assertBytesEqual(await readFile(target), bytes, `${path.basename(target)} replacement`);
  } catch (error) {
    if (handle !== undefined && handle !== null) await handle.close().catch(() => {});
    await unlink(stage).catch(() => {});
    throw error;
  }
}

function assertBytesEqual(actual, expected, label) {
  if (!actual.equals(expected)) throw integrityFailure(`${label} did not persist exact bytes.`);
}

export async function replaceProposal(root, proposal) {
  const directory = await ensureStoreDirectory(root);
  const current = await readCanonicalGoalFile(path.join(directory, CURRENT_FILE), CURRENT_FILE);
  const verified = verifyProposal(proposal, current?.record ?? null);
  await durableReplace(path.join(directory, PROPOSAL_FILE), canonicalBytes(verified));
}

export async function replaceCurrentRecord(root, record, context = {}) {
  const directory = await ensureStoreDirectory(root);
  const verified = verifyGoalRecord(record);
  await durableReplace(path.join(directory, CURRENT_FILE), canonicalBytes(verified));
  await context.storeFaults?.afterCurrentReplace?.({ record: verified });
}

export async function createHistoryRecord(root, record, context = {}) {
  const historyPath = await ensureHistoryDirectory(root);
  const verified = verifyGoalRecord(record);
  const target = path.join(historyPath, historyFilename(verified.version));
  let handle;
  try {
    // 历史记录是版本证据，使用 wx 直接创建，任何重放或覆盖都必须失败关闭。
    handle = await open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    const bytes = canonicalBytes(verified);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    assertBytesEqual(await readFile(target), bytes, `history/${historyFilename(verified.version)}`);
  } catch (error) {
    if (handle !== undefined && handle !== null) await handle.close().catch(() => {});
    if (error?.code === 'EEXIST') {
      throw integrityFailure(`history/${historyFilename(verified.version)} already exists.`, error);
    }
    throw error;
  }
  await context.storeFaults?.afterHistoryCreate?.({ record: verified });
}

export async function removeProposal(root, expectedProposalDigest) {
  const target = lockPath(root, PROPOSAL_FILE);
  const snapshot = await inspectGoalStore(root);
  if (snapshot.proposal === null) throw integrityFailure('proposal.json is missing.');
  if (snapshot.proposal.proposal_digest !== expectedProposalDigest) {
    throw integrityFailure('proposal.json digest does not match the expected approval digest.');
  }
  // 删除前按期望摘要重读并验证，避免调用方误删已经被替换的新提案。
  await unlink(target);
  const status = await pathStatus(target);
  if (status !== null) throw integrityFailure('proposal.json still exists after deletion.');
}
