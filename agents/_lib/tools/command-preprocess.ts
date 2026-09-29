import {
  MAKERS_DEV_PORT,
} from '../constants.ts';
import {
  buildMakersDevStopScript,
} from '../makers/cli-dev.ts';
import {
  buildNpmCacheReclaimScript,
  buildNpmWarmupHandoffScript,
  buildNpmWarmupWaitScript,
} from '../makers/npm-install.ts';
import {
  isBareInstallCommand,
  isInstallCommand,
  isScaffolderCommand,
  isVerificationCommand,
} from '../makers/tool-phase.ts';

export function extractCommand(args: unknown) {
  const record = args && typeof args === 'object' ? args as Record<string, unknown> : {};
  const command = typeof record.command === 'string'
    ? record.command
    : typeof record.cmd === 'string'
      ? record.cmd
      : '';
  return { record, command };
}

export function withWrappedCommand(args: unknown, wrapped: string) {
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

export function withCommandOptions(
  args: unknown,
  command: string,
  cwd: string,
  env: Record<string, string>,
  timeout: number,
) {
  const { record } = extractCommand(args);
  return {
    ...record,
    ...(typeof record.command === 'string' ? { command } : { cmd: command }),
    cwd,
    env: {
      ...(record.env && typeof record.env === 'object'
        ? record.env as Record<string, unknown>
        : {}),
      ...env,
    },
    timeout,
  };
}

export function withCommandEnvironment(args: unknown, env: Record<string, string>) {
  if (Object.keys(env).length === 0) return args;
  const { record } = extractCommand(args);
  return {
    ...record,
    env: {
      ...(record.env && typeof record.env === 'object'
        ? record.env as Record<string, unknown>
        : {}),
      ...env,
    },
  };
}

const DEV_SERVER_STOPPED_NOTICE = 'The preview dev server was stopped before this command, '
  + 'because a build or an install in the same directory races it over .next and node_modules. '
  + 'The preview is down until you run `edgeone makers dev` again.';


export function withDevServerStopped(command: string) {
  return [buildMakersDevStopScript(MAKERS_DEV_PORT, DEV_SERVER_STOPPED_NOTICE), command].join('\n');
}

export function withWarmedInstall(command: string, wrapped: string) {
  if (isBareInstallCommand(command)) {
    return [buildNpmWarmupHandoffScript(), wrapped, buildNpmCacheReclaimScript()].join('\n');
  }
  return [buildNpmWarmupWaitScript(), wrapped].join('\n');
}

export function shouldStopDevServer(command: string, isMakersCommand: boolean) {
  return !isMakersCommand
    && (
      isInstallCommand(command)
      || isVerificationCommand(command)
      || isScaffolderCommand(command)
    );
}
