import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { OBSERVER_STREAM_MAX_MS } from '../agents/_lib/lazy/budgets.ts';
import type { AgentContext, TurnRunner } from '../agents/_lib/runtime/context.ts';
import { createProjectResumeStreamResponse } from '../agents/_lib/session/resume.ts';
import { createMemoryBlobStore } from '../agents/_lib/session/store.ts';
import { createChatTaskAndStreamResponse } from '../agents/_lib/session/task.ts';
import { createTranscriptStreamResponse } from '../agents/_lib/session/transcript.ts';
import { consumeEventStream } from '../app/features/workspace/sse.ts';
import type { SessionStreamEvent, TranscriptStreamEvent } from '../shared/protocol.ts';

async function waitUntil(predicate: () => boolean) {
  for (let attempt = 0; attempt < 1_000 && !predicate(); attempt += 1) {
    await setImmediate();
  }
  assert.ok(predicate(), 'condition never became true');
}

function collect<T extends { type: string }>(response: Response) {
  const events: T[] = [];
  const done = consumeEventStream<T>(response, (event) => {
    if (event.type !== 'ping') events.push(event);
  });
  return { events, done };
}

function textOf(event: SessionStreamEvent) {
  return event.type === 'text_segment' ? event.data?.text : undefined;
}

// A tab that went away leaves its stream open on the server, holding one of
// the instance's request slots, so an observer ends itself and the client
// reopens it after the last event it received.
test('a session attach ends at its time limit and reopens after its cursor', async (t) => {
  let proceed!: () => void;
  const secondHalf = new Promise<void>((resolve) => { proceed = resolve; });
  const runTurn: TurnRunner = async (_ctx, _input, send) => {
    send({ type: 'text_segment', data: { text: 'one' } });
    await secondHalf;
    send({ type: 'text_segment', data: { text: 'two' } });
    send({ type: 'result', data: { ok: true, reply: 'done' } });
  };
  const context: AgentContext = {
    conversation_id: 'observer-attach',
    blobStore: createMemoryBlobStore(),
    runTurn,
  };
  const carrier = collect<SessionStreamEvent>(await createChatTaskAndStreamResponse(
    context,
    'build a page',
    { kind: 'prompt', turnId: 'observer-turn' },
  ));
  await waitUntil(() => carrier.events.some((event) => textOf(event) === 'one'));

  t.mock.timers.enable({ apis: ['setTimeout'] });
  const first = collect<SessionStreamEvent>(await createProjectResumeStreamResponse({
    ...context,
    request: { url: 'http://localhost/session' },
  }));
  await waitUntil(() => first.events.some((event) => textOf(event) === 'one'));
  t.mock.timers.tick(OBSERVER_STREAM_MAX_MS);
  await first.done;

  const reconnect = first.events.at(-1);
  assert.equal(first.events[0]?.type, 'resume_history');
  assert.ok(reconnect?.type === 'reconnect');
  assert.equal(reconnect.data?.turnId, 'observer-turn');
  const seqOfOne = first.events.find((event) => textOf(event) === 'one')?.seq;
  assert.equal(reconnect.data?.afterSeq, seqOfOne);

  proceed();
  await carrier.done;
  const reopened = collect<SessionStreamEvent>(await createProjectResumeStreamResponse({
    ...context,
    request: { url: `http://localhost/session?turnId=observer-turn&afterSeq=${seqOfOne}` },
  }));
  await reopened.done;

  // No history reload and no repeat of what the first stream delivered.
  assert.deepEqual(reopened.events.map((event) => event.type), ['text_segment', 'result']);
  assert.equal(textOf(reopened.events[0]!), 'two');
});

test('the turn\'s own /prompt stream is not time limited', async (t) => {
  let proceed!: () => void;
  const later = new Promise<void>((resolve) => { proceed = resolve; });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const context: AgentContext = {
    conversation_id: 'observer-carrier',
    blobStore: createMemoryBlobStore(),
    runTurn: async (_ctx, _input, send) => {
      await later;
      send({ type: 'result', data: { ok: true } });
    },
  };
  const carrier = collect<SessionStreamEvent>(await createChatTaskAndStreamResponse(
    context,
    'build a page',
    { kind: 'prompt', turnId: 'carrier-turn' },
  ));
  await waitUntil(() => carrier.events.some((event) => event.type === 'task_started'));
  t.mock.timers.tick(OBSERVER_STREAM_MAX_MS * 3);
  await setImmediate();
  assert.equal(carrier.events.some((event) => event.type === 'reconnect'), false);

  proceed();
  await carrier.done;
  assert.equal(carrier.events.at(-1)?.type, 'result');
});

test('a transcript stream resumes after the bytes it already delivered', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'transcript-cursor-'));
  const source = path.join(directory, 'session.jsonl');
  await writeFile(source, 'line-1\nline-2\n');
  const blobStore = createMemoryBlobStore();
  const finished = () => ({ path: source, sessionId: 'sess-cursor', active: false });

  const resumed = collect<TranscriptStreamEvent>(await createTranscriptStreamResponse(
    { blobStore, conversation_id: 'conv-cursor', request: { url: 'http://localhost/transcript?cursor=7&sessionId=sess-cursor' } },
    finished,
  ));
  await resumed.done;
  const piece = resumed.events[0];
  assert.ok(piece?.type === 'transcript');
  assert.equal(piece.data?.append, true);
  assert.equal(piece.data?.jsonl, 'line-2\n');
  assert.equal(piece.data?.cursor, 14);

  // A cursor from another session says nothing about this file.
  const other = collect<TranscriptStreamEvent>(await createTranscriptStreamResponse(
    { blobStore, conversation_id: 'conv-cursor', request: { url: 'http://localhost/transcript?cursor=7&sessionId=sess-other' } },
    finished,
  ));
  await other.done;
  const whole = other.events[0];
  assert.ok(whole?.type === 'transcript');
  assert.equal(whole.data?.append, false);
  assert.equal(whole.data?.jsonl, 'line-1\nline-2\n');
  await rm(directory, { recursive: true, force: true });
});

test('a live transcript stream ends at its time limit with a cursor, holding back a partial line', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'transcript-limit-'));
  const source = path.join(directory, 'session.jsonl');
  await writeFile(source, 'line-1\npartial');
  const stream = collect<TranscriptStreamEvent>(await createTranscriptStreamResponse(
    { blobStore: createMemoryBlobStore(), conversation_id: 'conv-limit' },
    () => ({ path: source, sessionId: 'sess-limit', active: true }),
    { maxMs: 0 },
  ));
  await stream.done;

  const [snapshot, reconnect] = stream.events;
  assert.ok(snapshot?.type === 'transcript');
  assert.equal(snapshot.data?.jsonl, 'line-1\n');
  assert.ok(reconnect?.type === 'reconnect');
  assert.deepEqual(reconnect.data, { cursor: 7, sessionId: 'sess-limit' });
  await rm(directory, { recursive: true, force: true });
});
