import assert from 'node:assert/strict';
import test from 'node:test';
import { createCommandOutputBuffer } from '../agents/utils/_command-stream.ts';

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
