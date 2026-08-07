import {
  getActivityHistory,
  getHistory,
  getProjectSnapshot,
  getProjectState,
  saveProjectState,
} from '../_memory';
import {
  getFileTree,
  resolvePublicLinks,
  restoreProjectArchive,
  runSandboxCommand,
  startPreviewServer,
  assertPreviewServerReady,
} from '../_project';
import type { FileTreeItem } from '../_types';
import { resolveConversationId } from '../utils/_request';

// Rehydrate a conversation after a page refresh. The sandbox /tmp is volatile, so
// the project may be gone even though history + snapshot survive in the store. This
// endpoint restores the code from the snapshot (when needed), restarts the preview,
// and returns everything the frontend needs to rebuild the workspace — without
// running the agent. Single JSON response (restore + npm install can take a while).
export async function runProjectResumePipeline(context: any): Promise<Response> {
  const { conversationId } = resolveConversationId(context, { allowQuery: true });

  const json = (obj: Record<string, unknown>, status = 200) => new Response(
    JSON.stringify(obj),
    { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } },
  );

  if (!conversationId) {
    return json({ ok: false, error: 'missing conversation_id' }, 400);
  }

  const state = await getProjectState(context, conversationId);
  const messages = await getHistory(context, conversationId);
  const activityHistory = await getActivityHistory(context, conversationId);

  // Does the sandbox still hold the project files?
  let hasFiles = false;
  try {
    if (await context.sandbox.files.exists(state.appDir)) {
      const tree = await getFileTree(context, state);
      hasFiles = tree.some((item) => item.type === 'file');
    }
  } catch {
    hasFiles = false;
  }

  // Sandbox lost the code but a snapshot survives → restore it (unzip + install).
  if (!hasFiles) {
    const snapshot = await getProjectSnapshot(context, conversationId);
    if (snapshot) {
      const restored = await restoreProjectArchive(context, state, snapshot);
      hasFiles = restored.ok;
    }
  }

  if (!hasFiles) {
    // Nothing to resume (brand-new visitor, or never generated). The frontend
    // stays on the home screen. Still return any chat history for completeness.
    return json({ ok: true, conversation_id: conversationId, messages, activityHistory, hasProject: false });
  }

  state.created = true;

  // Make sure dependencies are present before starting the preview. The restore
  // path already installs them; this covers a sandbox that kept source but lost
  // node_modules. Non-fatal.
  try {
    const hasPkg = await context.sandbox.files.exists(`${state.appDir}/package.json`);
    const hasNodeModules = await context.sandbox.files.exists(`${state.appDir}/node_modules`);
    if (hasPkg && !hasNodeModules) {
      await runSandboxCommand(context, 'npm install --no-audit --no-fund', { cwd: state.appDir, timeout: 300 });
    }
  } catch {
    // Non-fatal — preview startup below will surface a real failure.
  }

  let preview: Record<string, unknown> = {};
  try {
    const server = await startPreviewServer(context, state);
    await assertPreviewServerReady(context, server.readyPath);
    const links = await resolvePublicLinks(context);
    state.previewUrl = links.previewUrl;
    state.sandboxDebugUrl = links.sandboxDebugUrl;
    preview = { url: links.previewUrl, sandboxDebugUrl: links.sandboxDebugUrl };
  } catch (error) {
    state.previewUrl = undefined;
    state.sandboxDebugUrl = undefined;
    preview = { error: error instanceof Error ? error.message : 'Failed to restart the preview.' };
  }

  let items: FileTreeItem[] = [];
  try {
    items = await getFileTree(context, state);
  } catch {
    items = [];
  }

  await saveProjectState(context, conversationId, state);

  return json({
    ok: true,
    conversation_id: conversationId,
    messages,
    activityHistory,
    hasProject: true,
    preview,
    files: { root: state.appDir, items },
    // Restore the download pointer too, so the "Download source" button survives a
    // page refresh (the archive is built on demand by /download; this is just a link).
    download: { url: '/download', filename: 'source.zip' },
  });
}
