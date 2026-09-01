import type { ProjectState } from '../_types';
import { safeSegment } from '../utils/_paths';
import { runSandboxCommand } from './_commands';

export function createProjectState(conversationId: string): ProjectState {
  const sessionDir = `projects/${safeSegment(conversationId)}`;
  return {
    created: false,
    sessionDir,
    appDir: `${sessionDir}/app`,
  };
}

export async function resetProjectWorkspace(
  context: any,
  state: ProjectState,
) {
  assertResettableProjectPath(state);

  const sandbox = context.sandbox;

  await sandbox.files.makeDir(state.sessionDir);

  const appDirExists = await sandbox.files.exists(state.appDir);
  if (appDirExists) {
    if (typeof sandbox.files.remove === 'function') {
      await sandbox.files.remove(state.appDir);
    } else {
      const result = await runSandboxCommand(context, 'rm -rf app', {
        cwd: state.sessionDir,
        timeout: 60,
      });
      if (result.exitCode !== 0) {
        throw new Error(result.stderr || result.stdout || 'Failed to initialize the project workspace.');
      }
    }
  }

  await sandbox.files.makeDir(state.appDir);
  state.created = false;
  state.previewUrl = undefined;
  state.sandboxDebugUrl = undefined;
  state.previewPublished = undefined;
  state.makersProjectId = undefined;
  state.makersPreviewUrl = undefined;
  return appDirExists;
}

export function assertResettableProjectPath(state: ProjectState) {
  if (state.appDir !== `${state.sessionDir}/app`) {
    throw new Error(`Refusing to operate on an unexpected project path: ${state.appDir}`);
  }
  if (!/^projects\/[a-zA-Z0-9_-]+$/.test(state.sessionDir)) {
    throw new Error(`Refusing to operate on an unexpected session path: ${state.sessionDir}`);
  }
  if (!/^projects\/[a-zA-Z0-9_-]+\/app$/.test(state.appDir)) {
    throw new Error(`Refusing to operate on an unexpected project path: ${state.appDir}`);
  }
}
