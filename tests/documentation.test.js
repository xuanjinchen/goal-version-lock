import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { formatGoalLockHelp } from '../src/goal-lock/cli.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(relativePath) {
  return readFileSync(path.join(ROOT, ...relativePath.split('/')), 'utf8');
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
