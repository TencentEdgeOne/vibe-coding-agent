import { clearProjectSnapshot, getProjectSnapshot, getProjectState } from '../_memory';
import {
  createProjectState,
  getFileTree,
  resetProjectWorkspace,
  restoreProjectArchive,
} from '../_project';
import type { ProjectState, StreamSend } from '../_types';

/** Restore or reset the volatile sandbox before an agent turn starts. */
export async function prepareProjectWorkspace(
  context: any,
  conversationId: string,
  resetProject: boolean,
  send: StreamSend,
): Promise<ProjectState> {
  const state = resetProject
    ? createProjectState(conversationId)
    : await getProjectState(context, conversationId);

  if (resetProject) {
    await resetProjectWorkspace(context, state);
    await clearProjectSnapshot(context, conversationId);
    return state;
  }

  try {
    let hasProjectFiles = false;
    try {
      if (await context.sandbox.files.exists(state.appDir)) {
        const tree = await getFileTree(context, state);
        hasProjectFiles = tree.some((item) => item.type === 'file');
      }
    } catch {
      hasProjectFiles = false;
    }

    if (!hasProjectFiles) {
      const snapshot = await getProjectSnapshot(context, conversationId);
      if (snapshot) {
        send({ type: 'status', message: 'Restoring project from snapshot' });
        const restored = await restoreProjectArchive(context, state, snapshot);
        if (!restored.ok) {
          send({
            type: 'log',
            phase: 'scaffold',
            stream: 'stderr',
            message: restored.error || 'Failed to restore the project from snapshot.',
          });
        } else {
          hasProjectFiles = true;
        }
      }
    }

    await ensureWorkspaceDirectories(context, state);
    if (hasProjectFiles) state.created = true;
  } catch (error) {
    send({
      type: 'log',
      phase: 'scaffold',
      stream: 'stderr',
      message: error instanceof Error ? error.message : 'Snapshot restore check failed.',
    });
    try {
      await ensureWorkspaceDirectories(context, state);
    } catch {
      // Scaffold reports the actionable error if directory creation still fails.
    }
  }

  return state;
}

async function ensureWorkspaceDirectories(context: any, state: ProjectState) {
  await context.sandbox.files.makeDir(state.sessionDir);
  await context.sandbox.files.makeDir(state.appDir);
}
