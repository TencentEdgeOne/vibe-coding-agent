import {
  getActivityHistory,
  getChatTask,
  getHistory,
  getLegacyProjectSnapshot,
  getModelPreference,
  getProjectState,
  saveProjectState,
} from '../_memory';
import {
  getFileTree,
  isPreviewServerReady,
  previewTargetsMatch,
  resolvePublicLinks,
  restorePersistedProject,
  rewritePreviewAccessToken,
  runSandboxCommand,
  startPreviewServer,
} from '../_project';
import type { FileTreeItem, PersistedActivity, PersistedActivityTurn, ProjectState } from '../_types';
import { createProjectFiles } from '../core/_project-files.ts';
import { createMakersWorkspacePort } from '../core/adapters/_makers.ts';
import { createSSEResponse, sseEvent } from '../_shared';

const projectFilesFor = (context: any, state: ProjectState) =>
  createProjectFiles(createMakersWorkspacePort(context), state.appDir);
import { getRequestQueryParam, resolveConversationId } from '../utils/_request';
import { withTimeout } from './_helpers';
import { loadResumeFileContents } from './_resume-files';

function toolNameImpliesProject(name: string) {
  return name.includes('write_project_file')
    || name.includes('ensure_project_scaffold')
    || name.includes('publish_preview')
    || name.includes('get_preview_link')
    || name.includes('write_files')
    || /__files_write$/.test(name);
}

function activityHistoryImpliesProject(activityHistory: PersistedActivityTurn[]) {
  return activityHistory.some((turn) =>
    (turn.activities || []).some((activity: PersistedActivity) =>
      activity.kind === 'tool' && toolNameImpliesProject(activity.name || ''),
    ),
  );
}

function activityHistoryImpliesPreview(activityHistory: PersistedActivityTurn[]) {
  return activityHistory.some((turn) =>
    (turn.activities || []).some((activity: PersistedActivity) =>
      activity.kind === 'tool'
      && activity.status === 'completed'
      && (
        (activity.name || '').includes('publish_preview')
        || (activity.name || '').includes('get_preview_link')
      ),
    ),
  );
}

function projectStateImpliesPreview(state: ProjectState, activityHistory: PersistedActivityTurn[] = []) {
  return Boolean(state.previewUrl)
    || Boolean(state.previewPublished)
    || activityHistoryImpliesPreview(activityHistory);
}

type ResumeStage = 'history' | 'workspace' | 'preview';

// Hard ceiling for the workspace SSE stage (restore + file tree + warm remint).
// Cold preview (npm install + dev-server boot) is a separate /resume?stage=preview
// request so a long install cannot swallow the file tree or blow this budget.
// Keep the dedicated preview stage under the client abort in
// app/features/workspace/workspace-api.ts (RESUME_CLIENT_TIMEOUT_MS).
const WORKSPACE_RESUME_BUDGET_MS = 120_000;
const SANDBOX_PROBE_MS = 15_000;
const RESTORE_BUDGET_MS = 45_000;
const DEPENDENCY_INSTALL_BUDGET_MS = 120_000;
const PREVIEW_RESTART_BUDGET_MS = 120_000;
// Cold preview may restore a snapshot first, then npm install, then boot the
// dev server. Keep this under RESUME_CLIENT_TIMEOUT_MS.
const PREVIEW_STAGE_BUDGET_MS = WORKSPACE_RESUME_BUDGET_MS
  + DEPENDENCY_INSTALL_BUDGET_MS
  + PREVIEW_RESTART_BUDGET_MS;

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
  if (fromQuery === 'workspace' || fromQuery === 'history' || fromQuery === 'preview') {
    return fromQuery;
  }
  try {
    const body = await context?.request?.json?.();
    if (
      body
      && typeof body === 'object'
      && (body.stage === 'workspace' || body.stage === 'history' || body.stage === 'preview')
    ) {
      return body.stage;
    }
  } catch {
    // Body may be empty — default to the fast history stage.
  }
  return 'history';
}

