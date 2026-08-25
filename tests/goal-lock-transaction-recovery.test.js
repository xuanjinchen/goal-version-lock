import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  mkdir,
  readFile,
  readdir,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

import { canonicalBytes, parseCanonicalJson } from '../src/goal-lock/canonical.js';
import { commitGoalFiles, recoverGoalLock } from '../src/goal-lock/transaction.js';
import { createGoalLockFixture } from './helpers/goal-lock-fixture.js';

const TRANSACTION_PROTOCOL = 'goal-version-lock-transaction-v1';
const TRANSACTION_MODULE = new URL('../src/goal-lock/transaction.js', import.meta.url).href;

function independentSha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function staleOwner() {
  return {
    protocol: 'goal-version-lock-write-v1',
    token: 'stale-owner',
    pid: 9999,
    command: 'record',
    created_at: '2026-08-22T00:00:00.000Z',
  };
}

async function installStaleLock(root) {
  const directory = join(root, '.goal-lock');
  const lockPath = join(directory, '.write-lock.json');
  const lockBytes = canonicalBytes(staleOwner());
  await mkdir(directory, { recursive: true });
  await writeFile(lockPath, lockBytes);
  return {
    directory,
    lockPath,
    lockBytes,
    proof: {
      owner_token: 'stale-owner',
      lock_digest: independentSha256(lockBytes),
    },
  };
}

function emptyJournal(transactionId, state = 'prepared') {
  return {
    protocol: TRANSACTION_PROTOCOL,
    transaction_id: transactionId,
    state,
    owner_token: 'stale-owner',
    lock_digest: independentSha256(canonicalBytes(staleOwner())),
    entries: [{
      target: '.goal-lock/ghost.json',
      original: { kind: 'absent' },
      intended: { kind: 'absent' },
      stage: null,
      backup: null,
    }],
  };
}

function artifactPath(target, transactionId, index, suffix) {
  return join(dirname(target), `.${basename(target)}.${transactionId}.${index}.${suffix}`);
}

function portableRelative(root, target) {
  return relative(root, target).split('\\').join('/');
}

async function writeJournal(lock, journal) {
  const target = join(lock.directory, '.transaction.json');
  const bytes = canonicalBytes(journal);
  await writeFile(target, bytes);
  const sibling = canonicalBytes({ ...journal, state: journal.state === 'prepared' ? 'committed' : 'prepared' });
  const owner = {
    ...staleOwner(),
    transaction: {
      transaction_id: journal.transaction_id,
      lock_digest: independentSha256(lock.lockBytes),
      prepared_digest: journal.state === 'prepared' ? independentSha256(bytes) : independentSha256(sibling),
      committed_digest: journal.state === 'committed' ? independentSha256(bytes) : independentSha256(sibling),
    },
  };
  lock.lockBytes = canonicalBytes(owner);
  lock.proof.lock_digest = independentSha256(lock.lockBytes);
  await writeFile(lock.lockPath, lock.lockBytes);
  return { target, bytes };
}

test('recovery rejects every non-token transaction ID in prepared and committed journals', async (testContext) => {
  const unsafeIds = [
    ['forward separator', 'slash/token'],
    ['back separator', 'back\\token'],
    ['parent segment', '../token'],
    ['drive syntax', 'C:/token'],
    ['UNC syntax', '\\\\server\\share'],
  ];
  for (const state of ['prepared', 'committed']) {
    for (const [label, transactionId] of unsafeIds) {
      await testContext.test(`${state}: ${label}`, async (subtest) => {
        const fixture = createGoalLockFixture(subtest);
        const lock = await installStaleLock(fixture.root);
        const journal = await writeJournal(lock, emptyJournal(transactionId, state));

        await assert.rejects(
          recoverGoalLock(fixture.root, lock.proof, fixture),
          /cooperative|transaction|journal|ownership|path/i,
        );
        assert.deepEqual(await readFile(lock.lockPath), lock.lockBytes);
        assert.deepEqual(await readFile(journal.target), journal.bytes);
      });
    }
  }
});

