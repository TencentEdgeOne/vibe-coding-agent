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
} from '../_project';
import type { FileTreeItem } from '../_types';
import { getRequestQueryParam, resolveConversationId } from '../utils/_request';

type ResumeStage = 'history' | 'workspace';

function jsonResponse(obj: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

async function readResumeStage(context: any): Promise<ResumeStage> {
  const fromQuery = getRequestQueryParam(context, 'stage').value;
  if (fromQuery === 'workspace' || fromQuery === 'history') {
    return fromQuery;
  }
  try {
    const body = await context?.request?.json?.();
    if (body && typeof body === 'object' && (body.stage === 'workspace' || body.stage === 'history')) {
      return body.stage;
    }
  } catch {
    // Body may be empty — default to the fast history stage.
  }
  return 'history';
}

// Fast path: store reads only. No sandbox restore / npm install / preview.
// Lets the UI paint chat history immediately after a refresh.
export async function runProjectResumeHistoryPipeline(context: any): Promise<Response> {
  const { conversationId } = resolveConversationId(context, { allowQuery: true });
  if (!conversationId) {
    return jsonResponse({ ok: false, error: 'missing conversation_id' }, 400);
  }

  const [state, messages, activityHistory, snapshot] = await Promise.all([
    getProjectState(context, conversationId),
    getHistory(context, conversationId),
    getActivityHistory(context, conversationId),
    getProjectSnapshot(context, conversationId),
  ]);

  const hasProject = Boolean(snapshot?.base64) || state.created === true;

  return jsonResponse({
    ok: true,
    stage: 'history',
    conversation_id: conversationId,
    messages,
    activityHistory,
    hasProject,
    // Client should call stage=workspace when true.
    needsWorkspace: hasProject,
  });
}

// Slow path: restore snapshot into the sandbox (when needed), reinstall deps,
// restart the preview, and return files + preview links.
export async function runProjectResumeWorkspacePipeline(context: any): Promise<Response> {
  const { conversationId } = resolveConversationId(context, { allowQuery: true });
  if (!conversationId) {
    return jsonResponse({ ok: false, error: 'missing conversation_id' }, 400);
  }

  const state = await getProjectState(context, conversationId);

  let hasFiles = false;
  try {
    if (await context.sandbox.files.exists(state.appDir)) {
      const tree = await getFileTree(context, state);
      hasFiles = tree.some((item) => item.type === 'file');
    }
  } catch {
    hasFiles = false;
  }

  if (!hasFiles) {
    const snapshot = await getProjectSnapshot(context, conversationId);
    if (snapshot) {
      const restored = await restoreProjectArchive(context, state, snapshot);
      hasFiles = restored.ok;
    }
  }

  if (!hasFiles) {
    return jsonResponse({
      ok: true,
      stage: 'workspace',
      conversation_id: conversationId,
      hasProject: false,
      preview: {},
      files: { root: state.appDir, items: [] },
    });
  }

  state.created = true;

  // Restore already runs npm install; this covers a sandbox that kept source but
  // lost node_modules. Non-fatal.
  try {
    const hasPkg = await context.sandbox.files.exists(`${state.appDir}/package.json`);
    const hasNodeModules = await context.sandbox.files.exists(`${state.appDir}/node_modules`);
    if (hasPkg && !hasNodeModules) {
      await runSandboxCommand(context, 'npm install --no-audit --no-fund', {
        cwd: state.appDir,
        timeout: 300,
      });
    }
  } catch {
    // Non-fatal — preview startup below will surface a real failure.
  }

  let preview: Record<string, unknown> = {};
  try {
    // startPreviewServer already waits until the server answers; no second assert.
    const server = await startPreviewServer(context, state);
    const links = await resolvePublicLinks(context);
    state.previewUrl = links.previewUrl;
    state.sandboxDebugUrl = links.sandboxDebugUrl;
    preview = {
      url: links.previewUrl,
      sandboxDebugUrl: links.sandboxDebugUrl,
      framework: server.framework,
    };
  } catch (error) {
    state.previewUrl = undefined;
    state.sandboxDebugUrl = undefined;
    preview = {
      error: error instanceof Error ? error.message : 'Failed to restart the preview.',
    };
  }

  let items: FileTreeItem[] = [];
  try {
    items = await getFileTree(context, state);
  } catch {
    items = [];
  }

  await saveProjectState(context, conversationId, state);

  return jsonResponse({
    ok: true,
    stage: 'workspace',
    conversation_id: conversationId,
    hasProject: true,
    preview,
    files: { root: state.appDir, items },
    download: { url: '/download', filename: 'source.zip' },
  });
}

// Router kept for the thin agents/resume.ts entry. Body `{ stage: "workspace" }`
// selects the slow path; anything else (including `{}`) is the fast history path.
export async function runProjectResumePipeline(context: any): Promise<Response> {
  const stage = await readResumeStage(context);
  if (stage === 'workspace') {
    return runProjectResumeWorkspacePipeline(context);
  }
  return runProjectResumeHistoryPipeline(context);
}
