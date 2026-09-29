import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { AGENT_RUN_TIMEOUT_SECONDS, TURN_BUDGET_MS } from '../agents/_lib/lazy/budgets.ts';
import type { AgentContext, BlobStoreLike, TurnRunner } from '../agents/_lib/runtime/context.ts';
import { createMemoryBlobStore, type ConversationRecord } from '../agents/_lib/session/store.ts';
import { createChatTaskAndStreamResponse, stopLiveChatTask } from '../agents/_lib/session/task.ts';
import { consumeEventStream } from '../app/features/workspace/sse.ts';
import type { ChatStreamEvent } from '../shared/protocol.ts';
import { TURN_LIMIT_REPLY } from '../shared/user-facing-reply.ts';

/**
 * A task context whose Blob writes record the task status they carried, in
 * order. A write carrying `holdStatus` waits until `gate.open()`.
 */
function taskHarness(conversationId: string, runTurn: TurnRunner, holdStatus?: string) {
  const inner = createMemoryBlobStore();
  const saved: string[] = [];
  let openGate!: () => void;
  const gateOpen = new Promise<void>((resolve) => { openGate = resolve; });
  const gate = { reached: false, open: () => openGate() };
  const blobStore: BlobStoreLike = {
    set: (key, value, options) => inner.set(key, value, options),
    delete: (key) => inner.delete(key),
    list: (options) => inner.list(options),
    get: (key, options) => inner.get(key, options),
    async setJSON(key, value, options) {
      const status = (value as ConversationRecord | undefined)?.chatTask?.status;
      if (status && status === holdStatus) {
        gate.reached = true;
        await gateOpen;
      }
      if (status) saved.push(status);
      return inner.setJSON(key, value, options);
    },
  };
  const context: AgentContext = { conversation_id: conversationId, blobStore, runTurn };
  return { context, saved, gate };
}

async function startTurn(context: AgentContext, turnId: string, message = 'build a landing page') {
  const response = await createChatTaskAndStreamResponse(context, message, { kind: 'prompt', turnId });
  const events: ChatStreamEvent[] = [];
  const consumed = consumeEventStream<ChatStreamEvent>(response, (event) => {
    if (event.type !== 'ping') events.push(event);
  });
  return { events, consumed };
}

async function waitUntil(predicate: () => boolean) {
  for (let attempt = 0; attempt < 1_000 && !predicate(); attempt += 1) {
    await setImmediate();
  }
  assert.ok(predicate(), 'condition never became true');
}

function waitForAbort(context: AgentContext) {
  return new Promise<void>((resolve) => {
    const signal = context.request?.signal;
    if (signal?.aborted) resolve();
    else signal?.addEventListener('abort', () => resolve(), { once: true });
  });
}

test('the turn budget ends inside agents.timeout from edgeone.json', async () => {
  const config = JSON.parse(await readFile('edgeone.json', 'utf8')) as { agents?: { timeout?: number } };
  assert.equal(AGENT_RUN_TIMEOUT_SECONDS, config.agents?.timeout);
  assert.ok(TURN_BUDGET_MS < AGENT_RUN_TIMEOUT_SECONDS * 1000);
});

// The result ends the /prompt request, and the instance has no CPU guarantee
// once it is gone, so the status must already be saved when the result leaves.
test('a turn publishes its result only after its final status is saved', async () => {
  const { context, gate } = taskHarness('lifecycle-order', async (_ctx, _input, send) => {
    send({ type: 'text_segment', data: { text: 'working' } });
    send({ type: 'result', data: { ok: true, reply: 'done' } });
  }, 'completed');
  const { events, consumed } = await startTurn(context, 'lifecycle-order-1');
  await waitUntil(() => gate.reached);
  await waitUntil(() => events.some((event) => event.type === 'text_segment'));
  for (let turn = 0; turn < 20; turn += 1) await setImmediate();

  // Progress is live; the result waits for the final status write.
  assert.equal(events.some((event) => event.type === 'result'), false);

  gate.open();
  await consumed;
  assert.equal(events.at(-1)?.type, 'result');
});

test('a stop waits for the turn to save, and the status flips only then', async () => {
  let release!: () => void;
  const stillSaving = new Promise<void>((resolve) => { release = resolve; });
  const { context, saved } = taskHarness('lifecycle-stop', async (ctx, _input, send) => {
    await waitForAbort(ctx);
    await stillSaving;
    send({ type: 'result', data: { ok: false, stopped: true, reply: '' } });
  });
  const { events, consumed } = await startTurn(context, 'lifecycle-stop-1');
  await waitUntil(() => saved.includes('running'));

  assert.equal(await stopLiveChatTask('lifecycle-stop', { waitMs: 0 }), 'stopping');
  const stopping = stopLiveChatTask('lifecycle-stop', { waitMs: 5_000 });
  await setImmediate();
  // A new prompt reads this status; it must not see the slot free while the
  // stopped turn is still writing to the sandbox.
  assert.equal(saved.at(-1), 'running');

  release();
  assert.equal(await stopping, 'stopped');
  assert.equal(saved.at(-1), 'stopped');
  await consumed;
  const result = events.find((event) => event.type === 'result');
  assert.equal(result?.type === 'result' && result.data?.stopped, true);
});

test('a stop in a process that runs no turn for the conversation is idle', async () => {
  assert.equal(await stopLiveChatTask('lifecycle-nothing-running', { waitMs: 1_000 }), 'idle');
});

test('a turn that ends without a result still closes its stream with one', async () => {
  const { context, saved } = taskHarness('lifecycle-no-result', async () => {});
  const { events, consumed } = await startTurn(context, 'lifecycle-no-result-1');
  await consumed;

  const result = events.find((event) => event.type === 'result');
  assert.equal(result?.type === 'result' && result.data?.ok, true);
  assert.equal(saved.at(-1), 'completed');
});

test('the turn budget winds a turn down and says how to continue', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { context, saved } = taskHarness('lifecycle-budget', async (ctx, _input, send) => {
    await waitForAbort(ctx);
    send({ type: 'result', data: { ok: false, stopped: true, reply: '' } });
  });
  const { events, consumed } = await startTurn(context, 'lifecycle-budget-1');
  await waitUntil(() => saved.includes('running'));

  t.mock.timers.tick(TURN_BUDGET_MS);
  await consumed;

  const result = events.find((event) => event.type === 'result');
  assert.ok(result?.type === 'result');
  assert.equal(result.data?.stopped, true);
  assert.equal(result.data?.reply, TURN_LIMIT_REPLY.en);
  assert.equal(saved.at(-1), 'stopped');
});
