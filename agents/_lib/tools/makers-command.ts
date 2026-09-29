import {
  MAKERS_DEV_PORT,
  PREVIEW_ASSET_PREFIX_ENV,
  PREVIEW_PATH_PREFIX,
  PREVIEW_SERVER_PORT,
} from '../constants.ts';
import { prepareMakersSession } from '../makers/session.ts';
import {
  MAKERS_DEV_LAUNCH_TIMEOUT_SECONDS,
  buildMakersDevBackgroundCommand,
} from '../makers/cli-dev.ts';
import { buildMakersDeployCommand } from '../makers/cli-deploy.ts';
import {
  isMakersDeployCommand,
  isMakersDevCommand,
} from '../makers/tool-phase.ts';
import { withCommandOptions } from './command-preprocess.ts';
import type { MakersCommandLifecycle } from './makers-lifecycle.ts';

export type PreparedMakersCommand = {
  args: unknown;
  kind: 'dev' | 'deploy';
  sandboxToken: string;
  gatewayKey: string;
};

export async function prepareMakersCommand(
  args: unknown,
  command: string,
  lifecycle: MakersCommandLifecycle,
): Promise<PreparedMakersCommand> {
  const makers = await prepareMakersSession(lifecycle.context, lifecycle.state, {
    syncEnv: isMakersDeployCommand(command),
  });

  if (isMakersDevCommand(command)) {
    return {
      args: withCommandOptions(
        args,
        buildMakersDevBackgroundCommand({
          makersPort: MAKERS_DEV_PORT,
          previewPort: PREVIEW_SERVER_PORT,
          previewPath: PREVIEW_PATH_PREFIX,
          projectName: makers.projectName,
          assetPrefixEnvName: PREVIEW_ASSET_PREFIX_ENV,
        }),
        lifecycle.state.appDir,
        makers.env,
        MAKERS_DEV_LAUNCH_TIMEOUT_SECONDS,
      ),
      kind: 'dev' as const,
      sandboxToken: makers.sandboxToken,
      gatewayKey: makers.gatewayKey,
    };
  }

  return {
    args: withCommandOptions(
      args,
      buildMakersDeployCommand(makers.projectName, command, {
        stopDevPort: MAKERS_DEV_PORT,
        area: makers.area,
      }),
      lifecycle.state.appDir,
      makers.env,
      600,
    ),
    kind: 'deploy' as const,
    sandboxToken: makers.sandboxToken,
    gatewayKey: makers.gatewayKey,
  };
}