// Fast path: store reads only. No sandbox restore / npm install / preview.
// Lets the UI paint chat history immediately after a refresh.
async function loadProjectResumeHistory(context: any, conversationId: string) {
  const [messages, activityHistory, snapshot, chatTask, state, model] = await Promise.all([
    getHistory(context, conversationId),
    getActivityHistory(context, conversationId),
    getLegacyProjectSnapshot(context, conversationId),
    getChatTask(context, conversationId),
    getProjectState(context, conversationId),
    getModelPreference(context, conversationId),
  ]);

  // Prefer a durable snapshot, but also open the workspace when the turn clearly
  // touched the project (stop mid-write may race the snapshot flush; sandbox may
  // still hold files that workspace resume can list).
  const hasProject = Boolean(snapshot?.base64)
    || Boolean(state.created)
    || activityHistoryImpliesProject(activityHistory);
  const hasPreview = projectStateImpliesPreview(state, activityHistory);
  const activeTask = chatTask
    && (chatTask.status === 'queued' || chatTask.status === 'running')
    ? {
        id: chatTask.id,
        message: chatTask.message,
        status: chatTask.status,
        resetProject: chatTask.resetProject === true,
        createdAt: chatTask.createdAt,
        startedAt: chatTask.startedAt,
        streamUrl: `/chat?runId=${encodeURIComponent(chatTask.id)}`,
      }
    : null;

  return {
    ok: true as const,
    stage: 'history' as const,
    conversation_id: conversationId,
    messages,
    activityHistory,
    activeTask,
    hasProject,
    hasPreview,
    needsWorkspace: hasProject,
    // Empty until someone picks a model, which leaves the composer on whatever
    // the /models route reports as this deployment's default.
    model,
  };
}

export async function runProjectResumeHistoryPipeline(context: any): Promise<Response> {
  const { conversationId } = resolveConversationId(context, { allowQuery: true });
  if (!conversationId) {
    return jsonResponse({ ok: false, error: 'missing conversation_id' }, 400);
  }
  return jsonResponse(await loadProjectResumeHistory(context, conversationId));
}

async function probeSandboxHasFiles(context: any, state: ProjectState) {
  if (!(await projectFilesFor(context, state).projectExists())) {
    return false;
  }
  const tree = await getFileTree(context, state);
  return tree.some((item) => item.type === 'file');
}

async function ensureProjectDependencies(context: any, state: ProjectState) {
  const files = projectFilesFor(context, state);
  const hasPackageJson = await files.hasPackageJson();
  if (!hasPackageJson) {
    return false;
  }
  const hasNodeModules = await files.hasNodeModules();
  if (hasNodeModules) {
    return true;
  }
  const installed = await runSandboxCommand(context, 'npm install --no-audit --no-fund', {
    cwd: state.appDir,
    timeout: 300,
  });
  return installed.exitCode === 0;
}

type ResumePreview = { url?: string; error?: string; restarted?: boolean };

// Fast path: sandbox still serving /preview/. Rotate the token when the stored
// URL still points at this host; otherwise reuse the freshly resolved link.
async function remintWarmPreview(context: any, state: ProjectState): Promise<ResumePreview | null> {
  if (!(await isPreviewServerReady(context))) {
    return null;
  }

  try {
    const accessToken = createMakersWorkspacePort(context).accessToken ?? '';

    const warmLinks = await resolvePublicLinks(context);
    if (state.previewUrl && accessToken && warmLinks.previewUrl
      && previewTargetsMatch(state.previewUrl, warmLinks.previewUrl)) {
      const rewritten = rewritePreviewAccessToken(state.previewUrl, accessToken);
      if (rewritten) {
        state.previewUrl = rewritten;
        return {
          url: rewritten,
          restarted: false,
        };
      }
    }

    if (warmLinks.previewUrl) {
      state.previewUrl = warmLinks.previewUrl;
      return {
        url: warmLinks.previewUrl,
        restarted: false,
      };
    }
  } catch {
    // Warm links failed — caller falls through to a full restart.
  }

  return null;
}

async function restartColdPreview(context: any, state: ProjectState): Promise<ResumePreview> {
  const depsReady = await withTimeout(
    ensureProjectDependencies(context, state),
    DEPENDENCY_INSTALL_BUDGET_MS,
    'dependency install',
  );
  if (!depsReady) {
    throw new Error('Project dependencies are not available for preview resume.');
  }

  await withTimeout(
    startPreviewServer(context, state),
    PREVIEW_RESTART_BUDGET_MS,
    'preview resume',
  );
  const links = await resolvePublicLinks(context);
  if (!links.previewUrl) {
    throw new Error('Preview server started but no public preview URL was available.');
  }
  state.previewUrl = links.previewUrl;
  return {
    url: links.previewUrl,
    // The dev server is a new process: whatever an open iframe shows is dead.
    restarted: true,
  };
}

// Warm sandboxes may still be serving /preview/; otherwise install + restart.
async function republishPreviewOnResume(context: any, state: ProjectState) {
  const warm = await remintWarmPreview(context, state);
  if (warm?.url) {
    return warm;
  }
  return restartColdPreview(context, state);
}

