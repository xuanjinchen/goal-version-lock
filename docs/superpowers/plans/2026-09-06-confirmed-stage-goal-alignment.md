# Confirmed Stage Goal Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the protocol-v2 governance system with one independent Skill that keeps each development work slice aligned with the explicitly confirmed stage goal.

**Architecture:** Use a replacement architecture with a pure goal contract, a narrow verified store, a five-command transition state machine, and a thin JSON CLI. `SKILL.md` owns only the semantic aligned/change/ambiguous decision; no planning, progress, test, regression, evidence, audit, recovery-journal, or completion authority remains.

**Tech Stack:** Node.js 22+, ECMAScript modules, Node standard library, `node:test`, local Markdown/JSON Skill contracts.

**Spec:** `docs/superpowers/specs/2026-09-05-confirmed-stage-goal-alignment-design.md`

## Global Constraints

- The product has exactly one responsibility: keep the current development task aligned with the explicitly confirmed stage goal.
- Only `objective`, `success_criteria`, `constraints`, and `non_goals` are user-controlled goal fields.
- Persist only `.goal-lock/current.json`, `.goal-lock/history/vNNNN.json`, and non-authoritative `.goal-lock/proposal.json`.
- Expose only the `init`, `propose`, `approve`, `verify`, and `status` commands; global `--help` is not a sixth command.
- A clear goal-field change stops until its complete field-level proposal receives the byte-exact generated approval phrase.
- An ambiguous request returns `clarification-required` without a proposal or any other state mutation.
- Current-byte tampering, a missing or invalid history version, a broken predecessor, a stale proposal, and an incompatible partial transition fail closed.
- Do not read, migrate, wrap, or preserve protocol-v2 goal-lock state. Detect it and return `unsupported-state`.
- Do not depend on or integrate with `planning-with-files`; do not create planning or progress records inside this product.
- Do not govern paths, commands, tests, regressions, validations, evidence, audits, completion, release, or host activity.
- Use focused TDD. Each implementation task runs only the test file introduced or changed by that task.
- After stable implementation and evidence inputs exist, plan one `npm run check` and one `npm run gate:delivery`; rerun either only after fixing a concrete failure from that command.
- Preserve unrelated user work. Resolve the known old Task 10 draft files through explicit replacement or deletion; never use reset, checkout, or broad cleanup.
- Do not push, tag, release, publish, use credentials, mutate remotes, or change global configuration.
- Apply the repository `chinese-code-comments` policy in `SCOPED` mode during implementation and review the full diff plus untracked delivery files before completion.

---

## Target File Structure

```text
src/goal-lock/
  canonical.js       # Canonical UTF-8 JSON and SHA-256 primitives only.
  contract.js        # Goal/proposal validation, derived metadata, differences, errors.
  store.js           # Verified state reads and durable single-file writes.
  state-machine.js   # init/propose/approve/verify/status transitions.
  cli.js             # Five-command argument and JSON I/O adapter.
scripts/
  goal-lock.js       # Real process entry point.
tests/
  helpers/goal-lock-fixture.js
  goal-lock-contract.test.js
  goal-lock-store.test.js
  goal-lock-state-machine.test.js
  goal-lock-cli.test.js
  documentation.test.js
```

Remove rather than wrap these product files:

```text
src/goal-lock/authorization.js
src/goal-lock/contracts.js
src/goal-lock/repository.js
src/goal-lock/transaction.js
src/goal-lock/workspace.js
tests/goal-lock-authorization.test.js
tests/goal-lock-transaction-recovery.test.js
tests/goal-lock-workspace-scope.test.js
tests/goal-lock.test.js
references/contract.md
```

Keep `src/recover-lock.js`, `scripts/recover-lock.js`, `src/transaction.js`, `tests/recover-lock.test.js`, and `tests/transaction.test.js`; they protect scaffold initialization and are not the goal-lock product.

## Public Runtime Interfaces

Later tasks use these exact names and shapes.

```js
// src/goal-lock/contract.js
export const USER_GOAL_FIELDS;
export class GoalLockError extends Error;
export function normalizeGoalInput(value);
export function createGoalRecord(input, metadata);
export function verifyGoalRecord(value);
export function diffGoalFields(before, after);
export function createProposal(baseGoal, candidateGoal);
export function verifyProposal(value, baseGoal = null);

// metadata: { version: number, predecessor: null | { version: number, digest: string } }

// src/goal-lock/store.js
export async function inspectGoalStore(root);
export async function replaceProposal(root, proposal, context = {});
export async function createHistoryRecord(root, record, context = {});
export async function replaceCurrentRecord(root, record, context = {});
export async function removeProposal(root, expectedProposalDigest, context = {});

// src/goal-lock/state-machine.js
export async function initializeGoal(root, input, context = {});
export async function proposeGoal(root, input, context = {});
export async function approveGoal(root, approvalPhrase, context = {});
export async function verifyGoal(root);
export async function getGoalStatus(root);

// src/goal-lock/cli.js
export function parseGoalLockArgs(argv);
export function formatGoalLockHelp();
export async function runGoalLockCli(argv, context = {});
```

`inspectGoalStore(root)` returns this shape or throws `GoalLockError`:

```js
{
  state: 'uninitialized' | 'initial-proposed' | 'active' | 'change-proposed' | 'transition-incomplete',
  active: null | { version: 1, digest: '64 lowercase hexadecimal characters' },
  current: null | goalRecord,
  history: [goalRecord],
  proposal: null | proposalRecord,
  transition: null | {
    version: 1,
    history_installed: true,
    current_installed: false,
  },
}
```

State-machine results are JSON-serializable:

