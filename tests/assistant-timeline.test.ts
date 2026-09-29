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

test('buildAssistantTimeline interleaves text with consecutive tool calls', () => {
  const blocks = buildAssistantTimeline([
    { kind: 'text', content: 'Starting the landing page.' },
    writeFile('t1', 'package.json'),
    writeFile('t2', 'index.html'),
    { kind: 'text', content: 'Preview is ready.' },
    writeFile('t3', 'styles.css'),
  ]);

  assert.equal(blocks.length, 5);
  assert.equal(blocks[0].kind, 'text');
  assert.equal(blocks[0].kind === 'text' && blocks[0].content, 'Starting the landing page.');
  assert.equal(blocks[1].kind, 'tool');
  assert.equal(blocks[1].kind === 'tool' && blocks[1].activity.toolUseId, 't1');
  assert.equal(blocks[2].kind === 'tool' && blocks[2].activity.toolUseId, 't2');
  assert.equal(blocks[3].kind, 'text');
  assert.equal(blocks[4].kind === 'tool' && blocks[4].activity.toolUseId, 't3');
});

test('buildAssistantTimeline skips empty text and keeps tool order', () => {
  const blocks = buildAssistantTimeline([
    { kind: 'text', content: '   ' },
    writeFile('t1', 'a.ts'),
    { kind: 'text', content: 'Done.' },
  ]);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].kind, 'tool');
  assert.equal(blocks[1].kind, 'text');
  assert.equal(lastTimelineText(blocks)?.content, 'Done.');
});

test('reference loads stay one block per call', () => {
  const load = (id: string, skill: string, ref?: string): AssistantActivity => ({
    kind: 'tool',
    toolUseId: id,
    name: 'mcp__edgeone-sandbox__load_makers_skill',
    status: 'completed',
    inputSummary: ref ? JSON.stringify({ skill, ref }) : skill,
  });

  const blocks = buildAssistantTimeline([
    load('s1', 'makers-agents'),
    load('s2', 'makers-agents', 'platform/node-entry.md'),
    load('s3', 'makers-agents', 'platform/sse-protocol.md'),
    load('s4', 'makers-recipes'),
    writeFile('t1', 'app/page.tsx'),
  ]);

  assert.deepEqual(
    blocks.map((block) => block.kind === 'tool' ? block.activity.toolUseId : block.kind),
    ['s1', 's2', 's3', 's4', 't1'],
  );
  assert.equal(blocks[1].kind === 'tool' && blocks[1].activity.inputSummary, JSON.stringify({
    skill: 'makers-agents',
    ref: 'platform/node-entry.md',
  }));

  const resumed = buildAssistantTimeline([
    load('s1', 'makers-agents', 'platform/node-entry.md'),
    { kind: 'text', content: 'Now the streaming protocol.' },
    load('s2', 'makers-agents', 'platform/sse-protocol.md'),
  ]);
  assert.deepEqual(resumed.map((block) => block.kind), ['tool', 'text', 'tool']);
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
      '',
      'stopped',
    ),
    '',
  );
  assert.equal(trailingTimelineContent('Thinking', 'Boom', 'error'), 'Boom');
  assert.equal(trailingTimelineContent('Thinking', 'Thinking more', 'running'), '');
});

test('buildAssistantTimeline keeps thinking and system info as their own blocks', () => {
  const blocks = buildAssistantTimeline([
    { kind: 'thinking', content: 'Need a form first.' },
    { kind: 'text', content: 'I will add the form.' },
    {
      kind: 'info',
      infoType: 'usage',
      title: 'Usage',
      content: 'turns=2 cost=$0.01',
    },
  ]);
  assert.deepEqual(blocks.map((block) => block.kind), ['thinking', 'text', 'info']);
  assert.equal(blocks[0].kind === 'thinking' && blocks[0].content, 'Need a form first.');
  assert.equal(lastTimelineText(blocks)?.content, 'I will add the form.');
});
