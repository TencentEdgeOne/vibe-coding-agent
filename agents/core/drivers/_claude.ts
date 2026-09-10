/**
 * Claude Agent SDK driver.
 *
 * The only file in the template allowed to know that the agent loop is Claude:
 * it owns the `query()` call, the MCP server registration, the transcript
 * mirror, and the subprocess environment. Callers hand it prompts and tools and
 * read domain events back.
 */

import {
  createSdkMcpServer,
  query,
  type SDKMessage,
  type SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { DomainEvent } from '../_events.ts';
import { createSdkTranslator, type TranslatorHelpers } from '../_sdk-translator.ts';
import type {
  AgentDriverPort,
  AgentTurnInput,
  AgentTurnResult,
  AgentTurnRun,
} from './_types.ts';

export const CLAUDE_FRAMEWORK = 'claude-agent-sdk';

/**
 * Text helpers the translator needs but the core does not own.
 *
 * Injected rather than imported so this driver stays a translation of SDK
 * messages, not a home for the host's wording rules.
 */
export type ClaudeDriverOptions = {
  helpers: TranslatorHelpers;
};

export function createClaudeDriver(options: ClaudeDriverOptions): AgentDriverPort {
  return {
    framework: CLAUDE_FRAMEWORK,

    runTurn(input: AgentTurnInput): AgentTurnRun {
      let result: AgentTurnResult = { outcome: 'failed', summary: '' };

      async function* run(): AsyncGenerator<DomainEvent> {
        const abortController = new AbortController();
        const releaseCancellation = input.cancellation?.onAbort(() => abortController.abort());

        if (input.cancellation?.aborted) {
          result = { outcome: 'stopped', summary: '' };
          releaseCancellation?.();
          return;
        }

        const mcpServers = Object.fromEntries(
          input.servers.map((server) => [
            server.name,
            createSdkMcpServer({
              name: server.name,
              tools: server.tools as never[],
              alwaysLoad: true,
            }),
          ]),
        );

        const sdkQuery = query({
          prompt: input.prompt,
          options: {
            model: input.model,
            permissionMode: 'dontAsk',
            maxTurns: 100,
            // Claude Code's built-in local tools are disabled so the model can
            // only read, write, and execute through the host's sandbox tools.
            tools: [],
            includePartialMessages: true,
            mcpServers,
            allowedTools: input.allowedTools,
            strictMcpConfig: true,
            systemPrompt: input.systemPrompt,
            ...(input.env ? { env: input.env } : {}),
            ...(input.cwd ? { cwd: input.cwd } : {}),
            settingSources: ['project'],
            debug: input.debug === true,
            abortController,
            ...(input.onStderr ? { stderr: input.onStderr } : {}),
            // 'batched' coalesces transcript frames into ~100ms batches. 'eager'
            // gives each frame its own append(), and the platform store writes
            // one key per call — which the next turn reads back one at a time.
            ...(input.session?.store
              ? {
                sessionStore: input.session.store as never,
                sessionStoreFlush: 'batched' as const,
              }
              : {}),
            ...(input.session?.resume ? { resume: input.session.resume } : {}),
            ...(input.session?.sessionId ? { sessionId: input.session.sessionId } : {}),
            ...(input.executablePath ? { pathToClaudeCodeExecutable: input.executablePath } : {}),
          },
        });

        const translator = createSdkTranslator({
          runId: input.runId,
          helpers: options.helpers,
        });

        let resultMessage: SDKResultMessage | null = null;
        let fatalError = '';

        try {
          for await (const message of sdkQuery as AsyncIterable<SDKMessage>) {
            if (input.cancellation?.aborted) {
              abortController.abort();
              result = { outcome: 'stopped', summary: '' };
              return;
            }

            yield* translator.translate(message as never);

            if (message.type === 'result') {
              resultMessage = message;
              break;
            }

            const outcome = translator.outcome();
            if (outcome.fatalError) {
              fatalError = outcome.fatalError;
              break;
            }
          }
        } finally {
          releaseCancellation?.();
        }

        if (input.cancellation?.aborted || abortController.signal.aborted) {
          result = { outcome: 'stopped', summary: '' };
          return;
        }

        // A host failure outranks any result the SDK still produced: retrying
        // into it only burns turns and pollutes the transcript.
        if (fatalError) {
          try {
            await (sdkQuery as { return?: () => Promise<unknown> }).return?.();
          } catch {
            // Not every SDK build supports return(); stopping is best-effort.
          }
          result = { outcome: 'failed', summary: '', error: fatalError, fatal: true };
          return;
        }

        if (!resultMessage) {
          result = {
            outcome: 'failed',
            summary: '',
            error: 'The model stream ended without returning a result.',
          };
          return;
        }

        if (resultMessage.subtype !== 'success') {
          result = {
            outcome: 'failed',
            summary: '',
            error: Array.isArray(resultMessage.errors) && resultMessage.errors.length > 0
              ? String(resultMessage.errors[0])
              : 'Model execution failed.',
          };
          return;
        }

        result = {
          outcome: 'completed',
          summary: (resultMessage.result || '').trim(),
        };
      }

      return {
        events: run(),
        result: () => result,
      };
    },
  };
}
