import type { ClaudeMcpTool } from '../types.ts';
import { startPreviewServer } from '../project/preview.ts';
import { assertMakersProjectCompatible } from '../makers/compat/run.ts';
import {
  askUserForGatewayCredentials,
  pauseForGatewayCredentialsIfNeeded,
  shouldPauseForGatewayCredentials,
} from '../project/gateway.ts';
import {
  buildEdgeoneVersionCheckCommand,
  forbiddenSandboxCommandReason,
  isEdgeoneVersionCommand,
  isMakersDeployCommand,
  isMakersDevCommand,
  parseEdgeoneVersionExitCode,
  isEdgeoneCliUnavailable,
  shortenToolName,
  withExitCodeEcho,
} from '../makers/tool-phase.ts';
import {
  appendText,
  commandOutputFromToolResult,
  redactToolResult,
  textContents,
  withMakersCliUnavailableError,
} from './command-text.ts';
import {
  extractCommand,
  shouldStopDevServer,
  withCommandEnvironment,
  withDevServerStopped,
  withWarmedInstall,
  withWrappedCommand,
} from './command-preprocess.ts';
import { resolveSandboxNpmEnv } from '../makers/npm-install.ts';
import { prepareMakersCommand } from './makers-command.ts';
import type { MakersCommandLifecycle } from './makers-lifecycle.ts';
import { commandCallId } from './command-stream.ts';
import { handleDevCommandResult } from './preview-command-result.ts';
import {
  handleDeployCommandResult,
  updateDeploymentStatus,
} from './deploy-command-result.ts';

export type { MakersCommandLifecycle } from './makers-lifecycle.ts';

export function wrapSandboxTools(
  tools: ClaudeMcpTool[],
  lifecycle?: MakersCommandLifecycle,
): ClaudeMcpTool[] {
  return tools.map((tool) => {
    if (shortenToolName(tool.name) !== 'commands') {
      return tool;
    }
    const originalHandler = tool.handler;
    return {
      ...tool,
      handler: async (args, extra) => {
        const command = extractCommand(args).command;
        const blocked = forbiddenSandboxCommandReason(command);
        if (blocked) {
          return {
            content: [{ type: 'text' as const, text: blocked }],
            isError: true,
          };
        }
        if (isMakersDevCommand(command) || isMakersDeployCommand(command)) {
          return {
            content: [{
              type: 'text' as const,
              text: isMakersDeployCommand(command)
                ? 'Do not run edgeone makers deploy. Call deploy_project. The host publishes the static site.'
                : 'Do not run edgeone makers dev. Call start_preview. The preview is the site dev server.',
            }],
            isError: true,
          };
        }
        const isDeploymentCommand = isMakersDeployCommand(command);
        const isMakersCommand = isMakersDevCommand(command) || isDeploymentCommand;
        const deploymentStartedAt = Date.now();
        const failDeployment = (error: string) => {
          if (!lifecycle || !isDeploymentCommand) return;
          updateDeploymentStatus(lifecycle, {
            status: 'failed',
            startedAt: deploymentStartedAt,
            finishedAt: Date.now(),
            error,
          });
        };
        if (lifecycle && isDeploymentCommand) {
          updateDeploymentStatus(lifecycle, {
            status: 'running',
            startedAt: deploymentStartedAt,
          });
        }
        const stopsDevServer = shouldStopDevServer(command, isMakersCommand);
        let nextArgs = withWrappedCommand(
          args,
          isEdgeoneVersionCommand(command)
            ? buildEdgeoneVersionCheckCommand()
            : stopsDevServer
              ? withDevServerStopped(withWarmedInstall(command, withExitCodeEcho(command)))
              : withExitCodeEcho(command),
        ) as typeof args;
        let makers:
          | Awaited<ReturnType<typeof prepareMakersCommand>>
          | undefined;
        if (lifecycle && isMakersCommand) {
          try {
            if (isDeploymentCommand) {
              const pause = await pauseForGatewayCredentialsIfNeeded(
                lifecycle.context,
                lifecycle.state,
                {
                  conversationId: lifecycle.conversationId,
                  send: lifecycle.send,
                },
              );
              if (pause) {
                return {
                  content: [{ type: 'text' as const, text: pause }],
                  isError: true,
                };
              }
            } else if (await shouldPauseForGatewayCredentials(lifecycle.context, lifecycle.state)) {
              await askUserForGatewayCredentials(
                lifecycle.context,
                lifecycle.state,
                {
                  conversationId: lifecycle.conversationId,
                  send: lifecycle.send,
                },
              );
            }
            await assertMakersProjectCompatible(lifecycle.context, lifecycle.state);
            makers = await prepareMakersCommand(args, command, lifecycle);
            nextArgs = makers.args as typeof args;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            failDeployment(message);
            return {
              content: [{
                type: 'text' as const,
                text: message,
              }],
              isError: true,
            };
          }
        }
        if (lifecycle) {
          nextArgs = withCommandEnvironment(
            nextArgs,
            resolveSandboxNpmEnv(lifecycle.state.siteDomain),
          ) as typeof args;
        }
        let result: Awaited<ReturnType<ClaudeMcpTool['handler']>>;
        let endCommandStream: (() => void) | undefined;
        try {
          const stream = lifecycle?.commandStream;
          if (stream) {
            endCommandStream = stream.begin({
              toolUseId: commandCallId(extra),
              command: extractCommand(nextArgs).command,
              // The token and the gateway key are in the environment this
              // command inherits, so a live log is no safer a place for either
              // to surface than the finished one the tool_result carries.
              secrets: makers ? [makers.sandboxToken, makers.gatewayKey] : [],
            });
          }
          result = await originalHandler(nextArgs, extra);
        } catch (error) {
          failDeployment(error instanceof Error ? error.message : String(error));
          throw error;
        } finally {
          // The process is gone, so nothing more can print. Painting the tail
          // is over; the tool_result reports the whole output.
          endCommandStream?.();
        }
        if (isEdgeoneVersionCommand(command)) {
          const versionOutput = commandOutputFromToolResult(result);
          const versionExitCode = parseEdgeoneVersionExitCode(versionOutput);
          if (
            versionExitCode === 127
            || isEdgeoneCliUnavailable(versionOutput)
          ) {
            return withMakersCliUnavailableError(result, 'edgeone --version');
          }
          if (versionExitCode != null && versionExitCode !== 0) {
            return {
              ...appendText(result, JSON.stringify({
                status: 'error',
                errorCode: 'MAKERS_CLI_VERSION_CHECK_FAILED',
                retryable: false,
                error: `edgeone --version exited with code ${versionExitCode}.`,
                exitCode: versionExitCode,
              })),
              isError: true,
            };
          }
          return result;
        }
        if (!lifecycle || !makers) {
          return result;
        }

        const makersOutput = commandOutputFromToolResult(result);
        result = redactToolResult(result, makers.sandboxToken);
        result = redactToolResult(result, makers.gatewayKey);
        if (makers.kind === 'deploy') {
          try {
            await startPreviewServer(lifecycle.context, lifecycle.state);
          } catch {
            // Not part of publishing. The next preview command starts it again.
          }
        }
        if (result.isError) {
          failDeployment(
            textContents(result).trim().slice(-1500)
              || 'The Makers deployment command failed.',
          );
          return result;
        }

        if (makers.kind === 'dev') {
          return handleDevCommandResult(lifecycle, makers, result, makersOutput);
        }

        return handleDeployCommandResult(
          lifecycle,
          makers,
          result,
          makersOutput,
          deploymentStartedAt,
          failDeployment,
        );
      },
    };
  });
}
