import type { AgentContext } from '../runtime/context.ts';
import { getFileTree } from '../project/fs.ts';
import { startPreviewServer } from '../project/preview.ts';
import { bindSiteDomain, persistWorkspace, setDeployment } from '../project/workspace-store.ts';
import {
  applyUserGatewayDecision,
  askUserForGatewayCredentials,
  shouldPauseForGatewayCredentials,
} from '../project/gateway.ts';
import { resolveGatewayUserTurn } from '../../../shared/gateway-secret.ts';
import { workspaceSnapshotFromState } from '../project/snapshot.ts';
import type {
  AgentProgressEvent,
  DeploymentInfo,
  FileTreeItem,
  StreamSend,
} from '../types.ts';
import { resolveConversationId, resolveRequestSiteDomain } from '../runtime/request.ts';
import {
  createProjectCheckpointController,
  replyLocaleFor,
  withLiveDeploymentUrl,
} from './checkpoint.ts';
import { createTurnLifecycle } from './lifecycle.ts';
import { activateSandbox } from '../lazy/sandbox.ts';
import { bindLiveWorkspace } from '../session/live-workspace.ts';
import { sendTurnResult } from './result.ts';
import { publishStaticSite, SiteBuildError } from '../site/publish.ts';

/** Used when an API caller asks to publish without wording the request itself. */
export const DEPLOY_TIMEOUT_SECONDS = 600;

// The transcript row this pipeline writes.
const DEPLOY_ACTIVITY_COMMAND = 'publish site';

const COPY = {
  zh: {
    missingConversation: '缺少会话 ID，无法发布当前站点。',
    noProject: '还没有可发布的站点，请先生成一个。',
    success: '站点已发布。',
    failedPrefix: '发布失败：',
    needGateway: '请先添加 API 密钥，添加后我会继续发布。',
    buildFailed: '静态构建没有通过，站点未发布。',
  },
  en: {
    missingConversation: 'Missing conversationId, so this site cannot be published.',
    noProject: 'There is no site to publish yet. Generate one first.',
    success: 'The site is live.',
    failedPrefix: 'Publish failed: ',
    needGateway: 'Add an API key below. I will continue publishing after that.',
    buildFailed: 'The static build did not pass, so the site was not published.',
  },
} as const;

/** Deploy output can run to pages; the chat reply carries only its opening line. */
function summarizeDeployError(error: string) {
  const firstLine = error.split('\n').map((line) => line.trim()).find(Boolean) || error.trim();
  return firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine;
}

/**
 * Publish the current site from the host.
 *
 * The button is a publish request, not a coding turn. The host builds, and
 * only if that build fails does it ask the agent for one repair, then builds
 * again. The token stays in this runtime.
 */
