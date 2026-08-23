import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { runGoalLockCli } from '../src/goal-lock/cli.js';
import { writeOutput } from '../src/output.js';

const GIT_OUTPUT_LIMIT = 64 * 1024 * 1024;

function runGit(args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd: process.cwd(),
      encoding: 'buffer',
      maxBuffer: GIT_OUTPUT_LIMIT,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(Buffer.from(stdout));
    });
  });
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

let requestedExitCode = 6;
const result = await runGoalLockCli(process.argv.slice(2), {
  root: process.cwd(),
  stdin: process.stdin,
  now: () => new Date().toISOString(),
  randomToken: randomUUID,
  pid: process.pid,
  isProcessAlive,
  runGit,
  onExitCode: (value) => {
    requestedExitCode = value;
  },
});

const stream = result.ok ? process.stdout : process.stderr;
try {
  // 输出层只处理一次 JSON 写入及背压；业务诊断在进入流之前已经完成脱敏。
  const delivery = await writeOutput(stream, `${JSON.stringify(result)}\n`);
  process.exitCode = delivery === 'written' ? requestedExitCode : 6;
} catch {
  process.exitCode = 6;
}
