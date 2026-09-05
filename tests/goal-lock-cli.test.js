import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  lstat,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { formatGoalLockHelp, parseGoalLockArgs } from '../src/goal-lock/cli.js';

const SCRIPT_PATH = fileURLToPath(new URL('../scripts/goal-lock.js', import.meta.url));

test('parses exactly the five goal-lock command forms', () => {
  assert.deepEqual(parseGoalLockArgs(['init', '--input', '-']), {
    command: 'init', input: '-',
  });
  assert.deepEqual(parseGoalLockArgs(['propose', '--input', 'goal.json']), {
    command: 'propose', input: 'goal.json',
  });
  assert.deepEqual(parseGoalLockArgs(['approve', '--approval', 'EXACT PHRASE']), {
    command: 'approve', approval: 'EXACT PHRASE',
  });
  assert.deepEqual(parseGoalLockArgs(['verify']), { command: 'verify' });
  assert.deepEqual(parseGoalLockArgs(['status']), { command: 'status' });
});

test('rejects legacy commands and malformed argument shapes as usage failures', () => {
  const invalidCases = [
    [],
    ['lock', '--approval', 'APPROVE'],
    ['plan', '--input', 'plan.json', '--classification', 'aligned'],
    ['reject', '--cr', 'CR-0001', '--reason', 'no'],
    ['record', '--input', 'event.json'],
    ['gate'],
    ['recover-lock', '--owner-token', '11111111-1111-4111-8111-111111111111', '--lock-digest', '0'.repeat(64)],
    ['unknown'],
    ['init'],
    ['init', '--input'],
    ['init', '--input', 'a.json', '--input', 'b.json'],
    ['init', '--input=a.json'],
    ['init', '--approval', 'phrase'],
    ['init', '--input', 'goal.json', 'extra'],
    ['propose', '--input', 'goal.json', '--unknown', 'value'],
    ['propose', '--input', 'goal.json', '--input', 'other.json'],
    ['approve'],
    ['approve', '--approval'],
    ['approve', '--approval', 'EXACT PHRASE', '--approval', 'OTHER PHRASE'],
    ['approve', '--approval', 'EXACT PHRASE', 'extra'],
    ['verify', '--input', 'goal.json'],
    ['verify', 'extra'],
    ['status', '--approval', 'phrase'],
    ['status', 'extra'],
    ['--help', 'status'],
  ];

  for (const argv of invalidCases) {
    assert.throws(
      () => parseGoalLockArgs(argv),
      (error) => error?.code === 'CLI_USAGE' && error?.exitCode === 2,
      argv.join(' '),
    );
  }
});

