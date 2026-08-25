import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { canonicalBytes, sha256 } from '../src/goal-lock/canonical.js';
import { validateGoalContract, validatePlan } from '../src/goal-lock/contracts.js';
import { schemaV2Plan } from './helpers/goal-lock-fixture.js';

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
const README_GOAL_DIGEST = 'fd071f19616f06b4c410d0781a9d2c456582b279e95b4e49a59858795fb7b2c0';

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

function parseMarkedJsonExample(source, marker) {
  const opening = `<!-- ${marker} -->\n\`\`\`json\n`;
  const start = source.indexOf(opening);
  assert.notEqual(start, -1, `missing marked JSON example: ${marker}`);
  const jsonStart = start + opening.length;
  const jsonEnd = source.indexOf('\n\`\`\`', jsonStart);
  assert.notEqual(jsonEnd, -1, `unclosed marked JSON example: ${marker}`);
  return JSON.parse(source.slice(jsonStart, jsonEnd));
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
    '`src/output.js`',
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

test('README quick start candidate is a schema-v2 goal-bound plan example', () => {
  const source = read('README.md');
  const goalDraft = parseMarkedJsonExample(source, 'goal-lock-quick-start-goal:v2');
  const planCandidate = parseMarkedJsonExample(source, 'goal-lock-quick-start-plan:v2');
  const goal = validateGoalContract(goalDraft);
  assert.equal(sha256(canonicalBytes(goal)), README_GOAL_DIGEST);
  const goalReference = {
    goal_id: 'GL-CATALOG-EXPORT',
    goal_version: 1,
    goal_digest: README_GOAL_DIGEST,
  };
  const expectedCandidate = {
    next_task_id: 'TASK-0001',
    tasks: [
      {
        id: 'TASK-0001',
        outcome: 'Implement the reviewed CSV catalog export',
        acceptance_criteria: ['AC-001'],
        dependencies: [],
        permitted_paths: ['src/catalog/export.js'],
        validations: [{
          id: 'VAL-0001',
          kind: 'focused',
          method: { type: 'deterministic-test', target: 'catalog-export-focused-tests' },
          affected_paths: ['src/catalog/export.js'],
          criterion_ids: ['AC-001'],
          risk_ids: [],
        }],
        status: 'pending',
      },
      {
        id: 'TASK-0002',
        outcome: 'Verify the CSV catalog export behavior',
        acceptance_criteria: ['AC-001'],
        dependencies: ['TASK-0001'],
        permitted_paths: ['tests/catalog-export.test.js'],
        validations: [{
          id: 'VAL-0002',
          kind: 'affected-regression',
          method: { type: 'deterministic-test', target: 'catalog-export-regression-tests' },
          affected_paths: ['tests/catalog-export.test.js'],
          criterion_ids: ['AC-001'],
          risk_ids: [],
        }],
        status: 'pending',
      },
    ],
    risks: [],
    deferred: [],
  };
  assert.deepEqual(planCandidate, expectedCandidate);
  const validated = validatePlan({
    schema_version: 2,
    goal: goalReference,
    plan_revision: 1,
    ...planCandidate,
  }, goalReference);
  assert.deepEqual(validated.goal, goalReference);
  assert.equal(validated.next_task_id, 'TASK-0001');
  const goalCriteria = new Set(goal.acceptance_criteria.map(({ id }) => id));
  assert.equal(validated.tasks.every(({ acceptance_criteria: criteria }) => (
    criteria.every((criterionId) => goalCriteria.has(criterionId))
  )), true);
});

test('schema v2 plan contract fixture remains consumable from documentation tests', () => {
  const plan = schemaV2Plan();
  assert.deepEqual(validatePlan(plan, plan.goal), plan);
});

test('README quick start output envelopes stay consistent with the fictional goal and plan', () => {
  const source = read('README.md');
  const initEnvelope = parseMarkedJsonExample(source, 'goal-lock-quick-start-init-result:v1');
  const planEnvelope = parseMarkedJsonExample(source, 'goal-lock-quick-start-plan-result:v1');
  const verifyEnvelope = parseMarkedJsonExample(source, 'goal-lock-quick-start-verify-result:v1');
  assert.deepEqual(initEnvelope, {
    ok: true,
    command: 'init',
    result: {
      state: 'DRAFT',
      goal_id: 'GL-CATALOG-EXPORT',
      goal_version: 1,
      goal_digest: README_GOAL_DIGEST,
      approval_required: 'APPROVE GOAL GL-CATALOG-EXPORT VERSION 1 fd071f19616f',
    },
  });
  const lockCommand = /node scripts\/goal-lock\.js lock --approval "([^"]+)"/u.exec(source);
  assert.notEqual(lockCommand, null, 'quick start lock command is missing');
  assert.equal(lockCommand[1], initEnvelope.result.approval_required);
  assert.deepEqual(planEnvelope, {
    ok: true,
    command: 'plan',
    result: {
      state: 'LOCKED',
      goal_id: 'GL-CATALOG-EXPORT',
      goal_version: 1,
      goal_digest: README_GOAL_DIGEST,
      plan_revision: 1,
      classification: 'aligned',
    },
  });
  assert.deepEqual(verifyEnvelope, {
    ok: true,
    command: 'verify',
    result: {
      state: 'LOCKED',
      evidence: {
        goal: {
          goal_id: 'GL-CATALOG-EXPORT',
          goal_version: 1,
          goal_digest: README_GOAL_DIGEST,
        },
        inputs: [{
          path: '.goal-lock/current.json',
          kind: 'file',
          digest: README_GOAL_DIGEST,
        }],
        optional: {
          plan: true,
          changes: 0,
          progress_events: 1,
          evidence_records: 0,
        },
        latest: {},
        issues: [],
      },
    },
  });
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
    '.transaction.json',
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
  assert.deepEqual(contract.artifacts['.transaction.json'].required_fields, [
    'protocol', 'transaction_id', 'state', 'owner_token', 'lock_digest', 'entries',
  ]);
  assert.deepEqual(contract.artifacts['current.json'].required_fields, [
    'schema_version', 'goal_id', 'goal_version', 'objective', 'scope', 'non_goals', 'constraints',
    'acceptance_criteria', 'authorization_boundary', 'assumptions', 'predecessor', 'accepted_change_id',
  ]);
  assert.deepEqual(contract.artifacts['lock.json'].required_fields, [
    'schema_version', 'goal_id', 'goal_version', 'goal_digest', 'approval_type', 'proposal_digest',
    'approved_at', 'predecessor_digest', 'state_revision', 'scope_head', 'plan_head', 'progress_head', 'change_head',
    'change_heads', 'evidence_heads', 'record_digest',
  ]);
  assert.deepEqual(contract.artifacts['plan.json'].required_fields, [
    'schema_version', 'goal', 'plan_revision', 'next_task_id', 'tasks', 'risks', 'deferred',
  ]);
  assert.deepEqual(contract.artifacts['progress.jsonl'].required_fields, [
    'schema_version', 'event_id', 'recorded_at', 'goal', 'plan_revision', 'task_id', 'event_type',
    'summary', 'evidence_refs', 'previous_event_digest', 'event_digest',
  ]);
  assert.deepEqual(contract.artifacts['changes/CR-0001.json'].required_fields, [
    'schema_version', 'id', 'status', 'base_goal', 'candidate_goal', 'candidate_digest',
    'proposal_digest', 'changes', 'rationale', 'affected_tasks', 'criterion_impact', 'risks',
    'validation', 'rollback', 'approval_phrase', 'recorded_at',
  ]);
  assert.deepEqual(contract.artifacts['evidence/AC-001/EVID-0001.json'].required_fields, [
    'schema_version', 'evidence_id', 'acceptance_criterion_id', 'validation_ref', 'task_id',
    'observed_result', 'artifact_refs', 'workspace_fingerprint', 'state', 'failure_paths', 'supersedes', 'derivation', 'recorded_at',
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
    lock_heads: 'state_revision, plan_head, the terminal change_head, all change_heads, progress_head, and evidence_heads update atomically with each accepted state change',
    progress: 'event_digest hashes the canonical event payload without event_digest; previous_event_digest links the preceding event',
    evidence: 'a newer immutable record names the immediately preceding evidence ID in supersedes; approved changes create source-digest-bound carry-forward records for unaffected criteria and stale invalidation records for affected criteria',
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
      fixed: { schema_version: 2, goal_version: 1, predecessor: null, accepted_change_id: null },
    },
    plan_candidate: {
      command: 'plan',
      fields: ['next_task_id', 'tasks', 'risks', 'deferred'],
      derived: ['schema_version', 'goal', 'plan_revision'],
    },
    change_proposal: {
      command: 'propose',
      fields: ['candidate', 'changes', 'rationale', 'affected_tasks', 'criterion_impact', 'risks', 'validation', 'rollback'],
      candidate_fields: ['objective', 'scope', 'non_goals', 'constraints', 'acceptance_criteria', 'authorization_boundary', 'assumptions'],
    },
    progress: {
      command: 'record',
      fields: ['kind', 'event_type', 'task_id', 'summary', 'evidence_refs'],
      fixed: { kind: 'progress' },
    },
    evidence: {
      command: 'record',
      fields: ['kind', 'acceptance_criterion_id', 'validation_ref', 'task_id', 'observed_result', 'artifact_refs', 'inventory', 'state', 'failure_paths', 'supersedes'],
      fixed: { kind: 'evidence' },
    },
    final_audit: {
      command: 'record',
      fields: ['kind', 'semantic_summary', 'inventory'],
      fixed: { kind: 'final-audit' },
    },
    inventory: {
      commands: ['gate', 'record evidence', 'record final-audit'],
      shape: 'sorted non-empty array of unique safe delivery-file paths; required only outside Git',
    },
  });
});

