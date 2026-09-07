import { clearLegacyProjectSnapshot, getLegacyProjectSnapshot } from '../_memory';
import type { ProjectState } from '../_types';
import { restoreProjectArchive } from './_archive';
import { runSandboxCommand } from './_commands';

export async function restorePersistedProject(
  context: any,
  conversationId: string,
  state: ProjectState,
  options: { installDependencies?: boolean } = {},
): Promise<{
  restored: boolean;
  migratedLegacy?: boolean;
  error?: string;
  restoreMs?: number;
  installMs?: number;
  installed?: boolean;
}> {
  try {
    const restoreStartedAt = Date.now();
    const restored = await context.sandbox.restore({ path: state.appDir });
    const restoreMs = Date.now() - restoreStartedAt;
    if (restored?.restored) {
      if (options.installDependencies === false) {
        return { restored: true, restoreMs, installMs: 0, installed: false };
      }
      const installStartedAt = Date.now();
      const installed = await installDependencies(context, state);
      return {
        restored: true,
        restoreMs,
        installMs: Date.now() - installStartedAt,
        installed,
      };
    }
  } catch (error) {
    return { restored: false, error: error instanceof Error ? error.message : String(error) };
  }

  const legacy = await getLegacyProjectSnapshot(context, conversationId);
  if (!legacy) return { restored: false };
  const restoreStartedAt = Date.now();
  const restoredLegacy = await restoreProjectArchive(context, state, legacy, options);
  const restoreMs = Date.now() - restoreStartedAt;
  if (!restoredLegacy.ok) return { restored: false, error: restoredLegacy.error, restoreMs };

  try {
    await context.sandbox.persist({ path: state.appDir });
    await clearLegacyProjectSnapshot(context, conversationId);
  } catch {
    // Keep the legacy metadata until migration has durably completed.
  }
  return { restored: true, migratedLegacy: true, restoreMs };
}

async function installDependencies(context: any, state: ProjectState) {
  if (!(await context.sandbox.files.exists(`${state.appDir}/package.json`))) return false;
  if (await context.sandbox.files.exists(`${state.appDir}/node_modules`)) return false;
  await runSandboxCommand(context, 'npm install --no-audit --no-fund', {
    cwd: state.appDir,
    timeout: 300,
  });
  return true;
}
