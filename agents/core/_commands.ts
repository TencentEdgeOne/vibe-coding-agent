/**
 * Running commands in the workspace, against a port.
 *
 * Every sandbox command in the template funnels through here, so this is the
 * chokepoint that decides whether the project layer can run anywhere. The
 * behavior is carried over from agents/project/_commands.ts unchanged,
 * including the two quirks worth keeping:
 *
 *   - A non-zero exit with no output at all gets a synthesized stderr, because
 *     some sandbox failures surface as a bare exit code and would otherwise be
 *     reported as a silent success-shaped failure.
 *   - Verification commands echo their exit code, since a non-zero shell exit
 *     makes the host drop compiler output. The echoed value is authoritative.
 */

import type { CommandResult, WorkspacePort } from './_ports.ts';

export type CommandOptions = {
  cwd?: string;
  timeout?: number;
  env?: Record<string, string>;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
};

const OUTPUT_TRUNCATE_LIMIT = 2_000;

function truncateCommandOutput(value: string, limit = OUTPUT_TRUNCATE_LIMIT) {
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function describeInvocation(command: string, options: CommandOptions) {
  return [
    options.cwd ? `cwd: ${options.cwd}` : '',
    typeof options.timeout === 'number' ? `timeout: ${options.timeout}s` : '',
  ].filter(Boolean);
}

export function formatCommandExit(
  command: string,
  options: CommandOptions,
  exitCode: number,
) {
  return [
    `Sandbox command exited with code ${exitCode} while running: ${command}`,
    ...describeInvocation(command, options),
  ].join('\n');
}

export function formatCommandError(
  error: unknown,
  command: string,
  options: CommandOptions,
) {
  const parts = [
    `Sandbox command failed while running: ${command}`,
    ...describeInvocation(command, options),
  ];

  const record = error && typeof error === 'object'
    ? error as { stdout?: unknown; stderr?: unknown }
    : {};
  const message = error instanceof Error ? error.message : String(error || '');
  if (message) parts.push(`error: ${message}`);

  const stderr = typeof record.stderr === 'string' ? record.stderr.trim() : '';
  const stdout = typeof record.stdout === 'string' ? record.stdout.trim() : '';
  if (stderr) parts.push(`stderr: ${truncateCommandOutput(stderr)}`);
  if (stdout) parts.push(`stdout: ${truncateCommandOutput(stdout)}`);

  return parts.join('\n');
}

/**
 * Run a command, normalizing the result shape.
 *
 * A thrown transport error becomes a thrown Error with context attached; a
 * non-zero exit is returned as data, because a failing build is an outcome the
 * agent reasons about rather than an exception.
 */
export async function runCommand(
  workspace: WorkspacePort,
  command: string,
  options: CommandOptions = {},
): Promise<CommandResult> {
  let result: CommandResult;
  try {
    result = await workspace.commands.run(command, options);
  } catch (error) {
    throw new Error(formatCommandError(error, command, options));
  }

  const stdout = typeof result?.stdout === 'string' ? result.stdout : '';
  const stderr = typeof result?.stderr === 'string' ? result.stderr : '';
  const exitCode = typeof result?.exitCode === 'number' ? result.exitCode : 0;

  // A bare failing exit code with no diagnostics is useless to the model, so
  // describe the invocation instead of handing back two empty strings.
  if (exitCode !== 0 && !stdout.trim() && !stderr.trim()) {
    return {
      ...result,
      exitCode,
      stdout,
      stderr: formatCommandExit(command, options, exitCode),
    };
  }

  return { ...result, exitCode, stdout, stderr };
}

/**
 * Run a command whose real exit code is echoed into stdout.
 *
 * Needed because some hosts treat any non-zero shell exit as an infrastructure
 * error and discard the output, which is exactly the output a failing build
 * needs to surface.
 */
export async function runCommandCapturingExit(
  workspace: WorkspacePort,
  command: string,
  options: CommandOptions,
  helpers: {
    withExitCodeEcho: (command: string) => string;
    parseEchoedExitCode: (output: string) => number | undefined;
    stripEchoedExit: (output: string) => string;
  },
): Promise<CommandResult> {
  const result = await runCommand(workspace, helpers.withExitCodeEcho(command), options);
  const echoed = helpers.parseEchoedExitCode([result.stdout, result.stderr].join('\n'));

  if (typeof echoed !== 'number') return result;

  return {
    ...result,
    exitCode: echoed,
    stdout: helpers.stripEchoedExit(result.stdout),
    stderr: helpers.stripEchoedExit(result.stderr),
  };
}