test('prepared and committed recovery reject an escaping artifact before touching external bytes', async (testContext) => {
  for (const state of ['prepared', 'committed']) {
    await testContext.test(state, async (subtest) => {
      const fixture = createGoalLockFixture(subtest);
      const lock = await installStaleLock(fixture.root);
      const target = join(lock.directory, 'state.json');
      const intended = Buffer.from('installed target');
      const original = Buffer.from('external original');
      const transactionId = 'safe-token';
      const backup = join(fixture.root, 'outside.backup');
      assert.match(relative(lock.directory, backup), /^\.\./u);
      await writeFile(target, intended);
      await mkdir(dirname(backup), { recursive: true });
      await writeFile(backup, original);
      const journal = {
        protocol: TRANSACTION_PROTOCOL,
        transaction_id: transactionId,
        state,
        owner_token: 'stale-owner',
        lock_digest: independentSha256(lock.lockBytes),
        entries: [{
          target: '.goal-lock/state.json',
          original: { kind: 'sha256', digest: independentSha256(original) },
          intended: { kind: 'sha256', digest: independentSha256(intended) },
          stage: portableRelative(fixture.root, artifactPath(target, transactionId, 0, 'stage')),
          backup: portableRelative(fixture.root, backup),
        }],
      };
      await writeJournal(lock, journal);

      await assert.rejects(
        recoverGoalLock(fixture.root, lock.proof, fixture),
        /transaction|journal|ownership|path/i,
      );
      assert.deepEqual(await readFile(target), intended);
      assert.deepEqual(await readFile(backup), original);
    });
  }
});

test('recovery rejects duplicate journal targets before removing the lock', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const lock = await installStaleLock(fixture.root);
  const entry = emptyJournal('safe-token').entries[0];
  const journal = await writeJournal(lock, {
    ...emptyJournal('safe-token'),
    entries: [entry, { ...entry }],
  });

  await assert.rejects(recoverGoalLock(fixture.root, lock.proof, fixture), /duplicate|transaction|journal/i);
  assert.deepEqual(await readFile(lock.lockPath), lock.lockBytes);
  assert.deepEqual(await readFile(journal.target), journal.bytes);
});

test('recovery rejects a journal target whose ancestor is a junction', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const lock = await installStaleLock(fixture.root);
  const external = join(fixture.root, 'external');
  await mkdir(external);
  await symlink(external, join(lock.directory, 'history'), 'junction');
  const unsafe = emptyJournal('safe-token');
  unsafe.entries[0].target = '.goal-lock/history/ghost.json';
  const journal = await writeJournal(lock, unsafe);

  await assert.rejects(recoverGoalLock(fixture.root, lock.proof, fixture), /ancestor|canonical|transaction|journal/i);
  assert.deepEqual(await readdir(external), []);
  assert.deepEqual(await readFile(lock.lockPath), lock.lockBytes);
  assert.deepEqual(await readFile(journal.target), journal.bytes);
});

test('prepared recovery accepts an already-restored target when its backup is absent', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const lock = await installStaleLock(fixture.root);
  const target = join(lock.directory, 'state.json');
  const original = Buffer.from('original state');
  const intended = Buffer.from('interrupted replacement');
  const transactionId = 'replay-safe-token';
  await writeFile(target, original);
  await writeJournal(lock, {
    protocol: TRANSACTION_PROTOCOL,
    transaction_id: transactionId,
    state: 'prepared',
    owner_token: 'stale-owner',
    lock_digest: independentSha256(lock.lockBytes),
    entries: [{
      target: '.goal-lock/state.json',
      original: { kind: 'sha256', digest: independentSha256(original) },
      intended: { kind: 'sha256', digest: independentSha256(intended) },
      stage: portableRelative(fixture.root, artifactPath(target, transactionId, 0, 'stage')),
      backup: portableRelative(fixture.root, artifactPath(target, transactionId, 0, 'backup')),
    }],
  });

  await recoverGoalLock(fixture.root, lock.proof, fixture);

  assert.deepEqual(await readFile(target), original);
  assert.equal(existsSync(lock.lockPath), false);
  assert.equal(existsSync(join(lock.directory, '.transaction.json')), false);
});

