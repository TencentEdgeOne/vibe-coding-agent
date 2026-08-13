import type { ClaudeMcpTool } from '../_types.ts';
import { shortenToolName, withExitCodeEcho } from '../utils/_tool-phase.ts';

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

export function wrapSandboxToolsForVerification(tools: ClaudeMcpTool[]): ClaudeMcpTool[] {
  return tools.map((tool) => {
    if (shortenToolName(tool.name) !== 'commands') {
      return tool;
    }
    const originalHandler = tool.handler;
    return {
      ...tool,
      handler: async (args, extra) => {
        const wrapped = withExitCodeEcho(extractCommand(args).command);
        const nextArgs = withWrappedCommand(args, wrapped) as typeof args;
        // Keep isError false even when EXIT:N is non-zero. Flipping isError
        // makes the Agent SDK treat a captured compiler failure as a protocol
        // error and stall the turn instead of letting the model fix files.
        return originalHandler(nextArgs, extra);
      },
    };
  });
}
