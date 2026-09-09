import { createProjectState } from './_project.ts';
import { createMakersStorePort } from './core/adapters/_makers.ts';
import {
  ACTIVITY_ITEM_LIMIT,
  ACTIVITY_TURN_LIMIT,
  appendConversationTurn,
  readHistory,
  readMetadataField,
  readMetadataFields,
  readModelPreference,
  writeMetadataField,
  writeMetadataFieldStrict,
  writeMetadataFieldsStrict,
} from './core/_conversation-state.ts';
import type {
  ChatTask,
  ConversationMessage,
  PersistedActivityTurn,
  LegacyProjectSnapshot,
  ProjectState,
} from './_types.ts';
import { sanitizeAssistantText } from './utils/_text.ts';
import { appendTrimmedActivityTurn, dedupeActivityTurns } from './utils/_activity.ts';

// Makers file routing hands every endpoint a `context`. These wrappers translate
// it once and delegate to the port-based core, so the 11 existing call sites
// keep their signatures while the logic itself is host-agnostic.
const portFor = (context: any) => createMakersStorePort(context);

export async function getHistory(
  context: any,
  conversationId: string,
  options: { excludeLatestUserMessage?: string } = {},
): Promise<ConversationMessage[]> {
  return readHistory(portFor(context), conversationId, options);
}

function parseChatTask(value: unknown): ChatTask | null {
  return value && typeof value === 'object' && typeof (value as ChatTask).id === 'string'
    ? value as ChatTask
    : null;
}

export async function getChatTask(context: any, conversationId: string): Promise<ChatTask | null> {
  const task = await readMetadataField(portFor(context), conversationId, 'chatTask', (value) =>
    parseChatTask(value) ?? undefined,
  );
  return task ?? null;
}

export async function saveChatTask(context: any, conversationId: string, task: ChatTask) {
  // Deliberately not swallowing MemoryNotFoundError: /chat persists the user
  // message first, so the conversation exists and a failure here is real.
  await writeMetadataFieldStrict(portFor(context), conversationId, 'chatTask', task);
}

/**
 * The two pieces of conversation state a turn needs before it can start.
 *
 * Read together because getConversation returns the whole metadata document:
 * asking for the task and the model separately fetches that document twice, on
 * the critical path, before the request has even been acknowledged.
 */
export function getTurnStartState(
  context: any,
  conversationId: string,
): Promise<{ task: ChatTask | null; model: string }> {
  return readMetadataFields(portFor(context), conversationId, (metadata) => ({
    task: parseChatTask(metadata.chatTask),
    model: typeof metadata.modelPreference === 'string' ? metadata.modelPreference.trim() : '',
  }));
}

/**
 * Record the task, and the model it runs on, in one write.
 *
 * `model` is only persisted when the request named one; otherwise the
 * conversation keeps the preference it already had.
 */
export async function saveTurnStart(
  context: any,
  conversationId: string,
  task: ChatTask,
  model: string,
) {
  await writeMetadataFieldsStrict(portFor(context), conversationId, {
    chatTask: task,
    ...(model ? { modelPreference: model } : {}),
  });
}

/**
 * The model this conversation last ran on. Persisted so a refresh can restore
 * the picker, and so a turn that arrives without an explicit choice still runs
 * on the model the conversation has been using rather than silently reverting
 * to the deployment default.
 */
export async function getModelPreference(
  context: any,
  conversationId: string,
): Promise<string> {
  return readModelPreference(portFor(context), conversationId);
}

export async function appendTurn(
  context: any,
  conversationId: string,
  role: 'user' | 'assistant',
  content: string,
) {
  // Sanitize assistant content before writing history so control sequences or raw
  // JSON from new concatenation paths do not pollute the next prompt.
  await appendConversationTurn(
    portFor(context),
    conversationId,
    role,
    content,
    sanitizeAssistantText,
  );
}

export async function getProjectState(context: any, conversationId: string): Promise<ProjectState> {
  // Project state is conversation metadata, not a chat message. On first access
  // the conversation may not exist yet, so fall back to the default state.
  const stored = await readMetadataField(portFor(context), conversationId, 'projectState', (value) =>
    value && typeof value === 'object' ? value as ProjectState : undefined,
  );
  return stored ?? createProjectState(conversationId);
}

export async function saveProjectState(
  context: any,
  conversationId: string,
  state: ProjectState,
) {
  // updateConversation shallow-merges metadata; replace projectState as a whole.
  await writeMetadataField(portFor(context), conversationId, 'projectState', state);
}

// Read-only compatibility for snapshots written by template versions that stored
// the archive in conversation metadata. New writes use context.sandbox.persist().
export async function getLegacyProjectSnapshot(
  context: any,
  conversationId: string,
): Promise<LegacyProjectSnapshot | null> {
  const stored = await readMetadataField(portFor(context), conversationId, 'projectSnapshot', (value) => {
    const snapshot = value as LegacyProjectSnapshot | undefined;
    return snapshot
      && typeof snapshot === 'object'
      && typeof snapshot.base64 === 'string'
      && snapshot.base64
      ? snapshot
      : undefined;
  });
  return stored ?? null;
}

export async function clearLegacyProjectSnapshot(context: any, conversationId: string) {
  await writeMetadataField(portFor(context), conversationId, 'projectSnapshot', null);
}

export async function getActivityHistory(
  context: any,
  conversationId: string,
): Promise<PersistedActivityTurn[]> {
  const stored = await readMetadataField(portFor(context), conversationId, 'activityHistory', (value) =>
    Array.isArray(value) ? value as PersistedActivityTurn[] : undefined,
  );
  return stored ? dedupeActivityTurns(stored.slice(-ACTIVITY_TURN_LIMIT)) : [];
}

export async function saveActivityTurn(
  context: any,
  conversationId: string,
  turn: PersistedActivityTurn,
) {
  const current = await getActivityHistory(context, conversationId);
  const next = appendTrimmedActivityTurn(
    current,
    turn,
    ACTIVITY_TURN_LIMIT,
    ACTIVITY_ITEM_LIMIT,
  );
  await writeMetadataField(portFor(context), conversationId, 'activityHistory', next);
}
