import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { formatGoalLockHelp, parseGoalLockArgs, runGoalLockCli } from '../src/goal-lock/cli.js';
import { validateEvidence, validatePlan } from '../src/goal-lock/contracts.js';
import { schemaV2Evidence, schemaV2Plan } from './helpers/goal-lock-fixture.js';

const SCRIPT_PATH = fileURLToPath(new URL('../scripts/goal-lock.js', import.meta.url));

const COMMAND_CASES = [
  [['init', '--input', 'draft.json'], { command: 'init', input: 'draft.json' }],
  [['init', '--input', '-'], { command: 'init', input: '-' }],
  [['lock', '--approval', 'APPROVE GOAL GL-EXAMPLE VERSION 1 0123456789ab'], {
    command: 'lock',
    approval: 'APPROVE GOAL GL-EXAMPLE VERSION 1 0123456789ab',
  }],
  [['lock', '--approval', 'APPROVE GOAL GL-EXAMPLE VERSION 1 0123456789ab', '--inventory', 'inventory.json'], {
    command: 'lock',
    approval: 'APPROVE GOAL GL-EXAMPLE VERSION 1 0123456789ab',
    inventory: 'inventory.json',
  }],
  [['verify'], { command: 'verify' }],
  [['plan', '--input', 'plan.json', '--classification', 'aligned'], {
    command: 'plan', input: 'plan.json', classification: 'aligned',
  }],
  [['plan', '--input', 'revised-plan.json', '--classification', 'implementation-choice'], {
    command: 'plan', input: 'revised-plan.json', classification: 'implementation-choice',
  }],
  [['plan', '--input', '-', '--classification', 'aligned'], {
    command: 'plan', input: '-', classification: 'aligned',
  }],
  [['propose', '--input', 'change-proposal.json'], { command: 'propose', input: 'change-proposal.json' }],
  [['propose', '--input', '-'], { command: 'propose', input: '-' }],
  [[
    'approve', '--cr', 'CR-0001', '--approval',
    'APPROVE CR-0001 GOAL VERSION 2 0123456789ab',
  ], {
    command: 'approve',
    cr: 'CR-0001',
    approval: 'APPROVE CR-0001 GOAL VERSION 2 0123456789ab',
  }],
  [['reject', '--cr', 'CR-0001', '--reason', 'Keep the approved scope'], {
    command: 'reject', cr: 'CR-0001', reason: 'Keep the approved scope',
  }],
  [['record', '--input', 'progress-input.json'], { command: 'record', input: 'progress-input.json' }],
  [['record', '--input', '-'], { command: 'record', input: '-' }],
  [['gate'], { command: 'gate' }],
  [['gate', '--inventory', 'inventory.json'], { command: 'gate', inventory: 'inventory.json' }],
  [[
    'recover-lock',
    '--owner-token', '11111111-1111-4111-8111-111111111111',
    '--lock-digest', '0'.repeat(64),
  ], {
    command: 'recover-lock',
    ownerToken: '11111111-1111-4111-8111-111111111111',
    lockDigest: '0'.repeat(64),
  }],
  [['--help'], { command: 'help' }],
];

test('parses every supported goal-lock command and option form', () => {
  for (const [argv, expected] of COMMAND_CASES) {
    assert.deepEqual(parseGoalLockArgs(argv), expected, argv.join(' '));
  }
});

