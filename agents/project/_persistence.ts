import { clearLegacyProjectSnapshot, getLegacyProjectSnapshot } from '../_memory';
import { installProjectDependencies } from '../core/_project-files.ts';
import { createMakersWorkspacePort } from '../core/adapters/_makers.ts';
import type { ProjectState } from '../_types';
import { restoreProjectArchive } from './_archive';

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
    const restored = await createMakersWorkspacePort(context)
      .restore({ path: state.appDir }) as { restored?: boolean } | undefined;
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
    await createMakersWorkspacePort(context).persist({ path: state.appDir });
    await clearLegacyProjectSnapshot(context, conversationId);
  } catch {
    // Keep the legacy metadata until migration has durably completed.
  }
  return { restored: true, migratedLegacy: true, restoreMs };
}

async function installDependencies(context: any, state: ProjectState) {
  return installProjectDependencies(createMakersWorkspacePort(context), state.appDir);
}
