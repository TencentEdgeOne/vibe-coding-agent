import { tool as defineClaudeTool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { summarizeToolOutput } from '../../../shared/timeline.ts';
import { PREVIEW_PATH_PREFIX, PREVIEW_SERVER_PORT } from '../constants.ts';
import { ensurePreview } from '../lazy/preview.ts';
import type { AgentContext } from '../runtime/context.ts';
import type { ClaudeMcpTool, PreviewKind, ProjectState, StreamSend } from '../types.ts';
import { stringifyToolResult } from '../utils/text.ts';
import { commandCallId } from './command-stream.ts';

const startPreviewInputSchema = {
  restart: z.boolean().optional().describe(
    'Replace a dev server that is already running. Only needed after changing something it reads at startup, such as an environment variable — file edits are picked up on save.',
  ),
};

export type PreviewToolLifecycle = {
  context: AgentContext;
  conversationId: string;
  readonly state: ProjectState;
  onPreviewReady?: (preview: {
    url?: string;
    sandboxDebugUrl?: string;
    kind?: PreviewKind;
  }) => void;
  send?: StreamSend;
};

/**
 * The preview, as something the agent can ask for by name.
 *
 * Before this, the only way the agent could bring a preview up was to run
 * `edgeone makers dev` through the shell tool and read the launcher's output,
 * which made the preview a side effect of a command rather than a step in the
 * task. With a tool, the URL and the verdict on the generated routes come back
 * in the tool result, so the agent can act on a project that does not serve —
 * and the same call is the one the client and the host make, so there is no
 * second code path for the agent to disagree with.
 */
export function buildStartPreviewTool(lifecycle: PreviewToolLifecycle) {
  return defineClaudeTool(
    'start_preview',
    'Bring up the live preview for the current project and return its public URL. It starts the dev server and nothing more: whether the generated pages and endpoints answer is yours to check, from inside the sandbox, against the local URL this returns. Safe to call more than once: a healthy dev server is reused rather than restarted.',
    startPreviewInputSchema,
    async (input, extra) => {
      const toolUseId = commandCallId(extra);
      const report = (text: string) => {
        if (!toolUseId || !lifecycle.send) return;
        const summary = summarizeToolOutput(text);
        if (!summary) return;
        lifecycle.send({
          type: 'tool_use',
          data: { id: toolUseId, outputSummary: summary },
        });
      };
      try {
        const options = input as { restart?: unknown };
        report('Starting the preview');
        const preview = await ensurePreview(
          lifecycle.context,
          lifecycle.conversationId,
          lifecycle.state,
          {
            forceRestart: options.restart === true,
            onProgress: report,
          },
        );
        lifecycle.onPreviewReady?.(preview);
        return {
          content: [{
            type: 'text' as const,
            text: stringifyToolResult({
              status: 'success',
              preview: {
                url: preview.url,
                kind: preview.kind,
              },
              // The public URL needs the sandbox access token and resolves
              // outside the sandbox; this is the address the model can actually
              // request from its own commands when it wants to check a route.
              local_url: `http://127.0.0.1:${PREVIEW_SERVER_PORT}${PREVIEW_PATH_PREFIX}`,
              restarted: preview.restarted,
              // The panel is already showing it, so repeating the link in the
              // reply only gives the user the same URL twice.
              note: 'The preview panel is already showing this URL. Do not put it in your reply to the user.',
            }),
          }],
        };
      } catch (error) {
        return {
          content: [{
            type: 'text' as const,
            text: error instanceof Error ? error.message : String(error),
          }],
          isError: true,
        };
      }
    },
  ) as ClaudeMcpTool;
}