const INVALID_ARGUMENT_CASES = [
  [],
  ['help'],
  ['verify', '--help'],
  ['--help', 'verify'],
  ['unknown'],
  ['verify', 'draft.json'],
  ['init', 'draft.json'],
  ['init'],
  ['init', '--input'],
  ['init', '--input', 'a.json', '--input', 'b.json'],
  ['init', '--input=a.json'],
  ['init', '--classification', 'aligned'],
  ['lock'],
  ['lock', '--approval', ''],
  ['lock', '--approval', 'APPROVE\nGOAL'],
  ['lock', '--input', 'draft.json'],
  ['plan', '--input', 'plan.json'],
  ['plan', '--classification', 'aligned'],
  ['plan', '--input', 'plan.json', '--classification', 'implementation'],
  ['plan', '--input', 'plan.json', '--classification', 'Aligned'],
  ['plan', '--input', 'plan.json', '--classification', 'aligned', '--approval', 'yes'],
  ['propose', '--input', 'change.json', '--classification', 'aligned'],
  ['approve', '--cr', 'CR-1', '--approval', 'exact'],
  ['approve', '--cr', '../CR-0001', '--approval', 'exact'],
  ['approve', '--cr', 'CR-0001\n', '--approval', 'exact'],
  ['approve', '--cr', 'CR-0001'],
  ['approve', '--approval', 'exact'],
  ['reject', '--cr', 'CR-0001', '--reason', ''],
  ['reject', '--cr', 'CR-0001', '--reason', 'line one\nline two'],
  ['reject', '--cr', 'CR-0001', '--reason', 'reason', '--reason', 'again'],
  ['record', '--input', 'record.json', '--inventory', 'inventory.json'],
  ['gate', '--input', 'inventory.json'],
  ['gate', '--inventory'],
  ['gate', '--inventory', '-'],
  ['gate', '--inventory', 'one.json', '--inventory', 'two.json'],
  ['recover-lock', '--owner-token', 'not-a-token', '--lock-digest', '0'.repeat(64)],
  ['recover-lock', '--owner-token', '11111111-1111-4111-8111-111111111111', '--lock-digest', 'A'.repeat(64)],
  ['recover-lock', '--owner-token', '11111111-1111-4111-8111-111111111111'],
];

test('parses invalid, missing, duplicate, combined, positional, and cross-command arguments as usage failures', () => {
  for (const argv of INVALID_ARGUMENT_CASES) {
    assert.throws(
      () => parseGoalLockArgs(argv),
      (error) => error?.exitCode === 2 && error?.code === 'CLI_USAGE' && !JSON.stringify(error).includes('exact'),
      argv.join(' '),
    );
  }
});

test('help lists the complete command surface, approvals, exit codes, and cwd authority', () => {
  const help = formatGoalLockHelp();
  for (const [argv] of COMMAND_CASES.filter(([argv]) => argv[0] !== '--help')) {
    const display = argv.map((value) => value === '-' || !value.includes(' ') ? value : `"${value}"`).join(' ');
    assert.match(help, new RegExp(display.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(help, /0\s+success\/help/);
  assert.match(help, /2\s+usage\/input/);
  assert.match(help, /3\s+invalid transition/);
  assert.match(help, /4\s+integrity\/tamper\/unsafe path/);
  assert.match(help, /5\s+approval\/stale approval/);
  assert.match(help, /6\s+I\/O\/Git\/rollback\/recovery/);
  assert.match(help, /current working directory \(cwd\) is the governed project/i);
});

test('help formatting can load without repository, transaction, or workspace runtime modules', async (testContext) => {
  const isolated = await mkdtemp(path.join(tmpdir(), 'goal-lock-help-'));
  testContext.after(() => rm(isolated, { recursive: true, force: true }));
  const isolatedCli = path.join(isolated, 'cli.mjs');
  await copyFile(new URL('../src/goal-lock/cli.js', import.meta.url), isolatedCli);

  const module = await import(`${pathToFileURL(isolatedCli).href}?isolated=${Date.now()}`);
  assert.match(module.formatGoalLockHelp(), /goal-lock init/);
});

function goalDraft() {
  return {
    schema_version: 2,
    goal_id: 'GL-CLI',
    goal_version: 1,
    objective: 'Exercise the real goal-lock process lifecycle',
    scope: { in: ['CLI'], out: ['Remote services'] },
    non_goals: ['Publishing'],
    constraints: [{ id: 'C-001', text: 'Use only local files' }],
    acceptance_criteria: [{ id: 'AC-001', outcome: 'The CLI lifecycle completes', verification: 'Spawn the real process' }],
    authorization_boundary: ['The fixture workspace only'],
    assumptions: [{ statement: 'Git is available', confidence: 'high' }],
    predecessor: null,
    accepted_change_id: null,
  };
}

function planInput() {
  return {
    next_task_id: 'TASK-0001',
    tasks: [{
      id: 'TASK-0001',
      outcome: 'Complete the process lifecycle',
      acceptance_criteria: ['AC-001'],
      dependencies: [],
      permitted_paths: ['delivery.txt'],
      validations: [{
        id: 'VAL-0001',
        kind: 'focused',
        method: { type: 'deterministic-test', target: 'goal-lock-cli-process' },
        affected_paths: ['delivery.txt'],
        criterion_ids: ['AC-001'],
        risk_ids: [],
      }, {
        id: 'VAL-0002',
        kind: 'mandatory-gate',
        method: { type: 'delivery-gate', target: 'goal-lock-cli-final-gate' },
        affected_paths: ['@governed-workspace'],
        criterion_ids: ['AC-001'],
        risk_ids: [],
      }],
      status: 'pending',
    }],
    risks: [],
    deferred: [],
  };
}

function progressInput(eventType, summary, evidenceRefs = []) {
  return {
    kind: 'progress',
    event_type: eventType,
    task_id: 'TASK-0001',
    summary,
    evidence_refs: evidenceRefs,
  };
}

function evidenceInput({ validationId = 'VAL-0001', supersedes = null } = {}) {
  return {
    kind: 'evidence',
    acceptance_criterion_id: 'AC-001',
    validation_ref: {
      goal_id: 'GL-CLI',
      goal_version: 1,
      goal_digest: '9157a4eea1293409f55852b47dfc7b734552e7068828542b78cd55a0a08decfb',
      plan_revision: 1,
      validation_id: validationId,
    },
    task_id: 'TASK-0001',
    observed_result: 'The real process behaved as required',
    artifact_refs: ['delivery.txt'],
    inventory: null,
    state: 'pass',
    failure_paths: [],
    supersedes,
  };
}

function changeProposalInput() {
  return {
    candidate: {
      objective: 'Exercise the evolved goal-lock process lifecycle',
      scope: goalDraft().scope,
      non_goals: goalDraft().non_goals,
      constraints: goalDraft().constraints,
      acceptance_criteria: goalDraft().acceptance_criteria,
      authorization_boundary: goalDraft().authorization_boundary,
      assumptions: goalDraft().assumptions,
    },
    changes: [{
      field: 'objective',
      before: goalDraft().objective,
      after: 'Exercise the evolved goal-lock process lifecycle',
    }],
    rationale: 'Validate the change command surface',
    affected_tasks: [],
    criterion_impact: { affected: [], unaffected: ['AC-001'] },
    risks: ['The CLI mapping could be incomplete'],
    validation: ['Spawn the real process'],
    rollback: ['Reject the proposal'],
  };
}

test('schema v2 CLI contract fixtures use validation references without v1 method authority', () => {
  const plan = schemaV2Plan();
  const evidence = schemaV2Evidence();

  assert.equal(validatePlan(plan, plan.goal).schema_version, 2);
  assert.equal(validateEvidence(evidence, plan.goal).validation_ref.validation_id, 'VAL-0001');
  assert.equal(Object.hasOwn(evidence, 'method'), false);
});

async function createCliFixture(testContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'goal-lock-cli-'));
  testContext.after(() => rm(root, { recursive: true, force: true }));
  await new Promise((resolve, reject) => {
    const child = spawn('git', ['init', '--quiet'], { cwd: root, windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`git init exited ${code}`)));
  });
  return root;
}

