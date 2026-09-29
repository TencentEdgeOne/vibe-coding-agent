import type { AgentContext } from '../runtime/context.ts';
import { runCodingAgent } from '../session/live.ts';
import { activateSandbox } from '../lazy/sandbox.ts';
import {
  bindSiteDomain,
  persistWorkspace,
  publishPreview,
  setDeployment,
} from '../project/workspace-store.ts';
import { workspaceSnapshotFromState } from '../project/snapshot.ts';
import type {
  AgentProgressEvent,
  DeploymentInfo,
  PreviewKind,
  StreamSend,
} from '../types.ts';
import { toAppRelPath } from '../utils/paths.ts';
import { sanitizeAssistantText } from '../../../shared/timeline.ts';
import { resolveConversationId, resolveRequestSiteDomain } from '../runtime/request.ts';
import {
  compactUserFacingReply,
  createProjectCheckpointController,
  isGenericCompletionReply,
  replyLocaleFor,
  stripReturnedPreviewLinks,
  withLiveDeploymentUrl,
  buildRequirementConclusionFallback,
} from './checkpoint.ts';
import { bindLiveWorkspace } from '../session/live-workspace.ts';
import { createTurnLifecycle } from './lifecycle.ts';
import { applyUserGatewayDecision } from '../project/gateway.ts';
import { resolveGatewayUserTurn } from '../../../shared/gateway-secret.ts';
import { sendTurnResult } from './result.ts';
import type { ChatResponse } from '../../../shared/protocol.ts';

function slimResult(
  conversationId: string,
  extra: Omit<ChatResponse, 'conversation_id'>,
): ChatResponse {
  return { conversation_id: conversationId, ...extra };
}

