import type { SessionStore } from '@anthropic-ai/claude-agent-sdk';
import { writeMetadataField, writeMetadataFields } from './core/_conversation-state.ts';
import { tryCreateMakersStorePort } from './core/adapters/_makers.ts';
import type { FileTreeItem } from './_types.ts';

export type ClaudeSessionBinding = {
  resume?: string;
  sessionId?: string;
};

export type ResolveClaudeSessionOptions = {
  conversationId?: string;
  store?: {
    claudeSessionBinding?: (id: string) => Promise<unknown>;
    getConversation?: (input: { conversationId: string }) => Promise<{
      metadata?: Record<string, unknown>;
    } | null>;
  } | null;
  reset?: boolean;
  storedSessionId?: string;
};

/** Id of a session known to have a transcript, so a turn may resume it. */
const STARTED_SESSION_FIELD = 'sdkSessionId';
/**
 * Id the next turn should open a *fresh* session on. Written when a session is
 * discarded, so the replacement lands on a clean key rather than back on the
 * one whose transcript could not be read.
 */
const NEXT_SESSION_FIELD = 'sdkSessionNextId';

export const EXISTING_FILE_LIST_LIMIT = 80;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeClaudeSessionUuid(id: string): string | null {
  const trimmed = id.trim();
  if (!trimmed) {
    return null;
  }
  if (UUID_RE.test(trimmed)) {
    return trimmed.toLowerCase();
  }
  const hex = trimmed.replace(/[^0-9a-f]/gi, '').padEnd(32, '0').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function formatExistingFilePaths(
  items: Array<Pick<FileTreeItem, 'path' | 'type'>>,
  limit = EXISTING_FILE_LIST_LIMIT,
): string[] {
  return items
    .filter((item) => item.type === 'file' && item.path)
    .map((item) => item.path)
    .slice(0, limit);
}

export function buildExistingProjectGuidance(options: {
  isNewProject: boolean;
  sessionResumed: boolean;
  existingFiles?: string[];
}): string {
  if (options.isNewProject) {
    return '';
  }

  if (options.sessionResumed) {
    return [
      'This turn continues the same Claude session.',
      'Earlier turns already wrote and read the project files; those contents are still in this conversation.',
      'Do not call files_list to scan the project, and do not files_read files you already wrote or read.',
      'Only files_read a file when you need its current contents to edit it and that content is not already in this session.',
      'Then make the smallest complete change needed for the user request.',
    ].join(' ');
  }

  const files = (options.existingFiles || []).filter(Boolean);
  const listing = files.length > 0
    ? `Existing project files (paths only, no contents):\n${files.map((path) => `- ${path}`).join('\n')}`
    : '';
  const readRule = [
    'Make the smallest complete change needed for the user request.',
    'Do not files_list the whole project.',
    'Only files_read the files you will change for this request.',
  ].join(' ');
  return listing ? `${listing}\n${readRule}` : readRule;
}

function extractBindingSessionId(binding: unknown): string {
  if (typeof binding === 'string') {
    return binding.trim();
  }
  if (binding && typeof binding === 'object') {
    const sessionId = (binding as { sessionId?: unknown }).sessionId;
    if (typeof sessionId === 'string') {
      return sessionId.trim();
    }
  }
  return '';
}

type StoredSessionFields = {
  /** Resumable id, or '' when this conversation has no started session. */
  started: string;
  /** Id to open fresh, or '' when there is no discarded session to replace. */
  next: string;
};

/** One metadata read serving both session fields. */
async function readStoredSessionFields(
  store: ResolveClaudeSessionOptions['store'],
  conversationId: string,
): Promise<StoredSessionFields> {
  if (typeof store?.getConversation !== 'function') {
    return { started: '', next: '' };
  }
  try {
    const conversation = await store.getConversation({ conversationId });
    const metadata = conversation?.metadata;
    const read = (field: string) => {
      const value = metadata?.[field];
      return typeof value === 'string' ? value.trim() : '';
    };
    return {
      started: read(STARTED_SESSION_FIELD),
      next: read(NEXT_SESSION_FIELD),
    };
  } catch (error: any) {
    if (error?.code === 'MemoryNotFoundError') {
      return { started: '', next: '' };
    }
    throw error;
  }
}

/** The id a not-yet-started conversation should open its session on. */
async function resolveUnstartedSessionId(
  store: ResolveClaudeSessionOptions['store'],
  conversationId: string,
): Promise<string> {
  if (typeof store?.claudeSessionBinding === 'function') {
    try {
      const binding = await store.claudeSessionBinding(conversationId);
      const sessionId = extractBindingSessionId(binding);
      if (sessionId) {
        return sessionId;
      }
    } catch {
      // Fall through to UUID normalisation when the mapping API is unavailable.
    }
  }

  return normalizeClaudeSessionUuid(conversationId) || '';
}

async function resolveBoundSessionId(
  options: ResolveClaudeSessionOptions,
  conversationId: string,
): Promise<string> {
  if (options.storedSessionId?.trim()) {
    return options.storedSessionId.trim();
  }

  const stored = await readStoredSessionFields(options.store, conversationId);
  if (stored.started) {
    return stored.started;
  }
  if (stored.next) {
    return stored.next;
  }

  return resolveUnstartedSessionId(options.store, conversationId);
}

/**
 * Decide whether this turn resumes the conversation's Claude session.
 *
 * A persisted `sdkSessionId` is only written once the SDK has actually opened
 * the session (see `markSessionStarted`), so its presence is already evidence
 * that a transcript exists. Confirming that against the store would mean a full
 * transcript load — the platform session store reads one key per mirrored frame,
 * strongly consistent and serially — on the critical path before the model is
 * asked anything, and that cost grows for the life of the conversation.
 */
export async function resolveClaudeSessionBinding(
  options: ResolveClaudeSessionOptions,
): Promise<ClaudeSessionBinding> {
  const conversationId = options.conversationId?.trim() || '';
  if (!conversationId) {
    return {};
  }

  if (options.reset) {
    return { sessionId: crypto.randomUUID() };
  }

  const override = options.storedSessionId?.trim();
  if (override) {
    return { resume: override };
  }

  const stored = await readStoredSessionFields(options.store, conversationId);
  if (stored.started) {
    return { resume: stored.started };
  }
  if (stored.next) {
    return { sessionId: stored.next };
  }

  const sessionId = await resolveUnstartedSessionId(options.store, conversationId);
  return sessionId ? { sessionId } : {};
}

export async function readBoundSdkSessionId(
  context: any,
  conversationId: string,
): Promise<string> {
  const trimmed = conversationId.trim();
  if (!trimmed) {
    return '';
  }
  return resolveBoundSessionId({
    conversationId: trimmed,
    store: tryCreateMakersStorePort(context),
  }, trimmed);
}

export async function persistConversationSdkSession(
  context: any,
  conversationId: string,
  sessionId: string,
) {
  const trimmed = sessionId.trim();
  const store = tryCreateMakersStorePort(context);
  if (!trimmed || !store) {
    return;
  }
  await writeMetadataField(store, conversationId, STARTED_SESSION_FIELD, trimmed);
}

export async function resolveAgentSdkSession(
  context: any,
  conversationId: string,
  options: { reset?: boolean } = {},
): Promise<{
  binding: ClaudeSessionBinding;
  sessionStore: SessionStore | undefined;
  sessionResumed: boolean;
  /**
   * Record the id once the SDK has opened the session. Writing it before the
   * query runs would leave behind an id that no transcript backs, and the next
   * turn would resume into nothing.
   */
  markSessionStarted: () => Promise<void>;
  /**
   * Discard this session. The replacement id is recorded now so the next turn
   * opens a clean session instead of landing back on the transcript that just
   * failed to load.
   */
  forgetSession: () => Promise<void>;
}> {
  const store = tryCreateMakersStorePort(context);
  const sessionStore = store?.claudeSessionStore?.() as SessionStore | undefined;

  const binding = await resolveClaudeSessionBinding({
    conversationId,
    store,
    reset: options.reset === true,
  });

  const sessionId = binding.resume || binding.sessionId || '';
  // A resumed id is already recorded as started, so re-writing it every turn
  // would only add a store round trip.
  let started = Boolean(binding.resume);

  return {
    binding,
    sessionStore,
    sessionResumed: Boolean(binding.resume),
    async markSessionStarted() {
      if (started || !sessionId || !store) {
        return;
      }
      started = true;
      // This id is the started one now, so any pending replacement is spent.
      await writeMetadataFields(store, conversationId, {
        [STARTED_SESSION_FIELD]: sessionId,
        [NEXT_SESSION_FIELD]: '',
      });
    },
    async forgetSession() {
      if (!store) {
        return;
      }
      started = false;
      await writeMetadataFields(store, conversationId, {
        [STARTED_SESSION_FIELD]: '',
        [NEXT_SESSION_FIELD]: crypto.randomUUID(),
      });
    },
  };
}
