import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { link, mkdir, rename, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { GoalLockError } from '../src/goal-lock/contracts.js';
import {
  captureWorkspaceManifest,
  computeWorkspaceDelta,
  createScopeBaseline,
  inventoryWorkspaceFingerprint,
  verifyScopeBaseline,
  workspaceFingerprintFromManifest,
} from '../src/goal-lock/workspace.js';
import { activeGoalReference, createGoalLockFixture } from './helpers/goal-lock-fixture.js';

function git(root, args) {
  return execFileSync('git', args, { cwd: root });
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function writeWorkspace(root, relativePath, bytes) {
  const segments = relativePath.split('/');
  if (segments.length > 1) await mkdir(join(root, ...segments.slice(0, -1)), { recursive: true });
  await writeFile(join(root, ...segments), bytes);
}

test('workspace manifest baseline preserves dirty entries and reports later Git path deltas', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  await writeWorkspace(fixture.root, 'old-name.js', 'export const oldName = 1;\n');
  await writeWorkspace(fixture.root, 'tracked.js', 'export const value = "base";\n');
  git(fixture.root, ['add', '--', 'old-name.js', 'tracked.js']);
  git(fixture.root, ['commit', '--quiet', '-m', 'base']);

  await writeWorkspace(fixture.root, 'tracked.js', 'export const value = "dirty baseline";\n');
  await writeWorkspace(fixture.root, 'untracked.js', 'export const untracked = "baseline";\n');
  const baseline = await captureWorkspaceManifest(fixture.root, null, fixture);
  assert.deepEqual(baseline.entries.map((entry) => [entry.path, entry.source]), [
    ['old-name.js', 'tracked'],
    ['tracked.js', 'tracked'],
    ['untracked.js', 'untracked'],
  ]);

  const cases = [
    {
      label: 'a later untracked addition',
      mutate: async () => writeWorkspace(fixture.root, 'later.js', 'export const later = true;\n'),
      paths: ['later.js'],
      cleanup: async () => unlink(join(fixture.root, 'later.js')),
    },
    {
      label: 'a modification, deletion, rename, and trackedness change',
      mutate: async () => {
        await writeWorkspace(fixture.root, 'tracked.js', 'export const value = "later";\n');
        await rename(join(fixture.root, 'old-name.js'), join(fixture.root, 'renamed.js'));
        await writeWorkspace(fixture.root, 'untracked.js', 'export const untracked = "now staged";\n');
        git(fixture.root, ['add', '--', 'untracked.js']);
      },
      paths: ['old-name.js', 'renamed.js', 'tracked.js', 'untracked.js'],
    },
  ];

  for (const scenario of cases) {
    await scenario.mutate();
    const current = await captureWorkspaceManifest(fixture.root, null, fixture);
    assert.deepEqual(
      computeWorkspaceDelta(baseline.entries, current.entries).paths,
      scenario.paths,
      scenario.label,
    );
    await scenario.cleanup?.();
  }

  const current = await captureWorkspaceManifest(fixture.root, null, fixture);
  assert.deepEqual(
    computeWorkspaceDelta(baseline.entries, current.entries).paths,
    ['old-name.js', 'renamed.js', 'tracked.js', 'untracked.js'],
  );
  git(fixture.root, ['add', '--all']);
  git(fixture.root, ['commit', '--quiet', '-m', 'later state']);
  const afterCommit = await captureWorkspaceManifest(fixture.root, null, fixture);
  assert.deepEqual(
    computeWorkspaceDelta(baseline.entries, afterCommit.entries).paths,
    ['old-name.js', 'renamed.js', 'tracked.js', 'untracked.js'],
    'commits do not reset the workspace baseline',
  );

  git(fixture.root, ['update-index', '--chmod=+x', '--', 'tracked.js']);
  const executable = await captureWorkspaceManifest(fixture.root, null, fixture);
  assert.equal(executable.entries.find((entry) => entry.path === 'tracked.js').index_mode, '100755');
  assert.deepEqual(computeWorkspaceDelta(afterCommit.entries, executable.entries).paths, ['tracked.js']);
});

test('workspace manifest binds staged bytes separately from worktree bytes and accepts unborn Git state', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  await writeWorkspace(fixture.root, 'tracked.js', 'export const value = "base";\n');
  git(fixture.root, ['add', '--', 'tracked.js']);
  git(fixture.root, ['commit', '--quiet', '-m', 'base']);
  await writeWorkspace(fixture.root, 'tracked.js', 'export const value = "staged";\n');
  git(fixture.root, ['add', '--', 'tracked.js']);
  await writeWorkspace(fixture.root, 'tracked.js', 'export const value = "worktree";\n');
  const staged = await captureWorkspaceManifest(fixture.root, null, fixture);
  const entry = staged.entries[0];
  assert.equal(entry.digest, digest('export const value = "worktree";\n'));
  assert.equal(entry.index_digest, digest('export const value = "staged";\n'));
  assert.notEqual(entry.digest, entry.index_digest);

  const unborn = createGoalLockFixture(testContext);
  await writeWorkspace(unborn.root, 'delivery.txt', 'unborn delivery\n');
  const manifest = await captureWorkspaceManifest(unborn.root, null, unborn);
  assert.deepEqual(manifest.entries.map((entry) => entry.source), ['untracked']);
});

