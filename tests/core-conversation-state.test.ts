import assert from 'node:assert/strict';
import test from 'node:test';

import {
  HISTORY_FETCH_LIMIT,
  appendConversationTurn,
  readHistory,
  readMetadataField,
  readModelPreference,
  writeMetadataField,
  writeMetadataFieldStrict,
} from '../agents/core/_conversation-state.ts';
import { createMemoryStorePort } from '../agents/core/adapters/_local.ts';
import type { ConversationStorePort } from '../agents/core/_ports.ts';

function missingConversationError() {
  return Object.assign(new Error('conversation not found'), { code: 'MemoryNotFoundError' });
}

/** A store that fails a chosen method, to pin down which errors are swallowed. */
function failingStore(method: keyof ConversationStorePort, error: Error): ConversationStorePort {
  const base = createMemoryStorePort();
  return { ...base, [method]: async () => { throw error; } };
}

test('history is read in order and capped at the fetch limit', async () => {
  const store = createMemoryStorePort();
  const seen: Record<string, unknown>[] = [];
  const spy: ConversationStorePort = {
    ...store,
    getMessages: async (args) => { seen.push(args); return store.getMessages(args); },
  };

  await store.appendMessage({ conversationId: 'c1', role: 'user', content: 'first' });
  await store.appendMessage({ conversationId: 'c1', role: 'assistant', content: 'second' });

  const history = await readHistory(spy, 'c1');
  assert.deepEqual(history, [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'second' },
  ]);
  assert.equal(seen[0]?.limit, HISTORY_FETCH_LIMIT);
  assert.equal(seen[0]?.order, 'asc');
});

// /chat writes the user message before the detached task starts; leaving it in
// history would duplicate it in the prompt.
test('history drops the just-persisted user message when asked', async () => {
  const store = createMemoryStorePort();
  await store.appendMessage({ conversationId: 'c1', role: 'user', content: 'older' });
  await store.appendMessage({ conversationId: 'c1', role: 'assistant', content: 'reply' });
  await store.appendMessage({ conversationId: 'c1', role: 'user', content: 'current turn' });

  const history = await readHistory(store, 'c1', { excludeLatestUserMessage: 'current turn' });
  assert.deepEqual(history.map((turn) => turn.content), ['older', 'reply']);

  // Only an exact trailing match is removed.
  const untouched = await readHistory(store, 'c1', { excludeLatestUserMessage: 'something else' });
  assert.equal(untouched.length, 3);
});

test('non-text message content is stringified rather than dropped', async () => {
  const store = createMemoryStorePort();
  await store.appendMessage({
    conversationId: 'c1',
    role: 'user',
    content: [{ type: 'text', text: 'structured' }] as never,
  });

  const history = await readHistory(store, 'c1');
  assert.equal(history[0]?.content, '[{"type":"text","text":"structured"}]');
});

test('system and tool roles are filtered out of prompt history', async () => {
  const store = createMemoryStorePort();
  await store.appendMessage({ conversationId: 'c1', role: 'system' as never, content: 'ignore me' });
  await store.appendMessage({ conversationId: 'c1', role: 'user', content: 'keep me' });

  const history = await readHistory(store, 'c1');
  assert.deepEqual(history.map((turn) => turn.content), ['keep me']);
});

test('a conversation that does not exist yet reads as empty, not an error', async () => {
  const store = failingStore('getMessages', missingConversationError());
  assert.deepEqual(await readHistory(store, 'missing'), []);

  const metadataStore = failingStore('getConversation', missingConversationError());
  assert.equal(await readMetadataField(metadataStore, 'missing', 'anything', (v) => v), undefined);
});

// The swallow is scoped to the first-turn race. A transport failure must surface.
test('a real store failure still propagates', async () => {
  const store = failingStore('getMessages', new Error('network down'));
  await assert.rejects(() => readHistory(store, 'c1'), /network down/);

  const metadataStore = failingStore('getConversation', new Error('network down'));
  await assert.rejects(
    () => readMetadataField(metadataStore, 'c1', 'field', (v) => v),
    /network down/,
  );

  const writeStore = failingStore('updateConversation', new Error('network down'));
  await assert.rejects(() => writeMetadataField(writeStore, 'c1', 'field', 1), /network down/);
});

// Writing before the first appendMessage is normal, so that one is tolerated.
test('writing metadata to a not-yet-created conversation is tolerated', async () => {
  const store = failingStore('updateConversation', missingConversationError());
  await writeMetadataField(store, 'c1', 'projectState', { created: true });
});

// saveChatTask relies on this: /chat persists the user message first, so a
// missing conversation there is a real fault, not the first-turn race.
test('the strict write surfaces a missing conversation instead of swallowing it', async () => {
  const store = failingStore('updateConversation', missingConversationError());
  await assert.rejects(
    () => writeMetadataFieldStrict(store, 'c1', 'chatTask', { id: 't1' }),
    /conversation not found/,
  );

  // It is otherwise the same write.
  const working = createMemoryStorePort();
  await writeMetadataFieldStrict(working, 'c1', 'chatTask', { id: 't1' });
  assert.deepEqual(
    await readMetadataField(working, 'c1', 'chatTask', (v) => v),
    { id: 't1' },
  );
});

test('metadata writes shallow-merge instead of replacing the whole record', async () => {
  const store = createMemoryStorePort();

  await writeMetadataField(store, 'c1', 'modelPreference', 'model-a');
  await writeMetadataField(store, 'c1', 'projectState', { created: true });

  assert.equal(await readModelPreference(store, 'c1'), 'model-a');
  assert.deepEqual(
    await readMetadataField(store, 'c1', 'projectState', (v) => v),
    { created: true },
  );
});

test('assistant content is sanitized on write but user content is left alone', async () => {
  const store = createMemoryStorePort();
  const sanitize = (value: string) => value.replace(/secret/g, '[redacted]');

  await appendConversationTurn(store, 'c1', 'assistant', 'a secret value', sanitize);
  await appendConversationTurn(store, 'c1', 'user', 'a secret value', sanitize);

  const history = await readHistory(store, 'c1');
  assert.equal(history[0]?.content, 'a [redacted] value');
  assert.equal(history[1]?.content, 'a secret value');
});

test('an absent model preference reads as empty string, and is trimmed', async () => {
  const store = createMemoryStorePort();
  assert.equal(await readModelPreference(store, 'fresh'), '');

  await writeMetadataField(store, 'c1', 'modelPreference', '  spaced-model  ');
  assert.equal(await readModelPreference(store, 'c1'), 'spaced-model');
});

test('conversation state depends on the port, never on a host context', async () => {
  const source = await import('node:fs/promises')
    .then((fs) => fs.readFile('agents/core/_conversation-state.ts', 'utf8'));
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  assert.doesNotMatch(code, /context/);
  assert.doesNotMatch(code, /sandbox/);
});
