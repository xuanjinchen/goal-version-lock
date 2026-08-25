import { execFile } from 'node:child_process';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import { canonicalBytes, sha256 } from './canonical.js';
import { GoalLockError, validateScopeBaseline } from './contracts.js';

const GIT_OUTPUT_LIMIT = 64 * 1024 * 1024;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

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
    && left.ctimeNs === right.ctimeNs
    && left.mode === right.mode
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
    // 重读只能确认首次信任的目标和父链，不能以较新的路径观察值覆盖信任基线。
    const trusted = captured.get(record.path);
    if (trusted
      && (trusted.kind !== record.kind
        || trusted.digest !== record.digest
        || !sameSnapshot(trusted.snapshot, record.snapshot)
        || !sameParents(trusted.parents, record.parents))) {
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
        parents: parentsAfter,
      };
      if (capture) captureInput(record);
      return {
        bytes: Buffer.from(bytes),
        digest: record.digest,
        mode: Number(namedAfter.mode & 0o111n) === 0 ? '100644' : '100755',
        size: Number(namedAfter.size),
      };
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
      const record = { path: relativePath, kind: 'directory', names, digest, snapshot: after, parents: parentsAfter };
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
      const segments = safeRelativePath(expected.path);
      const parentsBefore = await validateParents(trustedRoot, segments);
      if (!sameParents(expected.parents, parentsBefore)) {
        throw integrityError('WORKSPACE_PARENT_CHANGED', 'Workspace input parent identity changed after verification began.');
      }
      const observed = expected.kind === 'file'
        ? await readFileInput(expected.path, {}, false)
        : await readDirectoryInput(expected.path, {}, false);
      const parentsAfter = await validateParents(trustedRoot, segments);
      const named = await lstat(path.join(canonicalRoot, ...segments), { bigint: true });
      const digest = observed.digest;
      // 最终复验同时固定内容、目标和父链，任何路径替换都不能成为新的可信输入。
      if (digest !== expected.digest
        || !sameSnapshot(named, expected.snapshot)
        || !sameParents(expected.parents, parentsAfter)) {
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

function gitError() {
  // Git 的 stderr、路径和底层异常都不进入公开错误对象，调用方只能依据稳定错误码处理。
  return integrityError('GOAL_IO_GIT', 'Git workspace state could not be captured safely.');
}

function compareNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function defaultGitRunner(root) {
  return (args) => new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd: root,
      encoding: 'buffer',
      maxBuffer: GIT_OUTPUT_LIMIT,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(Buffer.from(stdout));
    });
  });
}

function gitBytes(result) {
  let bytes;
  if (Buffer.isBuffer(result) || result instanceof Uint8Array) bytes = Buffer.from(result);
  if (result && (Buffer.isBuffer(result.stdout) || result.stdout instanceof Uint8Array)) {
    bytes = Buffer.from(result.stdout);
  }
  if (!bytes) throw new TypeError('Git runner did not return byte output.');
  if (bytes.length > GIT_OUTPUT_LIMIT) throw new RangeError('Git output exceeded the capture limit.');
  return bytes;
}

async function invokeGit(runGit, args, { unavailableRoot = null } = {}) {
  try {
    return gitBytes(await runGit([...args]));
  } catch (error) {
    if (unavailableRoot !== null) {
      if (error?.code === 'ENOENT') return null;
      if (typeof error?.code === 'number' && error.code !== 0) {
        let marker;
        try {
          marker = await optionalLstat(path.join(unavailableRoot, '.git'));
        } catch {
          throw gitError();
        }
        if (marker === null) return null;
      }
    }
    throw gitError();
  }
}

async function observeGit(runGit, args) {
  try {
    return { bytes: gitBytes(await runGit([...args])), error: null };
  } catch (error) {
    return { bytes: null, error };
  }
}

function decodeGitPaths(bytes) {
  if (bytes.length === 0) return [];
  if (bytes.at(-1) !== 0) throw gitError();
  try {
    return UTF8_DECODER.decode(bytes.subarray(0, -1)).split('\0');
  } catch {
    throw gitError();
  }
}

function isBookkeepingPath(relativePath) {
  return relativePath === '.goal-lock'
    || relativePath.startsWith('.goal-lock/')
    || relativePath === '.git'
    || relativePath.startsWith('.git/');
}

function normalizeInventory(inventory) {
  if (!Array.isArray(inventory) || inventory.length === 0) {
    throw integrityError('WORKSPACE_INVENTORY_REQUIRED', 'A non-Git workspace requires a non-empty delivery inventory.');
  }
  const normalized = inventory.map((relativePath) => safeRelativePath(relativePath).join('/'));
  if (normalized.some(isBookkeepingPath)
    || normalized.some((name, index) => index > 0 && compareNames(normalized[index - 1], name) >= 0)) {
    throw integrityError(
      'WORKSPACE_INVENTORY_INVALID',
      'Workspace inventory paths must be sorted, unique delivery files outside bookkeeping state.',
    );
  }
  return normalized;
}

