import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCUMENTS = [
  'AGENTS.md',
  'README.md',
  'SKILL.md',
  'docs/scaffold-usage.md',
  'docs/mature-skill-development-design.md',
  'docs/mature-skill-development-plan.md',
  'references/contract.md',
  'templates/project/README.md.template',
  'templates/project/skill-brief.md.template',
];
const PUBLIC_TEXT = [...DOCUMENTS, 'tests/documentation.test.js'];

function read(relativePath) {
  return readFileSync(path.join(ROOT, ...relativePath.split('/')), 'utf8');
}

function assertInOrder(source, values) {
  let cursor = -1;
  for (const value of values) {
    const next = source.indexOf(value, cursor + 1);
    assert.ok(next > cursor, `缺少或顺序错误: ${value}`);
    cursor = next;
  }
}

function parseSkillFrontmatter(source) {
  const frontmatter = /^---\n([\s\S]*?)\n---\n/u.exec(source);
  assert.notEqual(frontmatter, null, 'SKILL.md must have delimited frontmatter');
  const values = {};
  for (const line of frontmatter[1].split('\n')) {
    const entry = /^([a-z_]+): (.+)$/u.exec(line);
    assert.notEqual(entry, null, `invalid Skill frontmatter line: ${line}`);
    values[entry[1]] = JSON.parse(entry[2]);
  }
  return { body: source.slice(frontmatter[0].length), values };
}

function parseMarkdownTable(source, heading, expectedHeaders) {
  const headingIndex = source.indexOf(`${heading}\n`);
  assert.notEqual(headingIndex, -1, `missing table heading: ${heading}`);
  const lines = source.slice(headingIndex + heading.length + 1).split('\n');
  const tableStart = lines.findIndex((line) => line.startsWith('| '));
  assert.notEqual(tableStart, -1, `missing table after: ${heading}`);
  const endOffset = lines.slice(tableStart).findIndex((line) => !line.startsWith('| '));
  const tableLines = endOffset === -1 ? lines.slice(tableStart) : lines.slice(tableStart, tableStart + endOffset);
  const cells = tableLines
    .filter((line) => line.startsWith('| '))
    .map((line) => line.slice(1, -1).split('|').map((value) => value.trim()));
  assert.deepEqual(cells[0], expectedHeaders, `${heading} headers changed`);
  assert.equal(cells[1].every((value) => /^:?-{3,}:?$/u.test(value)), true, `${heading} separator is invalid`);
  return cells.slice(2).map((row) => Object.fromEntries(expectedHeaders.map((header, index) => [header, row[index]])));
}

