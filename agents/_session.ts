import type { SessionStore } from '@anthropic-ai/claude-agent-sdk';
import type { FileTreeItem } from './_types';

export type ClaudeSessionBinding = {
  resume?: string;
  sessionId?: string;
};

export type GetSessionInfoFn = (
  sessionId: string,
  options: { dir?: string; sessionStore?: SessionStore },
) => Promise<unknown>;

export type ResolveClaudeSessionOptions = {
  conversationId?: string;
  store?: {
    claudeSessionBinding?: (id: string) => Promise<unknown>;
    getConversation?: (input: { conversationId: string }) => Promise<{
      metadata?: { sdkSessionId?: unknown };
    } | null>;
  } | null;
  sessionStore?: SessionStore;
  cwd?: string;
  reset?: boolean;
  storedSessionId?: string;
  getSessionInfo?: GetSessionInfoFn;
};

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
      'If ensure_project_scaffold returns created=false, this turn continues the same Claude session.',
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
    'If ensure_project_scaffold returns created=false, make the smallest complete change needed for the user request.',
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

function isMemoryCorruptError(error: unknown): boolean {
  const record = error && typeof error === 'object'
    ? error as { code?: string; name?: string }
    : {};
  return record.code === 'MemoryCorruptError' || record.name === 'MemoryCorruptError';
}

async function defaultGetSessionInfo(
  sessionId: string,
  options: { dir?: string; sessionStore?: SessionStore },
) {
  const { getSessionInfo } = await import('@anthropic-ai/claude-agent-sdk');
  return getSessionInfo(sessionId, options);
}

async function loadStoredSdkSessionId(
  store: ResolveClaudeSessionOptions['store'],
  conversationId: string,
): Promise<string> {
  if (typeof store?.getConversation !== 'function') {
    return '';
  }
  try {
    const conversation = await store.getConversation({ conversationId });
    const stored = conversation?.metadata?.sdkSessionId;
    return typeof stored === 'string' ? stored.trim() : '';
  } catch (error: any) {
    if (error?.code === 'MemoryNotFoundError') {
      return '';
    }
    throw error;
  }
}

async function resolveBoundSessionId(
  options: ResolveClaudeSessionOptions,
  conversationId: string,
): Promise<string> {
  if (options.storedSessionId?.trim()) {
    return options.storedSessionId.trim();
  }

  const stored = await loadStoredSdkSessionId(options.store, conversationId);
  if (stored) {
    return stored;
  }

  if (typeof options.store?.claudeSessionBinding === 'function') {
    try {
      const binding = await options.store.claudeSessionBinding(conversationId);
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

async function lookupSessionInfo(
  sessionId: string,
  options: ResolveClaudeSessionOptions,
): Promise<unknown> {
  const getSessionInfo = options.getSessionInfo || defaultGetSessionInfo;
  const infoOptions: { dir?: string; sessionStore?: SessionStore } = {};
  if (options.cwd) {
    infoOptions.dir = options.cwd;
  }
  if (options.sessionStore) {
    infoOptions.sessionStore = options.sessionStore;
  }
  return getSessionInfo(sessionId, infoOptions);
}

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

  const sessionId = await resolveBoundSessionId(options, conversationId);
  if (!sessionId) {
    return {};
  }

  try {
    const info = await lookupSessionInfo(sessionId, options);
    if (info) {
      return { resume: sessionId };
    }
  } catch (error) {
    if (isMemoryCorruptError(error)) {
      return { sessionId: crypto.randomUUID() };
    }
  }

  return { sessionId };
}

export async function persistConversationSdkSession(
  context: any,
  conversationId: string,
  sessionId: string,
) {
  const trimmed = sessionId.trim();
  if (!trimmed || !context?.store?.updateConversation) {
    return;
  }
  try {
    await context.store.updateConversation({
      conversationId,
      metadata: { sdkSessionId: trimmed },
    });
  } catch (error: any) {
    if (error?.code !== 'MemoryNotFoundError') {
      throw error;
    }
  }
}

export async function resolveAgentSdkSession(
  context: any,
  conversationId: string,
  options: { reset?: boolean; cwd?: string; getSessionInfo?: GetSessionInfoFn } = {},
): Promise<{
  binding: ClaudeSessionBinding;
  sessionStore: SessionStore | undefined;
  sessionResumed: boolean;
}> {
  const store = context?.store;
  const sessionStore = typeof store?.claudeSessionStore === 'function'
    ? store.claudeSessionStore() as SessionStore
    : undefined;

  const binding = await resolveClaudeSessionBinding({
    conversationId,
    store,
    sessionStore,
    cwd: options.cwd || process.cwd(),
    reset: options.reset === true,
    getSessionInfo: options.getSessionInfo,
  });

  const sessionId = binding.resume || binding.sessionId;
  if (sessionId) {
    await persistConversationSdkSession(context, conversationId, sessionId);
  }

  return {
    binding,
    sessionStore,
    sessionResumed: Boolean(binding.resume),
  };
}
