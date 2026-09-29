import type { AgentContext } from './_lib/runtime/context.ts';
import { runFileReadPipeline } from './_lib/project/read.ts';

export async function onRequest(context: AgentContext) {
  return runFileReadPipeline(context);
}
