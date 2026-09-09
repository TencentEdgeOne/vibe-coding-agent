import {
  runCommand,
  runCommandCapturingExit as runCommandCapturingExitCore,
} from '../core/_commands.ts';
import { createMakersWorkspacePort } from '../core/adapters/_makers.ts';
import { parseEchoedExitCode, stripEchoedExit, withExitCodeEcho } from '../utils/_tool-phase';

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

const ECHO_HELPERS = { withExitCodeEcho, parseEchoedExitCode, stripEchoedExit };

export async function runSandboxCommand(
  context: any,
  command: string,
  options: SandboxCommandOptions = {},
): Promise<SandboxCommandResult> {
  return runCommand(createMakersWorkspacePort(context), command, options);
}

export async function runCommandCapturingExit(
  context: any,
  command: string,
  options: SandboxCommandOptions = {},
): Promise<SandboxCommandResult> {
  return runCommandCapturingExitCore(
    createMakersWorkspacePort(context),
    command,
    options,
    ECHO_HELPERS,
  );
}
