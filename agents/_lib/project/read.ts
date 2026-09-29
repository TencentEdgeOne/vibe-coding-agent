import type { AgentContext } from '../runtime/context.ts';
import { PREVIEW_BATCH_MAX_FILES } from '../constants.ts';
import { activateSandbox } from '../lazy/sandbox.ts';
import { readFileFromSandbox, readFilesFromSandbox } from './fs.ts';
import { toAppRelPath } from '../utils/paths.ts';
import { getRequestQueryParam, resolveConversationId } from '../runtime/request.ts';

export async function runFileReadPipeline(context: AgentContext): Promise<Response> {
  const { conversationId } = resolveConversationId(context);
  const pathParam = getRequestQueryParam(context, 'path');
  const pathsParam = getRequestQueryParam(context, 'paths');
  const relPath = pathParam.value;
  const batchPaths = pathsParam.value
    .split(',')
    .map((path) => path.trim())
    .filter(Boolean);
  const requestedPaths = batchPaths.length > 0 ? batchPaths : [relPath];
  const isBatch = batchPaths.length > 0;
  const json = (data: Record<string, unknown>, status = 200) => new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    },
  );

  if (!conversationId) {
    return json({ ok: false, error: 'missing conversation_id' }, 400);
  }
  if (isBatch && batchPaths.length > PREVIEW_BATCH_MAX_FILES) {
    return json({
      ok: false,
      error: `At most ${PREVIEW_BATCH_MAX_FILES} files can be read at once.`,
    }, 400);
  }

  const { state } = await activateSandbox(context, conversationId);
  const normalizedPaths = requestedPaths.map((path) => toAppRelPath(path, state.appDir));
  if (normalizedPaths.some((path) => !path)) {
    return json({ ok: false, error: 'invalid path' }, 400);
  }
  const paths = [...new Set(normalizedPaths as string[])];

  if (isBatch) {
    const files = await readFilesFromSandbox(context, state, paths);
    return json({ ok: true, files });
  }

  const norm = paths[0];
  const res = await readFileFromSandbox(context, state, norm);
  return json({ path: norm, ...res });
}
