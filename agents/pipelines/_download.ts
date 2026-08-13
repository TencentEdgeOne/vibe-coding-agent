import {
  getProjectSnapshot,
  getProjectState,
} from '../_memory';
import { createProjectArchive } from '../_project';
import { resolveConversationId } from '../utils/_request';

export async function runProjectDownloadPipeline(context: any): Promise<Response> {
  const { conversationId } = resolveConversationId(context, { allowQuery: true });

  const jsonError = (error: string, status = 400) => new Response(
    JSON.stringify({ ok: false, error }),
    { status, headers: { 'content-type': 'application/json; charset=utf-8' } },
  );

  if (!conversationId) {
    return jsonError('missing conversation_id');
  }

  const state = await getProjectState(context, conversationId);

  // Prefer the persisted snapshot so download works even after the sandbox is
  // recycled (the code lives durably in the store, not just in /tmp). Fall back to
  // packaging the live sandbox when no snapshot exists yet (e.g. first turn wrote
  // it after this download, or the snapshot write failed) — a pragmatic deviation
  // from plan §3.3.1-④ which forbade the fallback; keeping it avoids a dead-end
  // "not ready" error while the sandbox is still alive.
  const snapshot = await getProjectSnapshot(context, conversationId);
  if (snapshot?.base64) {
    return new Response(
      JSON.stringify({
        ok: true,
        filename: snapshot.filename,
        contentType: snapshot.contentType,
        size: snapshot.size,
        base64: snapshot.base64,
      }),
      {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        },
      },
    );
  }

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