async function runWorkspaceRestoreBody(context: any, conversationId: string) {
  const [state, chatTask, activityHistory] = await Promise.all([
    getProjectState(context, conversationId),
    getChatTask(context, conversationId),
    getActivityHistory(context, conversationId),
  ]);
  const hadPreview = projectStateImpliesPreview(state, activityHistory);
  const generationActive = Boolean(
    chatTask && (chatTask.status === 'queued' || chatTask.status === 'running'),
  );

  let hasFiles = false;
  let restoreError: string | undefined;
  try {
    hasFiles = await withTimeout(
      probeSandboxHasFiles(context, state),
      SANDBOX_PROBE_MS,
      'sandbox file probe',
    );
  } catch (error) {
    hasFiles = false;
    restoreError = error instanceof Error ? error.message : 'Sandbox probe failed.';
  }

  if (!hasFiles) {
    try {
      const restored = await withTimeout(
        restorePersistedProject(context, conversationId, state, { installDependencies: false }),
        RESTORE_BUDGET_MS,
        'snapshot restore',
      );
      hasFiles = restored.restored;
      if (!restored.restored) restoreError = restored.error;
    } catch (error) {
      hasFiles = false;
      restoreError = error instanceof Error ? error.message : 'Snapshot restore failed.';
    }
  }

  if (!hasFiles) {
    return {
      ok: true as const,
      stage: 'workspace' as const,
      conversation_id: conversationId,
      hasProject: false,
      hasPreview: hadPreview,
      preview: restoreError ? { error: restoreError } : {},
      files: { root: state.appDir, items: [] as FileTreeItem[] },
    };
  }

  state.created = true;

  let items: FileTreeItem[] = [];
  try {
    items = await withTimeout(
      getFileTree(context, state),
      SANDBOX_PROBE_MS,
      'file tree',
    );
  } catch {
    items = [];
  }

  const hasFileItems = items.some((item) => item.type === 'file');
  // Only remint preview when publish_preview previously succeeded for this
  // conversation. Do NOT key off package.json — a stopped mid-generation
  // project often has a scaffold but is not previewable yet.
  // Workspace stays on the warm path so a missing node_modules / dead dev
  // server cannot stall the file tree. Cold start is /resume?stage=preview.
  const shouldRemintPreview = !generationActive && hasFileItems && hadPreview;

  let preview: ResumePreview = {};
  if (shouldRemintPreview) {
    try {
      const warm = await withTimeout(
        remintWarmPreview(context, state),
        SANDBOX_PROBE_MS,
        'preview remint',
      );
      if (warm?.url) {
        preview = warm;
        state.previewPublished = true;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Preview remint failed.';
      console.warn('[resume:workspace] preview remint failed:', message);
      preview = { error: message };
    }
  } else if (!generationActive && !hadPreview) {
    // Never-published / interrupted projects stay files-only.
    state.previewUrl = undefined;
  }

  try {
    await saveProjectState(context, conversationId, state);
  } catch {
    // Non-fatal — the files payload below is still useful.
  }

  return {
    ok: true as const,
    stage: 'workspace' as const,
    conversation_id: conversationId,
    hasProject: hasFileItems || Boolean(state.created),
    hasPreview: hadPreview,
    preview,
    files: { root: state.appDir, items },
    ...(hasFileItems
      ? { download: { url: '/download', filename: 'source.zip' } }
      : {}),
  };
}

// Slow path: restore snapshot into the sandbox (when needed), then restart the
// live preview when the project was previously publishable.
export async function runProjectResumeWorkspacePipeline(context: any): Promise<Response> {
  const { conversationId } = resolveConversationId(context, { allowQuery: true });
  if (!conversationId) {
    return jsonResponse({ ok: false, error: 'missing conversation_id' }, 400);
  }

  try {
    const payload = await withTimeout(
      runWorkspaceRestoreBody(context, conversationId),
      WORKSPACE_RESUME_BUDGET_MS,
      'workspace resume',
    );
    return jsonResponse(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Workspace resume failed.';
    console.warn('[resume:workspace]', message);
    return jsonResponse({
      ok: true,
      stage: 'workspace',
      conversation_id: conversationId,
      hasProject: false,
      hasPreview: false,
      preview: { error: message },
      files: { root: '', items: [] },
    });
  }
}

// Light path: re-mint the public preview URL (fresh envdAccessToken) without
// restoring the full workspace. Used when the SPA tab stays open but the
// iframe's access_token expires — visibility return / toolbar refresh.
// Falls back to full workspace restore when the sandbox has gone cold.
async function runPreviewRefreshBody(context: any, conversationId: string) {
  const [state, activityHistory] = await Promise.all([
    getProjectState(context, conversationId),
    getActivityHistory(context, conversationId),
  ]);
  const hadPreview = projectStateImpliesPreview(state, activityHistory);
  if (!hadPreview) {
    return {
      ok: true as const,
      stage: 'preview' as const,
      conversation_id: conversationId,
      preview: {},
    };
  }

  try {
    const preview = await republishPreviewOnResume(context, state);
    state.previewPublished = true;
    try {
      await saveProjectState(context, conversationId, state);
    } catch {
      // Non-fatal — the fresh URL below is still usable for this session.
    }

    return {
      ok: true as const,
      stage: 'preview' as const,
      conversation_id: conversationId,
      preview,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('[resume:preview] remint failed, escalating to workspace restore:', message);
    const workspace = await runWorkspaceRestoreBody(context, conversationId);
    const restoredState = await getProjectState(context, conversationId);
    if (!workspace.hasProject || !projectStateImpliesPreview(restoredState, activityHistory)) {
      return {
        ...workspace,
        stage: 'preview' as const,
        preview: workspace.preview?.url
          ? workspace.preview
          : { error: workspace.preview?.error || message },
      };
    }

    try {
      const preview = await republishPreviewOnResume(context, restoredState);
      restoredState.previewPublished = true;
      try {
        await saveProjectState(context, conversationId, restoredState);
      } catch {
        // Non-fatal — the fresh URL below is still usable for this session.
      }
      return {
        ...workspace,
        stage: 'preview' as const,
        preview,
      };
    } catch (restartError) {
      const restartMessage = restartError instanceof Error ? restartError.message : String(restartError);
      console.warn('[resume:preview] cold start after restore failed:', restartMessage);
      return {
        ...workspace,
        stage: 'preview' as const,
        preview: { error: restartMessage },
      };
    }
  }
}

export async function runProjectResumePreviewPipeline(context: any): Promise<Response> {
  const { conversationId } = resolveConversationId(context, { allowQuery: true });
  if (!conversationId) {
    return jsonResponse({ ok: false, error: 'missing conversation_id' }, 400);
  }

  try {
    // Allow workspace-restore escalation inside the light path, so budget matches
    // the slow resume ceiling (and the client abort in fetchResumePreview).
    const payload = await withTimeout(
      runPreviewRefreshBody(context, conversationId),
      PREVIEW_STAGE_BUDGET_MS,
      'preview refresh',
    );
    return jsonResponse(payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Preview refresh failed.';
    console.warn('[resume:preview]', message);
    return jsonResponse({
      ok: true,
      stage: 'preview',
      conversation_id: conversationId,
      preview: { error: message },
    });
  }
}

/**
 * One progressive resume request replaces the former history → workspace chain.
 * History is emitted immediately; sandbox restore and preview restart follow on
 * the same SSE connection only when a durable project exists.
 */
export async function createProjectResumeStreamResponse(context: any): Promise<Response> {
  const { conversationId } = resolveConversationId(context, { allowQuery: true });
  if (!conversationId) {
    return jsonResponse({ ok: false, error: 'missing conversation_id' }, 400);
  }

  return createSSEResponse(async function* (signal) {
    const history = await loadProjectResumeHistory(context, conversationId);
    yield sseEvent({ type: 'resume_history', data: history });

    if (signal?.aborted || !history.needsWorkspace) return;

    try {
      const workspace = await withTimeout(
        runWorkspaceRestoreBody(context, conversationId),
        WORKSPACE_RESUME_BUDGET_MS,
        'workspace resume',
      );
      if (!signal?.aborted) {
        yield sseEvent({ type: 'resume_workspace', data: workspace });
      }

      // Warm the browser's source cache over this same resume connection. The
      // workspace event is sent first so the UI remains progressive; each file
      // then becomes immediately browseable without a /file route call.
      const fileItems = workspace.files?.items || [];
      if (!signal?.aborted && fileItems.length > 0) {
        const contents = await loadResumeFileContents(context, conversationId, fileItems);
        for (const file of contents) {
          if (signal?.aborted) return;
          yield sseEvent({ type: 'resume_file_content', data: file });
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Workspace resume failed.';
      console.warn('[resume:stream]', message);
      if (!signal?.aborted) {
        yield sseEvent({
          type: 'resume_workspace',
          data: {
            ok: true,
            stage: 'workspace',
            conversation_id: conversationId,
            hasProject: false,
            hasPreview: false,
            preview: { error: message },
            files: { root: '', items: [] },
          },
        });
      }
    }
  }, context?.request?.signal);
}

// Compatibility router for explicit preview refresh and older clients.
// `stage=workspace` → slow restore; `stage=preview` → re-mint preview URL;
// anything else (including `{}`) → fast history path.
export async function runProjectResumePipeline(context: any): Promise<Response> {
  const stage = await readResumeStage(context);
  if (stage === 'workspace') {
    return runProjectResumeWorkspacePipeline(context);
  }
  if (stage === 'preview') {
    return runProjectResumePreviewPipeline(context);
  }
  return runProjectResumeHistoryPipeline(context);
}
