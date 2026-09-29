import assert from 'node:assert/strict';
import test from 'node:test';
import { publishPreview } from '../agents/_lib/project/workspace-store.ts';
import type { BlobStoreLike } from '../agents/_lib/runtime/context.ts';
import { ownerKey } from '../agents/_lib/session/fence.ts';
import { enterConversation } from '../agents/_lib/session/ownership.ts';
import {
  createMemoryBlobStore,
  getConversationRecord,
  getProjectState,
  patchConversationRecord,
  saveProjectState,
  type ConversationRecord,
} from '../agents/_lib/session/store.ts';

async function readRecord(store: BlobStoreLike, id: string) {
  return await store.get(`conv/${id}/state.json`, { type: 'json' }) as ConversationRecord | null;
}

// Each request used to read the record, patch its copy, and write it back, so
// two requests at once dropped whichever field was written first.
test('concurrent writes from different requests keep each other\'s fields', async () => {
  const store = createMemoryBlobStore();
  const id = 'owner-concurrent';
  await enterConversation({ blobStore: store }, id, 'write');

  await Promise.all([
    patchConversationRecord({ blobStore: store }, id, { modelPreference: 'model-a' }),
    patchConversationRecord({ blobStore: store }, id, { languagePreference: 'zh' }),
  ]);

  const saved = await readRecord(store, id);
  assert.equal(saved?.modelPreference, 'model-a');
  assert.equal(saved?.languagePreference, 'zh');
});

test('requests in the owner process share one project state', async () => {
  const store = createMemoryBlobStore();
  const id = 'owner-shared-state';
  await enterConversation({ blobStore: store }, id, 'write');

  const previewRequest = await getProjectState({ blobStore: store }, id);
  const turnRequest = await getProjectState({ blobStore: store }, id);
  assert.equal(previewRequest, turnRequest);

  // The preview panel publishes a URL; the running turn then saves its own
  // change. The URL survives because both wrote the same object.
  publishPreview(previewRequest, { url: 'https://preview.example/app' });
  turnRequest.created = true;
  await saveProjectState({ blobStore: store }, id, turnRequest);

  const saved = await readRecord(store, id);
  assert.equal(saved?.projectState.previewUrl, 'https://preview.example/app');
  assert.equal(saved?.projectState.created, true);
});

test('a process that loses the conversation stops serving its copy', async () => {
  const store = createMemoryBlobStore();
  const id = 'owner-lost-copy';
  const context = { blobStore: store };
  await enterConversation(context, id, 'write');
  await patchConversationRecord(context, id, { modelPreference: 'ours' });

  // A newer owner claims the conversation and writes its own record.
  await store.setJSON(ownerKey(id, 2), { instance: 'other', at: 0, intent: 'write' });
  const theirs = { ...(await readRecord(store, id))!, epoch: 2, modelPreference: 'theirs' };
  await store.setJSON(`conv/${id}/state.json`, theirs);

  // Entering again finds the claim, drops the old copy, and reads Blob.
  const entry = await enterConversation({ blobStore: store }, id, 'read');
  assert.equal(entry.role, 'owner');
  const record = await getConversationRecord({ blobStore: store }, id);
  assert.equal(record.modelPreference, 'theirs');
  assert.equal(record.epoch, 3);
});