export async function runDeployPipeline(
  context: AgentContext,
  message: string,
  send: StreamSend,
  options: {
    turnId?: string;
    apiKey?: string;
    gatewaySkip?: boolean;
  } = {},
) {
  const { conversationId } = resolveConversationId(context);
  const request = message.trim() || 'Deploy this project';
  const copy = replyLocaleFor(request) === 'zh' ? COPY.zh : COPY.en;

  if (!conversationId) {
    sendTurnResult(send, {
      ok: false,
      conversation_id: '',
      reply: copy.missingConversation,
    });
    return;
  }

  send({ type: 'prepare_phase', data: { phase: 'workspace' } });
  const { state, dependenciesReady } = await activateSandbox(context, conversationId, { send });
  if (bindSiteDomain(state, resolveRequestSiteDomain(context))) {
    await persistWorkspace(context, conversationId, state);
  }
  const checkpoint = createProjectCheckpointController(context, conversationId, state);
  const turn = createTurnLifecycle({
    context,
    conversationId,
    message: request,
    turnId: options.turnId
      || String(context?.run_id || `${Date.now()}-${Math.random().toString(36).slice(2)}`),
    state,
    checkpoint,
  });

  // No `build` field: publishing runs no verification, and reporting one would
  // clear whatever the last generation said about the project.
  let files: FileTreeItem[] = [];
  const finish = async (reply: string, status: 'completed' | 'failed') => {
    await turn.finalize(reply, status);
    sendTurnResult(send, {
      ok: status === 'completed',
      reply,
      conversation_id: conversationId,
    }, workspaceSnapshotFromState(
      conversationId,
      state,
      files.length > 0 ? files : undefined,
    ));
  };

  files = await getFileTree(context, state).catch(() => []);
  if (!files.some((item) => item.type === 'file')) {
    await finish(copy.noProject, 'failed');
    return;
  }

  bindLiveWorkspace(conversationId, state, send);
  const inboundGateway = resolveGatewayUserTurn(request, options.apiKey);
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

  if (await shouldPauseForGatewayCredentials(context, state)) {
    await askUserForGatewayCredentials(context, state, { conversationId, send });
    await finish(copy.needGateway, 'completed');
    return;
  }

  const startedAt = Date.now();
  const toolUseId = `deploy-${startedAt}`;
  const emit = (event: AgentProgressEvent) => {
    turn.recordProgress(event);
    send(event);
  };
  const publish = (deployment: DeploymentInfo) => {
    setDeployment(state, deployment);
    void persistWorkspace(context, conversationId, state);
    send({ type: 'deployment_status', data: deployment });
  };
  // `detail` is whatever the CLI printed when it failed without phrasing the
  // failure itself. It goes to the activity card and nowhere else: the chat
  // reply and the deployment bar both have room for one line, and a wall of CLI
  // output in either would bury the sentence that says what to do next.
  const fail = async (error: string, detail = '') => {
    publish({
      status: 'failed',
      startedAt,
      finishedAt: Date.now(),
      error,
    });
    emit({
      type: 'tool_result',
      data: {
        id: toolUseId,
        toolName: 'commands',
        ok: false,
        preview: '',
        outputSummary: detail || summarizeDeployError(error),
        status: 'failed',
        endedAt: Date.now(),
      },
    });
    await finish(`${copy.failedPrefix}${summarizeDeployError(error)}`, 'failed');
  };

  emit({
    type: 'tool_use',
    data: {
      id: toolUseId,
      name: 'commands',
      inputSummary: DEPLOY_ACTIVITY_COMMAND,
      phaseHint: 'link',
      startedAt,
    },
  });
  publish({ status: 'running', startedAt });

  const report = (tail: string) => {
    send({
      type: 'tool_use',
      data: {
        id: toolUseId,
        name: 'commands',
        inputSummary: DEPLOY_ACTIVITY_COMMAND,
        phaseHint: 'link',
        startedAt,
        outputSummary: tail,
      },
    });
  };

  let published: { url: string; projectId: string; deploymentId: string } | undefined;
  let commandError = '';
  try {
    if (!await dependenciesReady) {
      throw new Error('Project dependencies are not available for publish.');
    }
    published = await publishStaticSite(context, state, {
      onProgress: report,
      repair: async (log) => {
        const { runCodingAgent } = await import('../session/live.ts');
        const repair = await runCodingAgent({
          context,
          conversationId,
          state,
          userMessage: [
            'The static build failed. Fix the site so npm run build succeeds.',
            'Do not call deploy_project and do not start a preview.',
            '',
            log,
          ].join('\n'),
          send,
          onProgress: emit,
          onProjectFilesChanged: () => {
            checkpoint.schedule();
          },
        });
        if (!repair.success) {
          throw new SiteBuildError(repair.error || copy.buildFailed);
        }
      },
    });
  } catch (error) {
    commandError = error instanceof SiteBuildError
      ? copy.buildFailed
      : (error instanceof Error ? error.message : String(error));
  }

  try {
    await startPreviewServer(context, state);
  } catch {
    // A preview that does not come back is not a failed publish.
  }

  if (commandError || !published) {
    await fail(commandError || copy.buildFailed);
    return;
  }

  publish({
    status: 'success',
    startedAt,
    finishedAt: Date.now(),
    url: published.url,
    projectId: published.projectId,
    deploymentId: published.deploymentId,
  });
  emit({
    type: 'tool_result',
    data: {
      id: toolUseId,
      toolName: 'commands',
      ok: true,
      preview: '',
      outputSummary: published.url,
      status: 'completed',
      endedAt: Date.now(),
    },
  });
  await finish(withLiveDeploymentUrl(copy.success, published.url), 'completed');
}
