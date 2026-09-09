import type { ClaudeMcpTool } from '../_types.ts';
import { shortenToolName, withExitCodeEcho } from '../utils/_tool-phase.ts';

export type CommandWrapOptions = {
  onCommand?: (command: string, meta?: { toolUseId?: string }) => void;
};

export function extractToolUseId(extra: unknown): string {
  if (!extra || typeof extra !== 'object') return '';
  const record = extra as Record<string, unknown>;
  const nested = record._meta && typeof record._meta === 'object'
    ? record._meta as Record<string, unknown>
    : {};
  for (const value of [record.toolUseId, record.tool_use_id, nested.toolUseId, nested.tool_use_id]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function extractCommand(args: unknown) {
  const record = args && typeof args === 'object' ? args as Record<string, unknown> : {};
  const command = typeof record.command === 'string'
    ? record.command
    : typeof record.cmd === 'string'
      ? record.cmd
      : '';
  return { record, command };
}

function withWrappedCommand(args: unknown, wrapped: string) {
  const { record, command } = extractCommand(args);
  if (!command || wrapped === command) {
    return args;
  }
  return {
    ...record,
    ...(typeof record.command === 'string' ? { command: wrapped } : {}),
    ...(typeof record.cmd === 'string' ? { cmd: wrapped } : {}),
  };
}

/**
 * Append an exit-code echo to verification commands so a captured build
 * failure survives in stdout.
 *
 * Live stdout/stderr is not handled here: the toolkit streams it once a
 * handler is registered via `tools.setCommandOutputHandler`.
 */
export function wrapSandboxToolsForVerification(
  tools: ClaudeMcpTool[],
  options?: CommandWrapOptions,
): ClaudeMcpTool[] {
  return tools.map((tool) => {
    if (shortenToolName(tool.name) !== 'commands') {
      return tool;
    }
    const originalHandler = tool.handler;
    return {
      ...tool,
      handler: async (args, extra) => {
        const { command } = extractCommand(args);
        if (command) {
          options?.onCommand?.(command, { toolUseId: extractToolUseId(extra) });
        }
        const nextArgs = withWrappedCommand(args, withExitCodeEcho(command)) as typeof args;
        // Keep isError false even when EXIT:N is non-zero. Flipping isError
        // makes the Agent SDK treat a captured compiler failure as a protocol
        // error and stall the turn instead of letting the model fix files.
        return originalHandler(nextArgs, extra);
      },
    };
  });
}
