import { setDeployment } from '../project/workspace-store.ts';
import {
  describeMakersDeployment,
  readMakersDeployOutcome,
} from '../makers/cli-deploy.ts';
import type { DeploymentInfo } from '../types.ts';
import {
  appendText,
  withMakersCliUnavailableError,
  type ToolHandlerResult,
} from './command-text.ts';
import type { MakersCommandLifecycle } from './makers-lifecycle.ts';
import type { PreparedMakersCommand } from './makers-command.ts';

export function updateDeploymentStatus(
  lifecycle: MakersCommandLifecycle,
  deployment: DeploymentInfo,
) {
  setDeployment(lifecycle.state, deployment);
  lifecycle.onDeploymentStatus?.(deployment);
}

export function handleDeployCommandResult(
  lifecycle: MakersCommandLifecycle,
  makers: PreparedMakersCommand,
  result: ToolHandlerResult,
  makersOutput: string,
  deploymentStartedAt: number,
  failDeployment: (error: string) => void,
): ToolHandlerResult {
  const outcome = readMakersDeployOutcome(makersOutput, '', makers.sandboxToken);
  if (outcome.status === 'cli-missing') {
    failDeployment(outcome.error);
    return withMakersCliUnavailableError(result, 'edgeone makers deploy');
  }
  if (outcome.status === 'error') {
    failDeployment(outcome.error);
    return {
      ...appendText(result, JSON.stringify({
        status: 'error',
        error: outcome.error,
        ...(outcome.exitCode != null ? { exitCode: outcome.exitCode } : {}),
      })),
      isError: true,
    };
  }
  updateDeploymentStatus(lifecycle, describeMakersDeployment(outcome, {
    startedAt: deploymentStartedAt,
  }));
  const { status: _outcomeStatus, ...published } = outcome;
  return appendText(result, JSON.stringify({
    status: 'published',
    ...published,
  }));
}