```js
// initializeGoal / changed proposeGoal
{
  state: 'initial-proposed' | 'change-proposed',
  active: null | { version, digest },
  proposal: { version, candidate_digest, proposal_digest, approval_phrase, changes },
}

// unchanged proposeGoal
{ state: 'no-change', active: { version, digest } }

// approveGoal
{ state: 'active', active: { version, digest } }

// verifyGoal
{ state, active }

// getGoalStatus
{ state, active, pending: null | { version, proposal_digest, approval_phrase, changes } }
```

## Known Dirty-File Ownership

- Delete obsolete `evals/results/EVAL-007.txt`, `EVAL-010.txt`, `EVAL-011.txt`, and `EVAL-012.txt` when reducing the old matrix.
- Replace untracked `evals/results/prompt-budget.txt` with the final measurement for the new `SKILL.md` only.
- Remove only the old Task 10 sentinel exemptions from `src/audit.js`: the `work` safe root, `SAFE_CREDENTIAL_ASSIGNMENT_PATTERN`, and its special-case loop.
- Remove only the two matching sentinel tests from `tests/audit.test.js`.
- Do not modify any other audit behavior while resolving those drafts.

---

### Task 1: Define the Pure Goal and Proposal Contract

**Files:**
- Create: `src/goal-lock/contract.js`
- Modify: `src/goal-lock/canonical.js`
- Create: `tests/goal-lock-contract.test.js`
- Modify: `tests/helpers/goal-lock-fixture.js`

**Interfaces:**
- Consumes: `canonicalBytes`, `parseCanonicalJson`, and `sha256` from `src/goal-lock/canonical.js`.
- Produces: every `src/goal-lock/contract.js` export listed above.

- [ ] **Step 1: Replace the old fixture vocabulary with four-field goal fixtures**

Write `tests/helpers/goal-lock-fixture.js` as:

```js
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
```

- [ ] **Step 2: Write contract tests before the module exists**

Create `tests/goal-lock-contract.test.js` with focused exact-field, normalization, digest, difference, and phrase cases:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalBytes, sha256 } from '../src/goal-lock/canonical.js';
import {
  createGoalRecord, createProposal, diffGoalFields,
  normalizeGoalInput, verifyGoalRecord, verifyProposal,
} from '../src/goal-lock/contract.js';
import { goalInput } from './helpers/goal-lock-fixture.js';

test('derives a canonical version-one record from only the four user fields', () => {
  const record = createGoalRecord(goalInput(), { version: 1, predecessor: null });
  const { digest, ...withoutDigest } = record;
  assert.deepEqual(Object.keys(record).sort(), [
    'constraints', 'digest', 'non_goals', 'objective', 'predecessor',
    'success_criteria', 'version',
  ]);
  assert.equal(digest, sha256(canonicalBytes(withoutDigest)));
  assert.deepEqual(verifyGoalRecord(record), record);
});

test('rejects unknown fields, whitespace, empty entries, and duplicate list values', () => {
  assert.throws(() => normalizeGoalInput({ ...goalInput(), plan: [] }), /exact fields/i);
  assert.throws(() => normalizeGoalInput({ ...goalInput(), objective: ' padded ' }), /trimmed/i);
  assert.throws(() => normalizeGoalInput({ ...goalInput(), constraints: [''] }), /non-empty/i);
  assert.throws(() => normalizeGoalInput({ ...goalInput(), non_goals: ['same', 'same'] }), /unique/i);
});

test('reports one ordered difference per changed user-controlled field', () => {
  const before = createGoalRecord(goalInput(), { version: 1, predecessor: null });
  const after = createGoalRecord(goalInput({
    objective: 'Deliver reviewed CSV and XML exports', non_goals: [],
  }), { version: 2, predecessor: { version: 1, digest: before.digest } });
  assert.deepEqual(diffGoalFields(before, after), [
    { field: 'objective', before: before.objective, after: after.objective },
    { field: 'non_goals', before: before.non_goals, after: after.non_goals },
  ]);
});

test('binds the exact approval phrase to candidate version and proposal digest', () => {
  const candidate = createGoalRecord(goalInput(), { version: 1, predecessor: null });
  const proposal = createProposal(null, candidate);
  assert.equal(proposal.approval_phrase, `APPROVE GOAL VERSION 1 ${proposal.proposal_digest}`);
  assert.deepEqual(verifyProposal(proposal), proposal);
  assert.throws(
    () => verifyProposal({ ...proposal, approval_phrase: `${proposal.approval_phrase} ` }),
    /approval phrase/i,
  );
});
```

- [ ] **Step 3: Run the contract test to verify RED**

```powershell
node --test tests/goal-lock-contract.test.js
```

Expected: FAIL because `src/goal-lock/contract.js` does not exist.

- [ ] **Step 4: Implement the exact contract and keep canonical.js generic**

Start `src/goal-lock/contract.js` with:

```js
export const USER_GOAL_FIELDS = Object.freeze([
  'objective', 'success_criteria', 'constraints', 'non_goals',
]);

export class GoalLockError extends Error {
  constructor(code, kind, exitCode, message, options = {}) {
    super(message, options);
    this.name = 'GoalLockError';
    this.code = code;
    this.kind = kind;
    this.exitCode = exitCode;
  }
}
```

Use exact-key validation. `normalizeGoalInput` accepts already trimmed strings, rejects unknown or derived keys, preserves list order, and rejects duplicates. `createGoalRecord` derives `digest` over canonical bytes without `digest` and deep-freezes the result. `verifyGoalRecord` recomputes the complete record and rejects any mismatch.

`createProposal(baseGoal, candidateGoal)` accepts the complete verified predecessor goal or `null`, then produces exact keys `base`, `candidate`, `changes`, `proposal_digest`, and `approval_phrase`. For an initial proposal, persisted `base` is null and `changes` is empty. For a changed goal, persisted `base` is only `{ version, digest }`, while `changes` is computed from the complete `baseGoal` and contains every changed user field in `USER_GOAL_FIELDS` order. `verifyProposal(value, baseGoal = null)` reconstructs the same proposal from the persisted candidate and the complete predecessor supplied by the verified store. Compute `proposal_digest` over canonical `{ base, candidate, changes }`; never hash `proposal_digest` or `approval_phrase` into themselves.

Keep `canonical.js` limited to reusable canonical JSON primitives. Retain recursive key sorting, array order, strict UTF-8 parsing, no BOM, and one final newline; remove `shortFingerprint` after all new call sites use the full digest.

- [ ] **Step 5: Run the contract test to verify GREEN**

```powershell
node --test tests/goal-lock-contract.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit the contract slice**

