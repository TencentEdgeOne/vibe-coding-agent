import type { AgentContext } from './_lib/runtime/context.ts';
import { createProjectResumeStreamResponse } from './_lib/session/resume.ts';

/** Session entry: history, workspace, and an in-flight task's SSE on one GET. */
export async function onRequestGet(context: AgentContext) {
  return createProjectResumeStreamResponse(context);
}