async function resolveGitHead(runGit) {
  const observed = await observeGit(runGit, ['rev-parse', '--verify', 'HEAD']);
  if (observed.bytes !== null) return observed.bytes;
  if (typeof observed.error?.code !== 'number') throw gitError();

  const symbolicHead = (await invokeGit(runGit, ['symbolic-ref', '--quiet', 'HEAD'])).toString('utf8').trim();
  if (!/^refs\/heads\/[^\0\r\n]+$/.test(symbolicHead)) throw gitError();
  const ref = await observeGit(runGit, ['show-ref', '--verify', '--quiet', symbolicHead]);
  // 只有符号 HEAD 指向确实不存在的分支（show-ref=1）才是 unborn；损坏 ref 与其他 Git 故障全部关闭。
  if (ref.bytes !== null || ref.error?.code !== 1) throw gitError();
  return null;
}

function parseIndexEntries(bytes) {
  if (bytes.length === 0) return [];
  if (bytes.at(-1) !== 0) throw gitError();
  let records;
  try {
    records = UTF8_DECODER.decode(bytes.subarray(0, -1)).split('\0');
  } catch {
    throw gitError();
  }
  return records.map((record) => {
    const match = /^(100(?:644|755)|120000|160000) ([0-9a-f]{40,64}) ([0-3])\t(.+)$/u.exec(record);
    if (!match) throw gitError();
    return { mode: match[1], object: match[2], stage: match[3], path: safeRelativePath(match[4]).join('/') };
  });
}

async function captureGitView(runGit) {
  // 先验证 HEAD，损坏引用不能被误判为 unborn；摘要本身不绑定提交身份。
  await resolveGitHead(runGit);
  const worktree = await invokeGit(runGit, [
    'diff', '--binary', '--no-ext-diff', '--', '.',
    ':(exclude).git', ':(exclude).git/**', ':(exclude).goal-lock', ':(exclude).goal-lock/**',
  ]);
  const untrackedOutput = await invokeGit(runGit, ['ls-files', '--others', '--exclude-standard', '-z', '--']);
  const trackedOutput = await invokeGit(runGit, ['ls-files', '--stage', '-z', '--']);
  const untracked = decodeGitPaths(untrackedOutput)
    .filter((name) => !isBookkeepingPath(name))
    .map((name) => safeRelativePath(name).join('/'))
    .sort(compareNames);
  const tracked = parseIndexEntries(trackedOutput).filter((entry) => !isBookkeepingPath(entry.path));
  if (tracked.some((entry) => entry.stage !== '0')) {
    throw integrityError('WORKSPACE_FILE_UNSAFE', 'Git workspace inputs must have one resolved index entry per path.');
  }
  if (tracked.some((entry) => !['100644', '100755'].includes(entry.mode))) {
    throw integrityError('WORKSPACE_FILE_UNSAFE', 'Git workspace inputs must be regular files.');
  }
  return { worktree, untracked, tracked };
}

function sameGitView(left, right) {
  return left.worktree.equals(right.worktree)
    && left.untracked.length === right.untracked.length
    && left.untracked.every((name, index) => name === right.untracked[index])
    && left.tracked.length === right.tracked.length
    && left.tracked.every((entry, index) => (
      entry.mode === right.tracked[index].mode
      && entry.object === right.tracked[index].object
      && entry.stage === right.tracked[index].stage
      && entry.path === right.tracked[index].path
    ));
}

function createManifest(mode, entries) {
  const manifestValue = {
    mode,
    entries: entries.toSorted((left, right) => left.path.localeCompare(right.path)),
  };
  return Object.freeze({
    ...manifestValue,
    manifest_digest: sha256(canonicalBytes(manifestValue)),
  });
}

async function gitManifest(reader, runGit) {
  const topLevel = await invokeGit(runGit, ['rev-parse', '--show-toplevel']);
  if (!samePath(topLevel.toString('utf8').trim(), reader.root)) {
    throw integrityError('WORKSPACE_GIT_ROOT_INVALID', 'Workspace root must equal the Git repository top level.');
  }
  const before = await captureGitView(runGit);
  const entries = [];
  for (const indexed of before.tracked) {
    const input = await reader.readFile(indexed.path, { optional: true });
    if (input) {
      const indexBytes = await invokeGit(runGit, ['cat-file', 'blob', indexed.object]);
      entries.push({
        path: indexed.path,
        source: 'tracked',
        mode: input.mode,
        size: input.size,
        digest: input.digest,
        index_mode: indexed.mode,
        index_digest: sha256(indexBytes),
      });
    }
  }
  for (const relativePath of before.untracked) {
    const input = await reader.readFile(relativePath);
    entries.push({
      path: relativePath,
      source: 'untracked',
      mode: input.mode,
      size: input.size,
      digest: input.digest,
      index_mode: null,
      index_digest: null,
    });
  }
  await reader.verifyInputs();
  const after = await captureGitView(runGit);
  // Git/index 视图与安全读取的文件快照必须同时稳定，避免混合两个时刻的字节。
  if (!sameGitView(before, after)) {
    throw integrityError('WORKSPACE_INPUT_CHANGED', 'Git workspace inputs changed during manifest capture.');
  }
  return createManifest('git', entries);
}