async function createNonGitCliFixture(testContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'goal-lock-cli-non-git-'));
  testContext.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function runProcess(cwd, args, input) {
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
  const envelope = JSON.parse(processResult.stdout);
  assert.deepEqual({ ok: envelope.ok, command: envelope.command }, { ok: true, command });
  assert.equal(processResult.stdout, `${JSON.stringify(envelope)}\n`);
  return envelope.result;
}

function parseFailure(processResult, exitCode, command) {
  assert.equal(processResult.code, exitCode, processResult.stderr);
  assert.equal(processResult.signal, null);
  assert.equal(processResult.stdout, '');
  const envelope = JSON.parse(processResult.stderr);
  assert.deepEqual({ ok: envelope.ok, command: envelope.command }, { ok: false, command });
  assert.deepEqual(Object.keys(envelope.error).sort(), ['code', 'message']);
  assert.equal(processResult.stderr, `${JSON.stringify(envelope)}\n`);
  return envelope.error;
}

async function nonGoalLockSnapshot(root, relative = '') {
  const values = {};
  for (const name of await readdir(path.join(root, relative))) {
    if (relative === '' && ['.git', '.goal-lock'].includes(name)) continue;
    const child = relative === '' ? name : `${relative}/${name}`;
    const target = path.join(root, child);
    const metadata = await lstat(target);
    if (metadata.isDirectory()) Object.assign(values, await nonGoalLockSnapshot(root, child));
    else values[child] = createHash('sha256').update(await readFile(target)).digest('hex');
  }
  return values;
}

async function writeJson(root, name, value) {
  await writeFile(path.join(root, name), `${JSON.stringify(value)}\n`, 'utf8');
}