```powershell
git add src/goal-lock/canonical.js src/goal-lock/contract.js tests/goal-lock-contract.test.js tests/helpers/goal-lock-fixture.js
git diff --cached --check
git commit -m "feat: define confirmed stage goal contract"
```

---

### Task 2: Implement the Verified Goal Store

**Files:**
- Create: `src/goal-lock/store.js`
- Create: `tests/goal-lock-store.test.js`

**Interfaces:**
- Consumes: `GoalLockError`, `createProposal`, `verifyGoalRecord`, and `verifyProposal` from `src/goal-lock/contract.js`; canonical bytes from `src/goal-lock/canonical.js`.
- Produces: every `src/goal-lock/store.js` function and the exact snapshot shape listed above.

- [ ] **Step 1: Write store tests for valid snapshots and fail-closed integrity**

Create `tests/goal-lock-store.test.js` with these concrete cases:

```js
test('derives uninitialized, initial-proposed, active, and change-proposed from disk', async (t) => {
  const { root } = await createGoalLockFixture(t);
  assert.equal((await inspectGoalStore(root)).state, 'uninitialized');

  const v1 = createGoalRecord(goalInput(), { version: 1, predecessor: null });
  const initial = createProposal(null, v1);
  await replaceProposal(root, initial);
  assert.equal((await inspectGoalStore(root)).state, 'initial-proposed');

  await createHistoryRecord(root, v1);
  await replaceCurrentRecord(root, v1);
  await removeProposal(root, initial.proposal_digest);
  assert.equal((await inspectGoalStore(root)).state, 'active');

  const v2 = createGoalRecord(goalInput({ non_goals: [] }), {
    version: 2,
    predecessor: { version: 1, digest: v1.digest },
  });
  await replaceProposal(root, createProposal(v1, v2));
  assert.equal((await inspectGoalStore(root)).state, 'change-proposed');
});

test('detects both valid interrupted approval positions', async (t) => {
  const fixture = await activeFixture(t);
  const proposal = await installVersionTwoProposal(fixture);
  await createHistoryRecord(fixture.root, proposal.candidate);
  let snapshot = await inspectGoalStore(fixture.root);
  assert.deepEqual(snapshot.transition, {
    version: 2, history_installed: true, current_installed: false,
  });

  await replaceCurrentRecord(fixture.root, proposal.candidate);
  snapshot = await inspectGoalStore(fixture.root);
  assert.deepEqual(snapshot.transition, {
    version: 2, history_installed: true, current_installed: true,
  });
});

test('fails closed for current tamper, missing history, broken predecessor, and stale proposal', async (t) => {
  for (const arrange of [tamperCurrent, removeHistoryVersion, breakPredecessor, staleProposal]) {
    await t.test(arrange.name, async (subtest) => {
      const fixture = await activeVersionTwoFixture(subtest);
      await arrange(fixture);
      await assert.rejects(inspectGoalStore(fixture.root), (error) => (
        error.code === 'INTEGRITY_FAILURE' && error.exitCode === 4
      ));
    });
  }
});

test('rejects protocol-v2 state without migration', async (t) => {
  const { root } = await createGoalLockFixture(t);
  await mkdir(path.join(root, '.goal-lock'), { recursive: true });
  await writeFile(path.join(root, '.goal-lock', 'lock.json'), '{}\n');
  await assert.rejects(inspectGoalStore(root), (error) => (
    error.code === 'UNSUPPORTED_STATE' && error.exitCode === 4
  ));
});
```

Define `activeFixture`, `installVersionTwoProposal`, and each arrange function in the same test file; each helper creates only the files needed by its case.

- [ ] **Step 2: Run the store test to verify RED**

```powershell
node --test tests/goal-lock-store.test.js
```

Expected: FAIL because `src/goal-lock/store.js` does not exist.

- [ ] **Step 3: Implement strict read and state derivation**

`inspectGoalStore` must:

1. Treat an absent `.goal-lock/` as `uninitialized`.
2. Reject a linked or non-directory `.goal-lock/`.
3. Recognize `lock.json`, `plan.json`, `progress.jsonl`, `scope.json`, `changes/`, `evidence/`, `.transaction.json`, `.write-lock.json`, or `history/goals/` as `UNSUPPORTED_STATE`.
4. Reject every other unrecognized root or history entry as `INTEGRITY_FAILURE`.
5. Read canonical regular files only and verify exact goal/proposal keys and digests.
6. Require history filenames `vNNNN.json`, with padding expanding beyond four digits rather than truncating versions.
7. Require history versions `1..N`, exact predecessor version/digest binding, and immutable canonical bytes.
8. Require `current.json` to be byte-identical to the authoritative history record allowed by the current transition position.
9. Accept `transition-incomplete` only when the pending proposal candidate is byte-identical to the newly installed history record and current is either the exact predecessor record or that exact candidate.
10. Return no `active` authority during `uninitialized`, `initial-proposed`, or `transition-incomplete`.

- [ ] **Step 4: Implement the four durable write primitives**

Use same-directory unique temporary files for mutable replacements:

```js
const stage = path.join(directory, `.${path.basename(target)}.${randomUUID()}.stage`);
const handle = await open(stage, 'wx', 0o600);
await handle.writeFile(bytes);
await handle.sync();
await handle.close();
await rename(stage, target);
assert((await readFile(target)).equals(bytes));
```

