import {
  createChatTaskAndStreamResponse,
  createChatTaskStreamResponse,
} from './_chat-tasks';

/** Create a durable task and stream it over the same HTTP request. */
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
    return await createChatTaskAndStreamResponse(context, message, {
      resetProject: body?.resetProject === true,
      turnId: String(body?.turnId || '').trim() || undefined,
    });
  } catch (error) {
    return new Response(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to start the chat task.',
    }), {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
}

/** Reconnect to an existing task after refresh or transport interruption. */
export async function onRequestGet(context: any) {
  try {
    return await createChatTaskStreamResponse(context);
  } catch (error) {
    return new Response(JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.message : 'Failed to open the chat stream.',
    }), {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  }
}