test('real process runs the complete lifecycle in cwd with single-envelope stdio and confined writes', async (testContext) => {
  const root = await createCliFixture(testContext);
  await Promise.all([
    writeFile(path.join(root, 'delivery.txt'), 'accepted delivery\n'),
    writeJson(root, 'plan.json', planInput()),
    writeJson(root, 'task-start.json', progressInput('task-start', 'Started the CLI lifecycle')),
    writeJson(root, 'evidence.json', evidenceInput()),
    writeJson(root, 'mandatory-evidence.json', evidenceInput({ validationId: 'VAL-0002', supersedes: 'EVID-0001' })),
    writeJson(root, 'task-complete.json', progressInput('task-complete', 'Completed the CLI lifecycle', ['EVID-0001', 'EVID-0002'])),
    writeJson(root, 'final-audit.json', {
      kind: 'final-audit',
      semantic_summary: 'Reviewed the fixture against the locked goal.',
      inventory: null,
    }),
    writeJson(root, 'inventory.json', ['delivery.txt']),
  ]);
  const before = await nonGoalLockSnapshot(root);

  const initialized = parseSuccess(
    await runProcess(root, ['init', '--input', '-'], Buffer.from(JSON.stringify(goalDraft()))),
    'init',
  );
  assert.equal(initialized.state, 'DRAFT');
  assert.match(initialized.approval_required, /^APPROVE GOAL GL-CLI VERSION 1 [a-f0-9]{12}$/);

  const rejected = parseFailure(
    await runProcess(root, ['lock', '--approval', 'APPROVE']),
    5,
    'lock',
  );
  assert.equal(rejected.code, 'APPROVAL_REJECTED');
  assert.doesNotMatch(JSON.stringify(rejected), /APPROVE GOAL|APPROVE$/);

  parseSuccess(await runProcess(root, ['lock', '--approval', initialized.approval_required]), 'lock');
  parseSuccess(await runProcess(root, ['plan', '--input', 'plan.json', '--classification', 'aligned']), 'plan');
  parseSuccess(await runProcess(root, ['record', '--input', 'task-start.json']), 'record');
  const evidence = parseSuccess(await runProcess(root, ['record', '--input', 'evidence.json']), 'record');
  assert.equal(evidence.evidence_id, 'EVID-0001');
  const mandatoryEvidence = parseSuccess(await runProcess(root, ['record', '--input', 'mandatory-evidence.json']), 'record');
  assert.equal(mandatoryEvidence.evidence_id, 'EVID-0002');
  parseSuccess(await runProcess(root, ['record', '--input', 'task-complete.json']), 'record');
  assert.equal(parseSuccess(await runProcess(root, ['verify']), 'verify').state, 'LOCKED');
  parseSuccess(await runProcess(root, ['record', '--input', 'final-audit.json']), 'record');
  const gate = parseSuccess(await runProcess(root, ['gate']), 'gate');
  assert.equal(gate.state, 'COMPLETE');
  assert.equal(gate.checklist.every((item) => item.passed), true);

  assert.deepEqual(await nonGoalLockSnapshot(root), before);
  assert.deepEqual((await readdir(path.join(root, '.goal-lock'))).sort(), [
    'current.json', 'evidence', 'history', 'lock.json', 'plan.json', 'progress.jsonl', 'scope.json',
  ]);
});

test('real process accepts lock inventory only when Git discovery is unavailable', async (testContext) => {
  const gitRoot = await createCliFixture(testContext);
  await Promise.all([
    writeFile(path.join(gitRoot, 'delivery.txt'), 'Git discovery owns this baseline\n'),
    writeJson(gitRoot, 'inventory.json', ['delivery.txt']),
  ]);
  const gitDraft = parseSuccess(
    await runProcess(gitRoot, ['init', '--input', '-'], Buffer.from(JSON.stringify(goalDraft()))),
    'init',
  );
  assert.equal(
    parseFailure(
      await runProcess(gitRoot, ['lock', '--approval', gitDraft.approval_required, '--inventory', 'inventory.json']),
      4,
      'lock',
    ).code,
    'WORKSPACE_INVENTORY_INVALID',
  );

  const nonGitRoot = await createNonGitCliFixture(testContext);
  await Promise.all([
    writeFile(path.join(nonGitRoot, 'delivery.txt'), 'Explicit inventory owns this baseline\n'),
    writeJson(nonGitRoot, 'inventory.json', ['delivery.txt']),
  ]);
  const nonGitDraft = parseSuccess(
    await runProcess(nonGitRoot, ['init', '--input', '-'], Buffer.from(JSON.stringify(goalDraft()))),
    'init',
  );
  parseSuccess(
    await runProcess(nonGitRoot, ['lock', '--approval', nonGitDraft.approval_required, '--inventory', 'inventory.json']),
    'lock',
  );
  const scope = JSON.parse(await readFile(path.join(nonGitRoot, '.goal-lock', 'scope.json'), 'utf8'));
  assert.equal(scope.mode, 'inventory');
});

