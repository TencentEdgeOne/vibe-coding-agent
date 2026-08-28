import { saveProjectState } from '../_memory';
import { getFileTree, runSandboxCommand } from '../_project';
import { assertMakersProjectCompatible } from '../project/_makers-compat';
import { resolveMakersProjectName } from '../project/_makers-deploy';
import {
  buildSandboxMakersEnv,
  resolveMakersMasterToken,
  resolveSandboxMakersToken,
} from '../project/_makers-token';
import type {
  AgentProgressEvent,
  DeploymentInfo,
  StreamSend,
} from '../_types';
import {
  buildMakersDeployCommand,
  describeMakersDeployment,
  readMakersDeployOutcome,
  redactSecret,
} from '../../shared/makers-deploy';
import { resolveConversationId } from '../utils/_request';
import {
  createProjectCheckpointController,
  ensureProjectDependencies,
  extendExistingSandboxTimeout,
  previewLinkFromState,
  withLiveDeploymentUrl,
} from './_helpers';
import { createTurnLifecycle } from './_turn-lifecycle';
import { prepareProjectWorkspace } from './_workspace';

/** Used when an API caller asks to publish without wording the request itself. */
export const DEFAULT_DEPLOY_REQUEST = 'Deploy this project';

const DEPLOY_TIMEOUT_SECONDS = 600;

// The transcript row this pipeline writes. Matching the command the model would
// have typed keeps one "Deploy project" entry in the activity stream, whoever
// started it.
const DEPLOY_ACTIVITY_COMMAND = 'edgeone makers deploy';

const COPY = {
  zh: {
    missingConversation: '缺少会话 ID，无法部署当前项目。',
    noProject: '还没有可部署的项目，请先生成一个项目。',
    success: '已发布到线上。',
    failedPrefix: '部署失败：',
  },
  en: {
    missingConversation: 'Missing conversationId, so this project cannot be deployed.',
    noProject: 'There is no project to deploy yet. Generate one first.',
    success: 'The project is live.',
    failedPrefix: 'Deploy failed: ',
  },
} as const;

/** Deploy output can run to pages; the chat reply carries only its opening line. */
function summarizeDeployError(error: string) {
  const firstLine = error.split('\n').map((line) => line.trim()).find(Boolean) || error.trim();
  return firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine;
}

/**
 * Publish the current project with the one command that publishes it.
 *
 * Deploying is not creative work: the project, the credential and the target
 * are all already decided, so putting the model in the loop would only add a
 * chance of it doing something else. It still runs in the chat task slot, which
 * is what keeps a publish and a generation from touching the sandbox at once.
 */
export async function runDeployPipeline(
  context: any,
  message: string,
  send: StreamSend,
  options: { turnId?: string; userMessagePersisted?: boolean } = {},
) {
  const { conversationId } = resolveConversationId(context);
  const request = message.trim() || DEFAULT_DEPLOY_REQUEST;
  const copy = /[\u3400-\u9fff]/.test(request) ? COPY.zh : COPY.en;

  if (!conversationId) {
    send({
      type: 'result',
      data: {
        ok: false,
        conversation_id: '',
        reply: copy.missingConversation,
        preview: {},
      },
    });
    return;
  }

  await extendExistingSandboxTimeout(context);
  send({ type: 'status', message: 'Publishing the project to Makers' });

  const state = await prepareProjectWorkspace(context, conversationId, false, send);
  const turn = createTurnLifecycle({
    context,
    conversationId,
    message: request,
    turnId: options.turnId
      || String(context?.run_id || `${Date.now()}-${Math.random().toString(36).slice(2)}`),
    userMessagePersisted: options.userMessagePersisted === true,
    state,
    // Publishing writes no project files, so nothing here ever needs a snapshot.
    checkpoint: createProjectCheckpointController(context, conversationId, state),
  });

  // No `build` field: publishing runs no verification, and reporting one would
  // clear whatever the last generation said about the project.
  const finish = async (reply: string, status: 'completed' | 'failed') => {
    await turn.finalize(reply, status);
    send({
      type: 'result',
      data: {
        ok: status === 'completed',
        reply,
        conversation_id: conversationId,
        preview: previewLinkFromState(state),
        deployment: state.deployment,
      },
    });
  };

  const files = await getFileTree(context, state).catch(() => []);
  if (!files.some((item) => item.type === 'file')) {
    await finish(copy.noProject, 'failed');
    return;
  }

  const startedAt = Date.now();
  const toolUseId = `deploy-${startedAt}`;
  const emit = (event: AgentProgressEvent) => {
    turn.recordProgress(event);
    send(event as unknown as Record<string, unknown>);
  };
  const publish = (deployment: DeploymentInfo) => {
    state.deployment = deployment;
    // Eagerly persisted so a refresh mid-publish resumes into the same state
    // the deployment bar was showing.
    void saveProjectState(context, conversationId, state);
    send({ type: 'deployment_status', data: deployment });
  };
  const fail = async (error: string) => {
    publish({
      status: 'failed',
      startedAt,
      finishedAt: Date.now(),
      error,
    });
    emit({
      type: 'tool_result',
      data: {
        tool_use_id: toolUseId,
        toolName: 'commands',
        ok: false,
        preview: '',
        outputSummary: summarizeDeployError(error),
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

  let sandboxToken = '';
  try {
    await assertMakersProjectCompatible(context, state);
    await ensureProjectDependencies(context, state);
    sandboxToken = await resolveSandboxMakersToken(
      context,
      state,
      resolveMakersMasterToken(context),
    );
  } catch (error) {
    await fail(error instanceof Error ? error.message : String(error));
    return;
  }

  let stdout = '';
  let stderr = '';
  try {
    // Past this point the CLI owns the outcome: an abort would stop us reading
    // the result, not the publish, so the run is always seen through.
    const result = await runSandboxCommand(
      context,
      buildMakersDeployCommand(resolveMakersProjectName(context, state)),
      {
        cwd: state.appDir,
        env: buildSandboxMakersEnv(context, sandboxToken),
        timeout: DEPLOY_TIMEOUT_SECONDS,
      },
    );
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    await fail(redactSecret(
      error instanceof Error ? error.message : String(error),
      sandboxToken,
    ));
    return;
  }

  const outcome = readMakersDeployOutcome(stdout, stderr, sandboxToken);
  if (outcome.status !== 'success') {
    await fail(outcome.error);
    return;
  }

  publish(describeMakersDeployment(outcome, { startedAt }));
  emit({
    type: 'tool_result',
    data: {
      tool_use_id: toolUseId,
      toolName: 'commands',
      ok: true,
      preview: '',
      outputSummary: outcome.url,
      status: 'completed',
      endedAt: Date.now(),
    },
  });
  await finish(withLiveDeploymentUrl(copy.success, outcome.url), 'completed');
}
