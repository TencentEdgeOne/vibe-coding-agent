import {
  createStreamResponse,
  runChatPipeline,
} from './_pipelines';

export async function onRequest(context: any) {
  const body = context?.request?.body || {};
  const message = String(body?.message || '').trim();
  const resetProject = body?.resetProject === true;
  const turnId = String(body?.turnId || '').trim();
  return createStreamResponse(
    (send) => runChatPipeline(context, message, send, { resetProject, turnId }),
    context?.request?.signal,
  );
}