test('real process records evidence through an exact validation reference without executing its target', async (testContext) => {
  const root = await createCliFixture(testContext);
  const plan = planInput();
  plan.tasks[0].validations[0].method.target = 'this-is-inert-validation-data';
  const evidence = evidenceInput();
  assert.equal(Object.hasOwn(evidence, 'method'), false);
  assert.equal(evidence.validation_ref.validation_id, 'VAL-0001');
  await Promise.all([
    writeFile(path.join(root, 'delivery.txt'), 'inert target fixture\n'),
    writeJson(root, 'plan.json', plan),
    writeJson(root, 'task-start.json', progressInput('task-start', 'Started inert validation fixture')),
    writeJson(root, 'evidence.json', evidence),
  ]);
  const initialized = parseSuccess(
    await runProcess(root, ['init', '--input', '-'], Buffer.from(JSON.stringify(goalDraft()))),
    'init',
  );
  parseSuccess(await runProcess(root, ['lock', '--approval', initialized.approval_required]), 'lock');
  parseSuccess(await runProcess(root, ['plan', '--input', 'plan.json', '--classification', 'aligned']), 'plan');
  parseSuccess(await runProcess(root, ['record', '--input', 'task-start.json']), 'record');
  const recorded = parseSuccess(await runProcess(root, ['record', '--input', 'evidence.json']), 'record');
  assert.equal(recorded.evidence_id, 'EVID-0001');
});

