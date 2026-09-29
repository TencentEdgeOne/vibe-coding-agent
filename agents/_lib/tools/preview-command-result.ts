import { ensurePreview } from '../lazy/preview.ts';
import { describeMissingMakersRuntimeToken } from '../makers/token.ts';
import {
  MAKERS_DEV_FRONTEND_EXIT,
  MAKERS_DEV_PORT_DRIFT_EXIT,
  parseMakersDevExitCode,
} from '../makers/cli-dev.ts';
import { isEdgeoneCliUnavailable } from '../makers/tool-phase.ts';
import {
  appendText,
  withMakersCliUnavailableError,
  type ToolHandlerResult,
} from './command-text.ts';
import type { MakersCommandLifecycle } from './makers-lifecycle.ts';
import type { PreparedMakersCommand } from './makers-command.ts';

export async function handleDevCommandResult(
  lifecycle: MakersCommandLifecycle,
  makers: PreparedMakersCommand,
  result: ToolHandlerResult,
  makersOutput: string,
): Promise<ToolHandlerResult> {

  const missingRuntimeToken = describeMissingMakersRuntimeToken(makersOutput);
  if (missingRuntimeToken) {
    return {
      ...appendText(result, JSON.stringify({
        status: 'error',
        error: missingRuntimeToken,
      })),
      isError: true,
    };
  }
  const devExitCode = parseMakersDevExitCode(makersOutput);
  if (devExitCode != null && devExitCode !== 0) {
    if (isEdgeoneCliUnavailable(makersOutput)) {
      return withMakersCliUnavailableError(result, 'edgeone makers dev');
    }
    // The one launch failure that says nothing about the project: the
    // port was still held, so the CLI came up healthy somewhere the
    // proxy does not look. Launching again is the fix, and the launcher
    // now clears that port first, so the second attempt is not a repeat
    // of the first.
    if (devExitCode === MAKERS_DEV_PORT_DRIFT_EXIT) {
      return {
        ...appendText(result, JSON.stringify({
          status: 'error',
          errorCode: 'MAKERS_DEV_PORT_DRIFT',
          retryable: true,
          error: 'edgeone makers dev started on a port the preview proxy does not forward to, because the previous dev server still held the expected one.',
          instruction: 'Run the same preview command once more. Nothing in the generated project caused this, so do not change project files, and do not kill processes or free ports yourself — the launcher terminates the previous server before this next attempt.',
        })),
        isError: true,
      };
    }
    // The port in the proxy error is the frontend dev server, not the agent
    // runtime, and it has already exited. Another launch runs the same command.
    if (devExitCode === MAKERS_DEV_FRONTEND_EXIT) {
      return {
        ...appendText(result, JSON.stringify({
          status: 'error',
          errorCode: 'MAKERS_DEV_FRONTEND_EXIT',
          retryable: false,
          error: 'The preview CLI is up, but the frontend dev server it proxies to already exited.',
          instruction: 'Read the dev command output above and fix that failure. Do not start the preview again until that command can stay up; a retry runs the same command.',
        })),
        isError: true,
      };
    }
    return {
      ...appendText(result, JSON.stringify({
        status: 'error',
        error: describeMissingMakersRuntimeToken(makersOutput)
          || `edgeone makers dev exited with code ${devExitCode}.`,
        exitCode: devExitCode,
      })),
      isError: true,
    };
  }
  try {
    // The CLI reported success, so publish the URL through the same readiness
    // layer the host and the client use. `lifecycle.state` is the turn's live
    // copy — the preview has to land on that one to reach its SSE stream.
    const preview = await ensurePreview(
      lifecycle.context,
      lifecycle.conversationId,
      lifecycle.state,
    );
    lifecycle.onPreviewReady?.(preview);
    return appendText(result, JSON.stringify({
      status: 'success',
      preview: {
        url: preview.url,
        kind: preview.kind,
      },
    }));
  } catch (error) {
    return {
      ...appendText(result, error instanceof Error ? error.message : String(error)),
      isError: true,
    };
  }
}
