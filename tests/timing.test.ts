import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createTurnTimer,
  formatTimingLog,
  isTimingLog,
  parseTimingLog,
} from '../agents/utils/_timing.ts';

test('formatTimingLog is parseable and skips empty fields', () => {
  const line = formatTimingLog({
    stage: 'workspace_restore',
    startedAt: 1_000,
    endedAt: 5_521,
    duration_ms: 4_521,
    since_turn_ms: 2_103,
    fields: {
      restored: true,
      installed: false,
      restore_ms: 800,
      note: undefined,
    },
  });
  assert.equal(
    line,
    '[timing] workspace_restore duration_ms=4521 since_turn_ms=2103 restored=true installed=false restore_ms=800',
  );
  assert.equal(isTimingLog(line), true);
  assert.deepEqual(parseTimingLog(line), {
    stage: 'workspace_restore',
    fields: {
      duration_ms: 4521,
      since_turn_ms: 2103,
      restored: true,
      installed: false,
      restore_ms: 800,
    },
  });
});

test('createTurnTimer records elapsed and a compact summary', () => {
  const timer = createTurnTimer(1_000);
  const first = timer.record('task_start', 1_000, 1_040);
  const second = timer.record('first_visible', 1_000, 1_800, { via: 'narration' });
  assert.equal(first.duration_ms, 40);
  assert.equal(second.since_turn_ms, 800);
  const summary = parseTimingLog(timer.formatSummary());
  assert.ok(summary);
  assert.equal(summary.stage, 'summary');
  assert.equal(summary.fields.stages, 'task_start:40,first_visible:800');
});

test('parseTimingLog ignores ordinary status lines', () => {
  assert.equal(parseTimingLog('Restoring project from snapshot'), null);
});