export async function runChatPipeline(
  context: AgentContext,
  message: string,
  send: StreamSend,
  options: {
    turnId?: string;
    /** Validated model for this turn; '' or absent runs the configured default. */
    model?: string;
    /** Real Models API key from the card or a chat sentence; never persisted. */
    apiKey?: string;
    gatewaySkip?: boolean;
  } = {},
) {
  const { conversationId } = resolveConversationId(context);
  const abortSignal = context?.request?.signal as AbortSignal | undefined;

  if (!message) {
    sendTurnResult(send, slimResult(conversationId, {
      ok: false,
      reply: 'Please describe the page or feature you want to build first.',
    }));
    return;
  }

  if (!conversationId) {
    sendTurnResult(send, slimResult('', {
      ok: false,
      reply: 'Missing conversationId. The project workspace cannot be prepared.',
    }));
    return;
  }

  send({ type: 'prepare_phase', data: { phase: 'workspace' } });
  const { state } = await activateSandbox(context, conversationId, { send });
  if (bindSiteDomain(state, resolveRequestSiteDomain(context))) {
    await persistWorkspace(context, conversationId, state);
  }
  const inboundGateway = resolveGatewayUserTurn(message, options.apiKey);
  message = inboundGateway.message;
  if (inboundGateway.apiKey || options.gatewaySkip) {
    await applyUserGatewayDecision(
      context,
      state,
      conversationId,
      {
        ...(inboundGateway.apiKey ? { apiKey: inboundGateway.apiKey } : {}),
        ...(options.gatewaySkip ? { skip: true } : {}),
      },
      send,
    );
  }
  bindLiveWorkspace(conversationId, state, send);
  const activityTurnId = options.turnId
    || String(context?.run_id || `${Date.now()}-${Math.random().toString(36).slice(2)}`);

  const checkpoint = createProjectCheckpointController(context, conversationId, state, (persistenceError) => {
    console.warn('[checkpoint]', persistenceError);
  });
  const turn = createTurnLifecycle({
    context,
    conversationId,
    message,
    turnId: activityTurnId,
    state,
    checkpoint,
  });
  const recordProgress = turn.recordProgress;
  const finalizeTurn = turn.finalize;

  const forwardProgress = (event: AgentProgressEvent) => {
    if (event.type === 'text_segment') {
      const text = state.previewUrl
        ? stripReturnedPreviewLinks(event.data?.text || '', state.previewUrl)
        : event.data?.text || '';
      if (text.length === 0) {
        return;
      }
      const narration = { ...event, data: { ...event.data, text } };
      recordProgress(narration);
      send(narration);
      return;
    }
    if (event.type === 'thinking_segment' && !event.data?.text) {
      return;
    }
    if (event.type === 'system_info' && !event.data?.content && !event.data?.title) {
      return;
    }
    recordProgress(event);
    send(event);
  };
  const finishResult = (extra: Omit<ChatResponse, 'conversation_id'>) => {
    sendTurnResult(
      send,
      slimResult(conversationId, extra),
      workspaceSnapshotFromState(conversationId, state, undefined, {
        // The turn knows whether it produced a project, which is what makes the
        // download link (and the deploy button it gates) available. Asking for
        // a file listing here would attach the sandbox after the model stopped.
        hasDownload: state.created,
      }),
    );
  };
  const handleProjectFilesChanged = async (file?: { path: string; content: string }) => {
    if (file) {
      const path = toAppRelPath(file.path, state.appDir) || file.path;
      send({ type: 'file_changed', data: { paths: [path] } });
    }
    checkpoint.schedule();
  };

  /**
   * A preview the agent brought up itself. Record it and let the panel know;
   * the host no longer starts or verifies one after the model has finished.
   */
  const handlePreviewReady = async (preview: { url?: string; sandboxDebugUrl?: string; kind?: PreviewKind }) => {
    if (!preview.url) {
      return;
    }
    publishPreview(state, {
      url: preview.url,
      sandboxDebugUrl: preview.sandboxDebugUrl,
      kind: preview.kind,
    });
    await persistWorkspace(context, conversationId, state);
    send({
      type: 'preview_ready',
      data: {
        preview: {
          url: preview.url,
          sandboxDebugUrl: preview.sandboxDebugUrl,
          kind: state.previewKind,
          routes: state.previewRoutes,
        },
        download: { url: '/download', filename: 'source.zip' },
      },
    });
  };
  const handleDeploymentStatus = (deployment: DeploymentInfo) => {
    setDeployment(state, deployment);
    void persistWorkspace(context, conversationId, state);
    send({
      type: 'deployment_status',
      data: deployment,
    });
  };

  send({ type: 'prepare_phase', data: { phase: 'agent' } });
  const modelResult = await runCodingAgent({
    context,
    conversationId,
    userMessage: message,
    state,
    onProgress: forwardProgress,
    onProjectFilesChanged: handleProjectFilesChanged,
    onPreviewReady: handlePreviewReady,
    onDeploymentStatus: handleDeploymentStatus,
    abortSignal,
    model: options.model,
    send,
  });

  if (modelResult.stopped || abortSignal?.aborted) {
    await finalizeTurn('', 'stopped', {
      withSnapshot: modelResult.projectTouched,
    });
    finishResult({
      ok: false,
      stopped: true,
      reply: '',
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
  const rawAssistantReply = stripReturnedPreviewLinks(sanitizeAssistantText(
    modelOutput || fallbackReply
  ) || fallbackReply, state.previewUrl).trim();
  const liveDeploymentUrl = modelResult.deploymentTouched
    && state.deployment?.status === 'success'
    ? state.deployment.url
    : undefined;
  const assistantReply = withLiveDeploymentUrl(
    modelResult.projectTouched
      ? compactUserFacingReply(rawAssistantReply, fallbackReply)
      : rawAssistantReply,
    liveDeploymentUrl,
  );

  // The result closes the request this turn runs in, and after that nothing is
  // guaranteed to run, so the last snapshot is taken first.
  await finalizeTurn(
    assistantReply,
    modelResult.success ? 'completed' : 'failed',
    { withState: false, withSnapshot: true },
  );
  send({
    type: 'agent',
    data: {
      ok: modelResult.success,
      reply: assistantReply,
      ...(modelResult.error ? { error: modelResult.error } : {}),
    },
  });
  finishResult({
    ok: modelResult.success,
    reply: assistantReply,
    ...(modelResult.error ? { error: modelResult.error } : {}),
  });
}
