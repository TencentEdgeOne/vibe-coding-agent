import { getStore } from '@edgeone/pages-blob';
import { createProjectState } from '../project/state.ts';
import { assertCanWrite, heldEpoch } from './ownership.ts';
import type { BlobStoreLike, PersistCapable } from '../runtime/context.ts';
import type { ChatTask, ProjectState } from '../types.ts';

const BLOB_STORE_NAME = 'vibe-sessions';

export type ConversationRecord = {
  /** Latest epoch the writer of this record held. A hint: newer ones may exist. */
  epoch?: number;
  claudeSessionId?: string;
  transcriptPath?: string;
  modelPreference?: string;
  languagePreference?: 'zh' | 'en';
  projectState: ProjectState;
  chatTask?: ChatTask | null;
};

function conversationKey(conversationId: string) {
  return `conv/${conversationId}/state.json`;
}

export function transcriptBlobKey(sessionId: string) {
  return `sessions/${sessionId}.jsonl`;
}

/** `@edgeone/pages-blob` throws this code when an `onlyIfNew` write finds the key taken. */
export const PRECONDITION_FAILED = 'PRECONDITION_FAILED';

export function isPreconditionFailed(error: unknown) {
  return Boolean(error) && (error as { code?: unknown }).code === PRECONDITION_FAILED;
}

function preconditionFailed() {
  return Object.assign(new Error('conditional write failed (key already exists)'), {
    code: PRECONDITION_FAILED,
  });
}

export function createMemoryBlobStore(): BlobStoreLike {
  const data = new Map<string, { kind: 'json' | 'bytes'; value: unknown }>();
  return {
    async set(key, value, options) {
      if (options?.onlyIfNew && data.has(key)) throw preconditionFailed();
      if (typeof value === 'string') {
        data.set(key, { kind: 'bytes', value });
        return;
      }
      if (value instanceof ReadableStream) {
        const reader = value.getReader();
        const chunks: Uint8Array[] = [];
        while (true) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          if (chunk) chunks.push(chunk);
        }
        const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        data.set(key, { kind: 'bytes', value: Buffer.from(bytes).toString('utf8') });
        return;
      }
      if (value instanceof ArrayBuffer) {
        data.set(key, { kind: 'bytes', value: Buffer.from(value).toString('utf8') });
        return;
      }
      data.set(key, { kind: 'bytes', value: String(value) });
    },
    // Stored as text and parsed on every read, like the real store: two reads
    // return two objects, never one shared reference.
    async setJSON(key, value, options) {
      if (options?.onlyIfNew && data.has(key)) throw preconditionFailed();
      data.set(key, { kind: 'json', value: JSON.stringify(value) });
    },
    async get(key, options) {
      const entry = data.get(key);
      if (!entry) return null;
      const text = String(entry.value);
      if (options?.type === 'stream') {
        return new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(text));
            controller.close();
          },
        });
      }
      if (options?.type === 'json' || entry.kind === 'json') return JSON.parse(text);
      return text;
    },
    async delete(key) {
      data.delete(key);
    },
    async list(options) {
      const prefix = options?.prefix || '';
      return {
        blobs: [...data.keys()]
          .filter((key) => key.startsWith(prefix))
          .map((key) => ({ key })),
      };
    },
  };
}

export function getBlobStore(context?: PersistCapable): BlobStoreLike {
  if (context?.blobStore) return context.blobStore;
  return (getStore as unknown as (options: { name: string; consistency: 'strong' }) => BlobStoreLike)({
    name: BLOB_STORE_NAME,
    consistency: 'strong',
  });
}

/**
 * Outside the owner, one wake reads `conv/{id}/state.json` about a dozen times
 * over strong-consistency Blob. The request `context` is the natural lifetime
 * for a memo of it: a WeakMap on it cannot outlive the request or leak across
 * conversations.
 */
const recordCache = new WeakMap<object, Map<string, ConversationRecord>>();

type RecordHost = { epoch: number; record: ConversationRecord; writing: Promise<void> };

/** Owner copies per Blob store, so contexts with their own store do not share. */
const DEFAULT_SCOPE = {};
const hostsByScope = new WeakMap<object, Map<string, RecordHost>>();

function hostsFor(context: { blobStore?: BlobStoreLike }) {
  const scope: BlobStoreLike | object = context.blobStore ?? DEFAULT_SCOPE;
  let hosts = hostsByScope.get(scope);
  if (!hosts) {
    hosts = new Map();
    hostsByScope.set(scope, hosts);
  }
  return hosts;
}