async function inventoryManifest(reader, inventory) {
  const names = normalizeInventory(inventory);
  const entries = [];
  for (const relativePath of names) {
    const input = await reader.readFile(relativePath);
    entries.push({
      path: relativePath,
      source: 'inventory',
      mode: input.mode,
      size: input.size,
      digest: input.digest,
      index_mode: null,
      index_digest: null,
    });
  }
  await reader.verifyInputs();
  return createManifest('inventory', entries);
}

/** 捕获唯一的 Git 或显式清单工作区视图，不允许两个视图竞争。 */
export async function captureWorkspaceManifest(root, inventory = null, context = {}) {
  const reader = await createWorkspaceReader(root, context);
  const runGit = context.runGit ?? defaultGitRunner(reader.root);
  const probe = await invokeGit(runGit, ['rev-parse', '--is-inside-work-tree'], { unavailableRoot: reader.root });
  if (probe?.toString('ascii').trim() === 'true') {
    if (inventory !== null) {
      throw integrityError('WORKSPACE_INVENTORY_INVALID', 'A Git workspace cannot select a competing inventory view.');
    }
    return gitManifest(reader, runGit);
  }
  return inventoryManifest(reader, inventory);
}

/** 将已捕获清单固定为版本一目标的可验证范围基线。 */
export function createScopeBaseline(goalReference, manifest, recordedAt) {
  const withoutDigest = {
    schema_version: 2,
    scope_version: 1,
    goal: goalReference,
    mode: manifest.mode,
    entries: manifest.entries,
    recorded_at: recordedAt,
  };
  return verifyScopeBaseline({
    ...withoutDigest,
    record_digest: sha256(canonicalBytes(withoutDigest)),
  }, goalReference);
}

/** 验证持久化范围基线的目标绑定、条目格式和记录摘要。 */
export function verifyScopeBaseline(scope, goalReference) {
  return validateScopeBaseline(scope, goalReference);
}

/** 计算两份清单的精确路径差异；清单模式不允许静默丢失已知基线路径。 */
export function computeWorkspaceDelta(baselineEntries, currentEntries) {
  const baseline = new Map(baselineEntries.map((entry) => [entry.path, entry]));
  const current = new Map(currentEntries.map((entry) => [entry.path, entry]));
  for (const [relativePath, entry] of baseline) {
    if (entry.source === 'inventory' && !current.has(relativePath)) {
      throw integrityError('WORKSPACE_INVENTORY_INCOMPLETE', 'An inventory manifest omitted a baseline path.');
    }
  }
  const entries = [...new Set([...baseline.keys(), ...current.keys()])]
    .toSorted(compareNames)
    .flatMap((relativePath) => {
      const before = baseline.get(relativePath) ?? null;
      const after = current.get(relativePath) ?? null;
      return canonicalBytes(before).equals(canonicalBytes(after)) ? [] : [{ path: relativePath, baseline: before, current: after }];
    });
  const deltaValue = { entries, paths: entries.map((entry) => entry.path) };
  return Object.freeze({ ...deltaValue, delta_digest: sha256(canonicalBytes(deltaValue)) });
}

/** 工作区指纹只从已捕获的规范清单推导，绝不重新读取工作区。 */
export function workspaceFingerprintFromManifest(manifest) {
  return sha256(canonicalBytes({ mode: manifest.mode, entries: manifest.entries }));
}

/** 兼容旧调用方：Git 摘要委托给唯一的清单捕获管线。 */
export async function gitWorkspaceFingerprint(root) {
  const manifest = await captureWorkspaceManifest(root);
  if (manifest.mode !== 'git') throw gitError();
  return workspaceFingerprintFromManifest(manifest);
}

/** 兼容旧调用方：非 Git 摘要仍由同一份清单派生。 */
export async function inventoryWorkspaceFingerprint(root, inventory) {
  return workspaceFingerprintFromManifest(await captureWorkspaceManifest(root, inventory));
}

/** 兼容旧调用方：捕获一次清单后派生单一工作区指纹。 */
export async function workspaceFingerprint(root, inventory, context = {}) {
  return workspaceFingerprintFromManifest(await captureWorkspaceManifest(root, inventory ?? null, context));
}
