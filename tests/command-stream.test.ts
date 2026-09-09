import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createCommandOutputBuffer,
  normalizeCommandChunk,
} from '../agents/utils/_command-stream.ts';

test('normalizeCommandChunk accepts strings and E2B-style line objects', () => {
  assert.equal(normalizeCommandChunk('hello'), 'hello');
  assert.equal(normalizeCommandChunk({ line: 'from e2b' }), 'from e2b');
  assert.equal(normalizeCommandChunk({ text: 'from text' }), 'from text');
  assert.equal(normalizeCommandChunk(null), '');
});

test('command output buffer emits accumulated text and flushes the tail', async () => {
  const seen: string[] = [];
  const buffer = createCommandOutputBuffer({
    emit: (text) => seen.push(text),
    intervalMs: 5,
  });

  buffer.push('a');
  assert.deepEqual(seen, ['a']);
  buffer.push('b');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(seen, ['a', 'ab']);

  buffer.push('c');
  buffer.flush();
  assert.deepEqual(seen, ['a', 'ab', 'abc']);
});
