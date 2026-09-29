import assert from 'node:assert/strict';
import test from 'node:test';
import type { AssistantActivity } from '../shared/protocol.ts';
import type { ChatMessage } from '../app/types/workspace.ts';
import {
  finalizeAssistant,
  foldActivityEvent,
  patchAssistant,
  settleRunningAssistant,
} from '../app/features/workspace/hooks/live/turn-messages.ts';

function assistantWithTools(activities: AssistantActivity[]): ChatMessage {
  return {
    id: 'a1',
    role: 'assistant',
    content: '',
    status: 'running',
    activities,
  };
}

const runningWrite: AssistantActivity = {
  kind: 'tool',
  toolUseId: 't-write',
  name: 'Write file',
  status: 'running',
  startedAt: 1,
};

const completedRead: AssistantActivity = {
  kind: 'tool',
  toolUseId: 't-read',
  name: 'Read file',
  status: 'completed',
  startedAt: 1,
  endedAt: 2,
};

test('finalizeAssistant closes running tools according to the terminal status', () => {
  const messages: ChatMessage[] = [
    { id: 'u1', role: 'user', content: 'ship it' },
    assistantWithTools([runningWrite, completedRead]),
  ];

  const stopped = finalizeAssistant(messages, 'a1', 'Stopped.', 'stopped');
  assert.equal(stopped[0].content, 'ship it');
  assert.equal(stopped[1].status, 'stopped');
  assert.equal(stopped[1].content, 'Stopped.');
  assert.equal(stopped[1].activities?.[0].kind === 'tool' && stopped[1].activities[0].status, 'stopped');
  assert.equal(stopped[1].activities?.[1].kind === 'tool' && stopped[1].activities[1].status, 'completed');
  assert.ok(
    stopped[1].activities?.[0].kind === 'tool'
      && typeof stopped[1].activities[0].endedAt === 'number',
  );

  const errored = finalizeAssistant(messages, 'a1', 'boom', 'error');
  assert.equal(errored[1].status, 'error');
  assert.equal(errored[1].activities?.[0].kind === 'tool' && errored[1].activities[0].status, 'failed');
  assert.equal(errored[1].activities?.[1].kind === 'tool' && errored[1].activities[1].status, 'completed');

  const done = finalizeAssistant(messages, 'a1', 'All set.', 'done');
  assert.equal(done[1].status, 'done');
  assert.equal(done[1].activities?.[0].kind === 'tool' && done[1].activities[0].status, 'completed');
});

test('finalizeAssistant leaves other messages untouched', () => {
  const other: ChatMessage = {
    id: 'a0',
    role: 'assistant',
    content: 'earlier',
    status: 'done',
    activities: [runningWrite],
  };
  const next = finalizeAssistant(
    [other, assistantWithTools([runningWrite])],
    'a1',
    'done',
    'done',
  );
  assert.equal(next[0], other);
  assert.equal(next[1].status, 'done');
});

test('patchAssistant only updates the active assistant turn', () => {
  const messages: ChatMessage[] = [
    { id: 'u1', role: 'user', content: 'hi' },
    assistantWithTools([]),
  ];
  const next = patchAssistant(messages, 'a1', { content: 'partial' });
  assert.equal(next[0].content, 'hi');
  assert.equal(next[1].content, 'partial');
  assert.equal(next[1].status, 'running');
});

test('foldActivityEvent appends a text segment onto the active turn', () => {
  const messages: ChatMessage[] = [assistantWithTools([])];
  const next = foldActivityEvent(messages, 'a1', {
    type: 'text_segment',
    data: { text: 'Hello' },
  });
  assert.equal(next[0].activities?.[0].kind, 'text');
  assert.equal(next[0].activities?.[0].kind === 'text' && next[0].activities[0].content, 'Hello');
  assert.ok(typeof next[0].startedAt === 'number');
});

test('foldActivityEvent starts the turn clock on thinking, not on submission', () => {
  const beforeOutput = foldActivityEvent(
    [{ ...assistantWithTools([]), startedAt: undefined }],
    'a1',
    { type: 'system_info', data: { infoType: 'status', title: 'Status', content: 'connecting' } },
  );
  assert.equal(beforeOutput[0].startedAt, undefined);

  const withThinking = foldActivityEvent(beforeOutput, 'a1', {
    type: 'thinking_segment',
    data: { text: 'Working out the layout.' },
  });
  assert.ok(typeof withThinking[0].startedAt === 'number');
  assert.ok(withThinking[0].activities?.some((activity) => activity.kind === 'thinking'));
});

test('settleRunningAssistant only fills an unfinished assistant turn', () => {
  const running = assistantWithTools([]);
  const done: ChatMessage = { id: 'a0', role: 'assistant', content: 'ok', status: 'done' };
  const next = settleRunningAssistant([done, running], 'a1', 'Agent flow has ended.');
  assert.equal(next[0], done);
  assert.equal(next[1].status, 'done');
  assert.equal(next[1].content, 'Agent flow has ended.');
  assert.ok(typeof next[1].endedAt === 'number');
});

test('finalizing a turn freezes its status bar elapsed time', () => {
  const running: ChatMessage = {
    id: 'a1',
    role: 'assistant',
    content: '',
    status: 'running',
    startedAt: 1_000,
  };
  const finished = finalizeAssistant([running], 'a1', 'All set.', 'done');
  assert.ok(typeof finished[0].endedAt === 'number');
  assert.equal(finished[0].startedAt, 1_000);
});
