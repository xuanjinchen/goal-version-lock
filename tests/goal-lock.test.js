import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { link, lstat, mkdir, readFile, readdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { canonicalBytes, canonicalJson, parseCanonicalJson, sha256 } from '../src/goal-lock/canonical.js';
import {
  GoalLockError,
  approvalPhraseForChange,
  approvalPhraseForGoal,
  normalizeRelativePath,
  validateGoalContract,
  validateLockRecord,
} from '../src/goal-lock/contracts.js';
import { commitGoalFiles, recoverGoalLock, withGoalLock } from '../src/goal-lock/transaction.js';
import { createGoalLockFixture } from './helpers/goal-lock-fixture.js';

async function goalRepository() {
  return import('../src/goal-lock/repository.js');
}

async function optionalBytes(target) {
  try {
    return await readFile(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

test('initializes goal draft as the only initial repository record', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const draft = goalV1();
  const expectedCurrent = Buffer.from('{"acceptance_criteria":[{"id":"AC-001","outcome":"State is locked","verification":"Run verification"}],"accepted_change_id":null,"assumptions":[{"confidence":"medium","statement":"Git is installed"}],"authorization_boundary":["Local workspace only"],"constraints":[{"id":"C-001","text":"Use Node.js"}],"goal_id":"GL-ALPHA","goal_version":1,"non_goals":["Remote publishing"],"objective":"Ship a safe lock","predecessor":null,"schema_version":1,"scope":{"in":["CLI"],"out":["Cloud sync"]}}\n');
  const { initializeGoal } = await goalRepository();

  const result = await initializeGoal(fixture.root, draft, fixture);

  assert.deepEqual(result, {
    state: 'DRAFT',
    goal_id: 'GL-ALPHA',
    goal_version: 1,
    goal_digest: '92d74f6bf766e096e71b949ff57e2d9a12302a4519226d05cf67c2b544babaa6',
    approval_required: 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766',
  });
  assert.deepEqual(await readFile(join(fixture.root, '.goal-lock', 'current.json')), expectedCurrent);
  assert.equal(await optionalBytes(join(fixture.root, '.goal-lock', 'lock.json')), null);
  assert.equal(await optionalBytes(join(fixture.root, '.goal-lock', 'history', 'goals', 'v0001.json')), null);
  assert.deepEqual(await readdir(join(fixture.root, '.goal-lock')), ['current.json']);
});

test('initializes goal draft validates before creating goal-lock state', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const invalid = goalV1();
  invalid.goal_version = 2;
  const { initializeGoal } = await goalRepository();

  await assert.rejects(initializeGoal(fixture.root, invalid, fixture), (error) => error instanceof GoalLockError && error.code === 'INVALID_CONTRACT');

  assert.equal(existsSync(join(fixture.root, '.goal-lock')), false);
});

test('initializes goal draft refuses pre-existing non-empty or linked goal-lock directories', async (testContext) => {
  const { initializeGoal } = await goalRepository();
  const occupied = createGoalLockFixture(testContext);
  const occupiedDirectory = join(occupied.root, '.goal-lock');
  const sentinel = join(occupiedDirectory, 'foreign.json');
  await mkdir(occupiedDirectory);
  await writeFile(sentinel, 'foreign bytes');

  await assert.rejects(initializeGoal(occupied.root, goalV1(), occupied), /goal-lock|initial|state/i);
  assert.deepEqual(await readFile(sentinel), Buffer.from('foreign bytes'));

  const linked = createGoalLockFixture(testContext);
  const externalDirectory = join(linked.root, 'external-goal-lock');
  const externalSentinel = join(externalDirectory, 'foreign.json');
  await mkdir(externalDirectory);
  await writeFile(externalSentinel, 'linked foreign bytes');
  try {
    await symlink(externalDirectory, join(linked.root, '.goal-lock'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EACCES', 'EPERM', 'ENOTSUP'].includes(error?.code)) {
      testContext.skip(`directory links unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  await assert.rejects(initializeGoal(linked.root, goalV1(), linked), /goal-lock|link|directory|state/i);
  assert.deepEqual(await readFile(externalSentinel), Buffer.from('linked foreign bytes'));
});

test('initializes goal draft refuses a repeated initialization without changing bytes', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const { initializeGoal } = await goalRepository();
  await initializeGoal(fixture.root, goalV1(), fixture);
  const currentPath = join(fixture.root, '.goal-lock', 'current.json');
  const before = await readFile(currentPath);

  await assert.rejects(initializeGoal(fixture.root, goalV1(), fixture), /goal-lock|initial|state/i);

  assert.deepEqual(await readFile(currentPath), before);
  assert.deepEqual(await readdir(join(fixture.root, '.goal-lock')), ['current.json']);
});

test('initializes goal draft preserves an empty goal-lock directory created after preflight', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const { initializeGoal } = await goalRepository();
  const directory = join(fixture.root, '.goal-lock');
  fixture.transactionFaults.beforeGoalLockMkdir = async () => { await mkdir(directory); };
  fixture.transactionFaults.install = () => { throw new Error('install failure'); };

  await assert.rejects(initializeGoal(fixture.root, goalV1(), fixture), /install failure/);

  assert.equal(existsSync(directory), true);
  assert.deepEqual(await readdir(directory), []);
});

test('version 1 lock rejects every approval other than the exact current phrase', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const { initializeGoal, lockInitialGoal } = await goalRepository();
  await initializeGoal(fixture.root, goalV1(), fixture);
  const approvals = [
    'APPROVE GOAL',
    'approve goal gl-alpha version 1 92d74f6bf766',
    ' APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766',
    'APPROVE GOAL GL-BETA VERSION 1 92d74f6bf766',
    'APPROVE GOAL GL-ALPHA VERSION 2 92d74f6bf766',
    'APPROVE GOAL GL-ALPHA VERSION 1 000000000000',
  ];

  for (const approval of approvals) {
    await assert.rejects(lockInitialGoal(fixture.root, approval, fixture), /approval|approve|confirmation/i);
    assert.equal(await optionalBytes(join(fixture.root, '.goal-lock', 'lock.json')), null);
    assert.equal(await optionalBytes(join(fixture.root, '.goal-lock', 'history', 'goals', 'v0001.json')), null);
  }
});

test('version 1 lock records the exact approved current bytes in immutable history', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const { initializeGoal, lockInitialGoal } = await goalRepository();
  await initializeGoal(fixture.root, goalV1(), fixture);
  const currentPath = join(fixture.root, '.goal-lock', 'current.json');
  const current = await readFile(currentPath);

  await lockInitialGoal(fixture.root, 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766', fixture);

  const lock = parseCanonicalJson(await readFile(join(fixture.root, '.goal-lock', 'lock.json')), 'lock');
  const { record_digest, ...lockWithoutDigest } = lock;
  assert.deepEqual(lockWithoutDigest, {
    schema_version: 1,
    goal_id: 'GL-ALPHA',
    goal_version: 1,
    goal_digest: '92d74f6bf766e096e71b949ff57e2d9a12302a4519226d05cf67c2b544babaa6',
    approval_type: 'explicit-version-1',
    proposal_digest: '92d74f6bf766e096e71b949ff57e2d9a12302a4519226d05cf67c2b544babaa6',
    approved_at: '2026-08-23T00:00:00.000Z',
    predecessor_digest: null,
    state_revision: 1,
    progress_head: null,
    change_head: null,
    evidence_heads: {},
  });
  assert.equal(record_digest, sha256(canonicalBytes(lockWithoutDigest)));
  assert.deepEqual(validateLockRecord(lock), lock);
  assert.deepEqual(await readFile(currentPath), current);
  assert.deepEqual(await readFile(join(fixture.root, '.goal-lock', 'history', 'goals', 'v0001.json')), current);

  const lockBytes = await readFile(join(fixture.root, '.goal-lock', 'lock.json'));
  await assert.rejects(lockInitialGoal(fixture.root, 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766', fixture), /lock|state|initial/i);
  assert.deepEqual(await readFile(join(fixture.root, '.goal-lock', 'lock.json')), lockBytes);
});

test('version 1 lock rolls back lock and history when either installation fails', async (testContext) => {
  const { initializeGoal, lockInitialGoal } = await goalRepository();

  for (const failedInstallation of [0, 1]) {
    const fixture = createGoalLockFixture(testContext);
    await initializeGoal(fixture.root, goalV1(), fixture);
    const currentPath = join(fixture.root, '.goal-lock', 'current.json');
    const current = await readFile(currentPath);
    let installations = 0;
    fixture.transactionFaults.install = () => {
      if (installations++ === failedInstallation) throw new Error(`install-${failedInstallation}`);
    };

    await assert.rejects(lockInitialGoal(fixture.root, 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766', fixture), new RegExp(`install-${failedInstallation}`));

    assert.deepEqual(await readFile(currentPath), current);
    assert.equal(await optionalBytes(join(fixture.root, '.goal-lock', 'lock.json')), null);
    assert.equal(await optionalBytes(join(fixture.root, '.goal-lock', 'history', 'goals', 'v0001.json')), null);
  }
});

test('version 1 lock rolls back when current draft ownership changes during final verification', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const { initializeGoal, lockInitialGoal } = await goalRepository();
  await initializeGoal(fixture.root, goalV1(), fixture);
  const currentPath = join(fixture.root, '.goal-lock', 'current.json');
  const externallyEdited = goalV1();
  externallyEdited.objective = 'Edited outside the writer protocol';
  const editedBytes = canonicalBytes(externallyEdited);
  fixture.transactionFaults.finalReadBack = async () => { await writeFile(currentPath, editedBytes); };

  await assert.rejects(lockInitialGoal(fixture.root, 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766', fixture), /ownership|current|digest|transaction/i);

  assert.deepEqual(await readFile(currentPath), editedBytes);
  assert.equal(await optionalBytes(join(fixture.root, '.goal-lock', 'lock.json')), null);
  assert.equal(await optionalBytes(join(fixture.root, '.goal-lock', 'history', 'goals', 'v0001.json')), null);
});

test('cooperative lock writes canonical owner bytes and removes them after success', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);

  const result = await withGoalLock(fixture.root, 'init', async () => {
    const bytes = await readFile(join(fixture.root, '.goal-lock', '.write-lock.json'));
    assert.deepEqual(bytes, canonicalBytes({
      protocol: 'goal-version-lock-write-v1',
      token: 'deterministic-token',
      pid: 4242,
      command: 'init',
      created_at: '2026-08-23T00:00:00.000Z',
    }));
    return 'committed';
  }, fixture);

  assert.equal(result, 'committed');
  assert.equal(existsSync(join(fixture.root, '.goal-lock', '.write-lock.json')), false);
});

test('cooperative lock rejects a second writer without disturbing the owner', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const lockPath = join(fixture.root, '.goal-lock', '.write-lock.json');

  await withGoalLock(fixture.root, 'first', async () => {
    const ownerBytes = await readFile(lockPath);
    await assert.rejects(
      withGoalLock(fixture.root, 'second', async () => {}, fixture),
      (error) => error instanceof GoalLockError && error.code === 'LOCK_HELD' && error.exitCode === 3,
    );
    assert.deepEqual(await readFile(lockPath), ownerBytes);
  }, fixture);
});

test('cooperative lock cleans up after a failed callback', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const failure = new Error('operation failed');

  await assert.rejects(
    withGoalLock(fixture.root, 'record', async () => { throw failure; }, fixture),
    (error) => error === failure,
  );
  assert.equal(existsSync(join(fixture.root, '.goal-lock', '.write-lock.json')), false);
});

test('cooperative lock release preserves another writer replacement', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const lockPath = join(fixture.root, '.goal-lock', '.write-lock.json');
  const replacement = canonicalBytes({
    protocol: 'goal-version-lock-write-v1',
    token: 'replacement-token',
    pid: 4343,
    command: 'approve',
    created_at: '2026-08-23T00:01:00.000Z',
  });

  await assert.rejects(withGoalLock(fixture.root, 'record', async () => {
    await unlink(lockPath);
    await writeFile(lockPath, replacement, { mode: 0o600 });
  }, fixture), (error) => error instanceof GoalLockError && error.code === 'LOCK_OWNERSHIP');

  assert.deepEqual(await readFile(lockPath), replacement);
});

test('cooperative lock treats malformed existing ownership as integrity failure', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const lockPath = join(fixture.root, '.goal-lock', '.write-lock.json');
  await mkdir(join(fixture.root, '.goal-lock'));
  await writeFile(lockPath, 'not canonical JSON', { mode: 0o600 });

  await assert.rejects(
    withGoalLock(fixture.root, 'init', async () => {}, fixture),
    (error) => error instanceof GoalLockError && error.kind === 'integrity' && error.exitCode === 4,
  );
  assert.equal((await readFile(lockPath, 'utf8')), 'not canonical JSON');
});

test('cooperative lock cleans only its own initialized lock after a write fault', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const failure = new Error('lock write fault');
  fixture.transactionFaults.afterLockWrite = () => { throw failure; };

  await assert.rejects(
    withGoalLock(fixture.root, 'init', async () => {}, fixture),
    (error) => error === failure,
  );
  assert.equal(existsSync(join(fixture.root, '.goal-lock', '.write-lock.json')), false);
});

test('cooperative lock rejects a linked repository root before mutation', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const actualRoot = join(fixture.root, 'actual');
  const linkedRoot = join(fixture.root, 'linked');
  await mkdir(actualRoot);
  await symlink(actualRoot, linkedRoot, 'junction');

  await assert.rejects(
    withGoalLock(linkedRoot, 'init', async () => {}, fixture),
    (error) => error instanceof GoalLockError && error.kind === 'integrity',
  );
  assert.equal(existsSync(join(actualRoot, '.goal-lock')), false);
});

test('cooperative lock rejects semantically invalid canonical owner records', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  const lockPath = join(directory, '.write-lock.json');
  await mkdir(directory);
  await writeFile(lockPath, canonicalBytes({
    protocol: 'goal-version-lock-write-v1',
    token: 'old-owner',
    pid: 1234,
    command: 'record',
    created_at: '2026-02-30T00:00:00.000Z',
  }));

  await assert.rejects(
    withGoalLock(fixture.root, 'init', async () => {}, fixture),
    (error) => error instanceof GoalLockError && error.kind === 'integrity',
  );
});

test('cooperative lock validates owner inputs before creating state', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);

  await assert.rejects(
    withGoalLock(fixture.root, ' ', async () => {}, fixture),
    (error) => error instanceof GoalLockError && error.kind === 'input',
  );
  assert.equal(existsSync(join(fixture.root, '.goal-lock')), false);
});

test('cooperative lock issues a fresh token for each acquisition', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const issued = ['token-one', 'token-two'];
  const observed = [];
  const context = { ...fixture, randomToken: () => issued.shift() };

  for (const command of ['init', 'plan']) {
    await withGoalLock(fixture.root, command, async () => {
      const owner = parseCanonicalJson(await readFile(join(fixture.root, '.goal-lock', '.write-lock.json')));
      observed.push(owner.token);
    }, context);
  }

  assert.deepEqual(observed, ['token-one', 'token-two']);
});

test('cooperative lock age alone never authorizes removal', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  const lockPath = join(directory, '.write-lock.json');
  const oldOwner = canonicalBytes({
    protocol: 'goal-version-lock-write-v1',
    token: 'old-owner',
    pid: 1234,
    command: 'record',
    created_at: '2000-01-01T00:00:00.000Z',
  });
  await mkdir(directory);
  await writeFile(lockPath, oldOwner);

  await assert.rejects(
    withGoalLock(fixture.root, 'init', async () => {}, fixture),
    (error) => error instanceof GoalLockError && error.code === 'LOCK_HELD',
  );
  assert.deepEqual(await readFile(lockPath), oldOwner);
});

test('cooperative lock rejects non-regular and linked lock paths', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  const lockPath = join(directory, '.write-lock.json');
  await mkdir(directory);
  await mkdir(lockPath);

  await assert.rejects(
    withGoalLock(fixture.root, 'init', async () => {}, fixture),
    (error) => error instanceof GoalLockError && error.kind === 'integrity',
  );

  const linkedFixture = createGoalLockFixture(testContext);
  const linkedDirectory = join(linkedFixture.root, '.goal-lock');
  const realDirectory = join(linkedDirectory, 'owner-directory');
  const linkedLockPath = join(linkedDirectory, '.write-lock.json');
  await mkdir(realDirectory, { recursive: true });
  await symlink(realDirectory, linkedLockPath, 'junction');
  await assert.rejects(
    withGoalLock(linkedFixture.root, 'init', async () => {}, linkedFixture),
    (error) => error instanceof GoalLockError && error.kind === 'integrity',
  );
});

test('cooperative lock rejects an external hard-linked existing owner', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  const lockPath = join(directory, '.write-lock.json');
  const externalPath = join(fixture.root, 'external-owner.json');
  const ownerBytes = canonicalBytes({
    protocol: 'goal-version-lock-write-v1', token: 'external-owner', pid: 9999, command: 'record', created_at: '2026-08-22T00:00:00.000Z',
  });
  await mkdir(directory);
  await writeFile(externalPath, ownerBytes);
  await link(externalPath, lockPath);

  await assert.rejects(
    withGoalLock(fixture.root, 'init', async () => {}, fixture),
    (error) => error instanceof GoalLockError && error.kind === 'integrity',
  );
  assert.deepEqual(await readFile(lockPath), ownerBytes);
  assert.equal((await lstat(lockPath, { bigint: true })).nlink, 2n);
});

test('cooperative lock release refuses an external hard link added by its callback', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const lockPath = join(fixture.root, '.goal-lock', '.write-lock.json');
  const externalPath = join(fixture.root, 'external-owner.json');

  await assert.rejects(withGoalLock(fixture.root, 'record', async () => {
    await link(lockPath, externalPath);
  }, fixture), (error) => error instanceof GoalLockError && error.kind === 'integrity');

  assert.equal(existsSync(lockPath), true);
  assert.equal(existsSync(externalPath), true);
  assert.equal((await lstat(lockPath, { bigint: true })).nlink, 2n);
});

test('transaction completes every target preflight before creating files', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);

  await assert.rejects(commitGoalFiles(fixture.root, [
    { target: '.goal-lock/current.json', expected: { kind: 'absent' }, content: Buffer.from('current') },
    { target: '.goal-lock/plan.json', expected: { kind: 'sha256', digest: '1'.repeat(64) }, content: Buffer.from('plan') },
  ], fixture), (error) => error instanceof GoalLockError && error.kind === 'integrity');

  assert.equal(existsSync(join(fixture.root, '.goal-lock')), false);
});

test('transaction rejects expected-absent ownership without changing the target', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const target = join(fixture.root, '.goal-lock', 'current.json');
  const original = Buffer.from('accepted-current');
  await mkdir(join(fixture.root, '.goal-lock'));
  await writeFile(target, original);

  await assert.rejects(commitGoalFiles(fixture.root, [
    { target: '.goal-lock/current.json', expected: { kind: 'absent' }, content: Buffer.from('replacement') },
  ], fixture), (error) => error instanceof GoalLockError && error.kind === 'integrity');
  assert.deepEqual(await readFile(target), original);
});

test('transaction creates an expected-absent target through a cleaned same-directory stage', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const content = canonicalBytes({ schema_version: 1 });

  const receipt = await commitGoalFiles(fixture.root, [
    { target: '.goal-lock/current.json', expected: { kind: 'absent' }, content },
  ], fixture);

  assert.deepEqual(await readFile(join(fixture.root, '.goal-lock', 'current.json')), content);
  assert.deepEqual(await readdir(join(fixture.root, '.goal-lock')), ['current.json']);
  assert.deepEqual(receipt, { warnings: [] });
});

test('transaction retains target identity when exact bytes are a final ownership precondition', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  const currentPath = join(directory, 'current.json');
  const current = canonicalBytes({ goal: 'draft' });
  await mkdir(directory);
  await writeFile(currentPath, current);
  const before = await lstat(currentPath, { bigint: true });

  await commitGoalFiles(fixture.root, [
    { target: '.goal-lock/current.json', expected: { kind: 'sha256', digest: sha256(current) }, content: current },
    { target: '.goal-lock/lock.json', expected: { kind: 'absent' }, content: canonicalBytes({ state: 'locked' }) },
  ], fixture);

  const after = await lstat(currentPath, { bigint: true });
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.deepEqual(await readFile(currentPath), current);
});

test('transaction replaces only the target with the exact expected digest', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  const target = join(directory, 'current.json');
  const original = canonicalBytes({ version: 1 });
  const replacement = canonicalBytes({ version: 2 });
  await mkdir(directory);
  await writeFile(target, original);

  const receipt = await commitGoalFiles(fixture.root, [
    { target: '.goal-lock/current.json', expected: { kind: 'sha256', digest: sha256(original) }, content: replacement },
  ], fixture);

  assert.deepEqual(await readFile(target), replacement);
  assert.deepEqual(await readdir(directory), ['current.json']);
  assert.deepEqual(receipt, { warnings: [] });
});

test('transaction rejects duplicate targets during preflight', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);

  await assert.rejects(commitGoalFiles(fixture.root, [
    { target: '.goal-lock/current.json', expected: { kind: 'absent' }, content: Buffer.from('one') },
    { target: '.goal-lock/current.json', expected: { kind: 'absent' }, content: Buffer.from('two') },
  ], fixture), (error) => error instanceof GoalLockError && error.kind === 'integrity');

  assert.equal(existsSync(join(fixture.root, '.goal-lock')), false);
});

test('transaction rejects unknown entry fields before mutation', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);

  await assert.rejects(commitGoalFiles(fixture.root, [
    { target: '.goal-lock/current.json', expected: { kind: 'absent' }, content: Buffer.from('current'), extra: true },
  ], fixture), (error) => error instanceof GoalLockError && error.kind === 'input');

  assert.equal(existsSync(join(fixture.root, '.goal-lock')), false);
});

test('transaction rejects escaping and internal ownership targets', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const unsafeTargets = [
    'current.json',
    '.goal-lock/../outside.json',
    '.goal-lock\\current.json',
    join(fixture.root, '.goal-lock', 'current.json'),
    '.goal-lock/.write-lock.json',
    '.goal-lock/.current.example.0.stage',
    '.goal-lock/.current.example.0.backup',
  ];

  for (const target of unsafeTargets) {
    await assert.rejects(commitGoalFiles(fixture.root, [
      { target, expected: { kind: 'absent' }, content: Buffer.from('unsafe') },
    ], fixture), (error) => error instanceof GoalLockError && error.kind === 'integrity');
    assert.equal(existsSync(join(fixture.root, '.goal-lock')), false);
  }
});

test('transaction rejects internal ownership artifact names in ancestor segments', async (testContext) => {
  const targets = [
    '.goal-lock/.write-lock.json/child.json',
    '.goal-lock/.current.example.0.stage/child.json',
    '.goal-lock/.current.example.0.backup/child.json',
    '.goal-lock/.current.example.0.detached/child.json',
  ];

  for (const target of targets) {
    const fixture = createGoalLockFixture(testContext);
    await assert.rejects(commitGoalFiles(fixture.root, [
      { target, expected: { kind: 'absent' }, content: Buffer.from('unsafe') },
    ], fixture), (error) => error instanceof GoalLockError && error.kind === 'integrity');
    assert.equal(existsSync(join(fixture.root, '.goal-lock')), false);
  }
});

test('transaction rejects linked target parents before mutation', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  const external = join(fixture.root, 'external');
  await mkdir(directory);
  await mkdir(external);
  await symlink(external, join(directory, 'history'), 'junction');

  await assert.rejects(commitGoalFiles(fixture.root, [
    { target: '.goal-lock/history/goals/v0001.json', expected: { kind: 'absent' }, content: Buffer.from('history') },
  ], fixture), (error) => error instanceof GoalLockError && error.kind === 'integrity');
  assert.deepEqual(await readdir(external), []);
});

test('transaction stage write failure removes only directories it created', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const evidenceDirectory = join(fixture.root, '.goal-lock', 'evidence');
  const createdDirectory = join(evidenceDirectory, 'AC-001');
  const failure = new Error('stage write failed');
  await mkdir(evidenceDirectory, { recursive: true });
  fixture.transactionFaults.stageWrite = () => { throw failure; };

  await assert.rejects(commitGoalFiles(fixture.root, [
    { target: '.goal-lock/evidence/AC-001/EVID-0001.json', expected: { kind: 'absent' }, content: Buffer.from('evidence') },
  ], fixture), (error) => error === failure);

  assert.equal(existsSync(createdDirectory), false);
  assert.equal(existsSync(evidenceDirectory), true);
  assert.deepEqual(await readdir(evidenceDirectory), []);
});

test('transaction detach failure preserves the original and removes owned artifacts', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  const target = join(directory, 'current.json');
  const original = Buffer.from('accepted');
  const failure = new Error('detach failed');
  await mkdir(directory);
  await writeFile(target, original);
  fixture.transactionFaults.detach = () => { throw failure; };

  await assert.rejects(commitGoalFiles(fixture.root, [
    { target: '.goal-lock/current.json', expected: { kind: 'sha256', digest: sha256(original) }, content: Buffer.from('candidate') },
  ], fixture), (error) => error === failure);

  assert.deepEqual(await readFile(target), original);
  assert.deepEqual(await readdir(directory), ['current.json']);
});

test('transaction install failure restores the detached original', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  const target = join(directory, 'current.json');
  const original = Buffer.from('accepted');
  const failure = new Error('install failed');
  await mkdir(directory);
  await writeFile(target, original);
  fixture.transactionFaults.install = () => { throw failure; };

  await assert.rejects(commitGoalFiles(fixture.root, [
    { target: '.goal-lock/current.json', expected: { kind: 'sha256', digest: sha256(original) }, content: Buffer.from('candidate') },
  ], fixture), (error) => error === failure);

  assert.deepEqual(await readFile(target), original);
  assert.deepEqual(await readdir(directory), ['current.json']);
});

test('transaction read-back failure rolls back a verified installation', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  const target = join(directory, 'current.json');
  const original = Buffer.from('accepted');
  const failure = new Error('read-back mismatch');
  await mkdir(directory);
  await writeFile(target, original);
  fixture.transactionFaults.readBack = () => { throw failure; };

  await assert.rejects(commitGoalFiles(fixture.root, [
    { target: '.goal-lock/current.json', expected: { kind: 'sha256', digest: sha256(original) }, content: Buffer.from('candidate') },
  ], fixture), (error) => error === failure);

  assert.deepEqual(await readFile(target), original);
  assert.deepEqual(await readdir(directory), ['current.json']);
});

test('transaction restores the original when the installed target disappears during verification', async (testContext) => {
  for (const phase of ['readBack', 'finalReadBack']) {
    const fixture = createGoalLockFixture(testContext);
    const directory = join(fixture.root, '.goal-lock');
    const target = join(directory, 'current.json');
    const original = Buffer.from('accepted');
    await mkdir(directory);
    await writeFile(target, original);
    fixture.transactionFaults[phase] = async () => { await unlink(target); };

    await assert.rejects(commitGoalFiles(fixture.root, [
      { target: '.goal-lock/current.json', expected: { kind: 'sha256', digest: sha256(original) }, content: Buffer.from('candidate') },
    ], fixture), (error) => error instanceof Error && !(error instanceof AggregateError));

    assert.deepEqual(await readFile(target), original);
    assert.deepEqual(await readdir(directory), ['current.json']);
  }
});

test('transaction final read-back detects a changed installed target', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  const target = join(directory, 'current.json');
  const original = Buffer.from('accepted');
  const foreign = Buffer.from('changed-after-install');
  await mkdir(directory);
  await writeFile(target, original);
  fixture.transactionFaults.finalReadBack = async () => {
    await unlink(target);
    await writeFile(target, foreign);
  };

  await assert.rejects(commitGoalFiles(fixture.root, [
    { target: '.goal-lock/current.json', expected: { kind: 'sha256', digest: sha256(original) }, content: Buffer.from('candidate') },
  ], fixture), AggregateError);

  assert.deepEqual(await readFile(target), foreign);
  assert.equal((await readdir(directory)).filter((name) => name.endsWith('.backup')).length, 1);
});

test('transaction rolls back touched targets in reverse order', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const rollbackOrder = [];
  fixture.transactionFaults.readBack = ({ index }) => {
    if (index === 1) throw new Error('second read-back failed');
  };
  fixture.transactionFaults.rollback = ({ index }) => { rollbackOrder.push(index); };

  await assert.rejects(commitGoalFiles(fixture.root, [
    { target: '.goal-lock/current.json', expected: { kind: 'absent' }, content: Buffer.from('current') },
    { target: '.goal-lock/plan.json', expected: { kind: 'absent' }, content: Buffer.from('plan') },
  ], fixture), /second read-back failed/);

  assert.deepEqual(rollbackOrder, [1, 0]);
  assert.equal(existsSync(join(fixture.root, '.goal-lock')), false);
});

test('transaction preserves foreign replacement and owned recovery backup when rollback is uncertain', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  const target = join(directory, 'current.json');
  const original = Buffer.from('accepted');
  const foreign = Buffer.from('foreign-writer');
  await mkdir(directory);
  await writeFile(target, original);
  fixture.transactionFaults.readBack = async () => {
    await unlink(target);
    await writeFile(target, foreign);
    throw new Error('raced read-back');
  };

  await assert.rejects(commitGoalFiles(fixture.root, [
    { target: '.goal-lock/current.json', expected: { kind: 'sha256', digest: sha256(original) }, content: Buffer.from('candidate') },
  ], fixture), AggregateError);

  assert.deepEqual(await readFile(target), foreign);
  const recoveryArtifacts = (await readdir(directory)).filter((name) => name.endsWith('.backup'));
  assert.equal(recoveryArtifacts.length, 1);
  assert.deepEqual(await readFile(join(directory, recoveryArtifacts[0])), original);
});

test('transaction deletes a target only with its exact expected digest', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  const target = join(directory, 'plan.json');
  const original = Buffer.from('plan');
  await mkdir(directory);
  await writeFile(target, original);

  await commitGoalFiles(fixture.root, [
    { target: '.goal-lock/plan.json', expected: { kind: 'sha256', digest: sha256(original) }, content: null },
  ], fixture);

  assert.equal(existsSync(target), false);
  assert.deepEqual(await readdir(directory), []);
});

test('transaction rejects a stale expected digest without producing stages', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  const target = join(directory, 'current.json');
  const original = Buffer.from('accepted');
  await mkdir(directory);
  await writeFile(target, original);

  await assert.rejects(commitGoalFiles(fixture.root, [
    { target: '.goal-lock/current.json', expected: { kind: 'sha256', digest: 'a'.repeat(64) }, content: Buffer.from('candidate') },
  ], fixture), (error) => error instanceof GoalLockError && error.kind === 'integrity');

  assert.deepEqual(await readFile(target), original);
  assert.deepEqual(await readdir(directory), ['current.json']);
});

test('recover removes an exact canonical lock only after its process is dead', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  const lockPath = join(directory, '.write-lock.json');
  const lockBytes = canonicalBytes({
    protocol: 'goal-version-lock-write-v1',
    token: 'stale-owner',
    pid: 9999,
    command: 'record',
    created_at: '2026-08-22T00:00:00.000Z',
  });
  await mkdir(directory);
  await writeFile(lockPath, lockBytes);

  const receipt = await recoverGoalLock(fixture.root, {
    owner_token: 'stale-owner',
    lock_digest: sha256(lockBytes),
  }, fixture);

  assert.deepEqual(receipt, {
    recovered: true,
    pid: 9999,
    command: 'record',
    created_at: '2026-08-22T00:00:00.000Z',
  });
  assert.equal(Object.hasOwn(receipt, 'token'), false);
  assert.equal(existsSync(lockPath), false);
});

test('recover refuses an externally hard-linked lock', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  const lockPath = join(directory, '.write-lock.json');
  const externalPath = join(fixture.root, 'external-owner.json');
  const lockBytes = canonicalBytes({
    protocol: 'goal-version-lock-write-v1', token: 'stale-owner', pid: 9999, command: 'record', created_at: '2026-08-22T00:00:00.000Z',
  });
  await mkdir(directory);
  await writeFile(externalPath, lockBytes);
  await link(externalPath, lockPath);

  await assert.rejects(recoverGoalLock(fixture.root, {
    owner_token: 'stale-owner',
    lock_digest: sha256(lockBytes),
  }, fixture), (error) => error instanceof GoalLockError && error.kind === 'integrity');

  assert.deepEqual(await readFile(lockPath), lockBytes);
  assert.equal((await lstat(lockPath, { bigint: true })).nlink, 2n);
});

test('recover rejects a missing lock without creating recovery state', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);

  await assert.rejects(recoverGoalLock(fixture.root, {
    owner_token: 'missing-owner',
    lock_digest: '0'.repeat(64),
  }, fixture), (error) => error instanceof GoalLockError && error.code === 'RECOVERY_LOCK_MISSING');

  assert.equal(existsSync(join(fixture.root, '.goal-lock')), false);
});

test('recover refuses live and inaccessible process states', async (testContext) => {
  for (const isProcessAlive of [
    () => true,
    () => { throw Object.assign(new Error('access denied'), { code: 'EPERM' }); },
  ]) {
    const fixture = createGoalLockFixture(testContext);
    const directory = join(fixture.root, '.goal-lock');
    const lockPath = join(directory, '.write-lock.json');
    const lockBytes = canonicalBytes({
      protocol: 'goal-version-lock-write-v1',
      token: 'current-owner',
      pid: 9999,
      command: 'record',
      created_at: '2026-08-22T00:00:00.000Z',
    });
    await mkdir(directory);
    await writeFile(lockPath, lockBytes);

    await assert.rejects(recoverGoalLock(fixture.root, {
      owner_token: 'current-owner',
      lock_digest: sha256(lockBytes),
    }, { ...fixture, isProcessAlive }), (error) => error instanceof GoalLockError && error.kind === 'integrity');
    assert.deepEqual(await readFile(lockPath), lockBytes);
    assert.deepEqual(await readdir(directory), ['.write-lock.json']);
  }
});

test('recover rejects malformed bytes and mismatched token or digest', async (testContext) => {
  const cases = [
    { bytes: Buffer.from('not canonical'), owner_token: 'owner', lock_digest: sha256(Buffer.from('not canonical')) },
    {
      bytes: canonicalBytes({ protocol: 'goal-version-lock-write-v1', token: 'owner', pid: 9999, command: 'record', created_at: '2026-08-22T00:00:00.000Z' }),
      owner_token: 'wrong-owner',
      lock_digest: null,
    },
    {
      bytes: canonicalBytes({ protocol: 'goal-version-lock-write-v1', token: 'owner', pid: 9999, command: 'record', created_at: '2026-08-22T00:00:00.000Z' }),
      owner_token: 'owner',
      lock_digest: 'f'.repeat(64),
    },
  ];

  for (const recoveryCase of cases) {
    const fixture = createGoalLockFixture(testContext);
    const directory = join(fixture.root, '.goal-lock');
    const lockPath = join(directory, '.write-lock.json');
    await mkdir(directory);
    await writeFile(lockPath, recoveryCase.bytes);
    const lockDigest = recoveryCase.lock_digest ?? sha256(recoveryCase.bytes);

    await assert.rejects(recoverGoalLock(fixture.root, {
      owner_token: recoveryCase.owner_token,
      lock_digest: lockDigest,
    }, fixture), (error) => error instanceof GoalLockError && error.kind === 'integrity');
    assert.deepEqual(await readFile(lockPath), recoveryCase.bytes);
  }
});

test('recover rejects a raced lock identity without disturbing its replacement', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  const lockPath = join(directory, '.write-lock.json');
  const initial = canonicalBytes({
    protocol: 'goal-version-lock-write-v1', token: 'stale-owner', pid: 9999, command: 'record', created_at: '2026-08-22T00:00:00.000Z',
  });
  const replacement = canonicalBytes({
    protocol: 'goal-version-lock-write-v1', token: 'new-owner', pid: 8888, command: 'plan', created_at: '2026-08-23T00:00:00.000Z',
  });
  await mkdir(directory);
  await writeFile(lockPath, initial);
  fixture.transactionFaults.beforeRecoveryDetach = async () => {
    await unlink(lockPath);
    await writeFile(lockPath, replacement);
  };

  await assert.rejects(recoverGoalLock(fixture.root, {
    owner_token: 'stale-owner',
    lock_digest: sha256(initial),
  }, fixture), (error) => error instanceof GoalLockError && error.kind === 'integrity');

  assert.deepEqual(await readFile(lockPath), replacement);
  assert.deepEqual(await readdir(directory), ['.write-lock.json']);
});

test('recover restores the verified lock if its process becomes active before removal', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  const lockPath = join(directory, '.write-lock.json');
  const lockBytes = canonicalBytes({
    protocol: 'goal-version-lock-write-v1', token: 'owner', pid: 9999, command: 'record', created_at: '2026-08-22T00:00:00.000Z',
  });
  let checks = 0;
  await mkdir(directory);
  await writeFile(lockPath, lockBytes);

  await assert.rejects(recoverGoalLock(fixture.root, {
    owner_token: 'owner',
    lock_digest: sha256(lockBytes),
  }, { ...fixture, isProcessAlive: () => { checks += 1; return checks > 1; } }),
  (error) => error instanceof GoalLockError && error.code === 'RECOVERY_PROCESS_ACTIVE');

  assert.equal(checks, 2);
  assert.deepEqual(await readFile(lockPath), lockBytes);
  assert.deepEqual(await readdir(directory), ['.write-lock.json']);
});

test('canonical JSON recursively orders object keys while preserving array order', () => {
  const value = { z: [{ b: 2, a: 1 }, 'last'], a: { z: true, a: false } };

  assert.equal(canonicalJson(value), '{"a":{"a":false,"z":true},"z":[{"a":1,"b":2},"last"]}\n');
});

test('canonical JSON preserves a valid __proto__ JSON key as data', () => {
  const value = JSON.parse('{"a":1,"__proto__":{"safe":true}}');

  assert.equal(canonicalJson(value), '{"__proto__":{"safe":true},"a":1}\n');
  assert.deepEqual(parseCanonicalJson(Buffer.from('{"__proto__":{"safe":true},"a":1}\n'), 'goal'), value);
});

test('canonical JSON round-trips Unicode as UTF-8 bytes with one final LF', () => {
  const bytes = canonicalBytes({ greeting: '你好😀' });

  assert.deepEqual(bytes, Buffer.from('{"greeting":"你好😀"}\n', 'utf8'));
  assert.deepEqual(parseCanonicalJson(bytes, 'Unicode document'), { greeting: '你好😀' });
  assert.equal(bytes.toString('utf8').endsWith('\n'), true);
  assert.equal(bytes.toString('utf8').endsWith('\n\n'), false);
});

test('canonical JSON produces the stable SHA-256 for hand-derived bytes', () => {
  const bytes = canonicalBytes({ a: 1, b: 2 });

  assert.equal(sha256(bytes), 'e8d38819d39f705646bfb643368eca78f7db476c16471dbc33b941b27326410d');
});

test('canonical JSON rejects values outside the JSON contract', () => {
  const cyclic = {};
  cyclic.self = cyclic;
  const sparse = [];
  sparse[1] = 'present';
  const symbolKeyed = { visible: true };
  symbolKeyed[Symbol('hidden')] = 'hidden';
  const symbolKeyedArray = ['visible'];
  symbolKeyedArray[Symbol('hidden')] = 'hidden';

  for (const value of [NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, undefined, () => {}, Symbol('x'), symbolKeyed, symbolKeyedArray, sparse, new Date(), cyclic]) {
    assert.throws(() => canonicalJson(value), /canonical JSON/i);
  }
});

test('canonical JSON parser rejects noncanonical bytes and invalid UTF-8', () => {
  assert.throws(() => parseCanonicalJson(Buffer.from('{"b":2,"a":1}\n'), 'goal'), /canonical/i);
  assert.throws(() => parseCanonicalJson(Buffer.from([0x7b, 0xff, 0x7d, 0x0a]), 'goal'), /UTF-8|goal/i);
  assert.throws(() => parseCanonicalJson(Buffer.from('\uFEFF{}\n'), 'goal'), /canonical/i);
  assert.throws(() => parseCanonicalJson(Buffer.from('{}\r\n'), 'goal'), /canonical/i);
});

test('canonical JSON parser rejects duplicate keys and missing or repeated terminators', () => {
  assert.throws(() => parseCanonicalJson(Buffer.from('{"a":1,"a":1}\n'), 'goal'), /canonical/i);
  assert.throws(() => parseCanonicalJson(Buffer.from('{"a":1}'), 'goal'), /canonical/i);
  assert.throws(() => parseCanonicalJson(Buffer.from('{"a":1}\n\n'), 'goal'), /canonical/i);
});

test('goal lock fixture uses an isolated Git repository by default', (testContext) => {
  const fixture = createGoalLockFixture(testContext);

  assert.equal(fixture.now(), '2026-08-23T00:00:00.000Z');
  assert.equal(fixture.pid, 4242);
  assert.equal(fixture.isProcessAlive(1), false);
});

test('goal lock fixture initializes Git with the deterministic test identity', (testContext) => {
  const fixture = createGoalLockFixture(testContext);

  assert.equal(execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: fixture.root, encoding: 'utf8' }).trim(), 'true');
  assert.equal(execFileSync('git', ['config', 'user.email'], { cwd: fixture.root, encoding: 'utf8' }).trim(), 'tester@example.invalid');
});

test('goal lock fixture omits Git when explicitly disabled', (testContext) => {
  const fixture = createGoalLockFixture(testContext, { git: false });

  assert.equal(existsSync(join(fixture.root, '.git')), false);
});

function goalV1() {
  return {
    schema_version: 1,
    goal_id: 'GL-ALPHA',
    goal_version: 1,
    objective: 'Ship a safe lock',
    scope: { in: ['CLI'], out: ['Cloud sync'] },
    non_goals: ['Remote publishing'],
    constraints: [{ id: 'C-001', text: 'Use Node.js' }],
    acceptance_criteria: [{ id: 'AC-001', outcome: 'State is locked', verification: 'Run verification' }],
    authorization_boundary: ['Local workspace only'],
    assumptions: [{ statement: 'Git is installed', confidence: 'medium' }],
    predecessor: null,
    accepted_change_id: null,
  };
}

function lockV1() {
  return {
    schema_version: 1,
    goal_id: 'GL-ALPHA',
    goal_version: 1,
    goal_digest: '1111111111111111111111111111111111111111111111111111111111111111',
    approval_type: 'explicit-version-1',
    proposal_digest: '2222222222222222222222222222222222222222222222222222222222222222',
    approved_at: '2026-08-23T00:00:00Z',
    predecessor_digest: null,
    state_revision: 1,
    progress_head: null,
    change_head: null,
    evidence_heads: {},
    record_digest: 'REPLACE_ME',
  };
}

test('goal contract accepts every required version-one field without mutating input', () => {
  const input = goalV1();
  const validated = validateGoalContract(input);

  assert.deepEqual(validated, input);
  assert.notEqual(validated, input);
  assert.equal(Object.isFrozen(validated), true);
  assert.equal(Object.isFrozen(validated.scope), true);
  assert.equal(input.scope.in[0], 'CLI');
});

test('goal contract permits an empty acceptance-criteria array when no criterion is declared', () => {
  const input = goalV1();
  input.acceptance_criteria = [];

  assert.deepEqual(validateGoalContract(input).acceptance_criteria, []);
});

test('goal contract names each missing required field', () => {
  for (const field of ['schema_version', 'goal_id', 'goal_version', 'objective', 'scope', 'non_goals', 'constraints', 'acceptance_criteria', 'authorization_boundary', 'assumptions', 'predecessor', 'accepted_change_id']) {
    const input = goalV1();
    delete input[field];
    assert.throws(() => validateGoalContract(input), new RegExp(field));
  }
});

test('goal contract validates the semantic boundary of every root field', () => {
  const cases = [
    ['schema_version', (goal) => { goal.schema_version = 2; }],
    ['goal_id', (goal) => { goal.goal_id = 'GL-lowercase'; }],
    ['goal_version', (goal) => { goal.goal_version = 0; }],
    ['objective', (goal) => { goal.objective = ''; }],
    ['scope', (goal) => { goal.scope = null; }],
    ['non_goals', (goal) => { goal.non_goals = [' ']; }],
    ['constraints', (goal) => { goal.constraints = [{ id: '', text: 'Use Node.js' }]; }],
    ['acceptance_criteria', (goal) => { goal.acceptance_criteria = [{ id: 'AC-1', outcome: 'State is locked', verification: 'Run verification' }]; }],
    ['authorization_boundary', (goal) => { goal.authorization_boundary = ['']; }],
    ['assumptions', (goal) => { goal.assumptions = [{ statement: 'Git is installed', confidence: 'certain' }]; }],
    ['predecessor', (goal) => { goal.predecessor = { goal_version: 1, goal_digest: '1111111111111111111111111111111111111111111111111111111111111111' }; }],
    ['accepted_change_id', (goal) => { goal.accepted_change_id = 'CR-0001'; }],
  ];

  for (const [field, change] of cases) {
    const input = goalV1();
    change(input);
    assert.throws(() => validateGoalContract(input), new RegExp(field));
  }
});

test('goal contract rejects duplicate semantic IDs and untrimmed required text without echoing objective', () => {
  const duplicateCriterion = goalV1();
  duplicateCriterion.acceptance_criteria.push({ id: 'AC-001', outcome: 'Another result', verification: 'Another command' });
  assert.throws(() => validateGoalContract(duplicateCriterion), /acceptance_criteria.*AC-001/i);

  const untrimmed = goalV1();
  untrimmed.objective = ' private objective ';
  assert.throws(
    () => validateGoalContract(untrimmed),
    (error) => error instanceof GoalLockError && /objective/i.test(error.message) && !error.message.includes('private objective'),
  );
});

test('goal contract enforces scope, version, predecessor, and accepted-change relations', () => {
  const emptyScope = goalV1();
  emptyScope.scope.in = [];
  assert.throws(() => validateGoalContract(emptyScope), /scope\.in/i);

  const invalidV1Predecessor = goalV1();
  invalidV1Predecessor.predecessor = { goal_version: 1, goal_digest: '1111111111111111111111111111111111111111111111111111111111111111' };
  assert.throws(() => validateGoalContract(invalidV1Predecessor), /predecessor/i);

  const invalidV2 = goalV1();
  invalidV2.goal_version = 2;
  invalidV2.predecessor = { goal_version: 2, goal_digest: '1111111111111111111111111111111111111111111111111111111111111111' };
  invalidV2.accepted_change_id = 'CR-0001';
  assert.throws(() => validateGoalContract(invalidV2), /predecessor\.goal_version/i);
});

test('goal contract rejects sparse and property-bearing semantic arrays', () => {
  const sparseScope = goalV1();
  sparseScope.scope.in = [];
  sparseScope.scope.in[1] = 'CLI';
  assert.throws(() => validateGoalContract(sparseScope), /scope\.in/i);

  const decoratedScope = goalV1();
  decoratedScope.scope.in.extra = 'not JSON array data';
  assert.throws(() => validateGoalContract(decoratedScope), /scope\.in/i);
});

test('relative artifact paths normalize only safe repository-relative paths', () => {
  assert.equal(normalizeRelativePath('reports/final.json', 'artifact'), 'reports/final.json');
  for (const value of ['reports\\final.json', '/etc/passwd', 'C:/work/file', '\\\\server\\share', 'a//b', './report', 'a/../report', '.goal-lock/current.json', 'a\u0000b']) {
    assert.throws(() => normalizeRelativePath(value, 'artifact'), /artifact|path/i);
  }
});

test('lock contract validates initial heads and the digest of every field except record_digest', () => {
  const input = lockV1();
  input.record_digest = '9829d201bd2c1d769712f66032544acc1d34f78ce92b6cc63c44305053b88f0f';
  const validated = validateLockRecord(input);

  assert.deepEqual(validated, input);
  assert.equal(Object.isFrozen(validated.evidence_heads), true);
});

test('lock contract rejects malformed enums, heads, and record digests', () => {
  const badApproval = lockV1();
  badApproval.approval_type = 'approved';
  assert.throws(() => validateLockRecord(badApproval), /approval_type/i);

  const badHead = lockV1();
  badHead.progress_head = { event_id: 'EVT-1', digest: '1111111111111111111111111111111111111111111111111111111111111111' };
  assert.throws(() => validateLockRecord(badHead), /progress_head\.event_id/i);

  const badDigest = lockV1();
  badDigest.record_digest = '1111111111111111111111111111111111111111111111111111111111111111';
  assert.throws(() => validateLockRecord(badDigest), /record_digest/i);
});

test('lock contract validates the semantic boundary of every root field', () => {
  const cases = [
    ['schema_version', (lock) => { lock.schema_version = 2; }],
    ['goal_id', (lock) => { lock.goal_id = 'GL-lowercase'; }],
    ['goal_version', (lock) => { lock.goal_version = 0; }],
    ['goal_digest', (lock) => { lock.goal_digest = 'not-a-digest'; }],
    ['approval_type', (lock) => { lock.approval_type = 'implicit'; }],
    ['proposal_digest', (lock) => { lock.proposal_digest = 'not-a-digest'; }],
    ['approved_at', (lock) => { lock.approved_at = 'not-a-timestamp'; }],
    ['predecessor_digest', (lock) => { lock.predecessor_digest = '1111111111111111111111111111111111111111111111111111111111111111'; }],
    ['state_revision', (lock) => { lock.state_revision = 0; }],
    ['progress_head', (lock) => { lock.progress_head = {}; }],
    ['change_head', (lock) => { lock.change_head = {}; }],
    ['evidence_heads', (lock) => { lock.evidence_heads = { invalid: {} }; }],
    ['record_digest', (lock) => { lock.record_digest = 'not-a-digest'; }],
  ];

  for (const [field, change] of cases) {
    const input = lockV1();
    change(input);
    assert.throws(() => validateLockRecord(input), new RegExp(field));
  }
});

test('lock contract rejects impossible RFC 3339 calendar dates and times', () => {
  for (const approvedAt of ['2026-02-30T00:00:00Z', '2026-08-23T24:00:00Z', '2026-08-23T23:60:00Z', '2026-08-23T23:59:60Z']) {
    const input = lockV1();
    input.approved_at = approvedAt;
    assert.throws(() => validateLockRecord(input), /approved_at/i);
  }
});

test('approval phrase builders bind the stable identifiers and digest fingerprints', () => {
  const goal = goalV1();
  assert.equal(approvalPhraseForGoal(goal), 'APPROVE GOAL GL-ALPHA VERSION 1 92d74f6bf766');
  assert.equal(
    approvalPhraseForChange({ id: 'CR-0001', candidate_goal: { goal_version: 2 }, proposal_digest: 'abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd' }),
    'APPROVE CR-0001 GOAL VERSION 2 abcdefabcdef',
  );
});

test('goal lock errors expose immutable classification metadata', () => {
  const error = new GoalLockError('INVALID_INPUT', 'input', 2, 'Invalid field');

  assert.equal(error.code, 'INVALID_INPUT');
  assert.equal(error.kind, 'input');
  assert.equal(error.exitCode, 2);
  assert.throws(() => { error.code = 'OTHER'; }, TypeError);
});