`createHistoryRecord` creates `history/vNNNN.json` with `open(target, 'wx')`, sync, close, and read back. It never overwrites an existing history name. `removeProposal` rereads and verifies the exact expected `proposal_digest` immediately before unlinking, then confirms absence; it cannot delete a concurrently replaced proposal.

Expose fault hooks only at the write boundaries used by Task 3:

```js
await context.storeFaults?.afterHistoryCreate?.({ record });
await context.storeFaults?.afterCurrentReplace?.({ record });
```

Do not add a lock file, transaction journal, backup tree, repair command, or general recovery API.

- [ ] **Step 5: Run the store test to verify GREEN**

```powershell
node --test tests/goal-lock-store.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit the store slice**

```powershell
git add src/goal-lock/store.js tests/goal-lock-store.test.js
git diff --cached --check
git commit -m "feat: add verified immutable goal store"
```

---

### Task 3: Implement the Five Transition Operations

**Files:**
- Create: `src/goal-lock/state-machine.js`
- Create: `tests/goal-lock-state-machine.test.js`

**Interfaces:**
- Consumes: the exact contract and store interfaces defined in Tasks 1 and 2.
- Produces: `initializeGoal`, `proposeGoal`, `approveGoal`, `verifyGoal`, and `getGoalStatus` with the listed result shapes.

- [ ] **Step 1: Write transition tests before implementation**

Create `tests/goal-lock-state-machine.test.js` with these behaviors:

```js
test('initial proposal has no authority until exact approval', async (t) => {
  const { root } = await createGoalLockFixture(t);
  const initialized = await initializeGoal(root, goalInput());
  assert.equal(initialized.state, 'initial-proposed');
  assert.equal(initialized.active, null);
  await assert.rejects(
    approveGoal(root, 'confirm'),
    (error) => error.code === 'APPROVAL_REJECTED' && error.exitCode === 5,
  );
  assert.equal((await verifyGoal(root)).active, null);
  const approved = await approveGoal(root, initialized.proposal.approval_phrase);
  assert.deepEqual(approved, {
    state: 'active',
    active: { version: 1, digest: initialized.proposal.candidate_digest },
  });
});

test('returns no-change without creating a new version', async (t) => {
  const fixture = await approvedFixture(t);
  const before = await getGoalStatus(fixture.root);
  const result = await proposeGoal(fixture.root, goalInput());
  assert.deepEqual(result, { state: 'no-change', active: before.active });
  assert.deepEqual(await getGoalStatus(fixture.root), before);
});

test('requires a field-level next-version proposal and exact phrase', async (t) => {
  const fixture = await approvedFixture(t);
  const proposed = await proposeGoal(fixture.root, goalInput({ non_goals: [] }));
  assert.deepEqual(proposed.proposal.changes, [{
    field: 'non_goals',
    before: ['Do not add XML export'],
    after: [],
  }]);
  assert.equal((await verifyGoal(fixture.root)).active.version, 1);
  await assert.rejects(approveGoal(fixture.root, 'APPROVE GOAL VERSION 2'), /approval/i);
  const approved = await approveGoal(fixture.root, proposed.proposal.approval_phrase);
  assert.equal(approved.active.version, 2);
});

test('same exact approval resumes after either approved write boundary', async (t) => {
  for (const phase of ['afterHistoryCreate', 'afterCurrentReplace']) {
    await t.test(phase, async (subtest) => {
      const fixture = await proposedVersionTwoFixture(subtest);
      const stop = new Error(`stop ${phase}`);
      await assert.rejects(
        approveGoal(fixture.root, fixture.approvalPhrase, {
          storeFaults: { [phase]() { throw stop; } },
        }),
        (error) => error === stop,
      );
      assert.equal((await getGoalStatus(fixture.root)).state, 'transition-incomplete');
      assert.equal(
        (await approveGoal(fixture.root, fixture.approvalPhrase)).active.version,
        2,
      );
    });
  }
});
```

Add one table-driven test proving `initializeGoal`, `proposeGoal`, and ordinary `approveGoal` reject integrity failure and unsupported legacy state without changing bytes. The same exact `approveGoal` phrase is the only operation allowed to resume `transition-incomplete`.

- [ ] **Step 2: Run the state-machine test to verify RED**

```powershell
node --test tests/goal-lock-state-machine.test.js
```

Expected: FAIL because `src/goal-lock/state-machine.js` does not exist.

- [ ] **Step 3: Implement initialization and proposal transitions**

`initializeGoal` accepts only `uninitialized`, builds version 1 plus an initial proposal, writes only `proposal.json`, and returns its full-digest approval phrase.

`proposeGoal` accepts `active` and `change-proposed`; a pending proposal may be atomically replaced because it has no authority. It verifies the current accepted chain, builds a complete `current.version + 1` candidate, compares only the four user fields, and:

- returns `no-change` without changing or deleting a pending proposal when all four fields match;
- otherwise replaces `proposal.json` and returns `change-proposed` while the current version remains active.

- [ ] **Step 4: Implement exact approval and the single retry rule**

`approveGoal` recomputes the proposal and compares `approvalPhrase` byte-for-byte before any write. For a fresh proposal it performs exactly:

```js
await createHistoryRecord(root, proposal.candidate, context);
await replaceCurrentRecord(root, proposal.candidate, context);
await removeProposal(root, proposal.proposal_digest, context);
```

For `transition-incomplete`, skip only steps whose exact candidate bytes are already installed. The same proposal and same phrase may finish the transition. Any other partial history/current/proposal combination is an integrity failure and has no authority.

- [ ] **Step 5: Implement read-only verify and status views**

`verifyGoal` returns only `{ state, active }` from `inspectGoalStore`.

`getGoalStatus` returns the same state and authority plus pending version, full proposal digest, exact phrase, and differences. It does not expose planning, progress, files, validations, evidence, audits, tests, or completion.

- [ ] **Step 6: Run the state-machine test to verify GREEN**

```powershell
node --test tests/goal-lock-state-machine.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit the transition slice**