// 这里只验证可解析的静态文档契约；Agent 的语义路由结论由 Task 14 的真实行为评测负责。
test('goal version lock skill exposes a discriminating static workflow contract', () => {
  const source = read('SKILL.md');
  const { body, values } = parseSkillFrontmatter(source);
  assert.deepEqual(Object.keys(values).sort(), ['description', 'name']);
  assert.equal(values.name, 'goal-version-lock');
  const stateDescription = JSON.parse(read('.scaffold/state.json')).skill.description;
  const packageDescription = JSON.parse(read('package.json')).description;
  assert.equal(values.description, stateDescription);
  assert.equal(values.description, packageDescription);
  assert.ok([...values.description].length <= 500, 'description exceeds initialized state limit');
  const triggerMatrix = [
    ['lock or freeze a development goal', 'lock, freeze with controlled version changes'],
    ['preserve a development goal against drift', 'preserve, or prevent drift in a development goal'],
    ['resume an existing governed workspace', 'existing .goal-lock/ workspace governs the task'],
    ['ordinary planning near-miss', 'Do not use for ordinary planning'],
    ['personal goal-tracking near-miss', 'personal OKRs'],
    ['configuration-drift near-miss', 'infrastructure configuration drift'],
    ['read-only near-miss', 'read-only questions'],
  ];
  for (const [context, discoveryText] of triggerMatrix) {
    assert.ok(values.description.includes(discoveryText), `frontmatter does not discriminate: ${context}`);
  }
  assert.match(values.description, /approved, versioned goal contract/u);
  assert.match(values.description, /planning, progress, change approval, recovery, and completion gates/u);
  assert.doesNotMatch(body, /^## (?:Triggers|When to use|Trigger boundaries)$/gmu);

  assertInOrder(body, [
    '# Goal Version Lock',
    '## Read runtime details only when needed',
    '## Establish or resume authority',
    '## Verify each work slice',
    '## Classify and route instructions',
    '## Apply exact approvals',
    '## Plan and record progress',
    '## Handle integrity failures',
    '## Audit and gate completion',
    '## Report',
  ]);

  const routes = parseMarkdownTable(body, '## Classify and route instructions', [
    'Classification', 'Semantic test', 'CLI route',
  ]);
  assert.deepEqual(routes.map(({ Classification, 'CLI route': route }) => [Classification, route]), [
    ['aligned', 'Continue; use `plan --classification aligned` only for a plan revision.'],
    ['implementation-choice', 'Use `plan --classification implementation-choice`; keep the goal version.'],
    ['clarification', 'Ask, then verify and reclassify before a governed write.'],
    ['goal-change', 'Use `propose`; pause affected work for exact approval.'],
    ['constraint-change', 'Use `propose`; pause affected work for exact approval.'],
    ['ambiguous', 'Ask; make no governed write until conservative reclassification.'],
    ['conflicting', 'Stop conflicting work; ask whether to propose a goal change.'],
  ]);

  const checkpoints = parseMarkdownTable(body, '## Verify each work slice', ['Checkpoint', 'Required action']);
  assert.deepEqual(checkpoints.map(({ Checkpoint }) => Checkpoint), [
    'Before every work slice',
    'Before applying a new instruction',
    'After context loss',
  ]);
  assert.match(checkpoints[0]['Required action'], /`verify`.*`(?:\.goal-lock\/)?current\.json`.*`(?:\.goal-lock\/)?plan\.json`/u);
  assert.match(checkpoints[1]['Required action'], /`verify`.*re-read.*classify/u);
  assert.match(checkpoints[2]['Required action'], /`verify`.*`lock\.json`.*progress.*`next_task_id`/u);

  const contract = parseGoalLockReference(read('references/contract.md'));
  assert.ok(body.includes(contract.approval.initial));
  assert.ok(body.includes(contract.approval.change));
  assert.match(body, /byte-for-byte and case-sensitive/u);
  assert.match(body, /generic confirmation/u);
  assert.match(body, /stop all goal-governed writes/u);
  assert.match(body, /final semantic diff audit/u);
  assert.match(body, /state is `COMPLETE`/u);

  const documentedCommands = new Set([...body.matchAll(/`(?:node scripts\/goal-lock\.js )?([a-z][a-z-]+)(?:\s[^`]*)?`/gu)]
    .map((match) => match[1])
    .filter((command) => contract.cli.commands.some((entry) => entry.command === command)));
  assert.deepEqual([...documentedCommands].sort(), contract.cli.commands.map(({ command }) => command).sort());
  assert.match(body, /Read \[`references\/contract\.md`\]\(references\/contract\.md\) only when creating, validating, changing, gating, or recovering runtime state\./u);
});

test('planning-with-files stays optional and non-authoritative', () => {
  const source = read('SKILL.md');
  const mapping = parseMarkdownTable(source, '### Optional `planning-with-files` display', [
    'Display field', 'Authoritative source',
  ]);
  assert.deepEqual(mapping, [
    { 'Display field': '`goal_id`', 'Authoritative source': '`.goal-lock/current.json`' },
    { 'Display field': '`goal_version`', 'Authoritative source': '`.goal-lock/lock.json`' },
    { 'Display field': '`goal_digest`', 'Authoritative source': '`.goal-lock/lock.json`' },
  ]);
  assert.match(source, /optional display only; it is not a dependency or authority/u);
  assert.match(source, /cannot replace `current\.json`, `lock\.json`, `plan\.json`, `progress\.jsonl`, or evidence records/u);
});

test('independent README presents a runnable user-guide contract', () => {
  const source = read('README.md');
  assertInOrder(source, [
    '# goal\\-version\\-lock',
    '## Features',
    '## Prerequisites',
    '## Install as a local Skill',
    '## Quick start',
    '## CLI reference',
    '## Core concepts',
    '## Common workflows',
    '## Recovery and tamper troubleshooting',
    '## Optional planning-with-files bridge',
    '## Non-goals',
    '## Documentation',
    '## Contributing',
    '## License',
  ]);
  for (const required of [
    'Node.js 22 or newer',
    '`SKILL.md`',
    '`references/`',
    '`scripts/`',
    '`src/goal-lock/`',
    'no runtime dependencies',
    'Expected output',
    'fictional',
    'goal ID, version, and digest',
    'optional and non-authoritative',
  ]) {
    assert.ok(source.includes(required), `README.md is missing: ${required}`);
  }
  const contract = parseGoalLockReference(read('references/contract.md'));
  const examples = new Set([...source.matchAll(/node scripts\/goal-lock\.js ([a-z][a-z-]+)/gu)].map((match) => match[1]));
  assert.deepEqual([...examples].sort(), contract.cli.commands.map(({ command }) => command).sort());
  assert.doesNotMatch(source, /works on (?:Windows|macOS|Linux)|compatible with (?:Claude|Codex|Cursor)/iu);
});

test('Task 10 文档存在且保持可移植文本格式', () => {
  for (const target of DOCUMENTS) {
    assert.equal(existsSync(path.join(ROOT, ...target.split('/'))), true, `${target} 应存在`);
    const source = read(target);
    assert.equal(source.startsWith('\uFEFF'), false, `${target} 不应包含 BOM`);
    assert.equal(source.includes('\r'), false, `${target} 应使用 LF`);
    assert.equal(source.includes('\0'), false, `${target} 不应包含 NUL`);
    assert.match(source, /[^\n]\n$/u, `${target} 应以单个换行结束`);
  }
});

test('README 按当前 scaffold 模式提供可执行入口', () => {
  const source = read('README.md');
  const pkg = JSON.parse(read('package.json'));
  if (pkg.scaffold.mode === 'initialized') {
    assert.notEqual(source.split('\n')[0], '<!-- skill-development-scaffold:source -->');
    assert.ok(source.includes(`# ${pkg.name.replaceAll('-', '\\-')}`) || source.includes(`# ${pkg.name}`));
    assert.ok(source.includes('npm run check'));
    return;
  }

  assert.equal(pkg.scaffold.mode, 'source');
  assert.equal(source.split('\n')[0], '<!-- skill-development-scaffold:source -->');
  assertInOrder(source, [
    '## 用途',
    '## 使用 GitHub Template',
    '## 直接克隆',
    '## 前置条件',
    '## 初始化',
    '### Dry run',
    '## 生成文件',
    '## 验证与交付门禁',
    '## 事务与恢复',
    '## 仓库结构',
    '## 贡献',
    '## 安全',
    '## 许可证',
  ]);
  for (const value of [
    'Node.js 22',
    'npm run init:skill -- --name',
    '--description',
    '--dry-run',
    'npm run check',
    'npm run gate:delivery',
    'origin',
    'git remote set-url origin',
    '不会执行 `git reset`',
  ]) {
    assert.match(source, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  }
});

test('AGENTS 采用用户优先型并固定开发与授权边界', () => {
  const source = read('AGENTS.md');
  for (const value of [
    '.scaffold/state.json',
    '维护脚手架本身时不要初始化',
    'initialized',
    'docs/mature-skill-development-design.md',
    'docs/mature-skill-development-plan.md',
    'docs/skill-brief.md',
    '最新用户要求优先',
    'enabled',
    'disabled',
    'blocked',
    'TDD',
    '行为评测',
    '需求变更',
    'npm run check',
    'npm run gate:delivery',
    '完整 diff',
    '付费',
    '破坏性',
    '发布',
    '明确授权',
  ]) {
    assert.ok(source.includes(value), `AGENTS.md 缺少约束: ${value}`);
  }
});

test('使用指南完整说明 CLI、状态、事务、许可证、发布白名单和升级', () => {
  const source = read('docs/scaffold-usage.md');
  for (const value of [
    '--name',
    '--description',
    '--license',
    '--dry-run',
    '--help',
    '.scaffold/state.json',
    'source',
    'initialized',
    '.scaffold-init.lock',
    'npm run recover:lock',
    '陈旧锁',
    '人工',
    'Apache-2.0',
    'MIT',
    'UNLICENSED',
    '不提供 reset 或 uninstall 命令',
    '静止工作树',
    '非协作写入',
    'package.json',
    'files',
    '升级',
    'artifact:path#sha256',
    'path:',
    'eval:',
    'eval:EVAL-001,EVAL-002',
    'required:<work>;impact:<delivery-impact>',
    'enabled',
    'disabled',
    'blocked',
    'Gate 不证明模型真实运行',
  ]) {
    assert.ok(source.includes(value), `使用指南缺少: ${value}`);
  }
});

test('设计、计划与初始化模板共享用户优先和证据引用契约', () => {
  const sources = [
    read('docs/mature-skill-development-design.md'),
    read('docs/mature-skill-development-plan.md'),
    read('templates/project/README.md.template'),
    read('templates/project/skill-brief.md.template'),
  ];
  for (const source of sources) {
    assert.ok(source.includes('artifact:path#sha256'));
    assert.ok(source.includes('path:'));
    assert.ok(source.includes('eval:'));
  }
  assert.match(sources[0], /最新用户要求.*优先/u);
  assert.match(sources[1], /需求变更/u);
  assert.match(sources[2], /npm run check/u);
  assert.match(sources[3], /acceptance_criteria/u);
});

test('公开文本不泄露私有绝对路径', () => {
  const neutralPaths = [
    ['C:', 'Users', 'tester'].join('/'),
    ['C:', 'Users', 'tester'].join('\\'),
    ['', 'Users', 'tester'].join('/'),
    ['', 'home', 'tester'].join('/'),
  ];
  for (const target of PUBLIC_TEXT) {
    let source = read(target);
    for (const neutralPath of neutralPaths) {
      source = source.replaceAll(neutralPath, '$HOME');
    }
    assert.doesNotMatch(source, /[A-Z]:[\\/]/u, target);
    assert.doesNotMatch(source, /\/(?:Users|home)\/[^\s)`"']+/u, target);
  }
});

test('文档中的 npm run 命令均有实际脚本入口', () => {
  const scripts = JSON.parse(read('package.json')).scripts;
  for (const target of DOCUMENTS) {
    const source = read(target);
    for (const match of source.matchAll(/npm run ([a-z][a-z0-9:-]*)/gu)) {
      assert.equal(typeof scripts[match[1]], 'string', `${target} 引用了不存在的脚本: ${match[1]}`);
    }
  }
});

test('Markdown 内部链接指向存在的仓库文件', () => {
  for (const target of DOCUMENTS.filter((file) => file.endsWith('.md'))) {
    const source = read(target);
    for (const match of source.matchAll(/\[[^\]]+\]\((?!https?:|mailto:|#)([^)#]+)(?:#[^)]+)?\)/gu)) {
      const linked = decodeURIComponent(match[1]);
      const absolute = path.resolve(path.dirname(path.join(ROOT, target)), linked);
      assert.equal(existsSync(absolute), true, `${target} 的链接不存在: ${linked}`);
    }
  }
});

function parseReferenceFrontmatter(source) {
  const frontmatter = /^---\n([\s\S]*?)\n---\n/u.exec(source);
  assert.notEqual(frontmatter, null, 'reference must have delimited frontmatter');
  const values = {};
  for (const line of frontmatter[1].split('\n')) {
    const entry = /^([a-z_]+): (.+)$/u.exec(line);
    assert.notEqual(entry, null, `invalid frontmatter line: ${line}`);
    values[entry[1]] = JSON.parse(entry[2]);
  }
  return values;
}

function parseGoalLockReference(source) {
  const marker = '<!-- goal-lock-reference-contract:v1 -->';
  const start = source.indexOf(`${marker}\n\`\`\`json\n`);
  assert.notEqual(start, -1, 'reference contract JSON block is missing');
  const jsonStart = start + `${marker}\n\`\`\`json\n`.length;
  const jsonEnd = source.indexOf('\n\`\`\`', jsonStart);
  assert.notEqual(jsonEnd, -1, 'reference contract JSON block is not closed');
  return JSON.parse(source.slice(jsonStart, jsonEnd));
}

test('goal lock reference defines every persisted artifact', () => {
  const target = 'references/contract.md';
  const source = read(target);
  assert.deepEqual(parseReferenceFrontmatter(source), {
    title: 'Goal Version Lock Contract',
    version: '1',
  });
  for (const match of source.matchAll(/\[[^\]]+\]\((?!https?:|mailto:|#)([^)#]+)(?:#[^)]+)?\)/gu)) {
    const linked = decodeURIComponent(match[1]);
    const absolute = path.resolve(path.dirname(path.join(ROOT, target)), linked);
    assert.equal(existsSync(absolute), true, `${target} 的链接不存在: ${linked}`);
  }

  const contract = parseGoalLockReference(source);
  assert.equal(contract.schema_version, 1);
  assert.deepEqual(contract.identifiers, {
    goal_id: '^GL-[A-Z0-9][A-Z0-9-]*$',
    acceptance_criterion_id: '^AC-[0-9]{3}$',
    task_id: '^TASK-[0-9]{4}$',
    change_request_id: '^CR-[0-9]{4}$',
    event_id: '^EVT-[0-9]{6}$',
    evidence_id: '^EVID-[0-9]{4}$',
  });
  assert.equal(contract.timestamp_format, 'RFC 3339 UTC with a Z suffix');
  assert.deepEqual(contract.canonicalization, {
    encoding: 'UTF-8',
    object_keys: 'recursively sorted by JavaScript ordinal string comparison',
    arrays: 'preserve input order',
    document_terminator: 'exactly one LF',
    json: 'compact JSON; reject non-finite numbers, unsafe integers, undefined, functions, symbols, sparse arrays, non-plain objects, and cycles',
    digest: 'SHA-256 of the exact canonical bytes as 64 lowercase hexadecimal characters',
  });
  assert.deepEqual(contract.safe_relative_paths, {
    separator: '/',
    reject: ['absolute paths', 'drive paths', 'UNC paths', 'backslashes', 'NUL', 'empty segments', '.', '..'],
    delivery_artifacts_reject_prefix: '.goal-lock/',
  });
  assert.deepEqual(Object.keys(contract.artifacts).sort(), [
    '.write-lock.json',
    'changes/CR-0001.json',
    'current.json',
    'evidence/AC-001/EVID-0001.json',
    'history/goals/v0001.json',
    'history/plans/v0001-r0001.json',
    'lock.json',
    'plan.json',
    'progress.jsonl',
  ]);
  assert.deepEqual(contract.artifacts['.write-lock.json'].required_fields, [
    'protocol', 'token', 'pid', 'command', 'created_at',
  ]);
  assert.deepEqual(contract.artifacts['current.json'].required_fields, [
    'schema_version', 'goal_id', 'goal_version', 'objective', 'scope', 'non_goals', 'constraints',
    'acceptance_criteria', 'authorization_boundary', 'assumptions', 'predecessor', 'accepted_change_id',
  ]);
  assert.deepEqual(contract.artifacts['lock.json'].required_fields, [
    'schema_version', 'goal_id', 'goal_version', 'goal_digest', 'approval_type', 'proposal_digest',
    'approved_at', 'predecessor_digest', 'state_revision', 'progress_head', 'change_head',
    'evidence_heads', 'record_digest',
  ]);
  assert.deepEqual(contract.artifacts['plan.json'].required_fields, [
    'schema_version', 'goal', 'plan_revision', 'next_task_id', 'tasks', 'deferred',
  ]);
  assert.deepEqual(contract.artifacts['progress.jsonl'].required_fields, [
    'schema_version', 'event_id', 'recorded_at', 'goal', 'plan_revision', 'task_id', 'event_type',
    'summary', 'evidence_refs', 'previous_event_digest', 'event_digest',
  ]);
  assert.deepEqual(contract.artifacts['changes/CR-0001.json'].required_fields, [
    'schema_version', 'id', 'status', 'base_goal', 'candidate_goal', 'candidate_digest',
    'proposal_digest', 'changes', 'rationale', 'affected_tasks', 'affected_criteria', 'risks',
    'validation', 'rollback', 'approval_phrase', 'recorded_at',
  ]);
  assert.deepEqual(contract.artifacts['evidence/AC-001/EVID-0001.json'].required_fields, [
    'schema_version', 'evidence_id', 'acceptance_criterion_id', 'goal', 'plan_revision', 'task_id',
    'method', 'observed_result', 'artifact_refs', 'workspace_fingerprint', 'state', 'supersedes', 'recorded_at',
  ]);
  assert.deepEqual(contract.enums, {
    task_status: ['pending', 'in_progress', 'blocked', 'complete', 'stale'],
    change_status: ['proposed', 'approved', 'rejected', 'superseded'],
    evidence_state: ['pass', 'fail', 'stale'],
    event_type: ['task-start', 'task-complete', 'plan-revision', 'blocker', 'verification-result', 'goal-change', 'evidence-invalidation', 'recovery', 'final-audit'],
    request_classification: ['aligned', 'implementation-choice', 'clarification', 'goal-change', 'constraint-change', 'ambiguous', 'conflicting'],
  });
  assert.deepEqual(contract.approval, {
    initial: 'APPROVE GOAL {goal_id} VERSION 1 {first-12-goal-digest}',
    change: 'APPROVE {cr_id} GOAL VERSION {candidate-version} {first-12-proposal-digest}',
    matching: 'byte-for-byte and case-sensitive',
    generic_confirmation: 'rejected with exit code 5',
  });
  assert.deepEqual(contract.digest_rules, {
    current_history: 'current.json and history/goals/vNNNN.json have byte-for-byte identical canonical bytes',
    lock_record: 'record_digest hashes every lock.json field except record_digest',
    lock_heads: 'state_revision and every head update atomically with each accepted state change',
    progress: 'event_digest hashes the canonical event payload without event_digest; previous_event_digest links the preceding event',
    evidence: 'a newer immutable record names the immediately preceding evidence ID in supersedes; stale records supersede affected current evidence',
  });
  assert.deepEqual(contract.fingerprints, {
    git: 'canonical manifest of HEAD identity, tracked diff bytes, and sorted non-ignored untracked delivery names, modes, sizes, and bytes; exclude .git/ and .goal-lock/',
    inventory: 'canonical manifest of the explicit repository-relative artifact inventory names and bytes',
    completion: 'a final semantic audit event and the gate use the exact active workspace fingerprint',
  });
  assert.deepEqual(contract.cli.exit_codes, {
    0: 'success or read-only help',
    2: 'usage or input error',
    3: 'invalid state transition',
    4: 'integrity, tamper, or unsafe-path failure',
    5: 'approval phrase or stale-approval failure',
    6: 'I/O, Git, or rollback/recovery failure',
  });
  assert.deepEqual(contract.cli.commands, [
    { command: 'init', input: 'draft.json or -' },
    { command: 'lock', approval: 'required' },
    { command: 'verify' },
    { command: 'plan', input: 'plan.json or -', classification: ['aligned', 'implementation-choice'] },
    { command: 'propose', input: 'change-proposal.json or -' },
    { command: 'approve', cr: 'CR-0001', approval: 'required' },
    { command: 'reject', cr: 'CR-0001', reason: 'required' },
    { command: 'record', input: 'progress-input.json or -' },
    { command: 'gate', inventory: 'optional inventory.json' },
    { command: 'recover-lock', owner_token: 'required', lock_digest: 'required' },
  ]);
});

test('goal lock reference input schemas match the public CLI boundary', () => {
  const contract = parseGoalLockReference(read('references/contract.md'));
  assert.deepEqual(contract.inputs, {
    initial_goal: {
      command: 'init',
      fields: ['schema_version', 'goal_id', 'goal_version', 'objective', 'scope', 'non_goals', 'constraints', 'acceptance_criteria', 'authorization_boundary', 'assumptions', 'predecessor', 'accepted_change_id'],
      fixed: { schema_version: 1, goal_version: 1, predecessor: null, accepted_change_id: null },
    },
    plan_candidate: {
      command: 'plan',
      fields: ['next_task_id', 'tasks', 'deferred'],
      derived: ['schema_version', 'goal', 'plan_revision'],
    },
    change_proposal: {
      command: 'propose',
      fields: ['candidate', 'changes', 'rationale', 'affected_tasks', 'affected_criteria', 'risks', 'validation', 'rollback'],
      candidate_fields: ['objective', 'scope', 'non_goals', 'constraints', 'acceptance_criteria', 'authorization_boundary', 'assumptions'],
    },
    progress: {
      command: 'record',
      fields: ['kind', 'event_type', 'task_id', 'summary', 'evidence_refs'],
      fixed: { kind: 'progress' },
    },
    evidence: {
      command: 'record',
      fields: ['kind', 'acceptance_criterion_id', 'task_id', 'method', 'observed_result', 'artifact_refs', 'workspace_fingerprint', 'state', 'supersedes'],
      fixed: { kind: 'evidence' },
    },
    final_audit: {
      command: 'record',
      fields: ['kind', 'semantic_summary', 'inventory'],
      fixed: { kind: 'final-audit' },
    },
    inventory: {
      commands: ['gate', 'record final-audit'],
      shape: 'sorted non-empty array of unique safe delivery-file paths; required only outside Git',
    },
  });
});

test('initial behavior matrix contains positive negative and boundary cases', () => {
  const evals = JSON.parse(read('evals/evals.json'));
  assert.deepEqual(evals, {
    schema_version: 1,
    skill: 'goal-version-lock',
    evals: [
      {
        id: 'EVAL-001',
        category: 'positive',
        prompt: 'Lock this multi-step development objective before implementation, and keep its plan and progress records locally so the work cannot drift.',
        assertions: [
          { id: 'ASSERT-001', text: 'Creates a local draft goal contract and requests the exact version-1 approval phrase before locking it.' },
        ],
        result: { status: 'not-run', evidence: '' },
      },
      {
        id: 'EVAL-002',
        category: 'negative',
        prompt: 'Give me a short implementation plan for adding a settings toggle; I only need the usual steps and tests.',
        assertions: [
          { id: 'ASSERT-002', text: 'Provides ordinary planning guidance and does not create a .goal-lock/ workspace.' },
        ],
        result: { status: 'not-run', evidence: '' },
      },
      {
        id: 'EVAL-003',
        category: 'boundary',
        prompt: 'Mid-task, change acceptance criterion AC-001 to require an additional export format. After the proposal is shown, I reply: 确认.',
        assertions: [
          { id: 'ASSERT-003', text: 'Creates a change request with field-level impact and pauses affected work.' },
          { id: 'ASSERT-004', text: 'Refuses the generic confirmation and keeps the active goal version unchanged.' },
        ],
        result: { status: 'not-run', evidence: '' },
      },
    ],
  });
});
