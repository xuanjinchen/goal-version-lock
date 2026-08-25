import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, realpath, rename, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';

import { canonicalBytes, parseCanonicalJson, sha256 } from './canonical.js';
import { GoalLockError } from './contracts.js';

const LOCK_PROTOCOL = 'goal-version-lock-write-v1';
const TRANSACTION_PROTOCOL = 'goal-version-lock-transaction-v1';
const TRANSACTION_FILE = '.transaction.json';
const AUTO_LOCKED_TRANSACTION = Symbol('auto-locked transaction');
const LOCK_CAPABILITY = Symbol('goal-version-lock capability');
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const TRANSACTION_ID_PATTERN = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;

function lockIntegrity(message, options = {}) {
  return new GoalLockError('LOCK_OWNERSHIP', 'integrity', 4, message, options);
}

function pathIntegrity(message, options = {}) {
  return new GoalLockError('UNSAFE_TRANSACTION_PATH', 'integrity', 4, message, options);
}

function transactionIntegrity(message, options = {}) {
  return new GoalLockError('TRANSACTION_OWNERSHIP', 'integrity', 4, message, options);
}

function recoveryIntegrity(code, message, options = {}) {
  return new GoalLockError(code, 'integrity', 4, message, options);
}

function comparablePath(target) {
  const resolved = path.resolve(target);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function validateCanonicalDirectory(target, label) {
  const resolved = path.resolve(target);
  const stat = await lstat(resolved, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw pathIntegrity(`${label} must be a real directory without a symbolic link or junction.`);
  }
  if (comparablePath(await realpath(resolved)) !== comparablePath(resolved)) {
    throw pathIntegrity(`${label} must resolve to its canonical path.`);
  }
  return resolved;
}

function resolveGoalTarget(root, target) {
  if (typeof target !== 'string'
    || !target.startsWith('.goal-lock/')
    || target.includes('\\')
    || path.isAbsolute(target)
    || path.win32.isAbsolute(target)) {
    throw pathIntegrity('Transaction targets must be normalized beneath .goal-lock/.');
  }
  const segments = target.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw pathIntegrity('Transaction targets must not contain empty, dot, or parent segments.');
  }
  // 保留名在任意层级都代表内部所有权状态，不能借“作为目录”绕过末段检查。
  const hasInternalSegment = segments.slice(1).some((segment) => segment === '.write-lock.json'
    || segment === TRANSACTION_FILE
    || segment.endsWith('.stage')
    || segment.endsWith('.backup')
    || segment.endsWith('.detached'));
  if (hasInternalSegment) {
    throw pathIntegrity('Transaction targets must not name internal ownership artifacts.');
  }
  const absolute = path.resolve(root, ...segments);
  const relative = path.relative(root, absolute);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw pathIntegrity('Transaction target escaped the repository root.');
  }
  return absolute;
}

function relativeTransactionPath(root, target) {
  return path.relative(root, target).split(path.sep).join('/');
}

function transactionArtifactPath(root, entry, transactionId, index, suffix) {
  return path.join(
    path.dirname(entry.absolute),
    `.${path.basename(entry.absolute)}.${transactionId}.${index}.${suffix}`,
  );
}

function assertTransactionId(transactionId) {
  if (typeof transactionId !== 'string' || !TRANSACTION_ID_PATTERN.test(transactionId)) {
    throw transactionIntegrity('Transaction IDs must use only alphanumeric tokens separated by single hyphens.');
  }
}

function journalEntryFor(root, entry) {
  return {
    target: entry.target,
    original: entry.original === null
      ? { kind: 'absent' }
      : { kind: 'sha256', digest: entry.original.digest },
    intended: entry.content === null
      ? { kind: 'absent' }
      : { kind: 'sha256', digest: sha256(entry.content) },
    stage: entry.stage ? relativeTransactionPath(root, entry.stage) : null,
    backup: entry.backup ? relativeTransactionPath(root, entry.backup) : null,
  };
}

