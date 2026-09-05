import { runGoalLockCli } from '../src/goal-lock/cli.js';
import { writeOutput } from '../src/output.js';

let requestedExitCode = 6;
const result = await runGoalLockCli(process.argv.slice(2), {
  root: process.cwd(),
  stdin: process.stdin,
  onExitCode: (value) => {
    requestedExitCode = value;
  },
});

const stream = result.ok ? process.stdout : process.stderr;
try {
  // 输出层只负责一次 JSON 行写入；CLI 层已经完成诊断脱敏和退出码选择。
  const delivery = await writeOutput(stream, `${JSON.stringify(result)}\n`);
  process.exitCode = delivery === 'written' ? requestedExitCode : 6;
} catch {
  process.exitCode = 6;
}
