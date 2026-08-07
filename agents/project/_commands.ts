type SandboxCommandOptions = {
  cwd?: string;
  timeout?: number;
  [key: string]: unknown;
};

type SandboxCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  [key: string]: unknown;
};

export async function runSandboxCommand(
  context: any,
  command: string,
  options: SandboxCommandOptions = {},
): Promise<SandboxCommandResult> {
  try {
    const result = await context.sandbox.commands.run(command, options) as SandboxCommandResult;
    const stdout = typeof result.stdout === 'string' ? result.stdout : '';
    const stderr = typeof result.stderr === 'string' ? result.stderr : '';
    if (result.exitCode !== 0 && !stdout.trim() && !stderr.trim()) {
      return {
        ...result,
        stdout,
        stderr: formatSandboxCommandExit(command, options, result.exitCode),
      };
    }
    return {
      ...result,
      stdout,
      stderr,
    };
  } catch (error) {
    throw new Error(formatSandboxCommandError(error, command, options));
  }
}

function formatSandboxCommandExit(
  command: string,
  options: SandboxCommandOptions,
  exitCode: number,
) {
  return [
    `Sandbox command exited with code ${exitCode} while running: ${command}`,
    options.cwd ? `cwd: ${options.cwd}` : '',
    typeof options.timeout === 'number' ? `timeout: ${options.timeout}s` : '',
  ].filter(Boolean).join('\n');
}

function formatSandboxCommandError(
  error: unknown,
  command: string,
  options: SandboxCommandOptions,
) {
  const parts = [`Sandbox command failed while running: ${command}`];
  if (options.cwd) {
    parts.push(`cwd: ${options.cwd}`);
  }
  if (typeof options.timeout === 'number') {
    parts.push(`timeout: ${options.timeout}s`);
  }

  const errorRecord = error && typeof error === 'object'
    ? error as { message?: unknown; stdout?: unknown; stderr?: unknown }
    : {};
  const message = error instanceof Error ? error.message : String(error || '');
  if (message) {
    parts.push(`error: ${message}`);
  }

  const stderr = typeof errorRecord.stderr === 'string' ? errorRecord.stderr.trim() : '';
  const stdout = typeof errorRecord.stdout === 'string' ? errorRecord.stdout.trim() : '';
  if (stderr) {
    parts.push(`stderr: ${truncateCommandOutput(stderr)}`);
  }
  if (stdout) {
    parts.push(`stdout: ${truncateCommandOutput(stdout)}`);
  }

  return parts.join('\n');
}

function truncateCommandOutput(value: string) {
  return value.length > 2000 ? `${value.slice(0, 2000)}...` : value;
}
