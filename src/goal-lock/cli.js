import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';

const INPUT_BYTE_LIMIT = 1024 * 1024;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

const COMMAND_SPECS = Object.freeze({
  init: Object.freeze({ input: 'required' }),
  lock: Object.freeze({ approval: 'required' }),
  verify: Object.freeze({}),
  plan: Object.freeze({ input: 'required', classification: 'required' }),
  propose: Object.freeze({ input: 'required' }),
  approve: Object.freeze({ cr: 'required', approval: 'required' }),
  reject: Object.freeze({ cr: 'required', reason: 'required' }),
  record: Object.freeze({ input: 'required' }),
  gate: Object.freeze({ inventory: 'optional' }),
  'recover-lock': Object.freeze({ ownerToken: 'required', lockDigest: 'required' }),
});

const OPTION_NAMES = Object.freeze({
  '--input': 'input',
  '--approval': 'approval',
  '--classification': 'classification',
  '--cr': 'cr',
  '--reason': 'reason',
  '--inventory': 'inventory',
  '--owner-token': 'ownerToken',
  '--lock-digest': 'lockDigest',
});

class CliUsageError extends Error {
  constructor() {
    super('Command arguments do not match a supported goal-lock form.');
    this.name = 'CliUsageError';
    this.code = 'CLI_USAGE';
    this.kind = 'input';
    this.exitCode = 2;
  }
}

class CliError extends Error {
  constructor(code, exitCode, message) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

function usageFailure() {
  throw new CliUsageError();
}

function validateOptionValue(name, value) {
  if (typeof value !== 'string' || value.length === 0 || /[\r\n\0]/.test(value)) usageFailure();
  if (name === 'classification' && !['aligned', 'implementation-choice'].includes(value)) usageFailure();
  if (name === 'inventory' && value === '-') usageFailure();
  if (name === 'cr' && !/^CR-[0-9]{4}$/.test(value)) usageFailure();
  if (name === 'reason' && value.trim().length === 0) usageFailure();
  if (name === 'ownerToken' && !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)) {
    usageFailure();
  }
  if (name === 'lockDigest' && !/^[a-f0-9]{64}$/.test(value)) usageFailure();
}

export function parseGoalLockArgs(argv) {
  if (!Array.isArray(argv)) usageFailure();
  if (argv.length === 1 && argv[0] === '--help') return { command: 'help' };
  if (argv.length === 0 || argv.includes('--help')) usageFailure();

  const [command, ...tokens] = argv;
  const spec = COMMAND_SPECS[command];
  if (!spec) usageFailure();

  const parsed = { command };
  for (let index = 0; index < tokens.length; index += 2) {
    const option = tokens[index];
    const value = tokens[index + 1];
    // 只接受分离的“--option value”，避免等号、短选项或位置参数产生第二套解析语义。
    if (!Object.hasOwn(OPTION_NAMES, option) || value === undefined || value.startsWith('--')) usageFailure();
    const name = OPTION_NAMES[option];
    if (!Object.hasOwn(spec, name) || Object.hasOwn(parsed, name)) usageFailure();
    validateOptionValue(name, value);
    parsed[name] = value;
  }

  for (const [name, presence] of Object.entries(spec)) {
    if (presence === 'required' && !Object.hasOwn(parsed, name)) usageFailure();
  }
  return parsed;
}

export function formatGoalLockHelp() {
  return `The current working directory (cwd) is the governed project.

Usage:
  goal-lock init --input draft.json
  goal-lock init --input -
  goal-lock lock --approval "APPROVE GOAL GL-EXAMPLE VERSION 1 0123456789ab"
  goal-lock verify
  goal-lock plan --input plan.json --classification aligned
  goal-lock plan --input revised-plan.json --classification implementation-choice
  goal-lock plan --input - --classification aligned
  goal-lock propose --input change-proposal.json
  goal-lock propose --input -
  goal-lock approve --cr CR-0001 --approval "APPROVE CR-0001 GOAL VERSION 2 0123456789ab"
  goal-lock reject --cr CR-0001 --reason "Keep the approved scope"
  goal-lock record --input progress-input.json
  goal-lock record --input -
  goal-lock gate
  goal-lock gate --inventory inventory.json
  goal-lock recover-lock --owner-token 11111111-1111-4111-8111-111111111111 --lock-digest 0000000000000000000000000000000000000000000000000000000000000000

Exit codes:
  0  success/help
  2  usage/input
  3  invalid transition
  4  integrity/tamper/unsafe path
  5  approval/stale approval
  6  I/O/Git/rollback/recovery
`;
}

function samePath(left, right) {
  const normalize = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
  return normalize(path.resolve(left)) === normalize(path.resolve(right));
}