```powershell
git add src/goal-lock/state-machine.js tests/goal-lock-state-machine.test.js
git diff --cached --check
git commit -m "feat: implement stage goal transitions"
```

---

### Task 4: Replace the CLI with Exactly Five Commands

**Files:**
- Rewrite: `src/goal-lock/cli.js`
- Rewrite: `scripts/goal-lock.js`
- Rewrite: `tests/goal-lock-cli.test.js`

**Interfaces:**
- Consumes: the five functions from `src/goal-lock/state-machine.js` and `writeOutput` from `src/output.js`.
- Produces: strict argument parsing, one JSON line on stdout for success, one redacted JSON line on stderr for failure, and stable exit codes.

- [ ] **Step 1: Write CLI parsing and real-process tests**

Replace `tests/goal-lock-cli.test.js` with focused tests that assert:

```js
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
```

Reject `lock`, `plan`, `reject`, `record`, `gate`, `recover-lock`, unknown options, duplicate options, missing values, and extra positional arguments with `CLI_USAGE` and exit code 2.

Add one real-process lifecycle test:

1. `init --input -` returns `initial-proposed`.
2. Pass the exact `approval_phrase` returned by `init` to `approve --approval`; this activates version 1.
3. `propose --input -` with a changed full four-field goal returns version 2 differences.
4. a generic approval exits 5 and changes no accepted state;
5. the exact phrase activates version 2;
6. `verify` and `status` return the same active version/digest;
7. `.goal-lock/` contains only `current.json`, `history/`, and no proposal after approval.

- [ ] **Step 2: Run the CLI test to verify RED**

```powershell
node --test tests/goal-lock-cli.test.js
```

Expected: FAIL because the old parser still exposes protocol-v2 commands.

- [ ] **Step 3: Implement strict five-command parsing and help**

Use this command table:

```js
const COMMAND_SPECS = Object.freeze({
  init: Object.freeze({ input: 'required' }),
  propose: Object.freeze({ input: 'required' }),
  approve: Object.freeze({ approval: 'required' }),
  verify: Object.freeze({}),
  status: Object.freeze({}),
});
```

The help usage section contains only:

```text
goal-lock init --input goal.json
goal-lock propose --input goal.json
goal-lock approve --approval "APPROVAL_PHRASE_FROM_PROPOSAL"
goal-lock verify
goal-lock status
```

Retain bounded strict UTF-8 JSON input from stdin or a safe repository-relative regular file. Do not retain Git runners, inventory support, CR identifiers, validation targets, recovery ownership, or protocol-v2 aliases.

- [ ] **Step 4: Dispatch only to the state machine and redact failures**

Successful results use:

```js
{ ok: true, command, result }
```

Failures use:

```js
{
  ok: false,
  command,
  error: {
    code: error.code ?? 'GOAL_OPERATION_FAILED',
    message: publicMessageFor(error.exitCode ?? 6),
  },
}
```

Map exit code 2 to input/usage, 3 to invalid transition, 4 to integrity or unsupported state, 5 to approval rejection, and 6 to I/O. Never echo goal text, file bytes, input paths, or supplied approval phrases in public errors.

Simplify `scripts/goal-lock.js` so the context contains only `root`, `stdin`, and `onExitCode`; remove Git, process-liveness, UUID-lock, and recovery helpers.

- [ ] **Step 5: Run the CLI test to verify GREEN**

```powershell
node --test tests/goal-lock-cli.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit the CLI slice**

```powershell
git add src/goal-lock/cli.js scripts/goal-lock.js tests/goal-lock-cli.test.js
git diff --cached --check
git commit -m "feat: reduce goal lock cli to five commands"
```

---

### Task 5: Remove Superseded Governance and Rewrite the Skill Surface

**Files:**
- Delete: `src/goal-lock/authorization.js`
- Delete: `src/goal-lock/contracts.js`
- Delete: `src/goal-lock/repository.js`
- Delete: `src/goal-lock/transaction.js`
- Delete: `src/goal-lock/workspace.js`
- Delete: `tests/goal-lock-authorization.test.js`
- Delete: `tests/goal-lock-transaction-recovery.test.js`
- Delete: `tests/goal-lock-workspace-scope.test.js`
- Delete: `tests/goal-lock.test.js`
- Delete: `references/contract.md`
- Rewrite: `SKILL.md`
- Rewrite: `README.md`
- Rewrite: `tests/documentation.test.js`
- Modify: `evals/evals.json`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.scaffold/state.json`
- Modify: `src/audit.js`
- Modify: `tests/audit.test.js`

**Interfaces:**
- Consumes: the completed runtime and approved design.
- Produces: one discoverable semantic workflow whose only pre-execution outcomes are `aligned`, `goal-change-required`, and `clarification-required`.

- [ ] **Step 1: Freeze the four behavior scenarios before rewriting Skill instructions**

Replace `evals/evals.json` with schema version 1 and exactly these cases, leaving every result `not-run` at this step:

```json
{
  "schema_version": 1,
  "skill": "goal-version-lock",
  "evals": [
    {
      "id": "EVAL-001",
      "category": "positive",
      "prompt": "The confirmed stage goal is to repair the CSV export so it preserves the final row. Fix the missing-final-row defect without changing any confirmed goal field.",
      "assertions": [
        { "id": "ASSERT-001", "text": "Verifies the active goal and classifies the requested defect fix as aligned before continuing." },
        { "id": "ASSERT-002", "text": "Keeps the active goal version and digest unchanged." }
      ],
      "result": { "status": "not-run", "evidence": "" }
    },
    {
      "id": "EVAL-002",
      "category": "negative",
      "prompt": "The confirmed goal delivers CSV only. Add XML output now and continue implementation without changing the approved stage-goal record.",
      "assertions": [
        { "id": "ASSERT-003", "text": "Returns goal-change-required and identifies the exact goal fields that would change." },
        { "id": "ASSERT-004", "text": "Does not execute changed work or grant authority before exact proposal approval." }
      ],
      "result": { "status": "not-run", "evidence": "" }
    },
    {
      "id": "EVAL-003",
      "category": "positive",
      "prompt": "Review the pending complete CSV-and-XML goal proposal, apply its exact generated approval phrase, verify the new active version, and only then continue the changed work.",
      "assertions": [
        { "id": "ASSERT-005", "text": "Approves only the exact current proposal phrase and creates the next consecutive goal version." },
        { "id": "ASSERT-006", "text": "Verifies the new version and predecessor chain before changed work continues." }
      ],
      "result": { "status": "not-run", "evidence": "" }
    },
    {
      "id": "EVAL-004",
      "category": "boundary",
      "prompt": "Make the exporter more robust. The request may mean an internal implementation improvement or a stronger success criterion; decide whether work can continue.",
      "assertions": [
        { "id": "ASSERT-007", "text": "Returns clarification-required because the request has both aligned and goal-changing readings." },
        { "id": "ASSERT-008", "text": "Asks one focused question and makes no proposal or accepted-state mutation." }
      ],
      "result": { "status": "not-run", "evidence": "" }
    }
  ]
}
```

- [ ] **Step 2: Rewrite SKILL.md around the single semantic decision**

Use this description verbatim in `SKILL.md` frontmatter, `package.json`, `package-lock.json`, and `.scaffold/state.json#skill.description`:

```text
Keep development work aligned with an explicitly confirmed stage goal. Use when a development stage must be confirmed, verified before each work slice, or changed through a versioned field-level proposal with exact approval. Return clarification-required when alignment is ambiguous and fail closed on tampered goal history. Do not use for planning, progress tracking, test or regression governance, evidence, audits, completion decisions, personal goals, or configuration drift.
```

The Skill body requires this sequence:

1. run deterministic `verify` before each new work slice;
2. stop and initialize/approve a goal when no active authority exists;
3. compare intended work against all four active fields semantically, not by keyword;
4. return `aligned` with active version/digest only when no field changes;
5. return `goal-change-required`, list changed fields, and materialize a complete proposal for a clear change;
6. return `clarification-required`, ask one focused question, and write no proposal for ambiguity;
7. require the exact generated phrase, verify the next version, then allow changed work;
8. stop on integrity, unsupported-state, or transition-incomplete results.

Do not instruct the Agent how to plan, record progress, choose tests, run regressions, collect evidence, audit, or decide completion.

- [ ] **Step 3: Rewrite README and documentation tests to the same public contract**

README contains one version-1 goal JSON example with exactly the four input fields, the five commands, the three semantic outcomes, the three persisted paths, and explicit protocol-v2 incompatibility. It contains no plan, progress, scope, evidence, audit, gate, recovery-journal, CR, inventory, or validation examples.

Rewrite `tests/documentation.test.js` to include:

```js
test('public docs expose only the four goal fields and five commands', () => {
  const readme = read('README.md');
  const goal = parseMarkedJsonExample(readme, 'goal-lock-input:v1');
  assert.deepEqual(Object.keys(goal).sort(), [
    'constraints', 'non_goals', 'objective', 'success_criteria',
  ]);
  assert.deepEqual(
    formatGoalLockHelp().split('\n').filter((line) => /^  goal-lock /u.test(line)),
    [
      '  goal-lock init --input goal.json',
      '  goal-lock propose --input goal.json',
      '  goal-lock approve --approval "APPROVAL_PHRASE_FROM_PROPOSAL"',
      '  goal-lock verify',
      '  goal-lock status',
    ],
  );
});

test('Skill owns alignment only and declares all three semantic outcomes', () => {
  const skill = read('SKILL.md');
  for (const outcome of ['aligned', 'goal-change-required', 'clarification-required']) {
    assert.match(skill, new RegExp(`\\b${outcome}\\b`, 'u'));
  }
  assert.doesNotMatch(skill, /next_task_id|ValidationRef|mandatory-gate|COMPLETE/u);
});

test('evaluation matrix contains exactly the four approved behaviors', () => {
  const matrix = JSON.parse(read('evals/evals.json'));
  assert.equal(matrix.schema_version, 1);
  assert.deepEqual(matrix.evals.map(({ id }) => id), [
    'EVAL-001', 'EVAL-002', 'EVAL-003', 'EVAL-004',
  ]);
});
```

- [ ] **Step 4: Remove obsolete runtime, tests, and reference authority**

Delete exactly the files listed in this task. Search the remaining live product surface:

```powershell
rg -n "authorization graph|plan_revision|progress.jsonl|scope.json|evidence|mandatory-gate|recover-lock|references/contract" SKILL.md README.md src/goal-lock scripts/goal-lock.js tests/documentation.test.js tests/goal-lock-*.test.js
```

Expected: no matches except negative-boundary prose in tests that asserts an obsolete term is absent. Historical specs, plans, Brief conflict history, and decision history may retain superseded terminology.

- [ ] **Step 5: Resolve the two old audit draft changes with exact edits**

In `src/audit.js`, remove the `work` safe root and `SAFE_CREDENTIAL_ASSIGNMENT_PATTERN`, then restore:

```js
function containsCredential(text) {
  return CREDENTIAL_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}
```

In `tests/audit.test.js`, delete only the tests named:

```text
allows the exact no-echo sentinel used by redaction tests in worktree and history
allows a neutral drive-root work path in worktree and history
```

This resolves those dirty files without reset or checkout and without changing unrelated audit behavior.

- [ ] **Step 6: Update package metadata and scaffold state without changing initial_files**

