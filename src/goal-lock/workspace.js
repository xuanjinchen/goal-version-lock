import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

import { canonicalBytes, sha256 } from './canonical.js';
import { GoalLockError } from './contracts.js';

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

function safeRelativePath(value) {
  if (typeof value !== 'string'
    || value.length === 0
    || value.includes('\0')
    || value.includes('\\')
    || value.startsWith('/')
    || /^[A-Za-z]:/.test(value)) {
    throw integrityError('UNSAFE_WORKSPACE_PATH', 'Workspace input path must be repository-relative.');
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw integrityError('UNSAFE_WORKSPACE_PATH', 'Workspace input path contains an unsafe segment.');
  }
  return segments;
}

async function optionalLstat(target) {
  try {
    return await lstat(target, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function validateRoot(root) {
  const resolved = path.resolve(root);
  let stat;
  try {
    stat = await lstat(resolved, { bigint: true });
  } catch (error) {
    throw integrityError('WORKSPACE_ROOT_INVALID', 'Workspace root is unavailable.', error);
  }
  if (stat.isSymbolicLink() || !stat.isDirectory() || !samePath(await realpath(resolved), resolved)) {
    throw integrityError('WORKSPACE_ROOT_INVALID', 'Workspace root must be a canonical real directory.');
  }
  return { path: resolved, snapshot: stat };
}

async function validateRootIdentity(root) {
  // 根目录必须始终保持初始化时的身份，不能把替换后的同名路径当作原工作区。
  const stat = await optionalLstat(root.path);
  if (!stat
    || stat.isSymbolicLink()
    || !stat.isDirectory()
    || !sameSnapshot(stat, root.snapshot)
    || !samePath(await realpath(root.path), root.path)) {
    throw integrityError('WORKSPACE_ROOT_CHANGED', 'Workspace root identity changed during verification.');
  }
}

async function validateParents(root, segments) {
  await validateRootIdentity(root);
  let current = root.path;
  const parents = [];
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    const stat = await optionalLstat(current);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory() || !samePath(await realpath(current), current)) {
      throw integrityError('WORKSPACE_PARENT_UNSAFE', 'Workspace input parent must be a real directory without links.');
    }
    parents.push({ path: current, snapshot: stat });
  }
  return parents;
}

function sameParents(left, right) {
  return left.length === right.length
    && left.every((parent, index) => samePath(parent.path, right[index].path)
      && sameSnapshot(parent.snapshot, right[index].snapshot));
}

function publicInput(record) {
  return { path: record.path, kind: record.kind, digest: record.digest };
}

/** 安全读取工作区输入，并保留首次观察到的身份与摘要供提交前复验。 */
export async function createWorkspaceReader(root, context = {}) {
  const trustedRoot = await validateRoot(root);
  const canonicalRoot = trustedRoot.path;
  const captured = new Map();

  function captureInput(record) {
    // 重读只能确认首次信任的快照，不能以较新的观察值覆盖信任基线。
    const trusted = captured.get(record.path);
    if (trusted
      && (trusted.kind !== record.kind
        || trusted.digest !== record.digest
        || !sameSnapshot(trusted.snapshot, record.snapshot))) {
      throw integrityError('WORKSPACE_INPUT_CHANGED', 'Workspace input changed after its first trusted read.');
    }
    if (!trusted) captured.set(record.path, record);
  }

  async function readFileInput(relativePath, options = {}, capture = true) {
    const segments = safeRelativePath(relativePath);
    const parentsBefore = await validateParents(trustedRoot, segments);
    await context.workspaceFaults?.afterParentValidation?.({ relativePath, target: path.join(canonicalRoot, ...segments) });
    const target = path.join(canonicalRoot, ...segments);
    let namedBefore;
    try {
      namedBefore = await optionalLstat(target);
    } catch (error) {
      throw integrityError('WORKSPACE_FILE_UNREADABLE', 'Workspace file could not be inspected.', error);
    }
    if (!namedBefore) {
      if (options.optional) return null;
      throw integrityError('WORKSPACE_FILE_MISSING', 'Required workspace file is missing.');
    }
    if (namedBefore.isSymbolicLink() || !namedBefore.isFile() || namedBefore.nlink !== 1n) {
      throw integrityError('WORKSPACE_FILE_UNSAFE', 'Workspace input must be an unlinked regular file.');
    }

    let handle;
    try {
      handle = await open(target, 'r');
      const openedBefore = await handle.stat({ bigint: true });
      if (!openedBefore.isFile() || openedBefore.nlink !== 1n || !sameSnapshot(namedBefore, openedBefore)) {
        throw integrityError('WORKSPACE_FILE_RACED', 'Workspace file identity changed before reading.');
      }
      const bytes = await handle.readFile();
      await context.workspaceFaults?.afterFileRead?.({ relativePath, target });
      const openedAfter = await handle.stat({ bigint: true });
      const namedAfter = await optionalLstat(target);
      const parentsAfter = await validateParents(trustedRoot, segments);
      // 路径名与已打开句柄在读前读后都必须指向同一快照，拒绝替换后继续信任旧句柄字节。
      if (!namedAfter
        || !sameSnapshot(openedBefore, openedAfter)
        || !sameSnapshot(openedAfter, namedAfter)
        || !sameParents(parentsBefore, parentsAfter)) {
        throw integrityError('WORKSPACE_FILE_RACED', 'Workspace file changed while being read.');
      }
      const record = {
        path: relativePath,
        kind: 'file',
        bytes,
        digest: sha256(bytes),
        snapshot: namedAfter,
      };
      if (capture) captureInput(record);
      return { bytes: Buffer.from(bytes), digest: record.digest };
    } catch (error) {
      if (error instanceof GoalLockError) throw error;
      throw integrityError('WORKSPACE_FILE_UNREADABLE', 'Workspace file could not be read safely.', error);
    } finally {
      await handle?.close();
    }
  }

  async function readDirectoryInput(relativePath, options = {}, capture = true) {
    const segments = safeRelativePath(relativePath);
    const parentsBefore = await validateParents(trustedRoot, segments);
    await context.workspaceFaults?.afterParentValidation?.({ relativePath, target: path.join(canonicalRoot, ...segments) });
    const target = path.join(canonicalRoot, ...segments);
    let before;
    try {
      before = await optionalLstat(target);
      if (!before) {
        if (options.optional) return null;
        throw integrityError('WORKSPACE_DIRECTORY_MISSING', 'Required workspace directory is missing.');
      }
      if (before.isSymbolicLink() || !before.isDirectory() || !samePath(await realpath(target), target)) {
        throw integrityError('WORKSPACE_DIRECTORY_UNSAFE', 'Workspace input directory must be real and contain no link traversal.');
      }
      const names = (await readdir(target)).sort();
      await context.workspaceFaults?.afterDirectoryRead?.({ relativePath, target });
      const after = await optionalLstat(target);
      const parentsAfter = await validateParents(trustedRoot, segments);
      if (!after
        || !sameSnapshot(before, after)
        || !samePath(await realpath(target), target)
        || !sameParents(parentsBefore, parentsAfter)) {
        throw integrityError('WORKSPACE_DIRECTORY_RACED', 'Workspace directory changed while being read.');
      }
      const digest = sha256(canonicalBytes(names));
      const record = { path: relativePath, kind: 'directory', names, digest, snapshot: after };
      if (capture) captureInput(record);
      return { names: [...names], digest };
    } catch (error) {
      if (error instanceof GoalLockError) throw error;
      throw integrityError('WORKSPACE_DIRECTORY_UNREADABLE', 'Workspace directory could not be read safely.', error);
    }
  }

  async function verifyInputs() {
    await context.workspaceFaults?.beforeVerifyInputs?.();
    await validateRootIdentity(trustedRoot);
    for (const expected of [...captured.values()].sort((left, right) => left.path.localeCompare(right.path))) {
      const observed = expected.kind === 'file'
        ? await readFileInput(expected.path, {}, false)
        : await readDirectoryInput(expected.path, {}, false);
      const named = await lstat(path.join(canonicalRoot, ...safeRelativePath(expected.path)), { bigint: true });
      const digest = observed.digest;
      // 最终复验既比较内容摘要也比较首次身份，任何外部改写都不能成为新的可信输入。
      if (digest !== expected.digest || !sameSnapshot(named, expected.snapshot)) {
        throw integrityError('WORKSPACE_INPUT_CHANGED', 'Workspace input changed after verification began.');
      }
    }
  }

  return {
    root: canonicalRoot,
    readFile: readFileInput,
    readDirectory: readDirectoryInput,
    verifyInputs,
    inputs: () => [...captured.values()]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map(publicInput),
  };
}
