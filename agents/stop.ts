import { abortLiveChatTask } from './_chat-tasks';
import { saveActivityTurn } from './_memory';
import type { PersistedActivity } from './_types';

export async function onRequest(context: any) {
  const conversationId = String(context?.request?.body?.conversation_id || '').trim();
  if (!conversationId) {
    return new Response(JSON.stringify({ ok: false, error: 'missing conversation_id' }), {
      status: 400,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  try {
    // Stop the detached in-process run first (SSE disconnect no longer aborts it).
    abortLiveChatTask(conversationId);
    const result = await context.utils?.abortActiveRun?.(conversationId);
    const rawTurn = context?.request?.body?.turn;
    if (rawTurn && typeof rawTurn === 'object') {
      const turn = rawTurn as Record<string, unknown>;
      const user = String(turn.user || '').slice(0, 20_000);
      const assistant = /[\u3400-\u9fff]/.test(user)
        ? '已停止本次生成，你可以继续描述下一步修改。'
        : 'Generation stopped. You can continue with another change.';
      const activities = (Array.isArray(turn.activities) ? turn.activities : [])
        .slice(-50)
        .filter((activity): activity is PersistedActivity => Boolean(activity) && typeof activity === 'object')
        .map((activity) => activity.kind === 'tool' && activity.status === 'running'
          ? { ...activity, status: 'stopped' as const, endedAt: Date.now() }
          : activity);
      if (user) {
        await saveActivityTurn(context, conversationId, {
          id: String(turn.id || context.run_id || Date.now()),
          user,
          assistant,
          status: 'stopped',
          createdAt: Number(turn.createdAt) || Date.now(),
          activities,
        });
      }
    }
    return new Response(JSON.stringify({
      ok: true,
      conversation_id: conversationId,
      aborted: result?.aborted === true,
    }), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  } catch (error) {
    return new Response(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to stop the active run.',
    }), {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
}
