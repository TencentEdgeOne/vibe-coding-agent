import { tool as defineClaudeTool } from '@anthropic-ai/claude-agent-sdk';
import { getFileTree } from '../project/fs.ts';
import { pauseForGatewayCredentialsIfNeeded } from '../project/gateway.ts';
import { dependenciesReady } from '../lazy/sandbox.ts';
import { startPreviewServer } from '../project/preview.ts';
import { setDeployment } from '../project/workspace-store.ts';
import type { AgentContext } from '../runtime/context.ts';
import { publishStaticSite, SiteBuildError } from '../site/publish.ts';
import type { ClaudeMcpTool, DeploymentInfo, ProjectState, StreamSend } from '../types.ts';
import { summarizeToolOutput } from '../../../shared/timeline.ts';
import { stringifyToolResult } from '../utils/text.ts';
import { commandCallId } from './command-stream.ts';

export const DEPLOY_PROJECT_TOOL_NAME = 'deploy_project';

const buildFailures = new Map<string, number>();

export type DeployToolLifecycle = {
  context: AgentContext;
  conversationId: string;
  readonly state: ProjectState;
  send?: StreamSend;
  onDeploymentStatus?: (deployment: DeploymentInfo) => void;
};

function toolError(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    isError: true,
  };
}

/**
 * Publish, as something the agent can ask for by name.
 *
 * The host builds and uploads. A build failure is returned once so the agent
 * can fix it and call again. The second failure stops the publish.
 */
export function buildDeployProjectTool(lifecycle: DeployToolLifecycle) {
  return defineClaudeTool(
    DEPLOY_PROJECT_TOOL_NAME,
    'Publish the current static site when the user asks to publish it. The host builds the site when it has a build script, then uploads it. Do not modify files in this turn, and do not run edgeone makers deploy or npm run build yourself. If this tool returns a build failure, fix the site once and call it again. A second build failure means stop.',
    {},
    async (_input, extra) => {
      const toolUseId = commandCallId(extra);
      const startedAt = Date.now();
      const publish = (deployment: DeploymentInfo) => {
        setDeployment(lifecycle.state, deployment);
        lifecycle.onDeploymentStatus?.(deployment);
      };

      const files = await getFileTree(lifecycle.context, lifecycle.state).catch(() => []);
      if (!files.some((item) => item.type === 'file')) {
        return toolError('There is no site to publish yet. Generate one first.');
      }

      const pause = await pauseForGatewayCredentialsIfNeeded(
        lifecycle.context,
        lifecycle.state,
        { conversationId: lifecycle.conversationId, send: lifecycle.send },
      );
      if (pause) return toolError(pause);

      publish({ status: 'running', startedAt });

      try {
        if (!await dependenciesReady(lifecycle.context, lifecycle.state)) {
          throw new Error('Project dependencies are not available for publish.');
        }
        const published = await publishStaticSite(lifecycle.context, lifecycle.state, {
          onProgress: (tail) => {
            if (!toolUseId || !lifecycle.send) return;
            const summary = summarizeToolOutput(tail);
            if (!summary) return;
            lifecycle.send({
              type: 'tool_use',
              data: { id: toolUseId, outputSummary: summary },
            });
          },
        });
        buildFailures.delete(lifecycle.state.appDir);
        publish({
          status: 'success',
          startedAt,
          finishedAt: Date.now(),
          url: published.url,
          projectId: published.projectId,
          deploymentId: published.deploymentId,
        });
        try {
          await startPreviewServer(lifecycle.context, lifecycle.state);
        } catch {
          // A preview that does not come back is not a failed publish.
        }
        return {
          content: [{
            type: 'text' as const,
            text: stringifyToolResult({
              status: 'published',
              url: published.url,
              note: 'The site is live. Tell the user in their language and write this complete URL on its own line.',
            }),
          }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const attempts = buildFailures.get(lifecycle.state.appDir) ?? 0;
        if (error instanceof SiteBuildError && attempts < 1) {
          buildFailures.set(lifecycle.state.appDir, attempts + 1);
          publish({
            status: 'failed',
            startedAt,
            finishedAt: Date.now(),
            error: 'Static build failed.',
          });
          return toolError([
            'The static build failed. Fix the site and call deploy_project one more time. Do not publish if the next build fails.',
            message,
          ].join('\n'));
        }
        buildFailures.delete(lifecycle.state.appDir);
        publish({
          status: 'failed',
          startedAt,
          finishedAt: Date.now(),
          error: message,
        });
        return toolError(error instanceof SiteBuildError
          ? 'The static build failed again. The site was not published. Tell the user what the build reported and stop.'
          : message);
      }
    },
  ) as ClaudeMcpTool;
}
