import type { WorkspaceSnapshot } from '../../../shared/protocol.ts';
import { activateSandbox } from '../lazy/sandbox.ts';
import { getProjectState } from '../session/store.ts';
import { getFileTree } from './fs.ts';
import { resolveConversationId } from '../runtime/request.ts';
import type { AgentContext } from '../runtime/context.ts';
import type { FileTreeItem, ProjectState } from '../types.ts';

function previewLinkFromState(state: ProjectState) {
  if (!state.previewUrl) return {};
  return {
    url: state.previewUrl,
    sandboxDebugUrl: state.sandboxDebugUrl,
    kind: state.previewKind,
    routes: state.previewRoutes,
  };
}

function jsonResponse(obj: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

/**
 * Project panel payload from in-memory state. Pass `items` only after a listing.
 *
 * `hasDownload` answers "does this conversation hold a project" without a file
 * listing. Callers that just finished a turn know the answer and must say so:
 * a turn that wrote files produces a deployable project, and gating the payload
 * on a listing the caller may not have made left the deploy button disabled
 * with the project sitting right there.
 */
export function workspaceSnapshotFromState(
  conversationId: string,
  state: ProjectState,
  items?: FileTreeItem[],
  options: { hasDownload?: boolean } = {},
): WorkspaceSnapshot {
  const preview = previewLinkFromState(state);
  const hasFiles = items?.some((item) => item.type === 'file') === true;
  const canDownload = options.hasDownload ?? hasFiles;
  return {
    ok: true,
    conversation_id: conversationId,
    ...(items ? { files: { root: state.appDir, items } } : {}),
    ...(preview.url ? { preview } : {}),
    deployment: state.deployment,
    build: state.lastBuild,
    ...(canDownload ? { download: { url: '/download', filename: 'source.zip' } } : {}),
  };
}

export async function loadWorkspaceSnapshot(
  context: AgentContext,
  conversationId: string,
): Promise<WorkspaceSnapshot> {
  const { state } = await activateSandbox(context, conversationId);
  let items: FileTreeItem[] = [];
  try {
    items = await getFileTree(context, state);
  } catch {
    items = [];
  }
  return workspaceSnapshotFromState(conversationId, state, items);
}

export async function runWorkspaceSnapshotPipeline(context: AgentContext): Promise<Response> {
  const { conversationId } = resolveConversationId(context, { allowQuery: true });
  if (!conversationId) {
    return jsonResponse({ ok: false, error: 'missing conversation_id' }, 400);
  }
  try {
    return jsonResponse(await loadWorkspaceSnapshot(context, conversationId));
  } catch (error) {
    return jsonResponse({
      ok: false,
      conversation_id: conversationId,
      error: error instanceof Error ? error.message : 'Failed to load the workspace.',
    }, 500);
  }
}
