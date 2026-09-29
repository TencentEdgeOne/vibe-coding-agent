import type { AgentContext } from './_lib/runtime/context.ts';
import { applyGatewayDecisionAndRespond } from './_lib/session/gateway-apply.ts';
import { createChatTaskAndStreamResponse } from './_lib/session/task.ts';
import { resolveRequestedModel } from './_lib/models.ts';
import { getRequestBody } from './_lib/runtime/request.ts';
import { isSitePublishRequest } from '../shared/site-publish.ts';

/** Submit a user message. Generation streams back as SSE. */
export async function onRequestPost(context: AgentContext) {
  const body = getRequestBody(context);
  const message = String(body.message || '').trim();
  const apiKey = String(body.apiKey || '').trim();
  const gatewaySkip = body.gatewaySkip === true;
  if (!message && (apiKey || gatewaySkip)) {
    return applyGatewayDecisionAndRespond(context, {
      ...(apiKey ? { apiKey } : {}),
      ...(gatewaySkip ? { skip: true } : {}),
    });
  }
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
      kind: isSitePublishRequest(message) ? 'deploy' : 'prompt',
      turnId: String(body.turnId || '').trim() || undefined,
      model: resolveRequestedModel(context, body.model),
      language: String(body.language || '').trim() || undefined,
      ...(apiKey ? { apiKey } : {}),
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
