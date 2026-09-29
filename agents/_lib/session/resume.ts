import type { AgentContext } from '../runtime/context.ts';
import {
  getChatTask,
  getConversationRecord,
  getProjectState,
} from './store.ts';
import {
  findLiveChatTask,
  hasLiveChatTask,
  isChatTaskActive,
  iterateLiveChatTaskEvents,
  settleUnrunTask,
} from './task.ts';
import { loadTranscriptJsonl } from './transcript.ts';
import { projectTranscript, turnsToMessages } from './projection.ts';
import { OBSERVER_STREAM_MAX_MS, READINESS_BUDGET_MS } from '../lazy/budgets.ts';
import { ensurePreview } from '../lazy/preview.ts';
import { activateSandbox } from '../lazy/sandbox.ts';
import { separateLegacyMakersDeployment } from '../project/state.ts';
import type { PersistedActivity, PersistedActivityTurn, ProjectState } from '../types.ts';
import type { ResumeData } from '../../../shared/protocol.ts';
import { createSSEResponse, sseEvent } from '../runtime/sse.ts';
import { isMakersDeployCommand, isMakersDevCommand } from '../makers/tool-phase.ts';
import { getRequestQueryParam, resolveConversationId } from '../runtime/request.ts';
import { withTimeout } from '../utils/timeout.ts';

function toolNameImpliesProject(name: string) {
  return name.includes('write_project_file')
    || name.includes('write_files')
    || /__files_write$/.test(name);
}

function activityIsMakersCli(activity: PersistedActivity) {
  if (activity.kind !== 'tool' || !activity.name.includes('commands')) return false;
  const command = activity.inputSummary || '';
  return isMakersDevCommand(command) || isMakersDeployCommand(command);
}

function activityHistoryImpliesProject(activityHistory: PersistedActivityTurn[]) {
  return activityHistory.some((turn) =>
    (turn.activities || []).some((activity: PersistedActivity) =>
      activity.kind === 'tool'
      && (toolNameImpliesProject(activity.name || '') || activityIsMakersCli(activity)),
    ),
  );
}

function activityHistoryImpliesPreview(activityHistory: PersistedActivityTurn[]) {
  return activityHistory.some((turn) =>
    (turn.activities || []).some((activity: PersistedActivity) =>
      activity.kind === 'tool'
      && activity.status === 'completed'
      && activity.name.includes('commands')
      && isMakersDevCommand(activity.command || activity.inputSummary || ''),
    ),
  );
}

function projectStateImpliesPreview(state: ProjectState, activityHistory: PersistedActivityTurn[] = []) {
  return Boolean(state.previewUrl)
    || Boolean(state.previewPublished)
    || activityHistoryImpliesPreview(activityHistory);
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

async function loadProjectResumeHistory(context: AgentContext, conversationId: string) {
  const [record, jsonl] = await Promise.all([
    getConversationRecord(context, conversationId),
    loadTranscriptJsonl(context, conversationId),
  ]);
  const model = record.modelPreference?.trim() || '';
  const storedLanguage = record.languagePreference;
  const language = storedLanguage === 'zh' || storedLanguage === 'en' ? storedLanguage : '';
  const state = separateLegacyMakersDeployment(record.projectState);
  const activityHistory = projectTranscript(jsonl, state.appDir);
  const messages = turnsToMessages(activityHistory);
  const storedTask = record.chatTask || null;
  let activeTask: ResumeData['activeTask'] = isChatTaskActive(storedTask)
    && hasLiveChatTask(conversationId, storedTask.id)
    ? {
        id: storedTask.id,
        message: storedTask.message,
        status: storedTask.status,
        createdAt: storedTask.createdAt,
        startedAt: storedTask.startedAt,
        preparePhase: storedTask.preparePhase,
      }
    : null;
  if (isChatTaskActive(storedTask) && !activeTask) {
    // Still making progress on another instance (after a redeploy, say): show
    // it running and let the client look again, rather than fail a live turn.
    if (await settleUnrunTask(context, conversationId, 'read') === 'elsewhere') {
      activeTask = {
        id: storedTask.id,
        message: storedTask.message,
        status: storedTask.status,
        createdAt: storedTask.createdAt,
        startedAt: storedTask.startedAt,
        preparePhase: storedTask.preparePhase,
        elsewhere: true,
      };
    }
  }

  const hasProject = Boolean(state.created) || activityHistoryImpliesProject(activityHistory);
  const hasPreview = projectStateImpliesPreview(state, activityHistory);

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
    // Restoring a project the agent already built also restores the one fact
    // the deploy button reads. The link itself is minted on demand by the
    // download route, so a static path is all the panel needs.
    ...(hasProject ? { download: { url: '/download', filename: 'source.zip' } } : {}),
    deployment: state.deployment,
    model,
    language: language || undefined,
    gatewayNeeded: state.gatewayPromptPending === true,
    gatewaySkipped: state.gatewaySkipped === true,
  };
}