function sameStat(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs
    && left.mode === right.mode
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

function inputSegments(value) {
  if (typeof value !== 'string'
    || value.length === 0
    || value.includes('\0')
    || value.includes('\\')
    || value.includes(':')
    || path.isAbsolute(value)
    || value.startsWith('/')
    || /^[A-Za-z]:/.test(value)) {
    throw new CliError('UNSAFE_INPUT_PATH', 4, 'The JSON input path is unsafe.');
  }
  const segments = value.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new CliError('UNSAFE_INPUT_PATH', 4, 'The JSON input path is unsafe.');
  }
  return segments;
}

async function canonicalRoot(root) {
  const resolved = path.resolve(root);
  const stat = await optionalLstat(resolved);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory() || !samePath(await realpath(resolved), resolved)) {
    throw new CliError('UNSAFE_INPUT_ROOT', 4, 'The governed project root is unsafe.');
  }
  return { path: resolved, stat };
}

async function inspectParents(root, segments) {
  const rootNow = await optionalLstat(root.path);
  if (!rootNow || !sameStat(rootNow, root.stat) || !samePath(await realpath(root.path), root.path)) {
    throw new CliError('INPUT_PATH_RACED', 4, 'The JSON input path changed while it was read.');
  }
  const parents = [];
  let current = root.path;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    const stat = await optionalLstat(current);
    if (!stat || stat.isSymbolicLink() || !stat.isDirectory() || !samePath(await realpath(current), current)) {
      throw new CliError('UNSAFE_INPUT_PATH', 4, 'The JSON input path is unsafe.');
    }
    parents.push({ path: current, stat });
  }
  return parents;
}

function sameParents(left, right) {
  return left.length === right.length
    && left.every((parent, index) => samePath(parent.path, right[index].path)
      && sameStat(parent.stat, right[index].stat));
}

async function readBoundedHandle(handle) {
  const chunks = [];
  let length = 0;
  while (length <= INPUT_BYTE_LIMIT) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, (INPUT_BYTE_LIMIT + 1) - length));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) break;
    chunks.push(buffer.subarray(0, bytesRead));
    length += bytesRead;
  }
  if (length > INPUT_BYTE_LIMIT) {
    throw new CliError('INPUT_TOO_LARGE', 2, 'JSON input exceeds the byte limit.');
  }
  return Buffer.concat(chunks, length);
}

async function readInputFile(rootValue, relativePath, context) {
  const segments = inputSegments(relativePath);
  const root = await canonicalRoot(rootValue);
  const parentsBefore = await inspectParents(root, segments);
  const target = path.join(root.path, ...segments);
  const namedBefore = await optionalLstat(target);
  if (!namedBefore) throw new CliError('INPUT_FILE_MISSING', 6, 'The JSON input file is unavailable.');
  if (namedBefore.isSymbolicLink() || !namedBefore.isFile() || namedBefore.nlink !== 1n) {
    throw new CliError('INPUT_FILE_UNSAFE', 4, 'The JSON input must be an unlinked regular file.');
  }
  if (namedBefore.size > BigInt(INPUT_BYTE_LIMIT)) {
    throw new CliError('INPUT_TOO_LARGE', 2, 'JSON input exceeds the byte limit.');
  }

  let handle;
  try {
    handle = await open(target, 'r');
    const openedBefore = await handle.stat({ bigint: true });
    if (!openedBefore.isFile() || openedBefore.nlink !== 1n || !sameStat(namedBefore, openedBefore)) {
      throw new CliError('INPUT_FILE_RACED', 4, 'The JSON input changed before it was read.');
    }
    // 有界句柄读取避免在路径检查与读取之间把增长后的任意大文件整体载入内存。
    const bytes = await readBoundedHandle(handle);
    await context.inputFaults?.afterFileRead?.({ relativePath, target });
    const openedAfter = await handle.stat({ bigint: true });
    const namedAfter = await optionalLstat(target);
    const parentsAfter = await inspectParents(root, segments);
    if (!namedAfter
      || !sameStat(openedBefore, openedAfter)
      || !sameStat(openedAfter, namedAfter)
      || !sameParents(parentsBefore, parentsAfter)) {
      throw new CliError('INPUT_FILE_RACED', 4, 'The JSON input changed while it was read.');
    }
    return bytes;
  } finally {
    await handle?.close();
  }
}

async function readStdin(stream) {
  if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
    throw new CliError('STDIN_UNAVAILABLE', 6, 'Standard input is unavailable.');
  }
  const chunks = [];
  let length = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > INPUT_BYTE_LIMIT) {
      throw new CliError('INPUT_TOO_LARGE', 2, 'JSON input exceeds the byte limit.');
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, length);
}

