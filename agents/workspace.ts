import type { AgentContext } from './_lib/runtime/context.ts';
import { runWorkspaceSnapshotPipeline } from './_lib/project/snapshot.ts';

/** Current files, preview, deployment, and download — independent of the chat stream. */
export async function onRequestGet(context: AgentContext) {
  return runWorkspaceSnapshotPipeline(context);
}
