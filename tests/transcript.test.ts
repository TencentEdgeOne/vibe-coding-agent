import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile as readDisk, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createMemoryBlobStore, patchConversationRecord, transcriptBlobKey } from '../agents/_lib/session/store.ts';
import {
  createTranscriptStreamResponse,
  downloadTranscript,
  loadTranscriptJsonl,
  resolveClaudeTranscriptPath,
  uploadTranscript,
} from '../agents/_lib/session/transcript.ts';
import { projectTranscript } from '../agents/_lib/session/projection.ts';
import { consumeEventStream } from '../app/features/workspace/sse.ts';
import { applyStreamEvent } from '../shared/timeline.ts';
import type { PersistedActivityTurn, TranscriptStreamEvent } from '../shared/protocol.ts';

test('transcript upload and download stay a single JSONL file', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'transcript-'));
  const source = path.join(directory, 'session.jsonl');
  const dest = path.join(directory, 'restored.jsonl');
  const jsonl = [
    JSON.stringify({
      type: 'user',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: 'Make a todo list' },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-01-01T00:00:01.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Working on it.' },
          { type: 'tool_use', id: 'tool-1', name: 'write_project_file', input: { path: 'src/app.tsx', content: 'x' } },
        ],
      },
    }),
    JSON.stringify({
      type: 'user',
      timestamp: '2026-01-01T00:00:02.000Z',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'wrote src/app.tsx' },
        ],
      },
    }),
  ].join('\n');
  await writeFile(source, jsonl);

  const blobStore = createMemoryBlobStore();
  const context = { blobStore };
  await uploadTranscript({
    context,
    conversationId: 'conv-1',
    sessionId: 'sess-1',
    sourcePath: source,
  });
  const stored = await blobStore.get(transcriptBlobKey('sess-1'));
  assert.equal(stored, jsonl);

  const restored = await downloadTranscript({
    context,
    conversationId: 'conv-1',
    sessionId: 'sess-1',
    destPath: dest,
  });
  assert.equal(restored, true);
  assert.equal(await readDisk(dest, 'utf8'), jsonl);
  await rm(directory, { recursive: true, force: true });
});

test('JSONL projects into conversation turns with tool results folded in', () => {
  const jsonl = [
    JSON.stringify({
      type: 'user',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: 'Build a page' },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-01-01T00:00:01.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Writing files.' },
          { type: 'tool_use', id: 'call-1', name: 'write_project_file', input: { path: 'index.html', content: '<h1>Hi</h1>' } },
        ],
      },
    }),
    JSON.stringify({
      type: 'user',
      timestamp: '2026-01-01T00:00:02.000Z',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call-1', content: 'ok' },
        ],
      },
    }),
  ].join('\n');

  const turns = projectTranscript(jsonl, '/tmp/project');
  assert.equal(turns.length, 1);
  assert.equal(turns[0].user, 'Build a page');
  assert.equal(turns[0].assistant, 'Writing files.');
  assert.equal(turns[0].activities.length, 2);
  assert.equal(turns[0].activities[0].kind, 'text');
  const tool = turns[0].activities[1];
  assert.equal(tool.kind, 'tool');
  if (tool.kind === 'tool') {
    assert.equal(tool.toolUseId, 'call-1');
    assert.equal(tool.status, 'completed');
    assert.match(tool.inputSummary || '', /index\.html/);
    assert.equal(tool.outputSummary, 'ok');
  }
});

test('live SSE events fold into the same turn model as a JSONL projection', () => {
  let turn: PersistedActivityTurn = {
    id: 'turn-1',
    user: 'Build a page',
    assistant: '',
    status: 'completed',
    createdAt: 1,
    activities: [],
  };
  turn = applyStreamEvent(turn, { type: 'text_segment', data: { text: 'Writing files.' } });
  turn = applyStreamEvent(turn, {
    type: 'tool_use',
    data: { id: 'call-1', name: 'write_project_file', inputSummary: 'index.html (8 chars)' },
  });
  turn = applyStreamEvent(turn, {
    type: 'tool_result',
    data: { id: 'call-1', ok: true, outputSummary: 'ok', status: 'completed' },
  });
  assert.equal(turn.activities.length, 2);
  const tool = turn.activities[1];
  assert.equal(tool.kind, 'tool');
  if (tool.kind === 'tool') {
    assert.equal(tool.toolUseId, 'call-1');
    assert.equal(tool.status, 'completed');
    assert.equal(tool.outputSummary, 'ok');
  }
});

test('JSONL thinking blocks survive projection', () => {
  const jsonl = [
    JSON.stringify({
      type: 'user',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { role: 'user', content: 'Build a page' },
    }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-01-01T00:00:01.000Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'A landing page needs a form.' },
          { type: 'text', text: 'Writing files.' },
        ],
      },
    }),
  ].join('\n');

  const turns = projectTranscript(jsonl);
  assert.equal(turns[0].activities[0]?.kind, 'thinking');
  assert.equal(turns[0].activities[0]?.kind === 'thinking' && turns[0].activities[0].content, 'A landing page needs a form.');
  assert.equal(turns[0].activities[1]?.kind, 'text');
});