test('real processes preserve v2 approval history and invalidate affected evidence', async (testContext) => {
  const root = await createCliFixture(testContext);
  await writeFile(path.join(root, 'delivery.txt'), 'version two delivery\n');
  const draft = {
    ...goalDraft(),
    objective: 'Prove a disk-resumed version change lifecycle',
    acceptance_criteria: [
      { id: 'AC-001', outcome: 'Changed work is re-verified', verification: 'Record fresh evidence' },
      { id: 'AC-002', outcome: 'Unaffected work remains valid', verification: 'Complete its task' },
    ],
  };
  const versionOnePlan = {
    next_task_id: 'TASK-0001',
    tasks: [
      {
        id: 'TASK-0001', outcome: 'Deliver changed work', acceptance_criteria: ['AC-001'],
        dependencies: [], permitted_paths: ['delivery.txt'], validations: [{
          id: 'VAL-0001', kind: 'focused', method: { type: 'deterministic-test', target: 'changed-work-focused' },
          affected_paths: ['delivery.txt'], criterion_ids: ['AC-001'], risk_ids: [],
        }], status: 'pending',
      },
      {
        id: 'TASK-0002', outcome: 'Deliver unaffected work', acceptance_criteria: ['AC-002'],
        dependencies: [], permitted_paths: ['delivery.txt'], validations: [{
          id: 'VAL-0002', kind: 'focused', method: { type: 'deterministic-test', target: 'unaffected-work-focused' },
          affected_paths: ['delivery.txt'], criterion_ids: ['AC-002'], risk_ids: [],
        }], status: 'pending',
      },
    ],
    risks: [],
    deferred: [],
  };
  const initialized = parseSuccess(
    await runProcess(root, ['init', '--input', '-'], Buffer.from(JSON.stringify(draft))),
    'init',
  );
  parseSuccess(await runProcess(root, ['lock', '--approval', initialized.approval_required]), 'lock');
  parseSuccess(
    await runProcess(root, ['plan', '--input', '-', '--classification', 'aligned'], Buffer.from(JSON.stringify(versionOnePlan))),
    'plan',
  );
  parseSuccess(
    await runProcess(root, ['plan', '--input', '-', '--classification', 'implementation-choice'], Buffer.from(JSON.stringify(versionOnePlan))),
    'plan',
  );
  parseSuccess(await runProcess(root, ['record', '--input', '-'], Buffer.from(JSON.stringify({
    kind: 'progress', event_type: 'task-start', task_id: 'TASK-0001', summary: 'Started changed work', evidence_refs: [],
  }))), 'record');
  const firstEvidence = parseSuccess(await runProcess(root, ['record', '--input', '-'], Buffer.from(JSON.stringify({
    kind: 'evidence', acceptance_criterion_id: 'AC-001', task_id: 'TASK-0001',
    validation_ref: {
      goal_id: initialized.goal_id, goal_version: initialized.goal_version, goal_digest: initialized.goal_digest,
      plan_revision: 2, validation_id: 'VAL-0001',
    },
    observed_result: 'Version one changed work passed.', artifact_refs: ['delivery.txt'],
    inventory: null, state: 'pass', failure_paths: [], supersedes: null,
  }))), 'record');
  assert.equal(firstEvidence.evidence_id, 'EVID-0001');
  parseSuccess(await runProcess(root, ['record', '--input', '-'], Buffer.from(JSON.stringify({
    kind: 'progress', event_type: 'task-complete', task_id: 'TASK-0001', summary: 'Completed changed work', evidence_refs: ['EVID-0001'],
  }))), 'record');

  const changedCriteria = draft.acceptance_criteria.map((criterion) => criterion.id === 'AC-001'
    ? { ...criterion, outcome: 'Changed work is re-verified against the version two goal' }
    : criterion);
  const proposal = parseSuccess(await runProcess(root, ['propose', '--input', '-'], Buffer.from(JSON.stringify({
    candidate: {
      objective: 'Prove a disk-resumed version two lifecycle', scope: draft.scope, non_goals: draft.non_goals,
      constraints: draft.constraints, acceptance_criteria: changedCriteria,
      authorization_boundary: draft.authorization_boundary, assumptions: draft.assumptions,
    },
    changes: [
      { field: 'objective', before: draft.objective, after: 'Prove a disk-resumed version two lifecycle' },
      { field: 'acceptance_criteria', before: draft.acceptance_criteria, after: changedCriteria },
    ],
    rationale: 'Changed work requires a fresh version-bound verification.', affected_tasks: ['TASK-0001'],
    criterion_impact: { affected: ['AC-001'], unaffected: ['AC-002'] },
    risks: ['Old evidence could be reused.'], validation: ['Run focused checks'], rollback: ['Reject the proposal'],
  }))), 'propose');
  parseFailure(await runProcess(root, ['approve', '--cr', proposal.change_request_id, '--approval', 'APPROVE']), 5, 'approve');
  parseSuccess(await runProcess(root, ['approve', '--cr', proposal.change_request_id, '--approval', proposal.approval_required]), 'approve');

  const versionOneGoal = JSON.parse(await readFile(path.join(root, '.goal-lock', 'history', 'goals', 'v0001.json'), 'utf8'));
  const versionTwoGoal = JSON.parse(await readFile(path.join(root, '.goal-lock', 'history', 'goals', 'v0002.json'), 'utf8'));
  assert.equal(versionOneGoal.goal_version, 1);
  assert.equal(versionTwoGoal.goal_version, 2);
  for (const name of ['v0001-r0001.json', 'v0001-r0002.json']) {
    await lstat(path.join(root, '.goal-lock', 'history', 'plans', name));
  }
  const staleEvidence = JSON.parse(await readFile(path.join(root, '.goal-lock', 'evidence', 'AC-001', 'EVID-0002.json'), 'utf8'));
  assert.deepEqual({ state: staleEvidence.state, supersedes: staleEvidence.supersedes }, { state: 'stale', supersedes: 'EVID-0001' });
  const postApprovalPlan = JSON.parse(await readFile(path.join(root, '.goal-lock', 'plan.json'), 'utf8'));
  assert.deepEqual(postApprovalPlan.tasks.map((task) => [task.id, task.status]), [['TASK-0001', 'stale'], ['TASK-0002', 'pending']]);
  const events = (await readFile(path.join(root, '.goal-lock', 'progress.jsonl'), 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line));
  assert.equal(events.at(-1).event_type, 'evidence-invalidation');
  for (let index = 0; index < events.length; index += 1) {
    assert.equal(events[index].event_id, `EVT-${String(index + 1).padStart(6, '0')}`);
    assert.equal(events[index].previous_event_digest, index === 0 ? null : events[index - 1].event_digest);
  }

});

