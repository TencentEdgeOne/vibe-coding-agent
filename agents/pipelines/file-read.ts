import { PREVIEW_BATCH_MAX_FILES } from '../_constants';
import { getProjectState } from '../_memory';
import { readFileFromSandbox, readFilesFromSandbox } from '../_project';
import { debugLog } from '../utils/_debug';
import { normalizeRelPath } from '../utils/_paths';
import {
  getRequestDebugSnapshot,
  getRequestHeader,
  getRequestQueryParam,
  maskConversationId,
  resolveConversationId,
} from '../utils/_request';
import { utf8ByteLength } from './_helpers';

export async function runFileReadPipeline(context: any): Promise<Response> {
  const contextConversationId = String(context.conversation_id || '');
  const pagesHeaderConversationId = getRequestHeader(context, 'makers-conversation-id');
  const headerConversationId = getRequestHeader(context, 'conversationId');
  const { conversationId, source: conversationSource } = resolveConversationId(context);
  const diagnosticBase = {
    contextConversationId: maskConversationId(contextConversationId),
    pagesHeaderConversationId: maskConversationId(pagesHeaderConversationId),
    headerConversationId: maskConversationId(headerConversationId),
    selectedConversationId: maskConversationId(conversationId),
    selectedConversationSource: conversationSource,
  };
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
    debugLog(context, '[file-read]', {
      ...diagnosticBase,
      rawPath: isBatch ? batchPaths : relPath,
      pathSource: isBatch ? pathsParam.source : pathParam.source,
      normalizedPath: null,
      error: 'missing conversation_id',
    });
    return json({ ok: false, error: 'missing conversation_id' }, 400);
  }
  if (isBatch && batchPaths.length > PREVIEW_BATCH_MAX_FILES) {
    return json({
      ok: false,
      error: `At most ${PREVIEW_BATCH_MAX_FILES} files can be read at once.`,
    }, 400);
  }

  const normalizedPaths = requestedPaths.map((path) => normalizeRelPath(path));
  if (normalizedPaths.some((path) => !path)) {
    debugLog(context, '[file-read]', {
      ...diagnosticBase,
      rawPath: isBatch ? batchPaths : relPath,
      pathSource: isBatch ? pathsParam.source : pathParam.source,
      normalizedPath: null,
      error: 'invalid path',
      request: getRequestDebugSnapshot(context),
    });
    return json({ ok: false, error: 'invalid path' }, 400);
  }
  const paths = [...new Set(normalizedPaths as string[])];

  const state = await getProjectState(context, conversationId);
  debugLog(context, '[file-read]', {
    ...diagnosticBase,
    rawPath: isBatch ? batchPaths : relPath,
    pathSource: isBatch ? pathsParam.source : pathParam.source,
    normalizedPath: isBatch ? paths : paths[0],
    appDir: state.appDir,
    stage: 'before-read',
  });

  if (isBatch) {
    const files = await readFilesFromSandbox(context, state, paths);
    const responseBytes = files.reduce(
      (total, file) => total + (file.ok && file.content ? utf8ByteLength(file.content) : 0),
      0,
    );
    debugLog(context, '[file-read]', {
      ...diagnosticBase,
      normalizedPath: paths,
      appDir: state.appDir,
      requested: paths.length,
      succeeded: files.filter((file) => file.ok).length,
      responseBytes,
      stage: 'after-batch-read',
    });
    return json({ ok: true, files });
  }

  const norm = paths[0];
  const res = await readFileFromSandbox(context, state, norm);
  debugLog(context, '[file-read]', {
    ...diagnosticBase,
    normalizedPath: norm,
    appDir: state.appDir,
    ok: res.ok,
    error: res.error,
    size: res.size,
    truncated: res.truncated,
    stage: 'after-read',
  });
  return json({ path: norm, ...res });
}
