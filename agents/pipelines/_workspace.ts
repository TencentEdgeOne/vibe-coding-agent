import { clearLegacyProjectSnapshot, getProjectState } from '../_memory';
import {
  createProjectState,
  ensureProjectScaffold,
  getFileTree,
  resetProjectWorkspace,
  restorePersistedProject,
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
    await clearLegacyProjectSnapshot(context, conversationId);
    await context.sandbox.persist({ path: state.appDir });
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
      send({ type: 'status', message: 'Restoring project from snapshot' });
      const restored = await restorePersistedProject(context, conversationId, state);
      if (!restored.restored) {
        if (restored.error) {
          send({
            type: 'log',
            phase: 'scaffold',
            stream: 'stderr',
            message: restored.error,
          });
        }
      } else {
        hasProjectFiles = true;
      }
    }

    const workspaceIsEmpty = await ensureProjectScaffold(context, state, (log) => {
      send({
        type: 'log',
        phase: 'scaffold',
        stream: log.stream,
        message: log.content,
      });
    });
    if (!workspaceIsEmpty) state.created = true;
  } catch (error) {
    send({
      type: 'log',
      phase: 'scaffold',
      stream: 'stderr',
      message: error instanceof Error ? error.message : 'Snapshot restore check failed.',
    });
    try {
      await ensureProjectScaffold(context, state);
    } catch {
      // Directory creation is retried here; write_project_file reports the next failure.
    }
  }

  return state;
}
