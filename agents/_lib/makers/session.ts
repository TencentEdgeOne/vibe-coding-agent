import type { AgentContext } from '../runtime/context.ts';
import type { ProjectState } from '../types.ts';
import {
  ensureMakersPublishProject,
  resolveConversationPublishArea,
  resolveMakersProjectName,
  syncSandboxEnvToMakersProject,
} from './project.ts';
import {
  buildSandboxMakersEnv,
  prepareSandboxGatewayEnv,
  resolveMakersMasterToken,
  resolveSandboxMakersToken,
} from './token.ts';
import { resolveSandboxNpmEnv } from './npm-install.ts';

export type PreparedMakersSession = {
  masterToken: string;
  sandboxToken: string;
  projectName: string;
  area: string;
  env: Record<string, string>;
  gatewayKey: string;
};

/**
 * Token, project, and env the sandbox CLI needs before a Makers command.
 * Preview, deploy, and the commands wrapper all used to do this separately.
 */
export async function prepareMakersSession(
  context: AgentContext,
  state: ProjectState,
  options: { syncEnv?: boolean } = {},
): Promise<PreparedMakersSession> {
  const masterToken = resolveMakersMasterToken(context);
  const sandboxToken = await resolveSandboxMakersToken(state, masterToken);
  const gateway = await prepareSandboxGatewayEnv(context, state);
  const projectName = resolveMakersProjectName(context, state);
  const area = resolveConversationPublishArea(state);
  await ensureMakersPublishProject(
    sandboxToken,
    projectName,
    area,
    state.makersApiRegion,
  );
  if (options.syncEnv) {
    await syncSandboxEnvToMakersProject(
      context,
      state,
      masterToken,
      projectName,
      state.makersApiRegion,
    );
  }
  return {
    masterToken,
    sandboxToken,
    projectName,
    area,
    env: {
      ...buildSandboxMakersEnv(sandboxToken, state.makersApiRegion),
      ...resolveSandboxNpmEnv(state.siteDomain),
    },
    gatewayKey: gateway.AI_GATEWAY_API_KEY || '',
  };
}
