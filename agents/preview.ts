import type { AgentContext } from './_lib/runtime/context.ts';
import { runProjectResumePreviewPipeline } from './_lib/session/resume.ts';

/** Re-mint the public preview URL without restoring the full workspace. */
export async function onRequestPost(context: AgentContext) {
  return runProjectResumePreviewPipeline(context);
}
