import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

test('chat uses one route for direct POST streaming and GET reconnect', async () => {
  const route = await readFile('agents/chat.ts', 'utf8');
  const client = await readFile('app/features/workspace/workspace-api.ts', 'utf8');

  assert.match(route, /onRequestPost/);
  assert.match(route, /createChatTaskAndStreamResponse/);
  assert.match(route, /onRequestGet/);
  assert.match(route, /createChatTaskStreamResponse/);
  assert.match(client, /return fetch\('\/chat'/);
  await assert.rejects(access('agents/chat/index.ts'));
});

test('initial resume is one progressive SSE request', async () => {
  const route = await readFile('agents/resume.ts', 'utf8');
  const pipeline = await readFile('agents/pipelines/_resume.ts', 'utf8');
  const client = await readFile('app/features/workspace/workspace-api.ts', 'utf8');

  assert.match(route, /onRequestGet/);
  assert.match(route, /createProjectResumeStreamResponse/);
  assert.match(pipeline, /type: 'resume_history'/);
  assert.match(pipeline, /type: 'resume_workspace'/);
  assert.match(client, /fetch\('\/resume',[\s\S]*?method: 'GET'/);
});

test('file panel performs no automatic or hover prefetch', async () => {
  const source = await readFile('app/components/files-panel.tsx', 'utf8');
  assert.doesNotMatch(source, /prefetch/i);
  assert.doesNotMatch(source, /onMouseEnter/);
  assert.match(source, /fetch\(`\/file\?path=/);
});