test('real process maps usage, transition, integrity, approval, and I/O failures to redacted stderr', async (testContext) => {
  const root = await createCliFixture(testContext);
  const secret = 'DO-NOT-ECHO-OBJECTIVE-OR-BYTES';
  await writeFile(path.join(root, 'malformed.json'), `{"objective":"${secret}"`);

  const usage = parseFailure(await runProcess(root, ['init', '--input', 'malformed.json']), 2, 'init');
  assert.doesNotMatch(JSON.stringify(usage), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(usage), /malformed\.json/);
  parseFailure(await runProcess(root, ['init', '--input', 'missing.json']), 6, 'init');

  const initialized = parseSuccess(
    await runProcess(root, ['init', '--input', '-'], Buffer.from(JSON.stringify(goalDraft()))),
    'init',
  );
  await writeJson(root, 'plan.json', planInput());
  parseFailure(
    await runProcess(root, ['plan', '--input', 'plan.json', '--classification', 'aligned']),
    3,
    'plan',
  );
  parseFailure(await runProcess(root, ['lock', '--approval', 'APPROVE']), 5, 'lock');
  parseSuccess(await runProcess(root, ['lock', '--approval', initialized.approval_required]), 'lock');
  await writeFile(path.join(root, '.goal-lock', 'current.json'), '{}\n');
  parseFailure(await runProcess(root, ['verify']), 4, 'verify');

  const gitFailureRoot = await createCliFixture(testContext);
  await Promise.all([
    writeJson(gitFailureRoot, 'plan.json', planInput()),
    writeJson(gitFailureRoot, 'audit.json', {
      kind: 'final-audit',
      semantic_summary: 'This audit must fail on corrupt Git state.',
      inventory: null,
    }),
  ]);
  const gitInitialized = parseSuccess(
    await runProcess(gitFailureRoot, ['init', '--input', '-'], Buffer.from(JSON.stringify(goalDraft()))),
    'init',
  );
  parseSuccess(await runProcess(gitFailureRoot, ['lock', '--approval', gitInitialized.approval_required]), 'lock');
  parseSuccess(
    await runProcess(gitFailureRoot, ['plan', '--input', 'plan.json', '--classification', 'aligned']),
    'plan',
  );
  await writeFile(path.join(gitFailureRoot, '.git', 'HEAD'), 'corrupt-head\n');
  const gitFailure = parseFailure(
    await runProcess(gitFailureRoot, ['record', '--input', 'audit.json']),
    6,
    'record',
  );
  assert.equal(gitFailure.code, 'GOAL_IO_GIT');
});

test('real process rejects unsafe input paths, linked files, oversized input, invalid UTF-8, and multiple JSON documents', async (testContext) => {
  const root = await createCliFixture(testContext);
  const outside = path.join(path.dirname(root), `${path.basename(root)}-outside.json`);
  testContext.after(() => rm(outside, { force: true }));
  await writeFile(outside, JSON.stringify(goalDraft()));
  await writeFile(path.join(root, 'linked-source.json'), JSON.stringify(goalDraft()));
  await link(path.join(root, 'linked-source.json'), path.join(root, 'linked.json'));

  for (const input of [outside, '../outside.json', 'parent\\draft.json', 'draft.json:stream', 'linked.json']) {
    parseFailure(await runProcess(root, ['init', '--input', input]), 4, 'init');
  }
  parseFailure(
    await runProcess(root, ['init', '--input', '-'], Buffer.alloc((1024 * 1024) + 1, 0x20)),
    2,
    'init',
  );
  parseFailure(await runProcess(root, ['init', '--input', '-'], Buffer.from([0xc3, 0x28])), 2, 'init');
  parseFailure(
    await runProcess(root, ['init', '--input', '-'], Buffer.from('{}\n{}\n')),
    2,
    'init',
  );
});

test('real process help is a read-only JSON success and does not require a goal repository', async (testContext) => {
  const root = await createCliFixture(testContext);
  await mkdir(path.join(root, '.goal-lock'));
  await writeFile(path.join(root, '.goal-lock', 'unrelated'), 'must remain unchanged');
  const before = await nonGoalLockSnapshot(root);
  const goalLockBefore = await readFile(path.join(root, '.goal-lock', 'unrelated'));

  const result = parseSuccess(await runProcess(root, ['--help']), 'help');

  assert.match(result, /goal-lock recover-lock/);
  assert.deepEqual(await nonGoalLockSnapshot(root), before);
  assert.deepEqual(await readFile(path.join(root, '.goal-lock', 'unrelated')), goalLockBefore);
});