async function writeDurableFile(target, bytes) {
  const handle = await open(target, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function installJournal(goalLockDirectory, journal, replace = false, context = {}) {
  const target = path.join(goalLockDirectory, TRANSACTION_FILE);
  const stage = path.join(goalLockDirectory, `.${TRANSACTION_FILE}.${journal.transaction_id}.${journal.state}.stage`);
  await writeDurableFile(stage, canonicalBytes(journal));
  try {
    if (!replace && await optionalLstat(target)) {
      throw transactionIntegrity('A durable transaction journal already exists.');
    }
    await rename(stage, target);
    await invokeFault(context, replace ? 'afterJournalStateReplace' : 'afterJournalPreparedInstall', {
      journal: target,
      state: journal.state,
    });
  } catch (error) {
    await unlink(stage).catch(() => {});
    throw error;
  }
  return target;
}

async function validateJournalObject(value, root, owner, journalDigest) {
  const fields = ['protocol', 'transaction_id', 'state', 'owner_token', 'lock_digest', 'entries'];
  if (value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.keys(value).length !== fields.length
    || fields.some((field) => !Object.hasOwn(value, field))
    || value.protocol !== TRANSACTION_PROTOCOL
    || typeof value.transaction_id !== 'string'
    || !TRANSACTION_ID_PATTERN.test(value.transaction_id)
    || !['prepared', 'committed'].includes(value.state)
    || value.owner_token !== owner.token
    || value.lock_digest !== owner.transaction?.lock_digest
    || !Array.isArray(value.entries)
    || value.entries.length === 0
    || owner.transaction?.transaction_id !== value.transaction_id
    || owner.transaction?.lock_digest !== value.lock_digest
    || owner.transaction?.[`${value.state}_digest`] !== journalDigest) {
    throw transactionIntegrity('Durable transaction journal is malformed or belongs to another writer.');
  }
  const seenTargets = new Set();
  const entries = [];
  for (const [index, entry] of value.entries.entries()) {
    const entryFields = ['target', 'original', 'intended', 'stage', 'backup'];
    if (entry === null
      || typeof entry !== 'object'
      || Array.isArray(entry)
      || Object.keys(entry).length !== entryFields.length
      || entryFields.some((field) => !Object.hasOwn(entry, field))) {
      throw transactionIntegrity('Durable transaction journal entry is malformed.');
    }
    validateExpected(entry.original);
    validateExpected(entry.intended);
    const absolute = resolveGoalTarget(root, entry.target);
    const targetKey = comparablePath(absolute);
    if (seenTargets.has(targetKey)) {
      throw transactionIntegrity(`Durable transaction journal repeats target: ${entry.target}`);
    }
    seenTargets.add(targetKey);
    await assertSafeAncestors(root, absolute);
    const expectedStage = entry.intended.kind === 'sha256'
      ? transactionArtifactPath(root, { absolute }, value.transaction_id, index, 'stage')
      : null;
    const expectedBackup = entry.original.kind === 'sha256'
      ? transactionArtifactPath(root, { absolute }, value.transaction_id, index, 'backup')
      : null;
    const stage = entry.stage === null ? null : path.resolve(root, ...entry.stage.split('/'));
    const backup = entry.backup === null ? null : path.resolve(root, ...entry.backup.split('/'));
    if ((expectedStage === null ? stage !== null : comparablePath(stage) !== comparablePath(expectedStage))
      || (expectedBackup === null ? backup !== null : comparablePath(backup) !== comparablePath(expectedBackup))) {
      throw transactionIntegrity('Durable transaction journal artifact paths do not match their target.');
    }
    // 目标与每个派生工件都独立验证祖先，避免有效目标借工件路径绕过链接检查。
    if (stage) await assertSafeAncestors(root, stage);
    if (backup) await assertSafeAncestors(root, backup);
    entries.push({ ...entry, absolute, stage, backup });
  }
  return { ...value, entries };
}

async function readDurableJournal(root, goalLockDirectory, owner) {
  const target = path.join(goalLockDirectory, TRANSACTION_FILE);
  const input = await optionalTransactionFile(target, 'Durable transaction journal');
  if (!input) return null;
  let value;
  try {
    value = parseCanonicalJson(input.bytes, 'durable transaction journal');
  } catch (error) {
    throw transactionIntegrity('Durable transaction journal is malformed.', { cause: error });
  }
  return { target, input, value: await validateJournalObject(value, root, owner, input.digest) };
}

async function removeOwnedArtifact(target, expectedDigest, label) {
  if (target === null) return;
  const actual = await optionalTransactionFile(target, label);
  if (!actual) return;
  if (actual.digest !== expectedDigest) throw transactionIntegrity(`${label} digest changed.`);
  await unlink(target);
}

async function rollbackDurableJournal(journal, context = {}) {
  for (const [reverseIndex, entry] of journal.value.entries.toReversed().entries()) {
    const index = journal.value.entries.length - 1 - reverseIndex;
    await invokeFault(context, 'rollback', { index, target: entry.target });
    const target = await optionalTransactionFile(entry.absolute, 'Transaction recovery target');
    let backup = null;
    if (entry.original.kind === 'sha256') {
      backup = await optionalTransactionFile(entry.backup, 'Transaction recovery backup');
      if (!target || entry.intended.kind === 'sha256' && target.digest === entry.intended.digest) {
        if (!backup || backup.digest !== entry.original.digest) {
          throw transactionIntegrity(`Transaction recovery backup is missing or changed: ${entry.target}`);
        }
        // rename 将旧 inode 原子放回权威名称，恢复过程中不会再次暴露缺失目标窗口。
        await rename(entry.backup, entry.absolute);
        await invokeFault(context, 'afterRollbackRestore', { index, target: entry.target });
      } else if (target.digest === entry.original.digest) {
        if (backup) {
          if (backup.digest !== entry.original.digest) {
            throw transactionIntegrity(`Transaction recovery backup is changed: ${entry.target}`);
          }
          await unlink(entry.backup);
          await invokeFault(context, 'afterRollbackBackupRemove', { index, target: entry.target });
        }
      } else {
        throw transactionIntegrity(`Transaction recovery refused to overwrite an unknown target: ${entry.target}`);
      }
      const restored = await readTransactionFile(entry.absolute, 'Restored transaction target');
      if (restored.digest !== entry.original.digest) {
        throw transactionIntegrity(`Transaction recovery restore verification failed: ${entry.target}`);
      }
    } else if (target) {
      if (entry.intended.kind !== 'sha256' || target.digest !== entry.intended.digest) {
        throw transactionIntegrity(`Transaction recovery refused to remove an unknown target: ${entry.target}`);
      }
      await unlink(entry.absolute);
      await invokeFault(context, 'afterRollbackTargetRemove', { index, target: entry.target });
    }
    if (entry.stage) {
      const stage = await optionalTransactionFile(entry.stage, 'Transaction recovery stage');
      if (stage) {
        const currentTarget = await optionalTransactionFile(entry.absolute, 'Transaction recovery target');
        const remainingBackup = entry.backup
          ? await optionalTransactionFile(entry.backup, 'Transaction recovery backup')
          : null;
        const targetIsOriginal = entry.original.kind === 'sha256'
          ? currentTarget?.digest === entry.original.digest && !remainingBackup
          : currentTarget === null;
        // 已绑定 journal 而尚未写入的独占空 stage 没有业务字节；只在权威目标仍是原态时允许清理。
        if (stage.digest !== entry.intended.digest && !(stage.snapshot.size === 0n && targetIsOriginal)) {
          throw transactionIntegrity('Transaction recovery stage digest changed.');
        }
        await unlink(entry.stage);
        await invokeFault(context, 'afterRollbackStageRemove', { index, target: entry.target });
      }
    }
  }
  await unlink(journal.target);
  await invokeFault(context, 'afterRollbackJournalRemove', { journal: journal.target });
}

async function finishCommittedJournal(journal, context = {}) {
  for (const entry of journal.value.entries) {
    const target = await optionalTransactionFile(entry.absolute, 'Committed recovery target');
    if (entry.intended.kind === 'absent' ? target !== null : !target || target.digest !== entry.intended.digest) {
      throw transactionIntegrity(`Committed transaction target does not match the journal: ${entry.target}`);
    }
  }
  for (const [reverseIndex, entry] of journal.value.entries.toReversed().entries()) {
    const index = journal.value.entries.length - 1 - reverseIndex;
    if (entry.backup && await optionalTransactionFile(entry.backup, 'Committed transaction backup')) {
      await removeOwnedArtifact(entry.backup, entry.original.digest, 'Committed transaction backup');
      await invokeFault(context, 'afterCommittedBackupRemove', { index, target: entry.target });
    }
    if (entry.stage && await optionalTransactionFile(entry.stage, 'Committed transaction stage')) {
      await removeOwnedArtifact(entry.stage, entry.intended.digest, 'Committed transaction stage');
      await invokeFault(context, 'afterCommittedStageRemove', { index, target: entry.target });
    }
  }
  await unlink(journal.target);
  await invokeFault(context, 'afterCommittedJournalRemove', { journal: journal.target });
}

async function optionalLstat(target) {
  try {
    return await lstat(target, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function assertSafeAncestors(root, target) {
  const relative = path.relative(root, path.dirname(target));
  let current = root;
  for (const segment of relative === '' ? [] : relative.split(path.sep)) {
    current = path.join(current, segment);
    const stat = await optionalLstat(current);
    if (!stat) return;
    await validateCanonicalDirectory(current, 'Transaction target ancestor');
  }
}

async function ensureParentDirectories(root, target, createdDirectories) {
  const relative = path.relative(root, path.dirname(target));
  let current = root;
  for (const segment of relative === '' ? [] : relative.split(path.sep)) {
    current = path.join(current, segment);
    const stat = await optionalLstat(current);
    if (!stat) {
      await mkdir(current);
      const created = await lstat(current, { bigint: true });
      createdDirectories.push({ path: current, snapshot: created });
    }
    await validateCanonicalDirectory(current, 'Transaction target ancestor');
  }
}

async function readTransactionFile(target, label) {
  const namedBefore = await lstat(target, { bigint: true });
  if (namedBefore.isSymbolicLink() || !namedBefore.isFile()) {
    throw transactionIntegrity(`${label} must be a regular file.`);
  }
  const handle = await open(target, 'r');
  try {
    const openedBefore = await handle.stat({ bigint: true });
    if (!sameIdentity(namedBefore, openedBefore)) {
      throw transactionIntegrity(`${label} identity changed while opening.`);
    }
    const bytes = await handle.readFile();
    const openedAfter = await handle.stat({ bigint: true });
    const namedAfter = await lstat(target, { bigint: true });
    if (!sameSnapshot(openedBefore, openedAfter) || !sameSnapshot(openedAfter, namedAfter)) {
      throw transactionIntegrity(`${label} changed while reading.`);
    }
    return { bytes, digest: sha256(bytes), snapshot: namedAfter };
  } finally {
    await handle.close();
  }
}

async function cleanupPreparedArtifacts(prepared) {
  const failures = [];
  // 仅清理仍能绑定到本事务 inode/摘要的工件；所有权不确定时原地保留恢复证据。
  for (const entry of prepared.toReversed()) {
    if (entry.backup) {
      try {
        const backup = await readTransactionFile(entry.backup, 'Transaction backup');
        const target = await readTransactionFile(entry.absolute, 'Transaction target');
        if (!sameIdentity(backup.snapshot, entry.original.snapshot)
          || !sameIdentity(target.snapshot, entry.original.snapshot)
          || backup.digest !== entry.original.digest
          || target.digest !== entry.original.digest) {
          throw transactionIntegrity(`Transaction backup cleanup cannot prove ownership: ${entry.target}`);
        }
        await unlink(entry.backup);
        entry.backup = null;
      } catch (error) {
        failures.push(error);
      }
    }
    if (!entry.stage) continue;
    try {
      const actual = await readTransactionFile(entry.stage, 'Transaction stage');
      if (!sameIdentity(actual.snapshot, entry.stageIdentity)) {
        throw transactionIntegrity(`Transaction stage ownership changed: ${entry.target}`);
      }
      if (entry.staged && actual.digest !== entry.staged.digest) {
        throw transactionIntegrity(`Transaction stage digest changed: ${entry.target}`);
      }
      await unlink(entry.stage);
      entry.stage = null;
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

async function cleanupCreatedDirectories(createdDirectories) {
  const failures = [];
  for (const created of createdDirectories.toReversed()) {
    try {
      const actual = await lstat(created.path, { bigint: true });
      if (!sameIdentity(actual, created.snapshot) || !actual.isDirectory() || actual.isSymbolicLink()) {
        throw transactionIntegrity(`Created directory ownership changed: ${created.path}`);
      }
      await rmdir(created.path);
    } catch (error) {
      if (error?.code !== 'ENOENT') failures.push(error);
    }
  }
  return failures;
}

async function optionalTransactionFile(target, label) {
  try {
    return await readTransactionFile(target, label);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function rollbackEntries(prepared, context) {
  const failures = [];
  // 已触及目标按提交逆序撤销，使每一步都回到它提交前所见的前序状态。
  for (const [reverseIndex, entry] of prepared.toReversed().entries()) {
    if (!entry.detached && !entry.installed) continue;
    const index = prepared.length - 1 - reverseIndex;
    try {
      await invokeFault(context, 'rollback', { index, target: entry.target });
      if (entry.installed) {
        const installed = await optionalTransactionFile(entry.absolute, 'Installed transaction target');
        if (installed) {
          if (!sameIdentity(installed.snapshot, entry.staged.snapshot) || installed.digest !== entry.staged.digest) {
            throw transactionIntegrity(`Rollback cannot prove installed target ownership: ${entry.target}`);
          }
          await unlink(entry.absolute);
        }
        // 安装名已消失时仍继续验证备份并用独占 link 恢复；名称被抢占则保留证据而不覆盖。
        entry.installed = false;
      }
      if (entry.detached) {
        const occupant = await optionalTransactionFile(entry.absolute, 'Transaction rollback target');
        if (occupant) {
          throw transactionIntegrity(`Rollback refused to overwrite a changed target: ${entry.target}`);
        }
        const backup = await readTransactionFile(entry.backup, 'Transaction backup');
        if (!sameIdentity(backup.snapshot, entry.original.snapshot) || backup.digest !== entry.original.digest) {
          throw transactionIntegrity(`Rollback backup ownership changed: ${entry.target}`);
        }
        await link(entry.backup, entry.absolute);
        const restored = await readTransactionFile(entry.absolute, 'Restored transaction target');
        if (!sameIdentity(restored.snapshot, entry.original.snapshot) || restored.digest !== entry.original.digest) {
          throw transactionIntegrity(`Rollback restore verification failed: ${entry.target}`);
        }
        entry.detached = false;
      }
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

async function cleanupBackups(prepared) {
  const failures = [];
  for (const entry of prepared.toReversed()) {
    if (!entry.backup) continue;
    try {
      const backup = await readTransactionFile(entry.backup, 'Transaction backup');
      if (!sameIdentity(backup.snapshot, entry.original.snapshot) || backup.digest !== entry.original.digest) {
        throw transactionIntegrity(`Transaction backup ownership changed: ${entry.target}`);
      }
      await unlink(entry.backup);
      entry.backup = null;
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

function validateExpected(expected) {
  if (expected?.kind === 'absent' && Object.keys(expected).length === 1) return;
  if (expected?.kind === 'sha256'
    && Object.keys(expected).length === 2
    && SHA256_PATTERN.test(expected.digest ?? '')) return;
  throw new GoalLockError('INVALID_TRANSACTION', 'input', 2, 'Transaction expected ownership is invalid.');
}

async function isOwnerProcessAlive(pid, context) {
  if (typeof context.isProcessAlive === 'function') {
    try {
      return await context.isProcessAlive(pid) !== false;
    } catch (error) {
      if (error?.code === 'ESRCH') return false;
      throw recoveryIntegrity('RECOVERY_PROCESS_UNKNOWN', 'Lock owner process state is inaccessible or indeterminate.', { cause: error });
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    if (error?.code === 'EPERM') return true;
    throw recoveryIntegrity('RECOVERY_PROCESS_UNKNOWN', 'Lock owner process state is inaccessible or indeterminate.', { cause: error });
  }
}

function validateRecoveryProof(proof) {
  if (proof === null
    || typeof proof !== 'object'
    || Array.isArray(proof)
    || Object.keys(proof).length !== 2
    || typeof proof.owner_token !== 'string'
    || proof.owner_token.length === 0
    || !SHA256_PATTERN.test(proof.lock_digest ?? '')) {
    throw new GoalLockError('INVALID_RECOVERY_PROOF', 'input', 2, 'Recovery requires exact owner_token and lock_digest values.');
  }
}

export async function recoverGoalLock(root, proof, context = {}) {
  validateRecoveryProof(proof);
  const canonicalRoot = await validateCanonicalDirectory(root, 'Repository root');
  let goalLockDirectory;
  try {
    goalLockDirectory = await validateCanonicalDirectory(path.join(canonicalRoot, '.goal-lock'), 'Goal-lock directory');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw recoveryIntegrity('RECOVERY_LOCK_MISSING', 'Cooperative lock is missing; recovery was refused.', { cause: error });
    }
    throw error;
  }
  const lockPath = path.join(goalLockDirectory, '.write-lock.json');

  let initial;
  try {
    initial = await readRegularFile(lockPath, 'Cooperative lock');
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw recoveryIntegrity('RECOVERY_LOCK_MISSING', 'Cooperative lock is missing; recovery was refused.', { cause: error });
    }
    throw error;
  }
  const owner = parseOwner(initial);
  if (initial.digest !== proof.lock_digest || owner.token !== proof.owner_token) {
    throw recoveryIntegrity('RECOVERY_PROOF_MISMATCH', 'Recovery proof does not match the cooperative lock.');
  }
  if (await isOwnerProcessAlive(owner.pid, context)) {
    throw recoveryIntegrity('RECOVERY_PROCESS_ACTIVE', 'Lock owner process is active or cannot be proven dead.');
  }

  const journal = await readDurableJournal(canonicalRoot, goalLockDirectory, {
    token: owner.token,
    digest: initial.digest,
    transaction: owner.transaction,
  });
  if (journal) {
    // stale-lock 恢复必须先收敛事务，再移除写锁；反向顺序会把部分安装状态暴露成可接受仓库。
    if (journal.value.state === 'prepared') await rollbackDurableJournal(journal, context);
    else await finishCommittedJournal(journal, context);
  }

  await invokeFault(context, 'beforeRecoveryDetach', { lockPath });
  const recoveryPath = path.join(goalLockDirectory, `.write-lock.json.${(context.randomToken ?? randomUUID)()}.recovery.backup`);
  await link(lockPath, recoveryPath);
  let detached = false;
  try {
    const isolated = await readRegularFile(recoveryPath, 'Recovery lock evidence', { expectedLinks: 2n });
    const current = await readRegularFile(lockPath, 'Cooperative lock', { expectedLinks: 2n });
    assertOwner(isolated, { digest: initial.digest, snapshot: initial.snapshot, token: owner.token });
    assertOwner(current, { digest: initial.digest, snapshot: initial.snapshot, token: owner.token });
    // 只有同一 inode 的隔离副本验证完成后才转移路径所有权，失败时绝不覆盖后来出现的锁。
    await unlink(lockPath);
    detached = true;
    await invokeFault(context, 'afterRecoveryDetach', { lockPath, recoveryPath });

    const detachedLock = await readRegularFile(recoveryPath, 'Recovery lock evidence');
    assertOwner(detachedLock, { digest: initial.digest, snapshot: initial.snapshot, token: owner.token });
    if (await isOwnerProcessAlive(owner.pid, context)) {
      throw recoveryIntegrity('RECOVERY_PROCESS_ACTIVE', 'Lock owner process became active during recovery.');
    }
    await unlink(recoveryPath);
    return { recovered: true, pid: owner.pid, command: owner.command, created_at: owner.created_at };
  } catch (recoveryError) {
    let restorationError;
    try {
      if (detached && !(await optionalLstat(lockPath))) {
        const recoveryEvidence = await readRegularFile(recoveryPath, 'Recovery lock evidence');
        assertOwner(recoveryEvidence, { digest: initial.digest, snapshot: initial.snapshot, token: owner.token });
        await link(recoveryPath, lockPath);
        const restored = await readRegularFile(lockPath, 'Restored cooperative lock', { expectedLinks: 2n });
        assertOwner(restored, { digest: initial.digest, snapshot: initial.snapshot, token: owner.token });
        const linkedEvidence = await readRegularFile(recoveryPath, 'Recovery lock evidence', { expectedLinks: 2n });
        assertOwner(linkedEvidence, { digest: initial.digest, snapshot: initial.snapshot, token: owner.token });
        await unlink(recoveryPath);
        const restoredOwner = await readRegularFile(lockPath, 'Restored cooperative lock');
        assertOwner(restoredOwner, { digest: initial.digest, snapshot: initial.snapshot, token: owner.token });
      } else if (!detached) {
        const evidence = await readRegularFile(recoveryPath, 'Recovery lock evidence', { expectedLinks: 2n });
        const current = await readRegularFile(lockPath, 'Cooperative lock', { expectedLinks: 2n });
        // 未发生路径转移时，仅删除仍与当前锁同 inode 的临时硬链接，无法证明则保留证据。
        if (sameIdentity(evidence.snapshot, current.snapshot) && evidence.digest === current.digest) {
          await unlink(recoveryPath);
          await readRegularFile(lockPath, 'Cooperative lock');
        } else {
          throw lockIntegrity('Recovery evidence ownership became uncertain.');
        }
      }
    } catch (error) {
      restorationError = error;
    }
    if (restorationError) {
      throw new AggregateError(
        [recoveryError, restorationError],
        'Lock recovery stopped and verified restoration was not possible; recovery evidence was retained.',
        { cause: recoveryError },
      );
    }
    throw recoveryError;
  }
}

export async function commitGoalFiles(root, entries, context = {}) {
  const canonicalRoot = await validateCanonicalDirectory(root, 'Repository root');
  if (!Array.isArray(entries)) {
    throw new GoalLockError('INVALID_TRANSACTION', 'input', 2, 'Transaction entries must be an array.');
  }
  if (context[AUTO_LOCKED_TRANSACTION] !== true && !context[LOCK_CAPABILITY]) {
    const goalLockDirectory = path.join(canonicalRoot, '.goal-lock');
    const directoryWasAbsent = !(await optionalLstat(goalLockDirectory));
    try {
      return await withGoalLock(canonicalRoot, 'transaction', (ownership) => commitGoalFiles(canonicalRoot, entries, {
        ...context,
        [AUTO_LOCKED_TRANSACTION]: true,
        ...ownership,
      }), context);
    } finally {
      if (directoryWasAbsent) await rmdir(goalLockDirectory).catch((error) => {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error?.code)) throw error;
      });
    }
  }

  const goalLockDirectory = path.join(canonicalRoot, '.goal-lock');
  const lockPath = path.join(goalLockDirectory, '.write-lock.json');
  const lock = await requireLockCapability(lockPath, context);

  const prepared = [];
  const seenTargets = new Set();
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new GoalLockError('INVALID_TRANSACTION', 'input', 2, 'Each transaction entry must be an object.');
    }
    const entryFields = ['target', 'expected', 'content'];
    if (Object.keys(entry).length !== entryFields.length || entryFields.some((field) => !Object.hasOwn(entry, field))) {
      throw new GoalLockError('INVALID_TRANSACTION', 'input', 2, 'Each transaction entry must contain exactly target, expected, and content.');
    }
    validateExpected(entry.expected);
    if (!Buffer.isBuffer(entry.content) && entry.content !== null) {
      throw new GoalLockError('INVALID_TRANSACTION', 'input', 2, 'Transaction content must be a Buffer or null.');
    }
    const absolute = resolveGoalTarget(canonicalRoot, entry.target);
    const targetKey = comparablePath(absolute);
    if (seenTargets.has(targetKey)) {
      throw transactionIntegrity(`Duplicate transaction target: ${entry.target}`);
    }
    seenTargets.add(targetKey);
    await assertSafeAncestors(canonicalRoot, absolute);
    const stat = await optionalLstat(absolute);
    if (!stat && entry.expected.kind === 'sha256') {
      throw transactionIntegrity(`Expected transaction target is missing: ${entry.target}`);
    }
    if (stat && entry.expected.kind === 'absent') {
      throw transactionIntegrity(`Expected transaction target to be absent: ${entry.target}`);
    }
    let original = null;
    if (stat) {
      original = await readTransactionFile(absolute, 'Transaction target');
      if (original.digest !== entry.expected.digest) {
        throw transactionIntegrity(`Transaction target digest changed: ${entry.target}`);
      }
    }
    // 相同字节是只读所有权前提而非替换操作，保留 inode 才能在末次复核发现并发修改。
    const readOnly = original !== null && entry.content !== null && original.bytes.equals(entry.content);
    prepared.push({ ...entry, absolute, original, readOnly });
  }

  const transactionId = (context.randomToken ?? randomUUID)();
  assertTransactionId(transactionId);
  const createdDirectories = [];
  const mutable = prepared.filter((entry) => !entry.readOnly);
  let journal = null;
  let journalBinding = null;
  try {
    for (const [transactionIndex, entry] of mutable.entries()) {
      entry.transactionIndex = transactionIndex;
      if (entry.content !== null) {
        entry.stage = transactionArtifactPath(canonicalRoot, entry, transactionId, transactionIndex, 'stage');
      }
      if (entry.original) {
        entry.backup = transactionArtifactPath(canonicalRoot, entry, transactionId, transactionIndex, 'backup');
      }
    }

    if (mutable.length > 0) {
      const journalValue = {
        protocol: TRANSACTION_PROTOCOL,
        transaction_id: transactionId,
        state: 'prepared',
        owner_token: lock.owner.token,
        // 该摘要固定写入者最初持有的锁；绑定记录再把两个精确 journal 字节摘要固定到当前锁。
        lock_digest: lock.input.digest,
        entries: mutable.map((entry) => journalEntryFor(canonicalRoot, entry)),
      };
      const committedValue = { ...journalValue, state: 'committed' };
      const transaction = {
        transaction_id: transactionId,
        lock_digest: lock.input.digest,
        prepared_digest: sha256(canonicalBytes(journalValue)),
        committed_digest: sha256(canonicalBytes(committedValue)),
      };
      const bound = await replaceOwnedLock(lockPath, lock.expected, lock.owner, transaction, context);
      lock.input = bound.input;
      lock.owner = bound.owner;
      journalBinding = transaction;
      const target = await installJournal(goalLockDirectory, journalValue, false, context);
      journal = {
        target,
        raw: journalValue,
        value: await validateJournalObject(journalValue, canonicalRoot, lock.owner, transaction.prepared_digest),
      };
    }

    for (const entry of mutable) {
      const index = prepared.indexOf(entry);
      if (entry.content === null) continue;
      await ensureParentDirectories(canonicalRoot, entry.absolute, createdDirectories);
      const handle = await open(entry.stage, 'wx', 0o600);
      try {
        entry.stageIdentity = await handle.stat({ bigint: true });
        await invokeFault(context, 'afterStageCreate', { index, target: entry.target, stage: entry.stage });
        await invokeFault(context, 'stageWrite', { index, target: entry.target, stage: entry.stage });
        await handle.writeFile(entry.content);
        await handle.sync();
        const stageSnapshot = await handle.stat({ bigint: true });
        entry.staged = await readTransactionFile(entry.stage, 'Transaction stage');
        if (!sameSnapshot(entry.staged.snapshot, stageSnapshot) || entry.staged.digest !== sha256(entry.content)) {
          throw transactionIntegrity(`Transaction stage verification failed: ${entry.target}`);
        }
      } finally {
        await handle.close();
      }
    }

    for (const entry of mutable) {
      const index = prepared.indexOf(entry);
      if (entry.original) {
        await link(entry.absolute, entry.backup);
        await invokeFault(context, 'afterBackupCreate', { index, target: entry.target, backup: entry.backup });
        const backedUp = await readTransactionFile(entry.backup, 'Transaction backup');
        const current = await readTransactionFile(entry.absolute, 'Transaction target');
        if (!sameIdentity(backedUp.snapshot, entry.original.snapshot)
          || !sameIdentity(current.snapshot, entry.original.snapshot)
          || backedUp.digest !== entry.original.digest
          || current.digest !== entry.original.digest) {
          throw transactionIntegrity(`Transaction target ownership changed before detach: ${entry.target}`);
        }
      }
    }

    for (const entry of mutable) {
      const index = prepared.indexOf(entry);
      if (entry.original) {
        await invokeFault(context, 'detach', { index, target: entry.target, backup: entry.backup });
      }
      if (entry.content !== null) {
        await invokeFault(context, 'install', { index, target: entry.target, stage: entry.stage });
        // 同文件系统 rename 是权威名称的唯一替换边界；原目标在任何可观察时刻都有旧或新 inode。
        await rename(entry.stage, entry.absolute);
        entry.installed = true;
        await invokeFault(context, 'readBack', { index, target: entry.target });
        const installed = await readTransactionFile(entry.absolute, 'Installed transaction target');
        if (!sameIdentity(installed.snapshot, entry.staged.snapshot) || installed.digest !== entry.staged.digest) {
          throw transactionIntegrity(`Transaction install verification failed: ${entry.target}`);
        }
      } else {
        await invokeFault(context, 'install', { index, target: entry.target, stage: null });
        await unlink(entry.absolute);
        entry.installed = true;
        await invokeFault(context, 'readBack', { index, target: entry.target });
      }
    }

    await invokeFault(context, 'finalReadBack', { targets: prepared.map((entry) => entry.target) });
    for (const entry of prepared) {
      const actual = await optionalTransactionFile(entry.absolute, 'Committed transaction target');
      if (entry.readOnly
        ? !actual || !sameIdentity(actual.snapshot, entry.original.snapshot) || actual.digest !== entry.original.digest
        : entry.content === null ? actual !== null : !actual
        || actual && (!sameIdentity(actual.snapshot, entry.staged.snapshot) || actual.digest !== entry.staged.digest)) {
        throw transactionIntegrity(`Final transaction verification failed: ${entry.target}`);
      }
    }
    if (journal) {
      const committedValue = { ...journal.raw, state: 'committed' };
      await installJournal(goalLockDirectory, committedValue, true, context);
      journal = {
        target: journal.target,
        raw: committedValue,
        value: await validateJournalObject(committedValue, canonicalRoot, lock.owner, journalBinding.committed_digest),
      };
      await finishCommittedJournal(journal, context);
      journal = null;
      const unbound = await replaceOwnedLock(lockPath, lock.expected, lock.owner, null, context);
      lock.input = unbound.input;
      lock.owner = unbound.owner;
      journalBinding = null;
    }
  } catch (originalError) {
    const rollbackFailures = [];
    if (journal) {
      try {
        const durable = await readDurableJournal(canonicalRoot, goalLockDirectory, {
          token: lock.owner.token,
          digest: lock.input.digest,
          transaction: lock.owner.transaction,
        });
        if (!durable || durable.value.state !== 'prepared') {
          throw transactionIntegrity('Prepared transaction journal disappeared during rollback.');
        }
        await rollbackDurableJournal(durable, context);
        journal = null;
      } catch (error) {
        rollbackFailures.push(error);
      }
    }
    if (journal === null && journalBinding !== null) {
      try {
        const unbound = await replaceOwnedLock(lockPath, lock.expected, lock.owner, null, context);
        lock.input = unbound.input;
        lock.owner = unbound.owner;
        journalBinding = null;
      } catch (error) {
        rollbackFailures.push(error);
      }
    }
    const artifactFailures = journal === null ? [] : await cleanupPreparedArtifacts(prepared);
    const directoryFailures = await cleanupCreatedDirectories(createdDirectories);
    const failures = [...rollbackFailures, ...artifactFailures, ...directoryFailures];
    if (failures.length > 0) {
      throw new AggregateError([originalError, ...failures], 'Transaction failed and cleanup was incomplete.', { cause: originalError });
    }
    throw originalError;
  }
  return { warnings: [] };
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameSnapshot(left, right) {
  return sameIdentity(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs;
}

function isUtcTimestamp(value) {
  const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/.exec(value);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12
    && day >= 1 && day <= days[month - 1]
    && Number(hourText) <= 23
    && Number(minuteText) <= 59
    && Number(secondText) <= 59;
}

async function invokeFault(context, phase, details) {
  const fault = context.transactionFaults?.[phase];
  if (typeof fault === 'function') await fault(details);
}

async function readRegularFile(target, label, { expectedLinks = 1n } = {}) {
  const namedBefore = await lstat(target, { bigint: true });
  // 对外可见锁只能有一个名称；恢复流程必须显式声明其短暂创建的精确硬链接数。
  if (namedBefore.isSymbolicLink() || !namedBefore.isFile() || namedBefore.nlink !== expectedLinks) {
    throw lockIntegrity(`${label} must be a regular file with the expected link count.`);
  }

  const handle = await open(target, 'r');
  try {
    const openedBefore = await handle.stat({ bigint: true });
    if (!sameIdentity(namedBefore, openedBefore) || !openedBefore.isFile() || openedBefore.nlink !== expectedLinks) {
      throw lockIntegrity(`${label} identity changed while opening.`);
    }
    const bytes = await handle.readFile();
    const openedAfter = await handle.stat({ bigint: true });
    const namedAfter = await lstat(target, { bigint: true });
    if (!sameSnapshot(openedBefore, openedAfter)
      || !sameSnapshot(openedAfter, namedAfter)
      || openedAfter.nlink !== expectedLinks
      || namedAfter.nlink !== expectedLinks) {
      throw lockIntegrity(`${label} identity changed while reading.`);
    }
    return { bytes, digest: sha256(bytes), snapshot: namedAfter };
  } finally {
    await handle.close();
  }
}

function parseOwner(actual) {
  let owner;
  try {
    owner = parseCanonicalJson(actual.bytes, 'cooperative lock');
  } catch (error) {
    throw lockIntegrity('Cooperative lock bytes are malformed or noncanonical.', { cause: error });
  }
  const baseFields = ['protocol', 'token', 'pid', 'command', 'created_at'];
  const fields = owner?.transaction === undefined ? baseFields : [...baseFields, 'transaction'];
  if (owner === null
    || typeof owner !== 'object'
    || Array.isArray(owner)
    || Object.keys(owner).length !== fields.length
    || fields.some((field) => !Object.hasOwn(owner, field))
    || owner.protocol !== LOCK_PROTOCOL
    || typeof owner.token !== 'string'
    || owner.token.length === 0
    || !Number.isSafeInteger(owner.pid)
    || owner.pid < 1
    || typeof owner.command !== 'string'
    || owner.command.length === 0
    || owner.command.trim() !== owner.command
    || !isUtcTimestamp(owner.created_at)
    || (owner.transaction !== undefined && (owner.transaction === null
      || typeof owner.transaction !== 'object'
      || Array.isArray(owner.transaction)
      || Object.keys(owner.transaction).length !== 4
      || !Object.hasOwn(owner.transaction, 'transaction_id')
      || !Object.hasOwn(owner.transaction, 'lock_digest')
      || !Object.hasOwn(owner.transaction, 'prepared_digest')
      || !Object.hasOwn(owner.transaction, 'committed_digest')
      || !TRANSACTION_ID_PATTERN.test(owner.transaction.transaction_id)
      || !SHA256_PATTERN.test(owner.transaction.lock_digest)
      || !SHA256_PATTERN.test(owner.transaction.prepared_digest)
      || !SHA256_PATTERN.test(owner.transaction.committed_digest)))) {
    throw lockIntegrity('Cooperative lock owner record does not match the protocol.');
  }
  return owner;
}

function lockCapabilityFor(expected) {
  return { [LOCK_CAPABILITY]: expected };
}

async function requireLockCapability(lockPath, context) {
  const expected = context?.[LOCK_CAPABILITY];
  if (!expected || typeof expected !== 'object') {
    throw lockIntegrity('Transaction writes require the non-forgeable capability supplied by withGoalLock.');
  }
  const actual = await readRegularFile(lockPath, 'Cooperative lock');
  assertOwner(actual, expected);
  return { input: actual, owner: parseOwner(actual), expected };
}

async function replaceOwnedLock(lockPath, expected, owner, transaction, context) {
  const nextOwner = transaction === null ? {
    protocol: owner.protocol,
    token: owner.token,
    pid: owner.pid,
    command: owner.command,
    created_at: owner.created_at,
  } : { ...owner, transaction };
  const bytes = canonicalBytes(nextOwner);
  const stage = `${lockPath}.${randomUUID()}.binding.stage`;
  await writeDurableFile(stage, bytes);
  try {
    const current = await readRegularFile(lockPath, 'Cooperative lock');
    assertOwner(current, expected);
    await rename(stage, lockPath);
  } catch (error) {
    await unlink(stage).catch(() => {});
    throw error;
  }
  const input = await readRegularFile(lockPath, 'Bound cooperative lock');
  const parsed = parseOwner(input);
  const transactionMatches = transaction === null
    ? parsed.transaction === undefined
    : parsed.transaction?.transaction_id === transaction.transaction_id
      && parsed.transaction.lock_digest === transaction.lock_digest
      && parsed.transaction.prepared_digest === transaction.prepared_digest
      && parsed.transaction.committed_digest === transaction.committed_digest;
  if (parsed.token !== owner.token || !transactionMatches) {
    throw lockIntegrity('Cooperative lock journal binding changed during replacement.');
  }
  const nextExpected = { digest: input.digest, snapshot: input.snapshot, token: owner.token };
  expected.digest = nextExpected.digest;
  expected.snapshot = nextExpected.snapshot;
  return { input, owner: parsed, expected };
}

function assertOwner(actual, expected) {
  const owner = parseOwner(actual);
  if (!sameSnapshot(actual.snapshot, expected.snapshot)
    || actual.digest !== expected.digest
    || owner.token !== expected.token) {
    throw lockIntegrity('Cooperative lock ownership changed.');
  }
}

export async function withGoalLock(root, command, operation, context = {}) {
  const canonicalRoot = await validateCanonicalDirectory(root, 'Repository root');
  const goalLockDirectory = path.join(canonicalRoot, '.goal-lock');
  const lockPath = path.join(goalLockDirectory, '.write-lock.json');
  const token = (context.randomToken ?? randomUUID)();
  const owner = {
    protocol: LOCK_PROTOCOL,
    token,
    pid: context.pid ?? process.pid,
    command,
    created_at: (context.now ?? (() => new Date().toISOString()))(),
  };
  if (typeof operation !== 'function'
    || typeof owner.token !== 'string'
    || owner.token.length === 0
    || !Number.isSafeInteger(owner.pid)
    || owner.pid < 1
    || typeof owner.command !== 'string'
    || owner.command.length === 0
    || owner.command.trim() !== owner.command
    || !isUtcTimestamp(owner.created_at)) {
    throw new GoalLockError('INVALID_LOCK_OWNER', 'input', 2, 'Cooperative lock owner inputs are invalid.');
  }
  const ownerBytes = canonicalBytes(owner);

  await invokeFault(context, 'beforeGoalLockMkdir', { goalLockDirectory });
  const createdDirectory = await mkdir(goalLockDirectory, { recursive: true });
  let createdDirectoryIdentity = null;
  // mkdir 返回本次创建路径且 inode 延续到持锁后，才可把失败清理的目录所有权交给调用方。
  if (createdDirectory && comparablePath(createdDirectory) === comparablePath(goalLockDirectory)) {
    const snapshot = await lstat(goalLockDirectory, { bigint: true });
    if (!snapshot.isSymbolicLink() && snapshot.isDirectory()) createdDirectoryIdentity = snapshot;
  }
  await validateCanonicalDirectory(goalLockDirectory, 'Goal-lock directory');
  let handle;
  let initialIdentity;
  try {
    handle = await open(lockPath, 'wx', 0o600);
    initialIdentity = await handle.stat({ bigint: true });
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => {});
      handle = null;
    }
    if (error?.code === 'EEXIST') {
      parseOwner(await readRegularFile(lockPath, 'Existing cooperative lock'));
      throw new GoalLockError('LOCK_HELD', 'state', 3, 'Another cooperative goal-lock writer already owns the repository.');
    }
    throw error;
  }
  let lockExpected;
  try {
    await handle.writeFile(ownerBytes);
    await handle.sync();
    const lockSnapshot = await handle.stat({ bigint: true });
    await handle.close();
    handle = null;
    lockExpected = { digest: sha256(ownerBytes), snapshot: lockSnapshot, token };
    assertOwner(await readRegularFile(lockPath, 'Cooperative lock'), lockExpected);
    await invokeFault(context, 'afterLockWrite', { lockPath });
  } catch (initializationError) {
    if (handle) await handle.close().catch(() => {});
    let cleanupError;
    try {
      const actual = await readRegularFile(lockPath, 'Cooperative lock');
      if (lockExpected) {
        assertOwner(actual, lockExpected);
      } else if (!sameIdentity(actual.snapshot, initialIdentity)) {
        throw lockIntegrity('Cooperative lock ownership changed during initialization.');
      }
      await unlink(lockPath);
    } catch (error) {
      cleanupError = error;
    }
    if (cleanupError) {
      throw new AggregateError(
        [initializationError, cleanupError],
        'Cooperative lock initialization failed and cleanup could not prove ownership.',
        { cause: initializationError },
      );
    }
    throw initializationError;
  }

  let result;
  let operationError;
  try {
    let goalLockDirectoryCreated = false;
    if (createdDirectoryIdentity) {
      const currentDirectory = await lstat(goalLockDirectory, { bigint: true });
      goalLockDirectoryCreated = !currentDirectory.isSymbolicLink()
        && currentDirectory.isDirectory()
        && sameIdentity(currentDirectory, createdDirectoryIdentity);
    }
    result = await operation({
      goalLockDirectoryCreated,
      goalLockDirectoryIdentity: createdDirectoryIdentity,
      ...lockCapabilityFor(lockExpected),
    });
  } catch (error) {
    operationError = error;
  }

  let releaseError;
  try {
    if (await optionalLstat(path.join(goalLockDirectory, TRANSACTION_FILE))) {
      throw lockIntegrity('Cooperative lock cannot be released while durable transaction recovery is pending.');
    }
    const actual = await readRegularFile(lockPath, 'Cooperative lock');
    assertOwner(actual, lockExpected);
    // Node 无条件 unlink 无法消除不协作同用户的最后竞态；协议安全依赖所有写入者共同持有此锁。
    await unlink(lockPath);
  } catch (error) {
    releaseError = error instanceof GoalLockError
      ? error
      : lockIntegrity('Cooperative lock could not be released without proving ownership.', { cause: error });
  }

  if (operationError && releaseError) {
    throw new AggregateError([operationError, releaseError], 'Goal operation and cooperative lock release both failed.', { cause: operationError });
  }
  if (operationError) throw operationError;
  if (releaseError) throw releaseError;
  return result;
}
