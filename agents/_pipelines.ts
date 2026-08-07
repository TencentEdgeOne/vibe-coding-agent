import { runCodingAgent } from './_agent';
import { AUTO_FIX_MAX_ATTEMPTS } from './_constants';
import {
  appendTurn,
  clearProjectSnapshot,
  getActivityHistory,
  getHistory,
  getProjectSnapshot,
  getProjectState,
  saveProjectSnapshot,
  saveProjectState,
  saveActivityTurn,
} from './_memory';
import {
  createProjectState,
  createProjectArchive,
  getFileTree,
  readFileFromSandbox,
  resetProjectWorkspace,
  restoreProjectArchive,
  resolvePublicLinks,
  runSandboxCommand,
  runVerification,
  startPreviewServer,
  assertPreviewServerReady,
} from './_project';
import type {
  AgentProgressEvent,
  BuildStatus,
  FileTreeItem,
  PersistedActivity,
  ProjectState,
  ScaffoldLog,
  StreamSend,
} from './_types';
import { buildAutoFixPrompt } from './utils/_build-errors';
import { debugLog } from './utils/_debug';
import { normalizeRelPath } from './utils/_paths';
import { sanitizeAssistantText } from './utils/_text';

const SANDBOX_EXTENSION_SECONDS = 1800;

type SandboxWithTimeoutExtension = {
  extendTimeout?: (seconds: number) => unknown;
};