/**
 * Opening the preview panel. Restores code if this sandbox is empty, then
 * mints a URL — installing dependencies and booting the dev server only when
 * the one already running is not answering.
 */
async function runPreviewRefreshBody(context: AgentContext, conversationId: string) {
  const stored = separateLegacyMakersDeployment(await getProjectState(context, conversationId));
  if (!stored.created && !stored.previewUrl && !stored.previewPublished) {
    return {
      ok: true as const,
      stage: 'preview' as const,
      conversation_id: conversationId,
      preview: {},
      deployment: stored.deployment,
    };
  }
  const { state } = await activateSandbox(context, conversationId);
  return {
    ok: true as const,
    stage: 'preview' as const,
    conversation_id: conversationId,
    preview: await ensurePreview(context, conversationId, state),
    deployment: state.deployment,
  };
}

export async function runProjectResumePreviewPipeline(context: AgentContext): Promise<Response> {
  const { conversationId } = resolveConversationId(context, { allowQuery: true });
  if (!conversationId) {
    return jsonResponse({ ok: false, error: 'missing conversation_id' }, 400);
  }

  try {
    const payload = await withTimeout(
      runPreviewRefreshBody(context, conversationId),
      READINESS_BUDGET_MS.workspace,
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
 * History, and a live task if this instance is still running one.
 * The sandbox and the coding agent stay cold until a prompt, a file read, or
 * a preview asks for them.
 *
 * `turnId` + `afterSeq` reopen an observer that hit its time limit: the turn's
 * events continue after that sequence, without reloading history. If this
 * process no longer holds the turn, it falls back to a full resume.
 */
export async function createProjectResumeStreamResponse(context: AgentContext): Promise<Response> {
  const { conversationId } = resolveConversationId(context, { allowQuery: true });
  if (!conversationId) {
    return jsonResponse({ ok: false, error: 'missing conversation_id' }, 400);
  }
  const turnId = getRequestQueryParam(context, 'turnId').value;
  const afterSeq = Number.parseInt(getRequestQueryParam(context, 'afterSeq').value, 10);
  const resumingTask = turnId && Number.isFinite(afterSeq)
    ? findLiveChatTask(conversationId, turnId)
    : null;

  return createSSEResponse(async function* (signal) {
    if (resumingTask) {
      yield* iterateLiveChatTaskEvents(context, conversationId, resumingTask, undefined, signal, {
        afterSeq,
        maxMs: OBSERVER_STREAM_MAX_MS,
      });
      return;
    }

    const history = await loadProjectResumeHistory(context, conversationId);
    if (signal?.aborted) return;
    yield sseEvent({ type: 'resume_history', data: history });

    const storedTask = await getChatTask(context, conversationId);
    if (isChatTaskActive(storedTask) && hasLiveChatTask(conversationId, storedTask.id)) {
      yield* iterateLiveChatTaskEvents(context, conversationId, storedTask, undefined, signal, {
        maxMs: OBSERVER_STREAM_MAX_MS,
      });
    }
  }, context?.request?.signal);
}
