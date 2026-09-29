import type { AgentContext } from './_lib/runtime/context.ts';
import { getLiveQuery } from './_lib/session/live.ts';
import { createTranscriptStreamResponse, resolveClaudeTranscriptPath } from './_lib/session/transcript.ts';

/** Session source of truth: stream the Claude JSONL file, unprojected. */
export async function onRequestGet(context: AgentContext) {
  return createTranscriptStreamResponse(context, (conversationId) => {
    const live = getLiveQuery(conversationId);
    if (!live) return null;
    return {
      path: resolveClaudeTranscriptPath(live.sessionId || '', {
        explicitPath: live.transcriptPath,
      }),
      sessionId: live.sessionId,
      active: Boolean(live.turn),
    };
  });
}
