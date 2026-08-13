import {
  getActivityHistory,
  getChatTask,
  getHistory,
  getProjectSnapshot,
  getProjectState,
  saveProjectState,
} from '../_memory';
import {
  assertPreviewServerReady,
  getFileTree,
  resolvePublicLinks,
  restoreProjectArchive,
  rewritePreviewAccessToken,
  runSandboxCommand,
  startPreviewServer,
} from '../_project';
import type { FileTreeItem, PersistedActivity, PersistedActivityTurn, ProjectState } from '../_types';
import { createSSEResponse, sseEvent } from '../_shared';
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

// Hard ceiling for the whole workspace stage so a stuck sandbox call cannot
// leave the browser spinner pending indefinitely after stop/refresh.
// Preview restart may need npm install + dev-server boot; keep this under the
// client abort in app/lib/conversation.ts (130s).
const WORKSPACE_RESUME_BUDGET_MS = 120_000;
const SANDBOX_PROBE_MS = 15_000;
const RESTORE_BUDGET_MS = 45_000;
const PREVIEW_RESTART_BUDGET_MS = 75_000;

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
  const [messages, activityHistory, snapshot, chatTask, state] = await Promise.all([
    getHistory(context, conversationId),
    getActivityHistory(context, conversationId),
    getProjectSnapshot(context, conversationId),
    getChatTask(context, conversationId),
    getProjectState(context, conversationId),
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
  if (!(await context.sandbox.files.exists(state.appDir))) {
    return false;
  }
  const tree = await getFileTree(context, state);
  return tree.some((item) => item.type === 'file');
}

async function ensureProjectDependencies(context: any, state: ProjectState) {
  const hasPackageJson = await context.sandbox.files.exists(`${state.appDir}/package.json`);
  if (!hasPackageJson) {
    return false;
  }
  const hasNodeModules = await context.sandbox.files.exists(`${state.appDir}/node_modules`);
  if (hasNodeModules) {
    return true;
  }
  const installed = await runSandboxCommand(context, 'npm install --no-audit --no-fund', {
    cwd: state.appDir,
    timeout: 300,
  });
  return installed.exitCode === 0;
}

// Warm sandboxes may still be serving /preview/; otherwise install + restart.
async function republishPreviewOnResume(context: any, state: ProjectState) {
  try {
    await assertPreviewServerReady(context);
    const accessToken = typeof context.sandbox?.envdAccessToken === 'string'
      ? context.sandbox.envdAccessToken
      : '';

    // Prefer rotating the token on the URL the iframe already used. Fresh
    // getHost() can mint a LazySandbox host whose /preview/ proxy is not ready,
    // which shows up in the panel as {"error":"Not Found",...}.
    if (state.previewUrl && accessToken) {
      const rewritten = rewritePreviewAccessToken(state.previewUrl, accessToken);
      if (rewritten) {
        const warmLinks = await resolvePublicLinks(context);
        state.previewUrl = rewritten;
        state.sandboxDebugUrl = warmLinks.sandboxDebugUrl || state.sandboxDebugUrl;
        return {
          url: rewritten,
          sandboxDebugUrl: state.sandboxDebugUrl,
          restarted: false,
        };
      }
    }

    const warmLinks = await resolvePublicLinks(context);
    if (warmLinks.previewUrl) {
      state.previewUrl = warmLinks.previewUrl;
      state.sandboxDebugUrl = warmLinks.sandboxDebugUrl;
      return {
        url: warmLinks.previewUrl,
        sandboxDebugUrl: warmLinks.sandboxDebugUrl,
        restarted: false,
      };
    }
  } catch {
    // Server is not ready — fall through to a full restart.
  }

  const depsReady = await ensureProjectDependencies(context, state);
  if (!depsReady) {
    throw new Error('Project dependencies are not available for preview resume.');
  }

  const server = await startPreviewServer(context, state);
  await assertPreviewServerReady(context, server.readyPath);
  const links = await resolvePublicLinks(context);
  if (!links.previewUrl) {
    throw new Error('Preview server started but no public preview URL was available.');
  }
  state.previewUrl = links.previewUrl;
  state.sandboxDebugUrl = links.sandboxDebugUrl;
  return {
    url: links.previewUrl,
    sandboxDebugUrl: links.sandboxDebugUrl,
    // The dev server is a new process: whatever an open iframe shows is dead.
    restarted: true,
  };
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
    const snapshot = await getProjectSnapshot(context, conversationId);
    if (snapshot) {
      try {
        // Files-only restore first (snapshot excludes node_modules). Dependency
        // install happens in republishPreviewOnResume under its own budget.
        const restored = await withTimeout(
          restoreProjectArchive(context, state, snapshot, {
            installDependencies: false,
          }),
          RESTORE_BUDGET_MS,
          'snapshot restore',
        );
        hasFiles = restored.ok;
        if (!restored.ok) {
          restoreError = restored.error || 'Failed to restore the project from snapshot.';
        }
      } catch (error) {
        hasFiles = false;
        restoreError = error instanceof Error ? error.message : 'Snapshot restore failed.';
      }
    }
  }

  if (!hasFiles) {
    return {
      ok: true as const,
      stage: 'workspace' as const,
      conversation_id: conversationId,
      hasProject: false,
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
  // Only restart preview when publish_preview previously succeeded for this
  // conversation. Do NOT key off package.json — a stopped mid-generation
  // project often has a scaffold but is not previewable yet.
  const shouldRestartPreview = !generationActive && hasFileItems && hadPreview;

  let preview: { url?: string; sandboxDebugUrl?: string; error?: string; restarted?: boolean } = {};
  if (shouldRestartPreview) {
    try {
      preview = await withTimeout(
        republishPreviewOnResume(context, state),
        PREVIEW_RESTART_BUDGET_MS,
        'preview resume',
      );
      state.previewPublished = true;
    } catch (error) {
      state.previewUrl = undefined;
      state.sandboxDebugUrl = undefined;
      // Keep previewPublished so the next refresh retries instead of sticking to Files.
      // Keep the files panel usable; do not surface a hard preview error on resume.
      console.warn(
        '[resume:workspace] preview restart failed:',
        error instanceof Error ? error.message : error,
      );
      preview = {};
    }
  } else if (!generationActive && !hadPreview) {
    // Never-published / interrupted projects stay files-only.
    state.previewUrl = undefined;
    state.sandboxDebugUrl = undefined;
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
    return {
      ...workspace,
      stage: 'preview' as const,
    };
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
      WORKSPACE_RESUME_BUDGET_MS,
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