test('help exposes only the five commands and stable public exit meanings', () => {
  const help = formatGoalLockHelp();
  assert.match(help, /goal-lock init --input goal\.json/);
  assert.match(help, /goal-lock propose --input goal\.json/);
  assert.match(help, /goal-lock approve --approval "APPROVAL_PHRASE_FROM_PROPOSAL"/);
  assert.match(help, /goal-lock verify/);
  assert.match(help, /goal-lock status/);
  assert.match(help, /2\s+usage\/input/);
  assert.match(help, /3\s+invalid transition/);
  assert.match(help, /4\s+integrity\/unsupported state/);
  assert.match(help, /5\s+approval rejected/);
  assert.match(help, /6\s+I\/O failure/);
  for (const removed of [
    'goal-lock lock',
    'goal-lock plan',
    'goal-lock reject',
    'goal-lock record',
    'goal-lock gate',
    'goal-lock recover-lock',
    '--inventory',
    'Git',
  ]) {
    assert.doesNotMatch(help, new RegExp(removed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  }
});

test('real process runs the five-command lifecycle with one-line JSON envelopes', async (t) => {
  const root = await createCliFixture(t);
  const versionOne = goalInput();
  const versionTwo = goalInput({
    objective: 'Keep a revised five-command CLI aligned to its approved goal',
    success_criteria: ['Version two is approved', 'Verify and status agree on active authority'],
    constraints: ['Expose only init, propose, approve, verify, and status', 'Return one JSON line per outcome'],
    non_goals: ['Do not retain protocol-v2 command aliases', 'Do not run Git workspace governance'],
  });

  const initialized = parseSuccess(
    await runProcess(root, ['init', '--input', '-'], Buffer.from(JSON.stringify(versionOne))),
    'init',
  );
  assert.equal(initialized.state, 'initial-proposed');
  assert.equal(initialized.active, null);
  assert.match(initialized.proposal.approval_phrase, /^APPROVE GOAL VERSION 1 [a-f0-9]{64}$/);

  const approvedV1 = parseSuccess(
    await runProcess(root, ['approve', '--approval', initialized.proposal.approval_phrase]),
    'approve',
  );
  assert.deepEqual(approvedV1, {
    state: 'active',
    active: { version: 1, digest: initialized.proposal.candidate_digest },
  });

  const proposed = parseSuccess(
    await runProcess(root, ['propose', '--input', '-'], Buffer.from(JSON.stringify(versionTwo))),
    'propose',
  );
  assert.equal(proposed.state, 'change-proposed');
  assert.equal(proposed.proposal.version, 2);
  assert.deepEqual(proposed.proposal.changes.map((change) => change.field), [
    'objective', 'success_criteria', 'constraints', 'non_goals',
  ]);

  const genericApproval = await runProcess(root, ['approve', '--approval', 'APPROVE']);
  const genericError = parseFailure(genericApproval, 5, 'approve');
  assert.equal(genericError.code, 'APPROVAL_REJECTED');
  assert.doesNotMatch(genericApproval.stderr, /APPROVE GOAL VERSION|APPROVE"/);
  assert.equal(parseSuccess(await runProcess(root, ['verify']), 'verify').active.version, 1);

  const approvedV2 = parseSuccess(
    await runProcess(root, ['approve', '--approval', proposed.proposal.approval_phrase]),
    'approve',
  );
  assert.equal(approvedV2.active.version, 2);

  const verified = parseSuccess(await runProcess(root, ['verify']), 'verify');
  const status = parseSuccess(await runProcess(root, ['status']), 'status');
  assert.deepEqual(verified, { state: 'active', active: approvedV2.active });
  assert.deepEqual(status, { state: 'active', active: approvedV2.active, pending: null });

  assert.deepEqual((await readdir(path.join(root, '.goal-lock'))).sort(), ['current.json', 'history']);
  assert.deepEqual((await readdir(path.join(root, '.goal-lock', 'history'))).sort(), ['v0001.json', 'v0002.json']);
  await assert.rejects(lstat(path.join(root, '.goal-lock', 'proposal.json')));
});

test('real process redacts JSON input text, paths, and supplied approval phrases from failures', async (t) => {
  const root = await createCliFixture(t);
  const secretObjective = 'DO-NOT-ECHO-GOAL-TEXT';
  const secretPath = 'secret-input.json';
  await writeFile(path.join(root, secretPath), `{"objective":"${secretObjective}"`, 'utf8');

  const invalidJson = await runProcess(root, ['init', '--input', secretPath]);
  const invalidJsonError = parseFailure(invalidJson, 2, 'init');
  assert.equal(invalidJsonError.code, 'INVALID_JSON');
  assert.doesNotMatch(invalidJson.stderr, new RegExp(secretObjective));
  assert.doesNotMatch(invalidJson.stderr, new RegExp(secretPath));

  const initialized = parseSuccess(
    await runProcess(root, ['init', '--input', '-'], Buffer.from(JSON.stringify(goalInput()))),
    'init',
  );
  const wrongPhrase = 'SUPPLIED APPROVAL PHRASE MUST STAY PRIVATE';
  const approvalFailure = await runProcess(root, ['approve', '--approval', wrongPhrase]);
  parseFailure(approvalFailure, 5, 'approve');
  assert.doesNotMatch(approvalFailure.stderr, new RegExp(wrongPhrase));
  assert.doesNotMatch(approvalFailure.stderr, new RegExp(initialized.proposal.approval_phrase));
});

function goalInput(overrides = {}) {
  return {
    objective: 'Keep the five-command CLI aligned to its approved goal',
    success_criteria: ['Version one is approved', 'The command surface stays minimal'],
    constraints: ['Expose only init, propose, approve, verify, and status'],
    non_goals: ['Do not retain protocol-v2 command aliases'],
    ...overrides,
  };
}

async function createCliFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'goal-lock-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function runProcess(cwd, args, input = Buffer.alloc(0)) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT_PATH, ...args], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({
      code,
      signal,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
    child.stdin.end(input);
  });
}

function parseSuccess(processResult, command) {
  assert.equal(processResult.code, 0, processResult.stderr);
  assert.equal(processResult.signal, null);
  assert.equal(processResult.stderr, '');
  assert.match(processResult.stdout, /^\{.*\}\n$/s);
  const envelope = JSON.parse(processResult.stdout);
  assert.deepEqual({ ok: envelope.ok, command: envelope.command }, { ok: true, command });
  assert.equal(processResult.stdout, `${JSON.stringify(envelope)}\n`);
  return envelope.result;
}

function parseFailure(processResult, exitCode, command) {
  assert.equal(processResult.code, exitCode, processResult.stderr);
  assert.equal(processResult.signal, null);
  assert.equal(processResult.stdout, '');
  assert.match(processResult.stderr, /^\{.*\}\n$/s);
  const envelope = JSON.parse(processResult.stderr);
  assert.deepEqual({ ok: envelope.ok, command: envelope.command }, { ok: false, command });
  assert.deepEqual(Object.keys(envelope.error).sort(), ['code', 'message']);
  assert.equal(processResult.stderr, `${JSON.stringify(envelope)}\n`);
  return envelope.error;
}
