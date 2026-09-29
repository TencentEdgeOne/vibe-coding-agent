import type { AgentContext } from '../runtime/context.ts';
import { activateSandbox } from '../lazy/sandbox.ts';
import { createProjectArchive } from './archive.ts';
import { resolveConversationId } from '../runtime/request.ts';

export async function runProjectDownloadPipeline(context: AgentContext): Promise<Response> {
  const { conversationId } = resolveConversationId(context, { allowQuery: true });

  const jsonError = (error: string, status = 400) => new Response(
    JSON.stringify({ ok: false, error }),
    { status, headers: { 'content-type': 'application/json; charset=utf-8' } },
  );

  if (!conversationId) {
    return jsonError('missing conversation_id');
  }

  const { state } = await activateSandbox(context, conversationId);

  let archive;
  try {
    archive = await createProjectArchive(context, state);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to package the project.';
    return jsonError(message, 500);
  }

  if (!archive.ok) {
    return jsonError(archive.error, 409);
  }

  return new Response(
    JSON.stringify({
      ok: true,
      filename: archive.filename,
      contentType: archive.contentType,
      size: archive.size,
      base64: archive.base64,
    }),
    {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    },
  );
}
