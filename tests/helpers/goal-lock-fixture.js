import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export function goalInput(overrides = {}) {
  return {
    objective: 'Deliver the reviewed CSV export',
    success_criteria: ['The reviewed CSV can be generated'],
    constraints: ['Use only local repository state'],
    non_goals: ['Do not add XML export'],
    ...overrides,
  };
}

export async function createGoalLockFixture(testContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'goal-version-lock-'));
  testContext.after(() => rm(root, { recursive: true, force: true }));
  return { root };
}
