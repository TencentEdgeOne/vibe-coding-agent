import type { ClaudeMcpTool } from '../types.ts';
import {
  MAKERS_CLI_UNAVAILABLE_ERROR_CODE,
  MAKERS_CLI_UNAVAILABLE_MESSAGE,
} from '../makers/tool-phase.ts';
import { redactSecret } from '../makers/cli-deploy.ts';

export type ToolHandlerResult = Awaited<ReturnType<ClaudeMcpTool['handler']>>;

export function textContents(result: ToolHandlerResult) {
  return (result.content || [])
    .flatMap((item) => item && typeof item === 'object' && 'text' in item
      && typeof item.text === 'string' ? [item.text] : [])
    .join('\n');
}

export function commandOutputFromToolResult(result: ToolHandlerResult) {
  const raw = textContents(result);
  const streams: string[] = [];
  for (const item of result.content || []) {
    if (!item || typeof item !== 'object' || !('text' in item) || typeof item.text !== 'string') {
      continue;
    }
    try {
      const parsed = JSON.parse(item.text) as Record<string, unknown>;
      if (typeof parsed.stdout === 'string') streams.push(parsed.stdout);
      if (typeof parsed.stderr === 'string') streams.push(parsed.stderr);
    } catch {
      // Some runtime versions return raw stdout instead of a JSON envelope.
    }
  }
  return [...streams, raw].filter(Boolean).join('\n');
}

export function appendText(result: ToolHandlerResult, text: string) {
  return {
    ...result,
    content: [
      ...(result.content || []),
      { type: 'text' as const, text },
    ],
  };
}

export function withMakersCliUnavailableError(
  result: ToolHandlerResult,
  attemptedCommand: string,
) {
  return {
    ...appendText(result, JSON.stringify({
      status: 'error',
      errorCode: MAKERS_CLI_UNAVAILABLE_ERROR_CODE,
      retryable: false,
      error: MAKERS_CLI_UNAVAILABLE_MESSAGE,
      attemptedCommand,
      instruction: 'Stop this preview/deploy attempt. Do not inspect PATH or installation directories, install packages, use npx, or retry. Tell the user this is a sandbox image rollout blocker, not a generated-project error.',
    })),
    isError: true,
  };
}

export function redactToolResult(result: ToolHandlerResult, secret: string) {
  if (!secret) return result;
  return {
    ...result,
    content: (result.content || []).map((item) => (
      item && typeof item === 'object' && 'text' in item && typeof item.text === 'string'
        ? { ...item, text: redactSecret(item.text, secret) }
        : item
    )),
  };
}
