import { tool as defineClaudeTool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  assertPreviewServerReady,
  ensureProjectScaffold,
  resolvePublicLinks,
  runSandboxCommand,
  startPreviewServer,
} from '../_project';
import type { ClaudeMcpTool, ProjectState, ScaffoldLog } from '../_types';
import { getBlockedProjectWriteReason, normalizeRelPath } from '../utils/_paths';
import { stringifyToolResult } from '../utils/_text';

const writeProjectFileInputSchema = {
  path: z.string().describe('Relative path of exactly one file under appDir.'),
  content: z.string().describe('Complete UTF-8 contents for that one file.'),
};

export function buildProjectScaffoldTool(
  context: any,
  state: ProjectState,
  onLog?: (log: ScaffoldLog) => void,
  onResult?: (result: { created: boolean }) => void,
) {
  return defineClaudeTool(
    'ensure_project_scaffold',
    'Prepare or reuse the project workspace in the EdgeOne sandbox before any project file reads or writes.',
    {},
    async () => {
      try {
        const created = await ensureProjectScaffold(context, state, onLog);
        state.created = true;
        onResult?.({ created });
        return {
          content: [{
            type: 'text' as const,
            text: stringifyToolResult({
              created,
              appDir: state.appDir,
            }),
          }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: message }],
          isError: true,
        };
      }
    },
  ) as ClaudeMcpTool;
}

export function buildWriteProjectFileTool(
  context: any,
  state: ProjectState,
  onResult?: (result: { written: string }) => void | Promise<void>,
) {
  return defineClaudeTool(
    'write_project_file',
    'Create or replace exactly one complete UTF-8 project file under appDir. Call this tool separately for every file and wait for each result before calling it again. Paths must be relative to appDir.',
    writeProjectFileInputSchema,
    async (input) => {
      try {
        const file = input as { path?: unknown; content?: unknown };
        if (typeof file.path !== 'string' || typeof file.content !== 'string') {
          throw new Error('Call write_project_file with {"path":"src/App.tsx","content":"complete file contents"}.');
        }
        const relPath = normalizeRelPath(file.path);
        if (!relPath) {
          throw new Error(`Invalid file path: ${file.path}`);
        }
        const blockedReason = getBlockedProjectWriteReason(relPath);
        if (blockedReason) {
          throw new Error(`Refusing to write ${relPath}: ${blockedReason}`);
        }

        const parent = relPath.split('/').slice(0, -1).join('/');
        if (parent) {
          await context.sandbox.files.makeDir(`${state.appDir}/${parent}`);
        }
        await context.sandbox.files.write(`${state.appDir}/${relPath}`, file.content);
        await onResult?.({ written: relPath });
        return {
          content: [{
            type: 'text' as const,
            text: stringifyToolResult({ written: relPath }),
          }],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: 'text' as const, text: message }],
          isError: true,
        };
      }
    },
  ) as ClaudeMcpTool;
}

export function buildPreviewLinkTool(
  context: any,
  state: ProjectState,
  onResult?: (result: { url?: string; sandboxDebugUrl?: string }) => void,
) {
  return defineClaudeTool(
    'get_preview_link',
    'Legacy alias for publish_preview. Start or refresh the project preview server on internal port 3000, wait until the /preview/ entry is ready, then return the public preview URL generated from sandbox.getHost(9000)/preview/ plus envdAccessToken and an optional sandboxDebugUrl from sandbox.browser.liveUrl. Do not call any other preview startup tool or synthesize either field.',
    {},
    async () => {
      return publishPreview(context, state, onResult);
    },
  ) as ClaudeMcpTool;
}

export function buildPublishPreviewTool(
  context: any,
  state: ProjectState,
  onResult?: (result: { url?: string; sandboxDebugUrl?: string }) => void,
) {
  return defineClaudeTool(
    'publish_preview',
    'Publish the project preview. Start or refresh the project preview server on internal port 3000, wait until the /preview/ entry is ready, then return the public preview URL generated from sandbox.getHost(9000)/preview/ plus envdAccessToken and an optional sandboxDebugUrl from sandbox.browser.liveUrl. Do not call any other preview startup tool or synthesize either field.',
    {},
    async () => {
      return publishPreview(context, state, onResult);
    },
  ) as ClaudeMcpTool;
}

async function publishPreview(
  context: any,
  state: ProjectState,
  onResult?: (result: { url?: string; sandboxDebugUrl?: string }) => void,
) {
  try {
    await assertPreviewableProject(context, state);
    const server = await startPreviewServer(context, state);
    await assertPreviewServerReady(context, server.readyPath);
    const links = await resolvePublicLinks(context);
    state.previewUrl = links.previewUrl;
    state.sandboxDebugUrl = links.sandboxDebugUrl;
    onResult?.({
      url: state.previewUrl,
      sandboxDebugUrl: state.sandboxDebugUrl,
    });
    const preview = {
      url: state.previewUrl,
      sandboxDebugUrl: state.sandboxDebugUrl,
      server,
    };
    return {
      content: [{
        type: 'text' as const,
        text: stringifyToolResult(preview),
      }],
    };
  } catch (error) {
    state.previewUrl = undefined;
    state.sandboxDebugUrl = undefined;
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text' as const, text: message }],
      isError: true,
    };
  }
}

async function assertPreviewableProject(context: any, state: ProjectState) {
  if (!state.created) {
    throw new Error('There is no previewable project yet. Please describe the page or feature you want to build first.');
  }

  const appDirExists = await context.sandbox.files.exists(state.appDir);
  if (!appDirExists) {
    throw new Error(`Project workspace does not exist: ${state.appDir}`);
  }

  const existing = await runSandboxCommand(
    context,
    [
      'find . -mindepth 1 -maxdepth 2',
      "\\( -path './node_modules' -o -path './.next' -o -path './.git' -o -path './dist' -o -path './build' \\) -prune",
      '-o -print -quit',
    ].join(' '),
    {
      cwd: state.appDir,
      timeout: 30,
    },
  );
  if (existing.exitCode !== 0) {
    throw new Error(existing.stderr || existing.stdout || 'Project workspace inspection failed.');
  }
  if (!existing.stdout.trim()) {
    throw new Error('The current project directory is empty. Please describe the page or feature you want to build first.');
  }
}
