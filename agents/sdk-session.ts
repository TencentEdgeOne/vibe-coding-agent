import { claudeSessionExportFilename, sessionEntriesToJsonl } from '../shared/claude-session-export';
import { readBoundSdkSessionId } from './_session';
import { resolveConversationId } from './utils/_request';
import { loadClaudeSessionEntries } from './utils/_sdk-transcript';

function json(data: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export async function onRequestGet(context: any) {
  const { conversationId } = resolveConversationId(context);
  if (!conversationId) {
    return json({ ok: false, error: 'missing conversation_id' }, 400);
  }

  const store = context?.store;
  const sessionStore = typeof store?.claudeSessionStore === 'function'
    ? store.claudeSessionStore()
    : undefined;
  if (!sessionStore || typeof sessionStore.load !== 'function') {
    return json({ ok: false, error: 'claude session store is unavailable' }, 404);
  }

  const sessionId = await readBoundSdkSessionId(context, conversationId);
  if (!sessionId) {
    return json({ ok: false, error: 'no claude session' }, 404);
  }

  let entries;
  try {
    entries = await loadClaudeSessionEntries({
      sessionStore,
      sessionId,
      cwd: process.cwd(),
      extraProjectKeys: [conversationId, sessionId],
    });
  } catch (error) {
    return json({
      ok: false,
      error: error instanceof Error ? error.message : 'failed to load claude session',
    }, 500);
  }

  if (!entries || entries.length === 0) {
    return json({ ok: false, error: 'no claude session' }, 404);
  }

  const filename = claudeSessionExportFilename(sessionId);
  return new Response(sessionEntriesToJsonl(entries), {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      'content-disposition': `attachment; filename="${filename}"`,
      'x-filename': filename,
    },
  });
}