Keep `.scaffold/state.json#initial_files` byte-for-byte equal as a JSON value. Change only `skill.description` in this task; `status` remains `draft` until final evidence exists. Update package-lock root metadata to match the package description. Keep `recover:lock` because it belongs to scaffold initialization.

- [ ] **Step 7: Run only the affected documentation and audit tests**

```powershell
node --test tests/documentation.test.js tests/audit.test.js
```

Expected: PASS.

- [ ] **Step 8: Commit the replacement surface**

```powershell
git add SKILL.md README.md package.json package-lock.json .scaffold/state.json evals/evals.json src/audit.js tests/audit.test.js tests/documentation.test.js
git add -u src/goal-lock tests references
git diff --cached --check
git commit -m "refactor: remove superseded goal governance"
```

---

### Task 6: Execute Exactly Four Behavior Evaluations and Bind Delivery Evidence

**Files:**
- Rewrite: `evals/results/EVAL-001.txt`
- Rewrite: `evals/results/EVAL-002.txt`
- Rewrite: `evals/results/EVAL-003.txt`
- Rewrite: `evals/results/EVAL-004.txt`
- Delete: `evals/results/EVAL-005.txt`
- Delete: `evals/results/EVAL-006.txt`
- Delete: `evals/results/EVAL-007.txt`
- Delete: `evals/results/EVAL-008.txt`
- Delete: `evals/results/EVAL-009.txt`
- Delete: `evals/results/EVAL-010.txt`
- Delete: `evals/results/EVAL-011.txt`
- Delete: `evals/results/EVAL-012.txt`
- Delete: `evals/results/EVAL-013.txt`
- Rewrite: `evals/results/prompt-budget.txt`
- Modify: `evals/evals.json`
- Modify: `docs/skill-brief.md`

**Interfaces:**
- Consumes: frozen EVAL-001–004 prompts, the implemented Skill, and fresh isolated `.goal-lock/` fixtures.
- Produces: four current real-Agent result artifacts and one measured prompt-budget artifact; no extra matrix or product state.

- [ ] **Step 1: Run one matched baseline and one with-Skill execution per frozen scenario**

Use `subagent-driven-development` to dispatch a fresh evaluation worker for each EVAL. Each worker receives only its frozen prompt, a fresh isolated fixture, and either:

- baseline condition: no `SKILL.md` instructions;
- with-Skill condition: current `SKILL.md` plus the local five-command runtime.

For each scenario, inspect final output and persisted bytes. Grade only its two frozen assertions. Do not add follow-up prompts, extra adversarial variants, or additional evaluations.

Required final fixture facts:

- EVAL-001: active version/digest unchanged; aligned work may continue.
- EVAL-002: active version/digest unchanged; changed work not executed; a complete proposal may exist only after the clear field change is identified.
- EVAL-003: exact phrase accepted; new consecutive history record and current bytes agree; predecessor points to version 1.
- EVAL-004: no proposal write and no accepted-state write; response is `clarification-required` with one question.

- [ ] **Step 2: Write one compact result artifact per evaluation**

Each `evals/results/EVAL-NNN.txt` uses the exact labels `Evaluation`, `Status`, `Assertions`, `Matched baseline`, `Model`, `Implementation commit`, `Skill SHA-256`, `Fixture SHA-256`, `Prompt SHA-256`, `Transcript SHA-256`, `Final output SHA-256`, and `Observed`. Populate every value from the completed run: record the concrete evaluation ID, `pass`, measured assertion and baseline counts, exact model and reasoning setting, complete `git rev-parse HEAD` output, and lowercase SHA-256 digests of the named bytes. Under `Observed`, write the two concrete assertion observations from that run.

No field value may remain generic or symbolic. Keep raw transcripts outside the repository evaluation result directory.

- [ ] **Step 3: Delete the nine obsolete result files explicitly**

```powershell
git rm evals/results/EVAL-005.txt evals/results/EVAL-006.txt evals/results/EVAL-007.txt evals/results/EVAL-008.txt evals/results/EVAL-009.txt evals/results/EVAL-010.txt evals/results/EVAL-011.txt evals/results/EVAL-012.txt evals/results/EVAL-013.txt
```

This intentionally resolves the modified old Task 10 EVAL-007/010/011/012 drafts by deletion.

- [ ] **Step 4: Measure only the final default-load Skill prompt**

Use the same `js-tiktoken@1.0.21` `o200k_base` proxy basis already documented by the project, but count only:

- parsed `SKILL.md` frontmatter description;
- `SKILL.md` body;
- zero standing-rule tokens because implicit-trigger is disabled;
- zero reference tokens because the references track is disabled and `references/contract.md` was removed.

Record source digest, layer token counts, measured total, and a maintenance margin of `max(256, ceil(total * 0.125))` in `evals/results/prompt-budget.txt`. Set the limit to measured total plus that margin. Perform this measurement once after the Skill text is final.

- [ ] **Step 5: Bind eval and prompt-budget evidence in the matrix and Brief**

For each passing evaluation, compute and bind its artifact digest rather than copying a sample:

```powershell
$evalPath = 'evals/results/EVAL-001.txt'
$evalDigest = (Get-FileHash -Algorithm SHA256 $evalPath).Hash.ToLowerInvariant()
$evalEvidence = "artifact:$evalPath#sha256:$evalDigest"
```

Set that matrix entry to `status: pass` and `evidence: $evalEvidence`.

In `docs/skill-brief.md`:

- keep requirements version 3 and `status: draft`;
- keep REQ-001–005 pending until the final trace is assembled;
- set the prompt budget numbers to the measured values and bind the lowercase SHA-256 of `evals/results/prompt-budget.txt` using the same artifact syntax;
- set scripts-track evidence to the lowercase SHA-256 of `src/goal-lock/state-machine.js` using the same artifact syntax;
- leave all six disabled tracks disabled with their existing reasons and empty unblock conditions.

- [ ] **Step 6: Run the affected documentation contract test**

```powershell
node --test tests/documentation.test.js
```

