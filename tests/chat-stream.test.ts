import assert from 'node:assert/strict';
import test from 'node:test';
import { createSSEResponse, sseEvent } from '../agents/_lib/runtime/sse.ts';
import type { AgentContext, BlobStoreLike } from '../agents/_lib/runtime/context.ts';
import { createMemoryBlobStore, patchConversationRecord } from '../agents/_lib/session/store.ts';
import { createProjectResumeStreamResponse } from '../agents/_lib/session/resume.ts';
import { consumeEventStream } from '../app/features/workspace/sse.ts';

test('SSE responses frame events and terminate with DONE', async () => {
  const response = createSSEResponse(async function* () {
    yield sseEvent({ type: 'ping', ts: 1 });
  });
  const body = await response.text();

  assert.equal(response.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'no-cache, no-transform');
  assert.match(body, /^data: \{"type":"ping","ts":1\}\n\n/);
  assert.match(body, /data: \[DONE\]\n\n$/);
});

type StreamEvent = {
  type: string;
  data?: { stage?: string; status?: string; mode?: string };
};

function streamLabel(event: StreamEvent) {
  return event.type;
}

function sessionContext(conversationId: string) {
  const inner = createMemoryBlobStore();
  const stats = { setJSONs: 0, sandbox: 0 };
  const blobStore: BlobStoreLike = {
    set: (key, value, extra) => inner.set(key, value, extra),
    delete: (key) => inner.delete(key),
    list: (extra) => inner.list(extra),
    get: (key, extra) => inner.get(key, extra),
    async setJSON(key, value, extra) {
      stats.setJSONs += 1;
      return inner.setJSON(key, value, extra);
    },
  };
  const touch = async () => {
    stats.sandbox += 1;
  };
  const context = {
    conversation_id: conversationId,
    blobStore,
    sandbox: {
      extendTimeout: touch,
      restore: async () => {
        stats.sandbox += 1;
        return { restored: false };
      },
      getHost: async () => {
        stats.sandbox += 1;
        return '';
      },
      files: {
        makeDir: touch,
        exists: async () => {
          stats.sandbox += 1;
          return false;
        },
      },
      commands: {
        run: async () => {
          stats.sandbox += 1;
          return { exitCode: 0, stdout: '', stderr: '' };
        },
      },
    },
  } as unknown as AgentContext;
  return { context, blobStore, stats };
}

async function collectSessionEvents(context: AgentContext) {
  const response = await createProjectResumeStreamResponse(context);
  const events: StreamEvent[] = [];
  await consumeEventStream<StreamEvent>(response, (event) => {
    if (event.type !== 'ping') events.push(event);
  });
  return events;
}

test('opening a session emits history only and does not touch the sandbox', async () => {
  const empty = sessionContext('cid-open-empty');
  const emptyEvents = await collectSessionEvents(empty.context);
  assert.deepEqual(emptyEvents.map(streamLabel), ['resume_history']);
  assert.equal(empty.stats.sandbox, 0);
  assert.equal(empty.stats.setJSONs, 0);

  const created = sessionContext('cid-open-created');
  const current = await patchConversationRecord(created.context, 'cid-open-created', {});
  await patchConversationRecord(created.context, 'cid-open-created', {
    projectState: { ...current.projectState, created: true },
  });
  const createdEvents = await collectSessionEvents(created.context);
  assert.deepEqual(createdEvents.map(streamLabel), ['resume_history']);
  assert.equal(created.stats.sandbox, 0);
  assert.ok(!createdEvents.some((event) => event.type === 'session_prep' || event.type === 'resume_workspace'));
});
