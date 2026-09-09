import { clearLegacyProjectSnapshot, getProjectState } from '../_memory';
import {
  createProjectState,
  ensureProjectScaffold,
  getFileTree,
  resetProjectWorkspace,
  restorePersistedProject,
} from '../_project';
import type { ProjectState, StreamSend } from '../_types';
import { createProjectFiles } from '../core/_project-files.ts';
import { createMakersWorkspacePort } from '../core/adapters/_makers.ts';
import { createTurnTimer, formatTimingLog, type TurnTimer } from '../utils/_timing';

function emitTiming(
  send: StreamSend,
  timer: TurnTimer,
  stage: string,
  startedAt: number,
  phase: 'scaffold' | 'agent',
  fields?: Parameters<TurnTimer['mark']>[2],
) {
  const mark = timer.mark(stage, startedAt, fields);
  send({
    type: 'log',
    phase,
    stream: 'status',
    message: formatTimingLog(mark),
    startedAt: mark.startedAt,
    endedAt: mark.endedAt,
  });
}

/** Restore or reset the volatile sandbox before an agent turn starts. */
export async function prepareProjectWorkspace(
  context: any,
  conversationId: string,
  resetProject: boolean,
  send: StreamSend,
  timer: TurnTimer = createTurnTimer(),
): Promise<ProjectState> {
  const state = resetProject
    ? createProjectState(conversationId)
    : await getProjectState(context, conversationId);

  if (resetProject) {
    const resetStartedAt = Date.now();
    await resetProjectWorkspace(context, state);
    await clearLegacyProjectSnapshot(context, conversationId);
    await createMakersWorkspacePort(context).persist({ path: state.appDir });
    emitTiming(send, timer, 'workspace_reset', resetStartedAt, 'scaffold');
    return state;
  }

  try {
    let hasProjectFiles = false;
    const probeStartedAt = Date.now();
    try {
      if (await createProjectFiles(createMakersWorkspacePort(context), state.appDir).projectExists()) {
        const tree = await getFileTree(context, state);
        hasProjectFiles = tree.some((item) => item.type === 'file');
      }
    } catch {
      hasProjectFiles = false;
    }
    emitTiming(send, timer, 'workspace_probe', probeStartedAt, 'scaffold', {
      has_files: hasProjectFiles,
    });

    if (!hasProjectFiles) {
      send({ type: 'status', message: 'Restoring project from snapshot' });
      const restoreStartedAt = Date.now();
      const restored = await restorePersistedProject(context, conversationId, state);
      emitTiming(send, timer, 'workspace_restore', restoreStartedAt, 'scaffold', {
        restored: restored.restored,
        installed: restored.installed === true,
        restore_ms: restored.restoreMs,
        install_ms: restored.installMs,
        legacy: restored.migratedLegacy === true,
      });
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

    const scaffoldStartedAt = Date.now();
    const workspaceIsEmpty = await ensureProjectScaffold(context, state, (log) => {
      send({
        type: 'log',
        phase: 'scaffold',
        stream: log.stream,
        message: log.content,
      });
    });
    emitTiming(send, timer, 'workspace_scaffold', scaffoldStartedAt, 'scaffold', {
      empty: workspaceIsEmpty,
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
