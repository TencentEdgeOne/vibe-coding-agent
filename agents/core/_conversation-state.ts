/**
 * Conversation persistence, expressed against ports.
 *
 * This is agents/_memory.ts with `context` replaced by ConversationStorePort.
 * The logic is unchanged; only the dependency is. Keeping the behavior
 * bit-for-bit identical is the point — `_memory.ts` now delegates here, so any
 * drift would be a live regression rather than a refactor detail.
 *
 * The recurring `MemoryNotFoundError` swallow is preserved throughout: until
 * the first appendMessage creates the conversation, updateConversation has
 * nothing to merge into, and that race is normal on a first turn.
 */

import type { ConversationStorePort } from './_ports.ts';

export const HISTORY_FETCH_LIMIT = 50;
export const ACTIVITY_TURN_LIMIT = 25;
export const ACTIVITY_ITEM_LIMIT = 50;

export type ConversationTurn = {
  role: 'user' | 'assistant';
  content: string;
};

function isMissingConversation(error: unknown) {
  return (error as { code?: string })?.code === 'MemoryNotFoundError';
}

/** Read conversation metadata, treating a not-yet-created conversation as empty. */
async function readMetadata(
  store: ConversationStorePort,
  conversationId: string,
): Promise<Record<string, unknown>> {
  try {
    const conversation = await store.getConversation({ conversationId });
    const metadata = conversation?.metadata;
    return metadata && typeof metadata === 'object' ? metadata : {};
  } catch (error) {
    if (isMissingConversation(error)) return {};
    throw error;
  }
}

/** Merge metadata, tolerating the first-turn race where the conversation is absent. */
async function mergeMetadata(
  store: ConversationStorePort,
  conversationId: string,
  metadata: Record<string, unknown>,
) {
  try {
    await store.updateConversation({ conversationId, metadata });
  } catch (error) {
    if (!isMissingConversation(error)) throw error;
  }
}

export async function readMetadataField<T>(
  store: ConversationStorePort,
  conversationId: string,
  field: string,
  parse: (value: unknown) => T | undefined,
): Promise<T | undefined> {
  return parse((await readMetadata(store, conversationId))[field]);
}

/**
 * Several fields from a single metadata read.
 *
 * getConversation returns the whole metadata document, so reading two fields
 * with two calls fetches the same payload twice — and that payload grows with
 * the conversation.
 */
export async function readMetadataFields<T>(
  store: ConversationStorePort,
  conversationId: string,
  parse: (metadata: Record<string, unknown>) => T,
): Promise<T> {
  return parse(await readMetadata(store, conversationId));
}

export function writeMetadataField(
  store: ConversationStorePort,
  conversationId: string,
  field: string,
  value: unknown,
) {
  return mergeMetadata(store, conversationId, { [field]: value });
}

/**
 * Same write for several fields at once.
 *
 * Fields that must move together belong in one merge: two sequential writes
 * cost two round trips and leave a window where a reader sees one applied and
 * the other not.
 */
export function writeMetadataFields(
  store: ConversationStorePort,
  conversationId: string,
  fields: Record<string, unknown>,
) {
  return mergeMetadata(store, conversationId, fields);
}

/**
 * Same write, but surfacing every error including a missing conversation.
 *
 * Used where the caller knows the conversation already exists, so
 * MemoryNotFoundError would indicate a real fault rather than the first-turn
 * race that `writeMetadataField` deliberately tolerates.
 */
export function writeMetadataFieldStrict(
  store: ConversationStorePort,
  conversationId: string,
  field: string,
  value: unknown,
) {
  return store.updateConversation({ conversationId, metadata: { [field]: value } });
}

/** Same strict write, for fields that must land together. */
export function writeMetadataFieldsStrict(
  store: ConversationStorePort,
  conversationId: string,
  fields: Record<string, unknown>,
) {
  return store.updateConversation({ conversationId, metadata: fields });
}

/**
 * Conversation history as user/assistant text pairs.
 *
 * `excludeLatestUserMessage` drops the message /chat already persisted before
 * the detached task started; the pipeline passes it separately as the current
 * turn, so leaving it here would duplicate it in the prompt.
 */
export async function readHistory(
  store: ConversationStorePort,
  conversationId: string,
  options: { excludeLatestUserMessage?: string } = {},
): Promise<ConversationTurn[]> {
  let raw;
  try {
    raw = await store.getMessages({
      conversationId,
      limit: HISTORY_FETCH_LIMIT,
      order: 'asc',
    });
  } catch (error) {
    if (isMissingConversation(error)) return [];
    throw error;
  }

  const items = Array.isArray(raw) ? raw : (raw?.items || []);
  const history = items
    .filter((item) => item.role === 'user' || item.role === 'assistant')
    .map((item) => ({
      role: item.role as 'user' | 'assistant',
      content: typeof item.content === 'string'
        ? item.content
        : JSON.stringify(item.content ?? ''),
    }));

  const currentMessage = options.excludeLatestUserMessage;
  const last = history.at(-1);
  if (currentMessage && last?.role === 'user' && last.content === currentMessage) {
    history.pop();
  }
  return history;
}

export async function appendConversationTurn(
  store: ConversationStorePort,
  conversationId: string,
  role: 'user' | 'assistant',
  content: string,
  // Injected because sanitizing is a text concern the core does not own.
  sanitize: (value: string) => string = (value) => value,
) {
  await store.appendMessage({
    conversationId,
    role,
    content: role === 'assistant' ? sanitize(content) : content,
  });
}

export function readModelPreference(store: ConversationStorePort, conversationId: string) {
  return readMetadataField(store, conversationId, 'modelPreference', (value) =>
    typeof value === 'string' ? value.trim() : '',
  ).then((value) => value ?? '');
}

export function writeModelPreference(
  store: ConversationStorePort,
  conversationId: string,
  model: string,
) {
  return writeMetadataField(store, conversationId, 'modelPreference', model);
}