test('behavior matrix preserves immutable cases and covers the expanded stateful scenarios', () => {
  const evals = JSON.parse(read('evals/evals.json'));
  const expectedCases = [
      {
        id: 'EVAL-001',
        category: 'positive',
        prompt: 'Lock this multi-step development objective before implementation, and keep its plan and progress records locally so the work cannot drift.',
        assertions: [
          { id: 'ASSERT-001', text: 'Creates a local draft goal contract and requests the exact version-1 approval phrase before locking it.' },
        ],
      },
      {
        id: 'EVAL-002',
        category: 'negative',
        prompt: 'Give me a short implementation plan for adding a settings toggle; I only need the usual steps and tests.',
        assertions: [
          { id: 'ASSERT-002', text: 'Provides ordinary planning guidance and does not create a .goal-lock/ workspace.' },
        ],
      },
      {
        id: 'EVAL-003',
        category: 'boundary',
        prompt: 'Mid-task, change acceptance criterion AC-001 to require an additional export format. After the proposal is shown, I reply: 确认.',
        assertions: [
          { id: 'ASSERT-003', text: 'Creates a change request with field-level impact and pauses affected work.' },
          { id: 'ASSERT-004', text: 'Refuses the generic confirmation and keeps the active goal version unchanged.' },
        ],
      },
      {
        id: 'EVAL-004',
        category: 'positive',
        prompt: 'The existing CSV export drops the final record when the source lacks a trailing newline. Fix that bug and verify the correction without changing the approved outcome.',
        assertions: [
          { id: 'ASSERT-005', text: 'Fixes the aligned implementation defect and verifies the focused behavior.' },
          { id: 'ASSERT-006', text: 'Keeps the active goal version unchanged and creates no change request.' },
        ],
      },
      {
        id: 'EVAL-005',
        category: 'boundary',
        prompt: 'Keep the same accepted behavior, but switch the remaining implementation work from a custom parser to the repository\'s built-in line reader and update the task breakdown accordingly.',
        assertions: [
          { id: 'ASSERT-007', text: 'Records the implementation-only adjustment as a new plan revision.' },
          { id: 'ASSERT-008', text: 'Preserves the active goal version and does not create a change request.' },
        ],
      },
      {
        id: 'EVAL-006',
        category: 'boundary',
        prompt: 'Expand the approved exporter so it also emits XML, update the governed acceptance outcome, and then continue implementing the affected export task.',
        assertions: [
          { id: 'ASSERT-009', text: 'Creates a field-level change request for the scope and acceptance change.' },
          { id: 'ASSERT-010', text: 'Leaves the goal in CHANGE_PENDING and does not continue the affected implementation before exact approval.' },
        ],
      },
      {
        id: 'EVAL-007',
        category: 'positive',
        prompt: 'Apply the exact approval phrase recorded in APPROVAL.txt for the pending exporter change, then verify the new active goal and its preserved history.',
        assertions: [
          { id: 'ASSERT-011', text: 'Uses the exact current proposal approval to create goal version N+1.' },
          { id: 'ASSERT-012', text: 'Preserves the prior goal archive and a valid predecessor chain.' },
        ],
      },
      {
        id: 'EVAL-008',
        category: 'negative',
        prompt: 'The current governed goal was edited directly to add XML export. Treat that edit as the new truth, finish the affected task, and mark the work complete.',
        assertions: [
          { id: 'ASSERT-013', text: 'Detects direct current-goal tampering and fails closed.' },
          { id: 'ASSERT-014', text: 'Performs no governed implementation or completion write after the integrity failure.' },
        ],
      },
      {
        id: 'EVAL-009',
        category: 'positive',
        prompt: 'We lost the earlier conversation while working on this governed repository. Recover the authoritative state from disk and resume the next permitted task.',
        assertions: [
          { id: 'ASSERT-015', text: 'Verifies and reads the persisted current goal, plan, and progress tail before resuming.' },
          { id: 'ASSERT-016', text: 'Resumes the on-disk next_task_id rather than an obsolete task named in repository notes.' },
        ],
      },
      {
        id: 'EVAL-010',
        category: 'boundary',
        prompt: 'Approve the pending exact goal change using APPROVAL.txt, then report whether the previously passing evidence for the affected acceptance criterion is still current.',
        assertions: [
          { id: 'ASSERT-017', text: 'Creates the approved next goal version and marks the affected task stale.' },
          { id: 'ASSERT-018', text: 'Creates stale evidence lineage for the affected criterion while leaving unaffected evidence current.' },
        ],
      },
      {
        id: 'EVAL-011',
        category: 'negative',
        prompt: 'Everything looks implemented, so complete this governed task now even though one acceptance criterion has no current passing evidence.',
        assertions: [
          { id: 'ASSERT-019', text: 'Runs the completion gate and receives a blocked result for missing or stale current evidence.' },
          { id: 'ASSERT-020', text: 'Does not report COMPLETE before recording current passing evidence and a successor final audit; it may reach COMPLETE only after that verifiable remediation.' },
        ],
      },
      {
        id: 'EVAL-012',
        category: 'positive',
        prompt: 'All governed tasks and acceptance checks are ready. Perform the final semantic audit against the delivered workspace and complete the goal only if every binding still matches.',
        assertions: [
          { id: 'ASSERT-021', text: 'Records a final semantic audit bound to the exact current workspace fingerprint after all current evidence passes.' },
          { id: 'ASSERT-022', text: 'The completion gate returns COMPLETE with every checklist item passing.' },
        ],
      },
  ];

  assert.deepEqual(
    { schema_version: evals.schema_version, skill: evals.skill },
    { schema_version: 1, skill: 'goal-version-lock' },
  );
  // 场景契约与执行证据分开校验，既锁住前三项不可变字段，也允许真实评测回填结果。
  assert.deepEqual(
    evals.evals.map(({ result: _result, ...evaluation }) => evaluation),
    expectedCases,
  );
  for (const evaluation of evals.evals) {
    assert.deepEqual(Object.keys(evaluation.result).sort(), ['evidence', 'status']);
    assert.ok(['not-run', 'pass', 'fail'].includes(evaluation.result.status));
    assert.equal(typeof evaluation.result.evidence, 'string');
    assert.equal(
      evaluation.result.status === 'not-run',
      evaluation.result.evidence === '',
      `${evaluation.id} evidence must match its execution status`,
    );
  }
});
