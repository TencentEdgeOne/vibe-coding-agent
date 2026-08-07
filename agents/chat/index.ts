import { createChatTask } from '../_chat-tasks';

export async function onRequestPost(context: any) {
  const body = context?.request?.body || {};
  const message = String(body?.message || '').trim();
  if (!message) {
    return new Response(JSON.stringify({
      ok: false,
      error: 'Please describe the page or feature you want to build first.',
    }), {
      status: 400,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }

  try {
    const result = await createChatTask(context, message, {
      resetProject: body?.resetProject === true,
      turnId: String(body?.turnId || '').trim() || undefined,
    });
    if (!result.ok) {
      return new Response(JSON.stringify(result), {
        status: result.status,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    return new Response(JSON.stringify({
      ok: true,
      conversation_id: result.conversationId,
      runId: result.task.id,
      streamUrl: `/chat/stream?runId=${encodeURIComponent(result.task.id)}`,
      status: result.task.status,
    }), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  } catch (error) {
    return new Response(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to submit the chat task.',
    }), {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
}
