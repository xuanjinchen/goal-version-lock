import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { TextDecoder } from 'node:util';

import {
  approveGoal,
  getGoalStatus,
  initializeGoal,
  proposeGoal,
  verifyGoal,
} from './state-machine.js';

const INPUT_BYTE_LIMIT = 1024 * 1024;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

const COMMAND_SPECS = Object.freeze({
  init: Object.freeze({ input: 'required' }),
  propose: Object.freeze({ input: 'required' }),
  approve: Object.freeze({ approval: 'required' }),
  verify: Object.freeze({}),
  status: Object.freeze({}),
});

const OPTION_NAMES = Object.freeze({
  '--input': 'input',
  '--approval': 'approval',
});

class CliUsageError extends Error {
  constructor() {
    super('Command arguments do not match a supported goal-lock form.');
    this.name = 'CliUsageError';
    this.code = 'CLI_USAGE';
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

function validateOptionValue(value) {
  if (typeof value !== 'string' || value.length === 0 || /[\r\n\0]/.test(value)) usageFailure();
}

export function parseGoalLockArgs(argv) {
  if (!Array.isArray(argv)) usageFailure();
  if (argv.length === 1 && argv[0] === '--help') return { command: 'help' };
  if (argv.length === 0 || argv.includes('--help')) usageFailure();

  const [command, ...tokens] = argv;
  const spec = COMMAND_SPECS[command];
  if (!spec || tokens.length % 2 !== 0) usageFailure();

  const parsed = { command };
  for (let index = 0; index < tokens.length; index += 2) {
    const option = tokens[index];
    const value = tokens[index + 1];
    if (!Object.hasOwn(OPTION_NAMES, option) || value === undefined || value.startsWith('--')) usageFailure();
    const name = OPTION_NAMES[option];
    if (!Object.hasOwn(spec, name) || Object.hasOwn(parsed, name)) usageFailure();
    validateOptionValue(value);
    parsed[name] = value;
  }

  for (const [name, presence] of Object.entries(spec)) {
    if (presence === 'required' && !Object.hasOwn(parsed, name)) usageFailure();
  }
  return parsed;
}

export function formatGoalLockHelp() {
  return `Usage:
  goal-lock init --input goal.json
  goal-lock propose --input goal.json
  goal-lock approve --approval "APPROVAL_PHRASE_FROM_PROPOSAL"
  goal-lock verify
  goal-lock status

Exit codes:
  0  success/help
  2  usage/input
  3  invalid transition
  4  integrity/unsupported state
  5  approval rejected
  6  I/O failure
`;
}

function samePath(left, right) {
  const normalize = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
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

async function readInputFile(rootValue, relativePath) {
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
    // 读取仍绑定已验证的文件句柄，防止路径检查后替换成任意大文件或非目标内容。
    const bytes = await readBoundedHandle(handle);
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
  try {
    return JSON.parse(UTF8_DECODER.decode(bytes));
  } catch {
    throw new CliError('INVALID_JSON', 2, 'JSON input must be one strict UTF-8 document.');
  }
}

async function readJsonInput(parsed, context) {
  const bytes = parsed.input === '-'
    ? await readStdin(context.stdin)
    : await readInputFile(context.root, parsed.input);
  return parseJsonDocument(bytes);
}

async function dispatchCommand(parsed, context) {
  switch (parsed.command) {
    case 'init':
      return initializeGoal(context.root, await readJsonInput(parsed, context));
    case 'propose':
      return proposeGoal(context.root, await readJsonInput(parsed, context));
    case 'approve':
      return approveGoal(context.root, parsed.approval);
    case 'verify':
      return verifyGoal(context.root);
    case 'status':
      return getGoalStatus(context.root);
    default:
      throw new CliUsageError();
  }
}

function publicMessageFor(exitCode) {
  return {
    2: 'Command usage or JSON input was rejected.',
    3: 'The requested goal-lock state transition was rejected.',
    4: 'Goal-lock integrity or unsupported state verification failed.',
    5: 'The approval was rejected.',
    6: 'The goal-lock I/O operation failed.',
  }[exitCode] ?? 'The goal-lock I/O operation failed.';
}

function publicFailure(error, command) {
  const exitCode = Number.isInteger(error?.exitCode) && error.exitCode >= 2 && error.exitCode <= 6
    ? error.exitCode
    : 6;
  return {
    exitCode,
    error: {
      code: typeof error?.code === 'string' ? error.code : 'GOAL_OPERATION_FAILED',
      message: publicMessageFor(exitCode),
    },
  };
}

export async function runGoalLockCli(argv, context = {}) {
  let command = null;
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
    const result = await dispatchCommand(parsed, context);
    // transition-incomplete 仍然没有执行权；对外沿用 3 号无效转移失败，避免把半完成状态当成功返回。
    if ((command === 'verify' || command === 'status') && result?.state === 'transition-incomplete') {
      throw new CliError('INVALID_TRANSITION', 3, 'The goal-lock state transition is incomplete.');
    }
    context.onExitCode?.(0);
    return { ok: true, command, result };
  } catch (error) {
    if (command === null && Array.isArray(argv) && Object.hasOwn(COMMAND_SPECS, argv[0])) command = argv[0];
    const failure = publicFailure(error, command);
    context.onExitCode?.(failure.exitCode);
    return { ok: false, command, error: failure.error };
  }
}