test('a writer capability binds both exact journal state digests before target mutation', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const directory = join(fixture.root, '.goal-lock');
  const target = join(directory, 'state.json');
  const original = Buffer.from('original');
  const stop = new Error('stop after binding observation');
  let observed;
  await mkdir(directory);
  await writeFile(target, original);
  fixture.transactionFaults.detach = async () => {
    const lock = parseCanonicalJson(await readFile(join(directory, '.write-lock.json')), 'bound lock');
    const journalBytes = await readFile(join(directory, '.transaction.json'));
    observed = { transaction: lock.transaction, journalDigest: independentSha256(journalBytes) };
    throw stop;
  };

  await assert.rejects(commitGoalFiles(fixture.root, [{
    target: '.goal-lock/state.json',
    expected: { kind: 'sha256', digest: independentSha256(original) },
    content: Buffer.from('replacement'),
  }], fixture), (error) => error === stop);

  assert.match(observed.transaction.transaction_id, /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/u);
  assert.equal(observed.transaction.prepared_digest, observed.journalDigest);
  assert.match(observed.transaction.committed_digest, /^[a-f0-9]{64}$/u);
  assert.notEqual(observed.transaction.committed_digest, observed.transaction.prepared_digest);
});

async function waitForFile(target, child) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (existsSync(target)) return;
    if (child.exitCode !== null) throw new Error(`Lock-owner child exited early with ${child.exitCode}.`);
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${target}.`);
}

test('a direct commit in process B cannot piggyback on process A lock ownership', async (testContext) => {
  const fixture = createGoalLockFixture(testContext);
  const ready = join(fixture.root, 'owner-ready');
  const release = join(fixture.root, 'owner-release');
  const ownerScript = join(fixture.root, 'owner.mjs');
  const contenderScript = join(fixture.root, 'contender.mjs');
  await writeFile(ownerScript, `
import { access, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { withGoalLock } from ${JSON.stringify(TRANSACTION_MODULE)};
const [root, ready, release] = process.argv.slice(2);
await withGoalLock(root, 'owner', async () => {
  await writeFile(ready, 'ready');
  for (;;) {
    try { await access(release); break; } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await delay(10);
    }
  }
});
`);
  await writeFile(contenderScript, `
