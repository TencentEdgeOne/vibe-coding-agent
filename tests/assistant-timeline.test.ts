import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAssistantTimeline,
  lastTimelineText,
  trailingTimelineContent,
} from '../app/lib/assistant-timeline.ts';
import type { AssistantActivity } from '../shared/protocol.ts';

const writeFile = (id: string, path: string): AssistantActivity => ({
  kind: 'tool',
  toolUseId: id,
  name: 'write_project_file',
  status: 'completed',
  inputSummary: path,
});

test('buildAssistantTimeline interleaves text with consecutive tool chains', () => {
  const blocks = buildAssistantTimeline([
    { kind: 'text', content: 'Starting the landing page.' },
    writeFile('t1', 'package.json'),
    writeFile('t2', 'index.html'),
    { kind: 'text', content: 'Preview is ready.' },
    writeFile('t3', 'styles.css'),
  ]);

  assert.equal(blocks.length, 4);
  assert.equal(blocks[0].kind, 'text');
  assert.equal(blocks[0].kind === 'text' && blocks[0].content, 'Starting the landing page.');
  assert.equal(blocks[1].kind, 'tools');
  assert.deepEqual(
    blocks[1].kind === 'tools' ? blocks[1].items.map((item) => item.activity.toolUseId) : [],
    ['t1', 't2'],
  );
  assert.equal(blocks[2].kind, 'text');
  assert.equal(blocks[2].kind === 'text' && blocks[2].content, 'Preview is ready.');
  assert.equal(blocks[3].kind, 'tools');
  assert.equal(blocks[3].kind === 'tools' && blocks[3].items[0]?.activity.toolUseId, 't3');
});

test('buildAssistantTimeline skips empty text and keeps tool order', () => {
  const blocks = buildAssistantTimeline([
    { kind: 'text', content: '   ' },
    writeFile('t1', 'a.ts'),
    { kind: 'text', content: 'Done.' },
  ]);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].kind, 'tools');
  assert.equal(blocks[1].kind, 'text');
  assert.equal(lastTimelineText(blocks)?.content, 'Done.');
});

test('trailingTimelineContent keeps leftover reply after the last streamed text', () => {
  assert.equal(
    trailingTimelineContent(
      'I will write the homepage files.',
      'I will write the homepage files.',
      'done',
    ),
    '',
  );
  assert.equal(
    trailingTimelineContent(
      'I will write the homepage files.',
      'I will write the homepage files. Preview is ready.',
      'done',
    ),
    'Preview is ready.',
  );
  assert.equal(
    trailingTimelineContent(
      'Writing files',
      'Generation stopped. You can continue with another change.',
      'stopped',
    ),
    'Generation stopped. You can continue with another change.',
  );
  assert.equal(trailingTimelineContent('Thinking', 'Boom', 'error'), 'Boom');
  assert.equal(trailingTimelineContent('Thinking', 'Thinking more', 'running'), '');
});