test('live SSE folds thinking and usage into the turn', () => {
  let turn: PersistedActivityTurn = {
    id: 'turn-1',
    user: 'Build a page',
    assistant: '',
    status: 'completed',
    createdAt: 1,
    activities: [],
  };
  turn = applyStreamEvent(turn, { type: 'thinking_segment', data: { text: 'Need a form.' } });
  turn = applyStreamEvent(turn, { type: 'text_segment', data: { text: 'Writing files.' } });
  turn = applyStreamEvent(turn, {
    type: 'system_info',
    data: { infoType: 'usage', title: 'Usage', content: 'turns=1 cost=$0.01' },
  });
  assert.equal(turn.activities[0]?.kind, 'thinking');
  assert.equal(turn.activities[1]?.kind, 'text');
  assert.equal(turn.activities[2]?.kind, 'info');
  assert.equal(turn.activities[2]?.kind === 'info' && turn.activities[2].infoType, 'usage');
});

test('GET /transcript streams the JSONL file unaltered', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'transcript-read-'));
  const source = path.join(directory, 'session.jsonl');
  const jsonl = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'Hello' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'Hi.' } }),
    '',
  ].join('\n');
  await writeFile(source, jsonl);

  const blobStore = createMemoryBlobStore();
  await uploadTranscript({
    context: { blobStore },
    conversationId: 'conv-read',
    sessionId: 'sess-read',
    sourcePath: source,
  });

  const missing = await createTranscriptStreamResponse({ blobStore }, () => null);
  assert.equal(missing.status, 400);

  const response = await createTranscriptStreamResponse(
    { blobStore, conversation_id: 'conv-read' },
    () => null,
  );
  assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
  const events: TranscriptStreamEvent[] = [];
  await consumeEventStream<TranscriptStreamEvent>(response, (event) => {
    if (event.type !== 'ping') events.push(event);
  });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, 'transcript');
  if (events[0]?.type === 'transcript') {
    assert.equal(events[0].data?.ok, true);
    assert.equal(events[0].data?.sessionId, 'sess-read');
    assert.equal(events[0].data?.jsonl, jsonl);
    assert.equal(events[0].data?.live, false);
  }
  await rm(directory, { recursive: true, force: true });
});

test('a live transcript path streams before the record is uploaded', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'transcript-live-'));
  const source = path.join(directory, 'session.jsonl');
  await writeFile(source, 'line-1\n');

  const blobStore = createMemoryBlobStore();
  const empty = await loadTranscriptJsonl({ blobStore }, 'conv-live');
  assert.equal(empty, '');

  let active = true;
  const response = await createTranscriptStreamResponse(
    { blobStore, conversation_id: 'conv-live' },
    () => ({ path: source, sessionId: 'sess-live', active }),
  );
  // The stream sends the file once and then only what was appended; the
  // client folds the pieces back into the file it shows.
  const snapshots: string[] = [];
  let shown = '';
  const done = consumeEventStream<TranscriptStreamEvent>(response, (event) => {
    if (event.type !== 'transcript' || typeof event.data?.jsonl !== 'string') return;
    shown = event.data.append ? shown + event.data.jsonl : event.data.jsonl;
    if (snapshots.at(-1) !== shown) snapshots.push(shown);
    if (snapshots.length === 1) {
      void writeFile(source, 'line-1\nline-2\n').then(() => {
        active = false;
      });
    }
  });
  await done;
  assert.deepEqual(snapshots, ['line-1\n', 'line-1\nline-2\n']);
  await rm(directory, { recursive: true, force: true });
});

test('Claude JSONL lives under projects/<cwd-slug>/<sessionId>.jsonl, not sessions/', async () => {
  const configDir = await mkdtemp(path.join(tmpdir(), 'claude-config-'));
  const cwd = '/Users/me/app';
  const sessionId = '28247548-0d9f-4dae-9760-e9380aab5c40';
  const jsonl = `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'Hello' } })}\n`;
  const expected = path.join(configDir, 'projects', '-Users-me-app', `${sessionId}.jsonl`);
  assert.equal(
    resolveClaudeTranscriptPath(sessionId, { configDir, cwd }),
    expected,
  );
  await mkdir(path.dirname(expected), { recursive: true });
  await writeFile(expected, jsonl);

  const blobStore = createMemoryBlobStore();
  await patchConversationRecord({ blobStore }, 'conv-slug', { claudeSessionId: sessionId });
  const loaded = await loadTranscriptJsonl({ blobStore }, 'conv-slug', '', { configDir, cwd, sessionId });
  assert.equal(loaded, jsonl);
  await rm(configDir, { recursive: true, force: true });
});

test('compaction re-uploads the local transcript file', async () => {
  const { readFile } = await import('node:fs/promises');
  const live = await readFile('agents/_lib/session/live.ts', 'utf8');
  assert.match(live, /subtype === 'compact_boundary'/);
  assert.match(live, /PostCompact:/);
  assert.match(live, /persistTranscript\(session\)/);
  assert.match(live, /SessionStart/);
  assert.match(live, /patchConversationRecord/);
  assert.match(live, /transcript_path/);
  assert.match(live, /resolveClaudeTranscriptPath/);
  assert.match(live, /extractVisibleThinkingDelta/);
  assert.match(live, /describeSdkMessage/);
  assert.match(live, /formatResultUsage/);
});