Expected: PASS with exactly four passing evaluation entries and no references track.

- [ ] **Step 7: Commit the current evaluation evidence**

```powershell
git add evals/evals.json evals/results/EVAL-001.txt evals/results/EVAL-002.txt evals/results/EVAL-003.txt evals/results/EVAL-004.txt evals/results/prompt-budget.txt docs/skill-brief.md
git add -u evals/results
git diff --cached --check
git commit -m "test: verify confirmed goal alignment behavior"
```

---

### Task 7: Finalize Requirement Traces and Run the Two Delivery Commands

**Files:**
- Modify: `docs/skill-brief.md`
- Rewrite: `docs/delivery-report.md`
- Modify: `.scaffold/state.json`
- Modify after a concrete failure: only the exact file named by that failure.

**Interfaces:**
- Consumes: Requirements v3, four passing evaluation artifacts, final runtime paths, final prompt budget, and the complete branch diff.
- Produces: ready scaffold state, five passing requirement traces, one successful repository check, and one successful delivery gate.

- [ ] **Step 1: Mark only evidence-backed acceptance criteria ready**

Set `docs/skill-brief.md#status` to `ready` and REQ-001–005 to `pass`. Keep each verification sentence factual and tied to:

```text
REQ-001 -> state-machine exact approval tests; EVAL-001 and EVAL-003
REQ-002 -> SKILL semantic workflow; EVAL-001, EVAL-002, and EVAL-004
REQ-003 -> contract/state-machine proposal binding; EVAL-002 and EVAL-003
REQ-004 -> store integrity tests; EVAL-003 plus deterministic tamper cases
REQ-005 -> public-surface review; EVAL-001, EVAL-002, EVAL-003, and EVAL-004
```

Set `.scaffold/state.json#status` to `ready`. Do not change `initial_files`.

- [ ] **Step 2: Replace the delivery report with exactly five traces**

Keep the scaffold contract marker and use this contract:

```json
{
  "schema_version": 1,
  "requirements": [
    {
      "id": "REQ-001",
      "implementation": "path:src/goal-lock/state-machine.js",
      "verification": "eval:EVAL-001,EVAL-003",
      "status": "pass"
    },
    {
      "id": "REQ-002",
      "implementation": "path:SKILL.md",
      "verification": "eval:EVAL-001,EVAL-002,EVAL-004",
      "status": "pass"
    },
    {
      "id": "REQ-003",
      "implementation": "path:src/goal-lock/contract.js",
      "verification": "eval:EVAL-002,EVAL-003",
      "status": "pass"
    },
    {
      "id": "REQ-004",
      "implementation": "path:src/goal-lock/store.js",
      "verification": "eval:EVAL-003",
      "status": "pass"
    },
    {
      "id": "REQ-005",
      "implementation": "path:SKILL.md",
      "verification": "eval:EVAL-001,EVAL-002,EVAL-003,EVAL-004",
      "status": "pass"
    }
  ],
  "capability_claims": []
}
```

- [ ] **Step 3: Review the complete diff and untracked delivery files**

```powershell
git status --short
git diff d219aa0 --check
git diff --stat d219aa0
git diff d219aa0 -- SKILL.md README.md package.json package-lock.json .scaffold/state.json docs evals src/goal-lock scripts/goal-lock.js tests src/audit.js
```

Review for:

- any responsibility beyond confirmed-stage-goal alignment;
- any remaining live protocol-v2 import, command, state path, or documentation;
- missing or misleading `SCOPED` Chinese maintenance comments at immutable-history, atomic-replacement, and exact-retry boundaries;
- changed `initial_files` values;
- sensitive values, private paths, obsolete result files, or undeclared untracked files;
- accidental changes to scaffold `recover:lock` and root transaction code.

Make only corrections required by this review. Do not add cleanup, optional hardening, extra tests, or broader regression work.

- [ ] **Step 4: Run the repository check once**

```powershell
npm run check
```

Expected: all deterministic tests and repository validation pass. If it fails, fix only the concrete reported defect, run only its focused test, then rerun `npm run check`; never repeat an unchanged command.

- [ ] **Step 5: Run the delivery gate once**

```powershell
npm run gate:delivery
```

Expected: exit 0 and one `EVIDENCE pass` line for each REQ-001–005. If it fails, fix only the reported evidence contract and rerun after the bytes have changed; do not add an evaluation unless the failure proves a frozen scenario result invalid.

- [ ] **Step 6: Commit the mature local delivery**

```powershell
git add docs/skill-brief.md docs/delivery-report.md .scaffold/state.json
git diff --cached --check
git commit -m "feat: deliver confirmed stage goal lock"
git status --short --branch
```

Expected: the branch is clean. Do not push, tag, release, or publish.

---

## Requirement Coverage

| Requirement | Runtime implementation | Deterministic verification | Behavior verification |
| --- | --- | --- | --- |
| REQ-001 explicit confirmed authority | Tasks 2–4 | state-machine initial/exact approval tests | EVAL-001, EVAL-003 |
| REQ-002 aligned/change/ambiguous routing | Task 5 | documentation contract | EVAL-001, EVAL-002, EVAL-004 |
| REQ-003 field diff and exact next-version approval | Tasks 1–4 | contract and state-machine tests | EVAL-002, EVAL-003 |
| REQ-004 fail-closed history/current integrity | Tasks 2–3 | store tamper/chain/legacy tests | EVAL-003 |
| REQ-005 independent narrow product | Tasks 4–7 | CLI/docs surface and deletion review | EVAL-001–004 |

## Out-of-Scope Confirmation

No task in this plan creates or governs plans, progress, paths, test selection, regression selection, validations, evidence, audits, completion, general transaction recovery, Agent adapters, installers, release automation, or `planning-with-files` integration. Tests and evaluation artifacts are development evidence for the Skill; they are not authority inside the delivered goal-lock protocol.