function parseJsonDocument(bytes) {
  let text;
  try {
    text = UTF8_DECODER.decode(bytes);
    return JSON.parse(text);
  } catch {
    // 解析错误不携带解码后的输入，诊断永远不能回显 objective、批准短语或文件字节。
    throw new CliError('INVALID_JSON', 2, 'JSON input must be one strict UTF-8 document.');
  }
}

async function readJsonInput(parsed, context, option = 'input') {
  const source = parsed[option];
  const bytes = source === '-'
    ? await readStdin(context.stdin)
    : await readInputFile(context.root, source, context);
  return parseJsonDocument(bytes);
}

async function dispatchCommand(parsed, context) {
  const root = context.root;
  // runtime 模块只在具体命令分派后加载，保证全局 --help 不触碰仓库实现或工作区状态。
  if (parsed.command === 'recover-lock') {
    const { recoverGoalLock } = await import('./transaction.js');
    return recoverGoalLock(root, {
      owner_token: parsed.ownerToken,
      lock_digest: parsed.lockDigest,
    }, context);
  }

  const repository = await import('./repository.js');
  switch (parsed.command) {
    case 'init':
      return repository.initializeGoal(root, await readJsonInput(parsed, context), context);
    case 'lock':
      return repository.lockInitialGoal(root, parsed.approval, context);
    case 'verify': {
      const result = await repository.verifyGoalRepository(root, context);
      if (result.state === 'TAMPERED') {
        throw new CliError('GOAL_REPOSITORY_TAMPERED', 4, 'Goal-lock integrity verification failed.');
      }
      return result;
    }
    case 'plan':
      return repository.revisePlan(
        root,
        await readJsonInput(parsed, context),
        parsed.classification,
        context,
      );
    case 'propose':
      return repository.proposeGoalChange(root, await readJsonInput(parsed, context), context);
    case 'approve':
      return repository.approveGoalChange(root, parsed.cr, parsed.approval, context);
    case 'reject': {
      const result = await repository.rejectGoalChange(root, parsed.cr, parsed.reason, context);
      const { reason: _reason, ...redacted } = result;
      return redacted;
    }
    case 'record':
      return repository.recordGoalEvent(root, await readJsonInput(parsed, context), context);
    case 'gate': {
      const inventory = parsed.inventory === undefined
        ? undefined
        : await readJsonInput(parsed, context, 'inventory');
      return repository.gateGoalCompletion(root, inventory, context);
    }
    default:
      throw new CliUsageError();
  }
}

function publicFailure(error, command, enteredDispatch) {
  const observedExitCode = Number.isInteger(error?.exitCode) && error.exitCode >= 2 && error.exitCode <= 6
    ? error.exitCode
    : 6;
  // usage/input 的 2 优先保留；恢复类 6 只属于成功解析并已进入 recovery dispatch 的失败。
  const exitCode = observedExitCode === 2
    ? 2
    : command === 'recover-lock' && enteredDispatch
      ? 6
      : error?.code === 'GOAL_IO_GIT'
        ? 6
        : error?.code === 'APPROVAL_REJECTED' ? 5 : observedExitCode;
  const messages = {
    2: 'Command usage or JSON input was rejected.',
    3: 'The requested goal-lock state transition was rejected.',
    4: 'Goal-lock integrity or path safety verification failed.',
    5: 'The approval was rejected or stale.',
    6: 'The goal-lock I/O, Git, rollback, or recovery operation failed.',
  };
  return {
    exitCode,
    error: {
      code: typeof error?.code === 'string' ? error.code : 'GOAL_OPERATION_FAILED',
      message: messages[exitCode],
    },
  };
}

export async function runGoalLockCli(argv, context = {}) {
  let command = null;
  let enteredDispatch = false;
  try {
    const parsed = parseGoalLockArgs(argv);
    command = parsed.command;
    if (command === 'help') {
      context.onExitCode?.(0);
      return { ok: true, command, result: formatGoalLockHelp() };
    }
    if (typeof context.root !== 'string') {
      throw new CliError('WORKSPACE_ROOT_REQUIRED', 6, 'The governed project root is unavailable.');
    }
    enteredDispatch = true;
    const result = await dispatchCommand(parsed, context);
    context.onExitCode?.(0);
    return { ok: true, command, result };
  } catch (error) {
    if (command === null && Array.isArray(argv) && Object.hasOwn(COMMAND_SPECS, argv[0])) command = argv[0];
    const failure = publicFailure(error, command, enteredDispatch);
    context.onExitCode?.(failure.exitCode);
    return { ok: false, command, error: failure.error };
  }
}
