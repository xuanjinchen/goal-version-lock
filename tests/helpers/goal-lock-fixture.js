import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function createGoalLockFixture(testContext, options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'goal-lock-'));
  testContext.after(() => rmSync(root, { force: true, recursive: true }));

  if (options.git !== false) {
    execFileSync('git', ['init', '--quiet'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'tester@example.invalid'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Goal Lock Tester'], { cwd: root });
  }

  return {
    root,
    now: () => '2026-08-23T00:00:00.000Z',
    randomToken: () => 'deterministic-token',
    pid: 4242,
    isProcessAlive: () => false,
    transactionFaults: {},
  };
}
