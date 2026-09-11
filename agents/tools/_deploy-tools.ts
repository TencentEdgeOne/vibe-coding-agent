import { tool as defineClaudeTool } from '@anthropic-ai/claude-agent-sdk';
import type { PublishResult, PublishStage } from '../../shared/protocol.ts';
import type { AgentProgressEvent, ClaudeMcpTool, ProjectState } from '../_types.ts';
import { createProjectFiles } from '../core/_project-files.ts';
import { createMakersWorkspacePort } from '../core/adapters/_makers.ts';
import {
  deployProjectToMakers,
  formatDeployStage,
  publishErrorMessage,
} from '../project/_deploy.ts';
import { stringifyToolResult } from '../utils/_text.ts';
import { extractToolUseId } from './_commands-wrap.ts';

function appendDeployStageLine(lines: string[], stage: PublishStage, status?: string) {
  const line = formatDeployStage(stage, status);
  const last = lines.at(-1);
  if (last && last.startsWith('Deploying to EdgeOne Makers') && line.startsWith('Deploying to EdgeOne Makers')) {
    lines[lines.length - 1] = line;
    return;
  }
  if (last !== line) {
    lines.push(line);
  }
}

async function assertDeployableProject(context: any, state: ProjectState) {
  if (!state.created) {
    throw new Error('There is no project to deploy yet. Please describe the page or feature you want to build first.');
  }

  const appDirExists = await createProjectFiles(createMakersWorkspacePort(context), state.appDir)
    .projectExists();
  if (!appDirExists) {
    throw new Error(`Project workspace does not exist: ${state.appDir}`);
  }
}

export function buildPublishProjectTool(
  context: any,
  conversationId: string,
  state: ProjectState,
  options: {
    siteDomain?: string;
    onProgress?: (event: AgentProgressEvent) => void;
    onPublished?: (result: PublishResult) => void;
    signal?: AbortSignal;
  } = {},
) {
  return defineClaudeTool(
    'publish_project',
    'Deploy the current project to EdgeOne Makers. Call this only when the user explicitly asks to deploy, publish, or go live. Call it at most once per request. Do not use it for the sandbox preview — that is publish_preview. The UI shows a site card; do not repeat any production URL in your reply.',
    {},
    async (_input, extra) => {
      const toolUseId = extractToolUseId(extra);
      const lines: string[] = [];
      const reportStage = (stage: PublishStage, status?: string) => {
        appendDeployStageLine(lines, stage, status);
        options.onProgress?.({
          type: 'tool_output',
          data: {
            tool_use_id: toolUseId,
            outputSummary: lines.join('\n'),
          },
        });
      };

      try {
        await assertDeployableProject(context, state);
        const result = await deployProjectToMakers(context, conversationId, state, {
          siteDomain: options.siteDomain || '',
          onStage: reportStage,
          signal: options.signal,
        });
        options.onPublished?.(result);
        return {
          content: [{
            type: 'text' as const,
            text: stringifyToolResult({
              ok: true,
              projectId: result.projectId,
              deploymentId: result.deploymentId,
            }),
          }],
        };
      } catch (error) {
        const message = publishErrorMessage(error);
        options.onPublished?.({ ok: false, error: message });
        return {
          content: [{ type: 'text' as const, text: message }],
          isError: true,
        };
      }
    },
  ) as ClaudeMcpTool;
}
