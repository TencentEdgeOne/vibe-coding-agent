import type { AgentContext } from './_lib/runtime/context.ts';
import { runProjectDownloadPipeline } from './_lib/project/download.ts';

export async function onRequest(context: AgentContext) {
  return runProjectDownloadPipeline(context);
}