function stripReturnedPreviewLinks(text: string, previewUrl?: string) {
  if (!text || !previewUrl) {
    return text;
  }
  const escapedUrl = escapeRegExp(previewUrl);
  return text
    .replace(new RegExp(`\\s*\\[[^\\]]*(?:打开预览|预览|preview)[^\\]]*\\]\\(${escapedUrl}\\)`, 'gi'), '')
    .replace(new RegExp(`\\s*${escapedUrl}`, 'g'), '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildRequirementConclusionFallback(
  request: string,
  status: 'pending' | 'ready' | 'generated',
) {
  const summary = summarizeUserRequest(request);
  const isEnglish = !/[\u3400-\u9fff]/.test(request);

  if (isEnglish) {
    if (status === 'ready') {
      return `Built this for your request: ${summary}. The preview is ready in the right preview panel.`;
    }
    if (status === 'generated') {
      return `Generated the project for your request: ${summary}.`;
    }
    return `Handled your request: ${summary}. Verification and preview results are being prepared.`;
  }

  if (status === 'ready') {
    return `Built this for your request: ${summary}. The preview is ready in the right preview panel.`;
  }
  if (status === 'generated') {
    return `Generated the project for your request: ${summary}.`;
  }
  return `Handled your request: ${summary}. Verification and preview results are being prepared.`;
}

function summarizeUserRequest(request: string) {
  const normalized = request.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return 'your web project';
  }
  const maxLength = 80;
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength).trimEnd()}...`
    : normalized;
}

function isGenericCompletionReply(text: string) {
  const normalized = text.replace(/\s+/g, '').replace(/[。.!！]+$/g, '');
  return normalized === '已编写完成，请查看结果'
    || normalized === '已完成，请查看结果'
    || /^theagentdidnotreturnanythingdisplayable$/i.test(normalized);
}

function getRequestHeader(context: any, name: string): string {
  const headers = context?.request?.headers;
  if (!headers) return '';

  const lowerName = name.toLowerCase();
  const directValue = headers[name] ?? headers[lowerName];
  const value = directValue ?? Object.entries(headers).find(([key]) => key.toLowerCase() === lowerName)?.[1];
  return typeof value === 'string' ? value : String(value || '');
}

function queryValueToString(value: unknown): string {
  if (Array.isArray(value)) {
    return queryValueToString(value[0]);
  }
  if (value === undefined || value === null) {
    return '';
  }
  return typeof value === 'string' ? value : String(value);
}

function getSearchParamFromString(rawValue: unknown, name: string): string {
  if (typeof rawValue !== 'string' || !rawValue.trim()) {
    return '';
  }

  const raw = rawValue.trim();
  try {
    if (raw.startsWith('?')) {
      return new URLSearchParams(raw.slice(1)).get(name) || '';
    }
    if (raw.includes('?') || raw.startsWith('/') || /^https?:\/\//i.test(raw)) {
      return new URL(raw, 'http://local').searchParams.get(name) || '';
    }
    if (raw.includes('=')) {
      return new URLSearchParams(raw).get(name) || '';
    }
  } catch {
    return '';
  }

  return '';
}

function getRequestQueryParam(context: any, name: string): {
  value: string;
  source: string;
} {
  const request = context?.request || {};
  const stringFields = [
    'url',
    'path',
    'pathname',
    'search',
    'queryString',
    'rawUrl',
    'originalUrl',
  ];
  for (const field of stringFields) {
    const value = getSearchParamFromString(request[field], name);
    if (value) {
      return { value, source: `request.${field}` };
    }
  }

  const queryObjects = [
    { source: 'request.query', value: request.query },
    { source: 'request.params', value: request.params },
    { source: 'request.searchParams', value: request.searchParams },
    { source: 'context.query', value: context?.query },
    { source: 'context.params', value: context?.params },
  ];
  for (const query of queryObjects) {
    if (query.value && typeof query.value.get === 'function') {
      const value = query.value.get(name);
      if (value) {
        return { value: queryValueToString(value), source: query.source };
      }
      continue;
    }
    if (!query || typeof query !== 'object') continue;
    const value = query.value?.[name];
    const normalized = queryValueToString(value);
    if (normalized) {
      return { value: normalized, source: query.source };
    }
  }

  return { value: '', source: 'none' };
}

function getRequestDebugSnapshot(context: any): Record<string, unknown> {
  const request = context?.request || {};
  const snapshot: Record<string, unknown> = {
    requestKeys: Object.keys(request).slice(0, 24),
  };
  for (const field of ['url', 'path', 'pathname', 'search', 'queryString', 'rawUrl', 'originalUrl']) {
    if (typeof request[field] === 'string' && request[field]) {
      snapshot[field] = request[field].slice(0, 300);
    }
  }
  for (const field of ['query', 'params', 'searchParams']) {
    const value = request[field];
    if (value && typeof value === 'object') {
      snapshot[field] = typeof value.entries === 'function'
        ? Object.fromEntries(Array.from(value.entries() as Iterable<[PropertyKey, unknown]>).slice(0, 20))
        : Object.keys(value).slice(0, 20);
    }
  }
  return snapshot;
}

function maskConversationId(value: string): string {
  if (!value) return '<empty>';
  if (value.length <= 12) return `${value.slice(0, 2)}...${value.slice(-2)}`;
  return `${value.slice(0, 6)}...${value.slice(-6)}`;
}

async function extendExistingSandboxTimeout(context: any) {
  const sandbox = context?.sandbox as SandboxWithTimeoutExtension | undefined;
  if (!sandbox || typeof sandbox.extendTimeout !== 'function') {
    return;
  }

  try {
    await sandbox.extendTimeout(SANDBOX_EXTENSION_SECONDS);
    debugLog(context, '[sandbox]', {
      stage: 'extend-timeout',
      seconds: SANDBOX_EXTENSION_SECONDS,
    });
  } catch (error) {
    console.warn('[sandbox]', {
      stage: 'extend-timeout-failed',
      seconds: SANDBOX_EXTENSION_SECONDS,
      error: error instanceof Error ? error.message : String(error || ''),
    });
  }
}

// Code persistence (防丢失): snapshot the current project into the store so the
// generated code survives sandbox recycling. Best-effort — a snapshot failure must
// never break the turn's result. Called on every path where the project has files
// on disk, INCLUDING fatal-build turns: the code was still generated, so it must not
// be lost just because verification failed (a later restore/resume needs it).
async function persistProjectSnapshot(
  context: any,
  conversationId: string,
  state: ProjectState,
) {
  try {
    const archive = await createProjectArchive(context, state);
    if (archive.ok) {
      await saveProjectSnapshot(context, conversationId, {
        base64: archive.base64,
        filename: archive.filename,
        contentType: archive.contentType,
        size: archive.size,
        updatedAt: Date.now(),
      });
    }
  } catch (error) {
    debugLog(context, '[snapshot]', {
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function runFileReadPipeline(context: any): Promise<Response> {
  const contextConversationId = String(context.conversation_id || '');
  const pagesHeaderConversationId = getRequestHeader(context, 'makers-conversation-id');
  const headerConversationId = getRequestHeader(context, 'conversationId');
  const conversationId = contextConversationId || pagesHeaderConversationId || headerConversationId;
  const conversationSource = contextConversationId
    ? 'context.conversation_id'
    : pagesHeaderConversationId
      ? 'makers-conversation-id'
      : headerConversationId
        ? 'conversationId'
        : 'none';
  const diagnosticBase = {
    contextConversationId: maskConversationId(contextConversationId),
    pagesHeaderConversationId: maskConversationId(pagesHeaderConversationId),
    headerConversationId: maskConversationId(headerConversationId),
    selectedConversationId: maskConversationId(conversationId),
    selectedConversationSource: conversationSource,
  };
  const pathParam = getRequestQueryParam(context, 'path');
  const relPath = pathParam.value;
  if (!conversationId) {
    debugLog(context, '[file-read]', {
      ...diagnosticBase,
      rawPath: relPath,
      pathSource: pathParam.source,
      normalizedPath: null,
      error: 'missing conversation_id',
    });
    return new Response(JSON.stringify({ ok: false, error: 'missing conversation_id' }), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
  const norm = normalizeRelPath(relPath);
  if (!norm) {
    debugLog(context, '[file-read]', {
      ...diagnosticBase,
      rawPath: relPath,
      pathSource: pathParam.source,
      normalizedPath: null,
      error: 'invalid path',
      request: getRequestDebugSnapshot(context),
    });
    return new Response(JSON.stringify({ ok: false, error: 'invalid path' }), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }

  const state = await getProjectState(context, conversationId);
  debugLog(context, '[file-read]', {
    ...diagnosticBase,
    rawPath: relPath,
    pathSource: pathParam.source,
    normalizedPath: norm,
    appDir: state.appDir,
    stage: 'before-read',
  });
  const res = await readFileFromSandbox(context, state, norm);
  debugLog(context, '[file-read]', {
    ...diagnosticBase,
    normalizedPath: norm,
    appDir: state.appDir,
    ok: res.ok,
    error: res.error,
    size: res.size,
    truncated: res.truncated,
    stage: 'after-read',
  });
  return new Response(
    JSON.stringify({ path: norm, ...res }),
    { headers: { 'content-type': 'application/json; charset=utf-8' } },
  );
}

export async function runProjectDownloadPipeline(context: any): Promise<Response> {
  const contextConversationId = String(context.conversation_id || '');
  const pagesHeaderConversationId = getRequestHeader(context, 'makers-conversation-id');
  const headerConversationId = getRequestHeader(context, 'conversationId');
  // Query-param fallback so a plain navigation can still target the right
  // sandbox; the frontend prefers the headers.
  const queryConversationId = getRequestQueryParam(context, 'cid').value
    || getRequestQueryParam(context, 'conversationId').value;
  const conversationId = contextConversationId
    || pagesHeaderConversationId
    || headerConversationId
    || queryConversationId;

  const jsonError = (error: string, status = 400) => new Response(
    JSON.stringify({ ok: false, error }),
    { status, headers: { 'content-type': 'application/json; charset=utf-8' } },
  );

  if (!conversationId) {
    return jsonError('missing conversation_id');
  }

  const state = await getProjectState(context, conversationId);

  // Prefer the persisted snapshot so download works even after the sandbox is
  // recycled (the code lives durably in the store, not just in /tmp). Fall back to
  // packaging the live sandbox when no snapshot exists yet (e.g. first turn wrote
  // it after this download, or the snapshot write failed) — a pragmatic deviation
  // from plan §3.3.1-④ which forbade the fallback; keeping it avoids a dead-end
  // "not ready" error while the sandbox is still alive.
  const snapshot = await getProjectSnapshot(context, conversationId);
  if (snapshot?.base64) {
    return new Response(
      JSON.stringify({
        ok: true,
        filename: snapshot.filename,
        contentType: snapshot.contentType,
        size: snapshot.size,
        base64: snapshot.base64,
      }),
      {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        },
      },
    );
  }

  let archive;
  try {
    archive = await createProjectArchive(context, state);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to package the project.';
    return jsonError(message, 500);
  }

  if (!archive.ok) {
    return jsonError(archive.error, 409);
  }

  return new Response(
    JSON.stringify({
      ok: true,
      filename: archive.filename,
      contentType: archive.contentType,
      size: archive.size,
      base64: archive.base64,
    }),
    {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    },
  );
}

// Rehydrate a conversation after a page refresh. The sandbox /tmp is volatile, so
// the project may be gone even though history + snapshot survive in the store. This
// endpoint restores the code from the snapshot (when needed), restarts the preview,
// and returns everything the frontend needs to rebuild the workspace — without
// running the agent. Single JSON response (restore + npm install can take a while).
export async function runProjectResumePipeline(context: any): Promise<Response> {
  const contextConversationId = String(context.conversation_id || '');
  const pagesHeaderConversationId = getRequestHeader(context, 'makers-conversation-id');
  const headerConversationId = getRequestHeader(context, 'conversationId');
  const queryConversationId = getRequestQueryParam(context, 'cid').value
    || getRequestQueryParam(context, 'conversationId').value;
  const conversationId = contextConversationId
    || pagesHeaderConversationId
    || headerConversationId
    || queryConversationId;

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

export async function runChatPipeline(
  context: any,
  message: string,
  send: StreamSend,
  options: { resetProject?: boolean; turnId?: string; userMessagePersisted?: boolean } = {},
) {
  const contextConversationId = String(context.conversation_id || '');
  const pagesHeaderConversationId = getRequestHeader(context, 'makers-conversation-id');
  const headerConversationId = getRequestHeader(context, 'conversationId');
  const conversationId = contextConversationId || pagesHeaderConversationId || headerConversationId;
  const abortSignal = context?.request?.signal as AbortSignal | undefined;

  if (!message) {
    send({
      type: 'result',
      data: {
        ok: false,
        conversation_id: conversationId,
        reply: 'Please describe the page or feature you want to build first.',
        build: { status: 'skipped' as BuildStatus },
        preview: {},
      },
    });
    return;
  }

  if (!conversationId) {
    send({
      type: 'result',
      data: {
        ok: false,
        conversation_id: '',
        reply: 'Missing conversationId. The project workspace cannot be prepared.',
        build: { status: 'skipped' as BuildStatus },
        preview: {},
      },
    });
    return;
  }

  await extendExistingSandboxTimeout(context);

  send({
    type: 'status',
    message: 'Running the agent workflow',
  });

  const shouldResetProject = options.resetProject === true;
  const state = shouldResetProject
    ? createProjectState(conversationId)
    : await getProjectState(context, conversationId);
  if (shouldResetProject) {
    await resetProjectWorkspace(context, state);
    // Starting over: drop any stale snapshot so a later empty-appDir turn cannot
    // restore the previous project. (The frontend also rotates conversationId on a
    // fresh start, so this is belt-and-suspenders.)
    await clearProjectSnapshot(context, conversationId);
  } else {
    // Code persistence (防丢失): the sandbox /tmp is volatile, so the generated
    // project may be gone between requests. When the appDir is missing but a
    // snapshot exists, restore it before the agent runs so ensure_project_scaffold
    // sees existing files (created=false) and the agent edits the real project.
    try {
      const appDirExists = await context.sandbox.files.exists(state.appDir);
      if (!appDirExists) {
        const snapshot = await getProjectSnapshot(context, conversationId);
        if (snapshot) {
          send({ type: 'status', message: 'Restoring project from snapshot' });
          const restored = await restoreProjectArchive(context, state, snapshot);
          if (!restored.ok) {
            send({
              type: 'log',
              phase: 'scaffold',
              stream: 'stderr',
              message: restored.error || 'Failed to restore the project from snapshot.',
            });
          }
        }
      }
    } catch (error) {
      // Restore is best-effort: if it fails, fall through and let the agent
      // scaffold/regenerate as usual rather than aborting the turn.
      send({
        type: 'log',
        phase: 'scaffold',
        stream: 'stderr',
        message: error instanceof Error ? error.message : 'Snapshot restore check failed.',
      });
    }
  }
  const history = shouldResetProject
    ? []
    : await getHistory(context, conversationId, {
      excludeLatestUserMessage: options.userMessagePersisted ? message : undefined,
    });
  const isInitialProjectTurn = !state.created;
  const hiddenScaffoldToolUseIds = new Set<string>();
  const activityTurnId = options.turnId
    || String(context?.run_id || `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const activities: PersistedActivity[] = [];

  const recordProgress = (event: AgentProgressEvent) => {
    if (event.type === 'text_segment') {
      const text = event.data.text;
      if (!text) return;
      const last = activities.at(-1);
      if (last?.kind === 'text') last.content += text;
      else activities.push({ kind: 'text', content: text });
      return;
    }

    if (event.type === 'tool_use') {
      const existing = activities.find(
        (item): item is Extract<PersistedActivity, { kind: 'tool' }> =>
          item.kind === 'tool' && item.toolUseId === event.data.id,
      );
      if (existing) {
        existing.name = event.data.name || existing.name;
        existing.inputSummary = event.data.inputSummary || existing.inputSummary;
        return;
      }
      activities.push({
        kind: 'tool',
        toolUseId: event.data.id,
        name: event.data.name,
        status: 'running',
        inputSummary: event.data.inputSummary,
        startedAt: event.data.startedAt || Date.now(),
      });
      return;
    }

    const existing = activities.find(
      (item): item is Extract<PersistedActivity, { kind: 'tool' }> =>
        item.kind === 'tool' && item.toolUseId === event.data.tool_use_id,
    );
    if (existing) {
      existing.status = event.data.status || (event.data.ok ? 'completed' : 'failed');
      existing.outputSummary = event.data.outputSummary || event.data.preview;
      existing.endedAt = event.data.endedAt || Date.now();
    }
  };

  const persistConversationTurn = async (
    assistant: string,
    status: 'completed' | 'failed' | 'stopped',
  ) => {
    if (status === 'stopped') {
      for (const activity of activities) {
        if (activity.kind === 'tool' && activity.status === 'running') {
          activity.status = 'stopped';
          activity.endedAt = Date.now();
        }
      }
    }
    if (!options.userMessagePersisted) {
      await appendTurn(context, conversationId, 'user', message);
    }
    await appendTurn(context, conversationId, 'assistant', assistant);
    await saveActivityTurn(context, conversationId, {
      id: activityTurnId,
      user: message,
      assistant,
      status,
      createdAt: Date.now(),
      activities,
    });
  };

  const handleScaffoldLog = (log: ScaffoldLog) => {
    if (!isInitialProjectTurn) {
      return;
    }
    send({
      type: 'log',
      phase: 'scaffold',
      stream: log.stream,
      message: log.content,
    });
  };
  const forwardProgress = (event: AgentProgressEvent) => {
    // Forward structured progress events directly; the frontend renders by type.
    if (
      !isInitialProjectTurn
      && event.type === 'tool_use'
      && (event.data.name === 'ensure_project_scaffold' || event.data.name.endsWith('__ensure_project_scaffold'))
    ) {
      hiddenScaffoldToolUseIds.add(event.data.id);
      return;
    }
    if (!isInitialProjectTurn && event.type === 'tool_result' && hiddenScaffoldToolUseIds.has(event.data.tool_use_id)) {
      return;
    }
    if (event.type === 'text_segment') {
      const text = state.previewUrl
        ? stripReturnedPreviewLinks(event.data.text, state.previewUrl)
        : event.data.text;
      if (text.length === 0) {
        return;
      }
      recordProgress({ ...event, data: { ...event.data, text } });
      send({
        ...event,
        data: {
          ...event.data,
          text,
        },
      } as unknown as Record<string, unknown>);
      return;
    }
    recordProgress(event);
    send(event as unknown as Record<string, unknown>);
  };
  const pushFileTree = async (fallbackMessage: string): Promise<FileTreeItem[]> => {
    try {
      const tree = await getFileTree(context, state);
      send({
        type: 'file_tree',
        data: {
          root: state.appDir,
          items: tree,
        },
      });
      return tree;
    } catch (error) {
      send({
        type: 'log',
        phase: 'agent',
        stream: 'stderr',
        message: error instanceof Error ? error.message : fallbackMessage,
      });
      return [];
    }
  };
  const pushEarlyFileTree = async () => {
    // Push file_tree as soon as scaffold succeeds so the Files panel does not
    // have to wait for the whole turn. Failures are non-fatal because the final
    // state is pushed again at turn completion.
    await pushFileTree('Failed to read the file list after scaffold.');
  };

  // The model handles creative code work; build and service steps remain deterministic.
  const modelResult = await runCodingAgent(
    context,
    conversationId,
    message,
    history,
    state,
    !state.created,
    handleScaffoldLog,
    forwardProgress,
    pushEarlyFileTree,
    abortSignal,
  );

  if (modelResult.stopped || abortSignal?.aborted) {
    const stoppedReply = /[\u3400-\u9fff]/.test(message)
      ? '已停止本次生成，你可以继续描述下一步修改。'
      : 'Generation stopped. You can continue with another change.';
    await persistConversationTurn(stoppedReply, 'stopped');
    await saveProjectState(context, conversationId, state);
    if (modelResult.projectTouched) await persistProjectSnapshot(context, conversationId, state);
    send({
      type: 'result',
      data: {
        ok: false,
        stopped: true,
        reply: stoppedReply,
        conversation_id: conversationId,
        build: { status: 'skipped' as BuildStatus },
        preview: state.previewUrl ? { url: state.previewUrl, sandboxDebugUrl: state.sandboxDebugUrl } : {},
      },
    });
    return;
  }
  const sanitizedModelOutput = modelResult.success && modelResult.output
    ? sanitizeAssistantText(modelResult.output)
    : '';
  const modelOutput = sanitizedModelOutput && !isGenericCompletionReply(sanitizedModelOutput)
    ? sanitizedModelOutput
    : '';
  const fallbackReply = modelResult.success
    ? buildRequirementConclusionFallback(message, state.previewUrl ? 'ready' : 'pending')
    : (modelResult.error || 'An error occurred during processing. Please try again.');
  const assistantReply = stripReturnedPreviewLinks(sanitizeAssistantText(
    modelOutput || fallbackReply
  ) || fallbackReply, state.previewUrl);

  send({
    type: 'agent',
    data: {
      ok: modelResult.success,
      reply: assistantReply,
      ...(modelResult.error ? { error: modelResult.error } : {}),
    },
  });

  if (modelResult.fatal) {
    await persistConversationTurn(assistantReply, 'failed');
    await saveProjectState(context, conversationId, state);

    send({
      type: 'result',
      data: {
        ok: false,
        reply: assistantReply,
        conversation_id: conversationId,
        build: {
          status: 'skipped' as BuildStatus,
          stderr: modelResult.error || assistantReply,
        },
        preview: {},
      },
    });
    return;
  }

  if (!modelResult.projectTouched && modelResult.previewTouched) {
    if (state.previewUrl) {
      send({
        type: 'preview_ready',
        data: {
          preview: {
            url: state.previewUrl,
            sandboxDebugUrl: state.sandboxDebugUrl,
          },
        },
      });
    }

    await persistConversationTurn(assistantReply, modelResult.success ? 'completed' : 'failed');
    await saveProjectState(context, conversationId, state);

    send({
      type: 'result',
      data: {
        ok: modelResult.success && Boolean(state.previewUrl),
        reply: assistantReply,
        conversation_id: conversationId,
        build: { status: 'skipped' as BuildStatus },
        preview: {
          url: state.previewUrl,
          sandboxDebugUrl: state.sandboxDebugUrl,
          ...(!state.previewUrl ? { error: 'The agent did not complete publish_preview.' } : {}),
        },
      },
    });
    return;
  }

  if (!modelResult.projectTouched) {
    await persistConversationTurn(assistantReply, modelResult.success ? 'completed' : 'failed');

    send({
      type: 'result',
      data: {
        ok: modelResult.success,
        reply: assistantReply,
        conversation_id: conversationId,
        build: { status: 'skipped' as BuildStatus },
        preview: {},
      },
    });
    return;
  }

  let fileTree = await pushFileTree('Failed to read the file list.');
  let build = await runVerification(context, state);
  let autoFixAttempts = 0;
  let autoFixApplied = false;
  let autoFixReply = '';

  // The project has files on disk from here on, so expose a download link. The
  // archive is built on demand by /download; this is just a pointer (the
  // authoritative filename comes from the /download response).
  const downloadLink = { url: '/download', filename: 'source.zip' };

  if (build.fatal) {
    const fatalReply = build.stderr || 'The task failed, and the remaining workflow was stopped.';
    await persistConversationTurn(fatalReply, 'failed');
    await saveProjectState(context, conversationId, state);
    // Files were generated this turn; persist them even though verification failed,
    // so the work survives a sandbox recycle and download/resume still see it.
    await persistProjectSnapshot(context, conversationId, state);

    send({
      type: 'result',
      data: {
        ok: false,
        reply: fatalReply,
        conversation_id: conversationId,
        project: {
          dir: state.appDir,
          created: modelResult.wasCreated,
        },
        build,
        files: {
          root: state.appDir,
          items: fileTree,
        },
        download: downloadLink,
        preview: {},
      },
    });
    return;
  }

  if (build.status === 'failed' && modelResult.success) {
    autoFixAttempts = AUTO_FIX_MAX_ATTEMPTS;
    autoFixApplied = true;
    send({
      type: 'status',
      message: `Verification failed. Running auto-fix 1/${AUTO_FIX_MAX_ATTEMPTS}`,
    });

    const autoFixPrompt = buildAutoFixPrompt(
      message,
      assistantReply,
      build,
      1,
      AUTO_FIX_MAX_ATTEMPTS,
    );
    const autoFixResult = await runCodingAgent(
      context,
      conversationId,
      autoFixPrompt,
      [
        ...history,
        { role: 'user', content: message },
        { role: 'assistant', content: assistantReply },
      ],
      state,
      false,
      handleScaffoldLog,
      forwardProgress,
      pushEarlyFileTree,
      abortSignal,
    );
    if (autoFixResult.stopped || abortSignal?.aborted) {
      const stoppedReply = /[\u3400-\u9fff]/.test(message)
        ? '已停止本次生成，你可以继续描述下一步修改。'
        : 'Generation stopped. You can continue with another change.';
      await persistConversationTurn(stoppedReply, 'stopped');
      await saveProjectState(context, conversationId, state);
      await persistProjectSnapshot(context, conversationId, state);
      send({
        type: 'result',
        data: {
          ok: false,
          stopped: true,
          reply: stoppedReply,
          conversation_id: conversationId,
          build: { status: 'skipped' as BuildStatus },
          preview: state.previewUrl ? { url: state.previewUrl, sandboxDebugUrl: state.sandboxDebugUrl } : {},
        },
      });
      return;
    }
    autoFixReply = stripReturnedPreviewLinks(sanitizeAssistantText(
      autoFixResult.success && autoFixResult.output
        ? autoFixResult.output
        : autoFixResult.error || ''
    ), state.previewUrl);

    if (autoFixReply) {
      send({
        type: 'agent',
        data: {
          ok: autoFixResult.success,
          reply: autoFixReply,
          ...(autoFixResult.error ? { error: autoFixResult.error } : {}),
        },
      });
    }

    fileTree = await pushFileTree('Failed to read the file list after auto-fix.');
    build = await runVerification(context, state);
    if (build.fatal) {
      const fatalReply = build.stderr || 'The task failed, and the remaining workflow was stopped.';
      await persistConversationTurn(fatalReply, 'failed');
      await saveProjectState(context, conversationId, state);
      // Persist the generated files even on a fatal auto-fix outcome (see above).
      await persistProjectSnapshot(context, conversationId, state);

      send({
        type: 'result',
        data: {
          ok: false,
          reply: fatalReply,
          conversation_id: conversationId,
          project: {
            dir: state.appDir,
            created: modelResult.wasCreated,
          },
          build,
          files: {
            root: state.appDir,
            items: fileTree,
          },
          download: downloadLink,
          preview: {},
        },
      });
      return;
    }
  }

  build = {
    ...build,
    ...(autoFixAttempts > 0 ? { autoFixAttempts, autoFixApplied } : {}),
  };

  // Preview startup, HTTP readiness checks, and link generation are handled by publish_preview.
  // publish_preview, or the legacy get_preview_link alias, writes state.previewUrl / state.sandboxDebugUrl.
  if (state.previewUrl) {
    send({
      type: 'preview_ready',
      data: {
        preview: {
          url: state.previewUrl,
          sandboxDebugUrl: state.sandboxDebugUrl,
        },
      },
    });
  }

  const autoFixSuffix = autoFixAttempts > 0
    ? build.status === 'success'
      ? ` Auto-fix ran ${autoFixAttempts} time(s) based on the verification error, and verification now passes.`
      : ` Auto-fix ran ${autoFixAttempts} time(s), but verification still fails. The final logs are preserved for further debugging.`
    : '';
  const buildFailedSuffix = build.status === 'failed' && autoFixAttempts === 0
    ? ' Verification currently fails, so I did not describe the update as successful. Please continue debugging from the logs.'
    : '';
  const missingPreviewSuffix = state.previewUrl
    ? ''
    : ' No preview link was obtained. Please continue by asking the agent to call publish_preview.';
  const finalFallbackReply = buildRequirementConclusionFallback(
    message,
    build.status !== 'failed' && state.previewUrl ? 'ready' : 'generated',
  );
  const baseReply = autoFixReply || (modelOutput ? assistantReply : finalFallbackReply);
  const reply = stripReturnedPreviewLinks(
    `${baseReply}${autoFixSuffix}${buildFailedSuffix}${missingPreviewSuffix}`,
    state.previewUrl,
  );

  // Append this turn first, which also creates the conversation, then write projectState to metadata.
  await persistConversationTurn(
    reply,
    modelResult.success && build.status !== 'failed' && Boolean(state.previewUrl) ? 'completed' : 'failed',
  );
  await saveProjectState(context, conversationId, state);

  // Code persistence (防丢失): snapshot the project into the store so the code
  // survives sandbox recycling. Reached only after a project was generated/modified
  // this turn (the no-touch / preview-only cases return earlier).
  await persistProjectSnapshot(context, conversationId, state);

  send({
    type: 'result',
    data: {
      ok: modelResult.success && build.status !== 'failed' && Boolean(state.previewUrl),
      reply,
      conversation_id: conversationId,
      project: {
        dir: state.appDir,
        created: modelResult.wasCreated,
      },
      build,
      files: {
        root: state.appDir,
        items: fileTree,
      },
      download: downloadLink,
      preview: {
        url: state.previewUrl,
        sandboxDebugUrl: state.sandboxDebugUrl,
        ...(!state.previewUrl ? { error: 'The agent did not complete publish_preview.' } : {}),
      },
    },
  });
}
