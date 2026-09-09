import type { CommandResult } from '../core/_ports.ts';
import type { ClaudeMcpTool } from '../_types.ts';
import {
  normalizeCommandChunk,
  type CommandStreamChunk,
} from '../utils/_command-stream.ts';
import { shortenToolName, withExitCodeEcho } from '../utils/_tool-phase.ts';

export type { CommandStreamChunk };

export type CommandRunFn = (
  command: string,
  options?: {
    cwd?: string;
    timeout?: number;
    env?: Record<string, string>;
    onStdout?: (data: string) => void;
    onStderr?: (data: string) => void;
  },
) => Promise<CommandResult>;

export type CommandWrapOptions = {
  onCommand?: (command: string, meta?: { toolUseId?: string }) => void;
  onCommandOutput?: (chunk: CommandStreamChunk) => void;
  /**
   * Host command runner. When present, the MCP commands tool goes through
   * this instead of the toolkit handler so stdout/stderr can stream.
   */
  runCommand?: CommandRunFn;
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

/** Keep npm/pip from sitting silent until the process exits (no TTY in the sandbox). */
export function withLineBufferedCommand(command: string) {
  const trimmed = command.trim();
  if (!trimmed) return trimmed;
  const quoted = `'${trimmed.replace(/'/g, `'\\''`)}'`;
  // bash -c (not -lc) so a login profile cannot reset the sandbox cwd.
  return `if command -v stdbuf >/dev/null 2>&1; then stdbuf -oL -eL bash -c ${quoted}; else ${trimmed}; fi`;
}

function streamingEnv(command: string, env?: Record<string, string>) {
  const next = { ...env };
  if (/\bnpm\s+(install|i|ci)\b/i.test(command)) {
    next.npm_config_progress ??= 'true';
    next.npm_config_loglevel ??= 'info';
    next.npm_config_foreground_scripts ??= 'true';
  }
  next.PYTHONUNBUFFERED ??= '1';
  return next;
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

function readEnv(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const env: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string') env[key] = item;
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

function stringifyCommandResult(result: CommandResult) {
  return JSON.stringify({
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.exitCode ?? 0,
  }, null, 2);
}

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
        const { record, command } = extractCommand(args);
        if (command) {
          options?.onCommand?.(command, { toolUseId: extractToolUseId(extra) });
        }
        const wrapped = withExitCodeEcho(command);
        const nextArgs = withWrappedCommand(args, wrapped) as typeof args;

        if (!options?.runCommand) {
          // Keep isError false even when EXIT:N is non-zero. Flipping isError
          // makes the Agent SDK treat a captured compiler failure as a protocol
          // error and stall the turn instead of letting the model fix files.
          return originalHandler(nextArgs, extra);
        }

        const cwd = typeof record.cwd === 'string' ? record.cwd : undefined;
        const timeout = typeof record.timeout === 'number' ? record.timeout : undefined;
        const env = streamingEnv(wrapped, readEnv(record.env));
        const onCommandOutput = options.onCommandOutput;
        try {
          const result = await options.runCommand(withLineBufferedCommand(wrapped), {
            ...(cwd ? { cwd } : {}),
            ...(typeof timeout === 'number' ? { timeout } : {}),
            ...(env ? { env } : {}),
            onStdout: onCommandOutput
              ? (data) => {
                  const text = normalizeCommandChunk(data);
                  if (text) onCommandOutput({ stream: 'stdout', data: text });
                }
              : undefined,
            onStderr: onCommandOutput
              ? (data) => {
                  const text = normalizeCommandChunk(data);
                  if (text) onCommandOutput({ stream: 'stderr', data: text });
                }
              : undefined,
          });
          return { content: [{ type: 'text', text: stringifyCommandResult(result) }] };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { content: [{ type: 'text', text: message }], isError: true };
        }
      },
    };
  });
}