import { commitGoalFiles } from ${JSON.stringify(TRANSACTION_MODULE)};
const root = process.argv[2];
await commitGoalFiles(root, [{
  target: '.goal-lock/contender.json',
  expected: { kind: 'absent' },
  content: Buffer.from('must-not-install'),
}]);
`);

  const owner = spawn(process.execPath, [ownerScript, fixture.root, ready, release], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const ownerExit = new Promise((resolve) => owner.once('exit', (code, signal) => resolve({ code, signal })));
  await waitForFile(ready, owner);
  const contender = spawnSync(process.execPath, [contenderScript, fixture.root], {
    encoding: 'utf8',
    windowsHide: true,
  });
  const directory = join(fixture.root, '.goal-lock');
  const namesWhileOwned = await readdir(directory);
  await writeFile(release, 'release');
  const ownerResult = await ownerExit;

  assert.notEqual(contender.status, 0, contender.stdout);
  assert.equal(existsSync(join(directory, 'contender.json')), false);
  assert.deepEqual(
    namesWhileOwned.filter((name) => name === '.transaction.json' || name.endsWith('.stage') || name.endsWith('.backup')),
    [],
  );
  assert.deepEqual(ownerResult, { code: 0, signal: null });
});

async function writeCrashHarness(root) {
  const target = join(root, 'crash-harness.mjs');
  await writeFile(target, `
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { commitGoalFiles, recoverGoalLock, withGoalLock } from ${JSON.stringify(TRANSACTION_MODULE)};
const [root, mode, scenario, phase] = process.argv.slice(2);
const transactionFaults = phase === 'none' ? {} : {
  [phase]() { process.exit(91); },
};
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
if (mode === 'writer') {
  const target = root + '/.goal-lock/state.json';
  const entries = scenario === 'create'
    ? [{ target: '.goal-lock/state.json', expected: { kind: 'absent' }, content: Buffer.from('new state') }]
    : [{ target: '.goal-lock/state.json', expected: { kind: 'sha256', digest: digest(await readFile(target)) }, content: Buffer.from('new state') }];
await withGoalLock(root, 'crash-writer', (ownership) => commitGoalFiles(root, entries, { transactionFaults, ...ownership }), { transactionFaults });
} else {
  const lockBytes = await readFile(root + '/.goal-lock/.write-lock.json');
  const owner = JSON.parse(lockBytes);
  await recoverGoalLock(root, { owner_token: owner.token, lock_digest: digest(lockBytes) }, {
    isProcessAlive: () => false,
    transactionFaults,
  });
}
`);
  return target;
}

function runCrashHarness(script, root, mode, scenario, phase) {
  return spawnSync(process.execPath, [script, root, mode, scenario, phase], {
    encoding: 'utf8',
    windowsHide: true,
  });
}

async function assertNoTransactionArtifacts(directory) {
  const names = await readdir(directory);
  assert.deepEqual(names.filter((name) => (
    name === '.write-lock.json'
    || name === '.transaction.json'
    || name.includes('.stage')
    || name.includes('.backup')
    || name.includes('.binding')
  )), []);
}

test('writer crashes during staging, backup construction, state replacement, and committed cleanup converge', async (testContext) => {
  const cases = [
    ['staging', 'afterStageCreate', 'old state'],
    ['backup construction', 'afterBackupCreate', 'old state'],
    ['journal state replacement', 'afterJournalStateReplace', 'new state'],
    ['committed cleanup', 'afterCommittedBackupRemove', 'new state'],
  ];
  for (const [label, phase, expected] of cases) {
    await testContext.test(label, async (subtest) => {
      const fixture = createGoalLockFixture(subtest);
      const directory = join(fixture.root, '.goal-lock');
      await mkdir(directory);
      await writeFile(join(directory, 'state.json'), 'old state');
      const harness = await writeCrashHarness(fixture.root);

      const writer = runCrashHarness(harness, fixture.root, 'writer', 'replace', phase);
      assert.equal(writer.status, 91, writer.stderr);
      const recovery = runCrashHarness(harness, fixture.root, 'recovery', 'replace', 'none');
      assert.equal(recovery.status, 0, `${recovery.stderr}\n${recovery.stdout}`);

      assert.equal(await readFile(join(directory, 'state.json'), 'utf8'), expected);
      await assertNoTransactionArtifacts(directory);
    });
  }
});

test('a crash after every prepared rollback action is replay-safe on the next recovery', async (testContext) => {
  const cases = [
    ['restore original', 'replace', 'readBack', 'afterRollbackRestore', 'old state'],
    ['remove newly created target', 'create', 'readBack', 'afterRollbackTargetRemove', null],
    ['remove redundant backup', 'replace', 'install', 'afterRollbackBackupRemove', 'old state'],
    ['remove partial stage', 'replace', 'stageWrite', 'afterRollbackStageRemove', 'old state'],
  ];
  for (const [label, scenario, writerPhase, recoveryPhase, expected] of cases) {
    await testContext.test(label, async (subtest) => {
      const fixture = createGoalLockFixture(subtest);
      const directory = join(fixture.root, '.goal-lock');
      await mkdir(directory);
      if (scenario === 'replace') await writeFile(join(directory, 'state.json'), 'old state');
      const harness = await writeCrashHarness(fixture.root);

      const writer = runCrashHarness(harness, fixture.root, 'writer', scenario, writerPhase);
      assert.equal(writer.status, 91, writer.stderr);
      const interrupted = runCrashHarness(harness, fixture.root, 'recovery', scenario, recoveryPhase);
      assert.equal(interrupted.status, 91, interrupted.stderr);
      const retry = runCrashHarness(harness, fixture.root, 'recovery', scenario, 'none');
      assert.equal(retry.status, 0, `${retry.stderr}\n${retry.stdout}`);

      const target = join(directory, 'state.json');
      if (expected === null) assert.equal(existsSync(target), false);
      else assert.equal(await readFile(target, 'utf8'), expected);
      await assertNoTransactionArtifacts(directory);
    });
  }
});
