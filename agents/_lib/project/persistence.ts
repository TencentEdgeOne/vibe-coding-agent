import { requireSandbox, type AgentContext } from '../runtime/context.ts';
import type { ProjectState } from '../types.ts';
import { restoreProjectArchive } from './archive.ts';
import { runSandboxCommand } from './commands.ts';
import { resolveSandboxNpmEnv } from '../makers/npm-install.ts';

export async function restorePersistedProject(
  context: AgentContext,
  conversationId: string,
  state: ProjectState,
  options: { installDependencies?: boolean } = {},
): Promise<{ restored: boolean; error?: string }> {
  try {
    const restored = await requireSandbox(context).restore?.({ path: state.appDir });
    if (restored?.restored) {
      if (options.installDependencies !== false) await installDependencies(context, state);
      return { restored: true };
    }
  } catch (error) {
    return { restored: false, error: error instanceof Error ? error.message : String(error) };
  }
  return { restored: false };
}

async function installDependencies(context: AgentContext, state: ProjectState) {
  if (!(await requireSandbox(context).files.exists(`${state.appDir}/package.json`))) return;
  if (await requireSandbox(context).files.exists(`${state.appDir}/node_modules`)) return;
  await runSandboxCommand(context, 'npm install --no-audit --no-fund', {
    cwd: state.appDir,
    env: resolveSandboxNpmEnv(state.siteDomain),
    timeout: 300,
  });
}

export { restoreProjectArchive };
