import assert from 'node:assert/strict';
import test from 'node:test';
import {
  appendTrimmedActivityTurn,
  dedupeActivityTurns,
  summarizeToolInput,
  summarizeToolOutput,
} from '../agents/utils/_activity.ts';
import type { PersistedActivityTurn } from '../agents/_types.ts';

test('tool summaries redact secrets and project paths', () => {
  const summary = summarizeToolInput('mcp__edgeone__commands', {
    command: 'curl -H "Authorization: Bearer top-secret" /tmp/project/api?token=abc',
    apiKey: 'secret-key',
  }, '/tmp/project');

  assert.doesNotMatch(summary, /top-secret|secret-key|token=abc/);
  assert.match(summary, /\[REDACTED\]/);
  assert.match(summary, /<project>/);
});

test('activity history collapses immediate retry duplicates', () => {
  const base: PersistedActivityTurn = {
    id: 'first',
    user: 'stop this',
    assistant: 'stopped',
    status: 'stopped',
    createdAt: 100,
    activities: [],
  };
  const deduped = dedupeActivityTurns([
    base,
    { ...base, id: 'retry', createdAt: 200, activities: [{ kind: 'text', content: 'partial' }] },
  ]);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].id, 'retry');
});

test('file writes expose paths and sizes without source contents', () => {
  const summary = summarizeToolInput('write_project_file', {
    path: 'src/app.tsx',
    content: 'const privateValue = 42;',
  });

  assert.match(summary, /src\/app\.tsx/);
  assert.match(summary, /24 chars/);
  assert.doesNotMatch(summary, /privateValue/);
});

test('a streamed single-file call stays blank until its path arrives', () => {
  assert.equal(summarizeToolInput('write_project_file', {}), '');
});

test('directory tools summarize as a path, not JSON', () => {
  assert.equal(summarizeToolInput('mcp__edgeone-sandbox__files_make_dir', { path: 'src/lib' }), 'src/lib');
});

test('tool output is capped at two kilobytes', () => {
  const summary = summarizeToolOutput('x'.repeat(3_000));
  assert.ok(summary.length <= 2_000);
  assert.doesNotMatch(summary, /truncated/i);
});

test('command output keeps the tail and collapses npm http fetch noise', () => {
  const lines = [
    'npm info using npm@10.8.2',
    ...Array.from({ length: 40 }, (_, index) => (
      `npm http fetch GET 200 https://registry.npmjs.org/pkg-${index} ${index}ms`
    )),
    'added 120 packages in 3s',
  ];
  const summary = summarizeToolOutput(lines.join('\n'), '', 'commands');

  assert.doesNotMatch(summary, /truncated/i);
  assert.doesNotMatch(summary, /registry\.npmjs\.org/);
  assert.match(summary, /npm http fetch ×40/);
  assert.match(summary, /added 120 packages/);
});

test('activity trim keeps timing logs when the item cap is exceeded', () => {
  const activities = [
    { kind: 'log' as const, message: '[timing] task_start duration_ms=12 since_turn_ms=12', startedAt: 1, endedAt: 13 },
    { kind: 'log' as const, message: '[timing] first_visible duration_ms=800 since_turn_ms=800 via=narration', startedAt: 1, endedAt: 801 },
    ...Array.from({ length: 8 }, (_, index) => ({
      kind: 'text' as const,
      content: `step-${index}`,
    })),
  ];
  const next = appendTrimmedActivityTurn(
    [],
    {
      id: 'turn',
      user: 'hi',
      assistant: 'ok',
      status: 'completed',
      createdAt: 1,
      activities,
    },
    25,
    4,
  );
  assert.equal(next[0].activities.length, 4);
  assert.equal(next[0].activities.filter((item) => item.kind === 'log').length, 2);
  assert.equal(next[0].activities.filter((item) => item.kind === 'text').length, 2);
});

test('activity history replaces duplicate turns and applies both caps', () => {
  const makeTurn = (id: string, count = 1): PersistedActivityTurn => ({
    id,
    user: id,
    assistant: id,
    status: 'completed',
    createdAt: 1,
    activities: Array.from({ length: count }, (_, index) => ({
      kind: 'text' as const,
      content: `${id}-${index}`,
    })),
  });
  const current = [makeTurn('one'), makeTurn('two')];
  const next = appendTrimmedActivityTurn(current, makeTurn('two', 4), 2, 3);

  assert.deepEqual(next.map((turn) => turn.id), ['one', 'two']);
  assert.equal(next[1].activities.length, 3);
  assert.equal(next[1].activities[0].kind === 'text' && next[1].activities[0].content, 'two-1');
});