/**
 * The owner's copy of the record. While this process holds the conversation's
 * epoch it is the only writer, so its in-memory record is the truth: every
 * request reads the same object, a patch applies to it at once, and a write
 * sends it whole. There is no read-modify-write left for two requests to race.
 */
function ownerHost(context: { blobStore?: BlobStoreLike }, conversationId: string) {
  const hosts = hostsFor(context);
  const host = hosts.get(conversationId);
  if (!host) return undefined;
  if (heldEpoch(context, conversationId) === host.epoch) return host;
  hosts.delete(conversationId);
  return undefined;
}

/** Writes go out one after another, each carrying the latest record. */
async function writeHost(context: { blobStore?: BlobStoreLike }, conversationId: string, host: RecordHost) {
  const write = host.writing.then(() => (
    getBlobStore(context).setJSON(conversationKey(conversationId), host.record)
  ));
  host.writing = write.catch(() => undefined);
  await write;
  recordCacheFor(context)?.set(conversationId, host.record);
}

function mergeRecord(current: ConversationRecord, patch: Partial<ConversationRecord>): ConversationRecord {
  return { ...current, ...patch, projectState: patch.projectState || current.projectState };
}

function recordCacheFor(context: { blobStore?: BlobStoreLike }) {
  if (!context || typeof context !== 'object') return null;
  const existing = recordCache.get(context);
  if (existing) return existing;
  const created = new Map<string, ConversationRecord>();
  recordCache.set(context, created);
  return created;
}

export async function getConversationRecord(
  context: { blobStore?: BlobStoreLike },
  conversationId: string,
  /** `refresh` is for callers that poll for another writer's field. */
  options: { refresh?: boolean } = {},
): Promise<ConversationRecord> {
  // The owner has no other writer to poll for, so even a refresh reads its copy.
  const host = ownerHost(context, conversationId);
  if (host) return host.record;
  const cache = recordCacheFor(context);
  if (!options.refresh) {
    const cached = cache?.get(conversationId);
    if (cached) return cached;
  }
  const stored = await getBlobStore(context).get(conversationKey(conversationId), { type: 'json' });
  const record = stored
    && typeof stored === 'object'
    && (stored as ConversationRecord).projectState
    && typeof (stored as ConversationRecord).projectState === 'object'
    ? stored as ConversationRecord
    : { projectState: createProjectState(conversationId) };
  cache?.set(conversationId, record);
  return record;
}

/**
 * The record a new owner starts from, written whole. Replaces any copy this
 * process kept from an earlier epoch.
 */
export async function adoptConversationRecord(
  context: { blobStore?: BlobStoreLike; epoch?: number },
  conversationId: string,
  record: ConversationRecord,
) {
  await assertCanWrite(context, conversationId);
  const host: RecordHost = { epoch: context.epoch as number, record, writing: Promise.resolve() };
  hostsFor(context).set(conversationId, host);
  await writeHost(context, conversationId, host);
}

/** Every record write passes the ownership guard: a replaced owner cannot write. */
export async function patchConversationRecord(
  context: { blobStore?: BlobStoreLike; epoch?: number },
  conversationId: string,
  patch: Partial<ConversationRecord>,
) {
  const held = ownerHost(context, conversationId);
  if (held) {
    // Applied before any await, so a concurrent patch builds on this one.
    held.record = mergeRecord(held.record, patch);
    await assertCanWrite(context, conversationId);
    await writeHost(context, conversationId, held);
    return held.record;
  }

  const current = await getConversationRecord(context, conversationId, { refresh: true });
  // Entering may claim the conversation, and a claim adopts a fresh record.
  await assertCanWrite(context, conversationId);
  const adopted = ownerHost(context, conversationId);
  const host: RecordHost = adopted ?? {
    epoch: context.epoch as number,
    record: current,
    writing: Promise.resolve(),
  };
  host.record = mergeRecord(host.record, patch);
  hostsFor(context).set(conversationId, host);
  await writeHost(context, conversationId, host);
  return host.record;
}

export async function getProjectState(context: { blobStore?: BlobStoreLike }, conversationId: string) {
  return (await getConversationRecord(context, conversationId)).projectState;
}

export async function saveProjectState(
  context: { blobStore?: BlobStoreLike },
  conversationId: string,
  state: ProjectState,
) {
  await patchConversationRecord(context, conversationId, { projectState: state });
}

export async function getChatTask(context: { blobStore?: BlobStoreLike }, conversationId: string) {
  return (await getConversationRecord(context, conversationId)).chatTask || null;
}

export async function saveChatTask(
  context: { blobStore?: BlobStoreLike },
  conversationId: string,
  task: ChatTask | null,
) {
  await patchConversationRecord(context, conversationId, { chatTask: task });
}