test('workspace manifest rejects capture races, unsafe paths, links, and non-regular Git entries', async (testContext) => {
  const raced = createGoalLockFixture(testContext);
  await writeWorkspace(raced.root, 'delivery.txt', 'before\n');
  let changed = false;
  raced.workspaceFaults = {
    afterFileRead: async ({ relativePath }) => {
      if (!changed && relativePath === 'delivery.txt') {
        changed = true;
        await writeWorkspace(raced.root, relativePath, 'after\n');
      }
    },
  };
  await assert.rejects(captureWorkspaceManifest(raced.root, null, raced), GoalLockError);

  const inventory = createGoalLockFixture(testContext, { git: false });
  await writeWorkspace(inventory.root, 'delivery.txt', 'delivery\n');
  await assert.rejects(captureWorkspaceManifest(inventory.root, ['../escape.txt'], inventory), GoalLockError);

  const linked = createGoalLockFixture(testContext);
  await writeWorkspace(linked.root, 'source.txt', 'source\n');
  await symlink(join(linked.root, 'source.txt'), join(linked.root, 'symbolic.txt'));
  await assert.rejects(captureWorkspaceManifest(linked.root, null, linked), GoalLockError);
  await link(join(linked.root, 'source.txt'), join(linked.root, 'hard.txt'));
  await unlink(join(linked.root, 'symbolic.txt'));
  await assert.rejects(captureWorkspaceManifest(linked.root, null, linked), GoalLockError);

  const submodule = createGoalLockFixture(testContext);
  git(submodule.root, ['update-index', '--add', '--cacheinfo', '160000,4b825dc642cb6eb9a060e54bf8d69288fbee4904,nested-module']);
  await assert.rejects(captureWorkspaceManifest(submodule.root, null, submodule), GoalLockError);
});

test('inventory manifests retain only declared files and fail closed when a baseline file disappears', async (testContext) => {
  const fixture = createGoalLockFixture(testContext, { git: false });
  await writeWorkspace(fixture.root, 'delivery.txt', 'one\n');
  await writeWorkspace(fixture.root, 'external-never-listed.txt', 'not visible\n');
  const baseline = await captureWorkspaceManifest(fixture.root, ['delivery.txt'], fixture);
  assert.deepEqual(baseline.entries.map((entry) => entry.path), ['delivery.txt']);
  assert.equal(baseline.entries.some((entry) => entry.path === 'external-never-listed.txt'), false);

  await writeWorkspace(fixture.root, 'delivery.txt', 'two\n');
  const modified = await captureWorkspaceManifest(fixture.root, ['delivery.txt'], fixture);
  assert.deepEqual(computeWorkspaceDelta(baseline.entries, modified.entries).paths, ['delivery.txt']);

  await writeWorkspace(fixture.root, 'new.txt', 'new\n');
  const added = await captureWorkspaceManifest(fixture.root, ['delivery.txt', 'new.txt'], fixture);
  assert.deepEqual(computeWorkspaceDelta(modified.entries, added.entries).paths, ['new.txt']);
  const omitted = await captureWorkspaceManifest(fixture.root, ['new.txt'], fixture);
  assert.throws(() => computeWorkspaceDelta(baseline.entries, omitted.entries), GoalLockError);
  await unlink(join(fixture.root, 'delivery.txt'));
  await assert.rejects(captureWorkspaceManifest(fixture.root, ['delivery.txt', 'new.txt'], fixture), GoalLockError);
});

test('inventory fingerprint rejects a competing inventory in a Git workspace', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  await writeWorkspace(fixture.root, 'delivery.txt', 'delivery\n');
  await assert.rejects(
    inventoryWorkspaceFingerprint(fixture.root, ['delivery.txt']),
    (error) => error instanceof GoalLockError && error.code === 'WORKSPACE_INVENTORY_INVALID',
  );
});

test('scope baselines bind a manifest to the version-one goal and fingerprint its canonical bytes', async (testContext) => {
  const fixture = createGoalLockFixture(testContext, { git: false });
  await writeWorkspace(fixture.root, 'delivery.txt', 'locked\n');
  const manifest = await captureWorkspaceManifest(fixture.root, ['delivery.txt'], fixture);
  const scope = createScopeBaseline(activeGoalReference(), manifest, '2026-08-25T00:00:00.000Z');
  assert.equal(scope.mode, 'inventory');
  assert.deepEqual(verifyScopeBaseline(scope, activeGoalReference()), scope);
  assert.match(scope.record_digest, /^[a-f0-9]{64}$/);
  assert.equal(workspaceFingerprintFromManifest(manifest), manifest.manifest_digest);
});
