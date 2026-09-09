import type { SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';

/**
 * Injectable `getSessionInfo`. Loading a whole transcript is deliberate here —
 * this is the export endpoint, not the per-turn agent path, which resolves its
 * session without touching the transcript at all.
 */
export type GetSessionInfoFn = (
  sessionId: string,
  options: { dir?: string; sessionStore?: SessionStore },
) => Promise<unknown>;

export type LoadClaudeSessionEntriesOptions = {
  sessionStore: SessionStore;
  sessionId: string;
  cwd?: string;
  extraProjectKeys?: string[];
  getSessionInfo?: GetSessionInfoFn;
};

/**
 * Claude session store keys default to a sanitized cwd. Paths longer than 200
 * characters are truncated and suffixed with a portable djb2 hash (SDK contract).
 */
export function encodeClaudeProjectKey(dir: string): string {
  const sanitized = dir.replace(/[^a-zA-Z0-9]/g, '-');
  if (sanitized.length <= 200) {
    return sanitized;
  }
  return `${sanitized.slice(0, 191)}-${djb2Hex(dir)}`;
}

function djb2Hex(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16);
}

async function defaultGetSessionInfo(
  sessionId: string,
  options: { dir?: string; sessionStore?: SessionStore },
) {
  const { getSessionInfo } = await import('@anthropic-ai/claude-agent-sdk');
  return getSessionInfo(sessionId, options);
}

function wrapSessionStore(
  sessionStore: SessionStore,
  onLoad: (entries: SessionStoreEntry[] | null) => void,
): SessionStore {
  return {
    append: (key, entries) => sessionStore.append(key, entries),
    load: async (key) => {
      const entries = await sessionStore.load(key);
      onLoad(entries);
      return entries;
    },
    listSessions: sessionStore.listSessions
      ? (projectKey) => sessionStore.listSessions!(projectKey)
      : undefined,
    listSessionSummaries: sessionStore.listSessionSummaries
      ? (projectKey) => sessionStore.listSessionSummaries!(projectKey)
      : undefined,
    delete: sessionStore.delete
      ? (key) => sessionStore.delete!(key)
      : undefined,
    listSubkeys: sessionStore.listSubkeys
      ? (key) => sessionStore.listSubkeys!(key)
      : undefined,
  };
}

/**
 * Load the raw Claude JSONL entries for a session. Prefers intercepting the
 * same `getSessionInfo` load the resume path uses (correct projectKey), then
 * falls back to cwd / conversation-scoped keys if that helper never called load.
 */
export async function loadClaudeSessionEntries(
  options: LoadClaudeSessionEntriesOptions,
): Promise<SessionStoreEntry[] | null> {
  const sessionId = options.sessionId.trim();
  if (!sessionId) {
    return null;
  }

  let captured: SessionStoreEntry[] | null | undefined;
  const probingStore = wrapSessionStore(options.sessionStore, (entries) => {
    captured = entries;
  });
  const getSessionInfo = options.getSessionInfo || defaultGetSessionInfo;
  try {
    await getSessionInfo(sessionId, {
      dir: options.cwd,
      sessionStore: probingStore,
    });
  } catch {
    // Missing or corrupt transcripts still return whatever load() produced.
  }
  if (captured !== undefined) {
    return captured;
  }

  const projectKeys = [
    options.cwd ? encodeClaudeProjectKey(options.cwd) : '',
    ...(options.extraProjectKeys || []),
  ].filter(Boolean);
  const seen = new Set<string>();
  for (const projectKey of projectKeys) {
    if (seen.has(projectKey)) continue;
    seen.add(projectKey);
    const entries = await options.sessionStore.load({ projectKey, sessionId });
    if (entries) {
      return entries;
    }
  }
  return null;
}
