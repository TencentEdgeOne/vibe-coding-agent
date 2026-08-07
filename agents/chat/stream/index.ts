import { createChatTaskStreamResponse } from '../../_chat-tasks';

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