test('real process dispatches propose, reject, approve, and recover-lock with exact bindings', async (testContext) => {
  const root = await createCliFixture(testContext);
  await Promise.all([
    writeJson(root, 'plan.json', planInput()),
    writeJson(root, 'change.json', changeProposalInput()),
  ]);
  const initialized = parseSuccess(
    await runProcess(root, ['init', '--input', '-'], Buffer.from(JSON.stringify(goalDraft()))),
    'init',
  );
  parseSuccess(await runProcess(root, ['lock', '--approval', initialized.approval_required]), 'lock');
  parseSuccess(await runProcess(root, ['plan', '--input', 'plan.json', '--classification', 'aligned']), 'plan');

  const first = parseSuccess(await runProcess(root, ['propose', '--input', 'change.json']), 'propose');
  assert.equal(first.change_request_id, 'CR-0001');
  parseFailure(
    await runProcess(root, ['approve', '--cr', 'CR-0001', '--approval', 'APPROVE']),
    5,
    'approve',
  );
  const rejected = parseSuccess(
    await runProcess(root, ['reject', '--cr', 'CR-0001', '--reason', 'Keep the approved scope']),
    'reject',
  );
  assert.equal(rejected.status, 'rejected');
  assert.equal(Object.hasOwn(rejected, 'reason'), false);

  const second = parseSuccess(await runProcess(root, ['propose', '--input', 'change.json']), 'propose');
  assert.equal(second.change_request_id, 'CR-0002');
  parseSuccess(
    await runProcess(root, ['approve', '--cr', 'CR-0002', '--approval', second.approval_required]),
    'approve',
  );
  assert.equal(parseSuccess(await runProcess(root, ['verify']), 'verify').evidence.goal.goal_version, 2);

  const recoveryRoot = await createCliFixture(testContext);
  const recovery = parseFailure(await runProcess(recoveryRoot, [
    'recover-lock',
    '--owner-token', '11111111-1111-4111-8111-111111111111',
    '--lock-digest', '0'.repeat(64),
  ]), 6, 'recover-lock');
  assert.equal(recovery.code, 'RECOVERY_LOCK_MISSING');
});

test('real process keeps recover-lock usage failures at exit 2 without writes or sensitive echoes', async (testContext) => {
  const root = await createCliFixture(testContext);
  const validOwnerToken = '11111111-1111-4111-8111-111111111111';
  const secondOwnerToken = '22222222-2222-4222-8222-222222222222';
  const invalidOwnerToken = 'invalid-owner-token-DO-NOT-ECHO';
  const lockDigest = '0'.repeat(64);
  const before = await nonGoalLockSnapshot(root);
  const cases = [
    ['invalid UUID', [
      'recover-lock', '--owner-token', invalidOwnerToken, '--lock-digest', lockDigest,
    ]],
    ['missing lock digest', [
      'recover-lock', '--owner-token', validOwnerToken,
    ]],
    ['duplicate owner token', [
      'recover-lock',
      '--owner-token', validOwnerToken,
      '--owner-token', secondOwnerToken,
      '--lock-digest', lockDigest,
    ]],
  ];

  for (const [label, argv] of cases) {
    const processResult = await runProcess(root, argv);
    const failure = parseFailure(processResult, 2, 'recover-lock');
    assert.equal(failure.code, 'CLI_USAGE', label);
    for (const sensitive of [invalidOwnerToken, validOwnerToken, secondOwnerToken, lockDigest]) {
      assert.doesNotMatch(processResult.stderr, new RegExp(sensitive), label);
    }
  }

  assert.deepEqual(await nonGoalLockSnapshot(root), before);
  await assert.rejects(lstat(path.join(root, '.goal-lock')));
});

test('module input reader fails closed when a regular file changes after its bounded read', async (testContext) => {
  const root = await createCliFixture(testContext);
  const target = path.join(root, 'raced.json');
  await writeJson(root, 'raced.json', goalDraft());
  let faultInvoked = false;

  const result = await runGoalLockCli(['init', '--input', 'raced.json'], {
    root,
    inputFaults: {
      afterFileRead: async () => {
        faultInvoked = true;
        await writeJson(root, 'raced.json', { ...goalDraft(), objective: 'Raced objective must not be trusted' });
      },
    },
  });

  assert.equal(faultInvoked, true);
  assert.deepEqual(result, {
    ok: false,
    command: 'init',
    error: {
      code: 'INPUT_FILE_RACED',
      message: 'Goal-lock integrity or path safety verification failed.',
    },
  });
  await assert.rejects(readFile(path.join(root, '.goal-lock', 'current.json')));
  assert.notEqual(await readFile(target, 'utf8'), '');
});
