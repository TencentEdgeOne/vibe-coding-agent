import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { createProjectState } from '../agents/_lib/project/state.ts';
import type { AgentContext, BlobStoreLike } from '../agents/_lib/runtime/context.ts';
import { claimEpoch, ownerKey, stillOwner } from '../agents/_lib/session/fence.ts';
import {
  FENCE_WATCH_MS,
  FencedError,
  PROGRESS_EVERY_WATCHES,
  TURN_PROGRESS_STALE_MS,
  TurnRunningElsewhereError,
  enterConversation,
} from '../agents/_lib/session/ownership.ts';
import {
  createMemoryBlobStore,
  patchConversationRecord,
  type ConversationRecord,
} from '../agents/_lib/session/store.ts';
import { createChatTaskAndStreamResponse, settleUnrunTask } from '../agents/_lib/session/task.ts';
import type { ChatTask } from '../agents/_lib/types.ts';
import { consumeEventStream } from '../app/features/workspace/sse.ts';
import type { ChatStreamEvent } from '../shared/protocol.ts';

const recordKey = (id: string) => `conv/${id}/state.json`;

async function readRecord(store: BlobStoreLike, id: string) {
  return await store.get(recordKey(id), { type: 'json' }) as ConversationRecord | null;
}

async function waitFor(predicate: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (await predicate()) return;
    await setImmediate();
  }
  assert.fail('condition never became true');
}

function runningTask(progressAt: number): ChatTask {
  return {
    id: 'turn-elsewhere',
    message: 'build a page',
    kind: 'prompt',
    status: 'running',
    createdAt: progressAt,
    startedAt: progressAt,
    progressAt,
  };
}

/** What another instance leaves in Blob: its claim and its record. */
async function ownedElsewhere(store: BlobStoreLike, id: string, task: ChatTask) {
  await store.setJSON(ownerKey(id, 1), { instance: 'other', at: 0, intent: 'write' });
  await store.setJSON(recordKey(id), { epoch: 1, projectState: createProjectState(id), chatTask: task });
}

function waitForAbort(context: AgentContext) {
  return new Promise<void>((resolve) => {
    const signal = context.request?.signal;
    if (signal?.aborted) resolve();
    else signal?.addEventListener('abort', () => resolve(), { once: true });
  });
}

test('concurrent claims get distinct epochs, and only the newest still owns', async () => {
  const store = createMemoryBlobStore();
  const claim = { instance: 'test', at: 0, intent: 'write' as const };
  const epochs = await Promise.all([
    claimEpoch(store, 'fence-race', 0, claim),
    claimEpoch(store, 'fence-race', 0, claim),
  ]);

  assert.deepEqual([...epochs].sort(), [1, 2]);
  assert.equal(await stillOwner(store, 'fence-race', 1), false);
  assert.equal(await stillOwner(store, 'fence-race', 2), true);
});

test('a replaced owner cannot write the record', async () => {
  const store = createMemoryBlobStore();
  const context: AgentContext = { blobStore: store };
  await enterConversation(context, 'fence-write', 'write');
  assert.equal(context.epoch, 1);

  await store.setJSON(ownerKey('fence-write', 2), { instance: 'other', at: 0, intent: 'write' });
  await assert.rejects(
    patchConversationRecord(context, 'fence-write', { modelPreference: 'late' }),
    FencedError,
  );
});

// After a redeploy the old instance keeps running its turn while new requests
// land elsewhere. Only an explicit stop may take that turn away.
test('a turn still making progress elsewhere is left alone except by a stop', async () => {
  const store = createMemoryBlobStore();
  const id = 'fence-elsewhere';
  await ownedElsewhere(store, id, runningTask(Date.now()));

  assert.equal(await settleUnrunTask({ blobStore: store }, id, 'read'), 'elsewhere');
  assert.equal(await store.get(ownerKey(id, 2), { type: 'json' }), null);
  await assert.rejects(
    patchConversationRecord({ blobStore: store }, id, { modelPreference: 'late' }),
    TurnRunningElsewhereError,
  );

  const prompt = await createChatTaskAndStreamResponse(
    { conversation_id: id, blobStore: store },
    'build something else',
    { kind: 'prompt' },
  );
  assert.equal(prompt.status, 409);
  assert.equal((await prompt.json() as { code?: string }).code, 'TURN_RUNNING_ELSEWHERE');

  assert.equal(await settleUnrunTask({ blobStore: store }, id, 'stop'), 'settled');
  const record = await readRecord(store, id);
  assert.equal(record?.epoch, 2);
  assert.equal(record?.chatTask?.status, 'stopped');
});

test('a running turn with no recent progress is taken over and recorded as failed', async () => {
  const store = createMemoryBlobStore();
  const id = 'fence-stale';
  await ownedElsewhere(store, id, runningTask(Date.now() - TURN_PROGRESS_STALE_MS - 1_000));

  assert.equal(await settleUnrunTask({ blobStore: store }, id, 'read'), 'settled');
  const record = await readRecord(store, id);
  assert.equal(record?.epoch, 2);
  assert.equal(record?.chatTask?.status, 'failed');
});

test('a turn whose conversation is taken over stops and writes nothing', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const store = createMemoryBlobStore();
  const id = 'fence-zombie';
  const context: AgentContext = {
    conversation_id: id,
    blobStore: store,
    runTurn: async (ctx, _input, send) => {
      await waitForAbort(ctx);
      send({ type: 'result', data: { ok: false, stopped: true } });
    },
  };
  const events: ChatStreamEvent[] = [];
  const done = consumeEventStream<ChatStreamEvent>(
    await createChatTaskAndStreamResponse(context, 'build a page', { kind: 'prompt', turnId: 'zombie-turn' }),
    (event) => { events.push(event); },
  );
  await waitFor(async () => (await readRecord(store, id))?.chatTask?.status === 'running');

  // Another instance claims the conversation and writes its own record.
  await store.setJSON(ownerKey(id, 2), { instance: 'other', at: 0, intent: 'stop' });
  const theirs = await readRecord(store, id);
  const replaced = { ...theirs!, epoch: 2, chatTask: { ...theirs!.chatTask!, status: 'stopped' as const } };
  await store.setJSON(recordKey(id), replaced);

  t.mock.timers.tick(FENCE_WATCH_MS);
  await done;

  const result = events.find((event) => event.type === 'result');
  assert.equal(result?.type === 'result' && result.data?.stopped, true);
  assert.deepEqual(await readRecord(store, id), replaced);
});

test('a running turn records progress so another instance can tell it is alive', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 });
  const store = createMemoryBlobStore();
  const id = 'fence-progress';
  let release!: () => void;
  const finish = new Promise<void>((resolve) => { release = resolve; });
  const done = consumeEventStream<ChatStreamEvent>(
    await createChatTaskAndStreamResponse(
      {
        conversation_id: id,
        blobStore: store,
        runTurn: async (_ctx, _input, send) => {
          await finish;
          send({ type: 'result', data: { ok: true } });
        },
      },
      'build a page',
      { kind: 'prompt', turnId: 'progress-turn' },
    ),
    () => {},
  );
  await waitFor(async () => (await readRecord(store, id))?.chatTask?.status === 'running');
  const started = (await readRecord(store, id))?.chatTask?.progressAt ?? 0;

  t.mock.timers.tick(FENCE_WATCH_MS * PROGRESS_EVERY_WATCHES);
  await waitFor(async () => ((await readRecord(store, id))?.chatTask?.progressAt ?? 0) > started);

  release();
  await done;
  assert.equal((await readRecord(store, id))?.chatTask?.status, 'completed');
});
