import type { AgentContext } from './_lib/runtime/context.ts';
import { settleUnrunTask, stopLiveChatTask } from './_lib/session/task.ts';
import { getRequestBody, resolveConversationId } from './_lib/runtime/request.ts';

/** How long a stop waits for the turn to save its work before answering. */
const STOP_WAIT_MS = 5_000;

/**
 * Stop the running turn. The request carries `makers-conversation-id`, so
 * session affinity lands it on the instance running the turn; the platform's
 * `abortActiveRun` is not used.
 */
export async function onRequest(context: AgentContext) {
  const body = getRequestBody(context);
  const conversationId = resolveConversationId(context).conversationId.trim()
    || String(body.conversation_id || '').trim();
  if (!conversationId) {
    return new Response(JSON.stringify({ ok: false, error: 'missing conversation_id' }), {
      status: 400,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  try {
    const status = await stopLiveChatTask(conversationId, {
      // Leaving the project does not wait for its last turn to finish saving.
      waitMs: body.discardProject === true ? 0 : STOP_WAIT_MS,
    });
    if (status === 'idle') {
      // No turn runs here. If the record says one is running, a stop claims the
      // conversation, which fences whoever still runs it elsewhere.
      await settleUnrunTask(context, conversationId, 'stop');
    }
    return new Response(JSON.stringify({ ok: true, conversation_id: conversationId, status }), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  } catch (error) {
    return new Response(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to stop the active run.',
    }), {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
}
