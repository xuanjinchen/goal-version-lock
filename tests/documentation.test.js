import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOCUMENTS = [
  'AGENTS.md',
  'README.md',
  'docs/scaffold-usage.md',
  'docs/mature-skill-development-design.md',
  'docs/mature-skill-development-plan.md',
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
