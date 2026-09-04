import { tool as defineClaudeTool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  isPreviewServerReady,
  resolvePublicLinks,
  runSandboxCommand,
  startPreviewServer,
} from '../_project';
import type { ClaudeMcpTool, PreviewRestartSignal, ProjectState } from '../_types';
import { getBlockedProjectWriteReason, toAppRelPath } from '../utils/_paths';
import { stringifyToolResult } from '../utils/_text';
import { shouldReusePreviewServer } from '../utils/_tool-phase';

const writeProjectFileInputSchema = {
  path: z.string().describe(
    'Path relative to the project appDir only (e.g. package.json, src/App.tsx). Do not include the appDir prefix.',
  ),
  content: z.string().describe('Complete UTF-8 contents for that one file.'),
};

export function buildWriteProjectFileTool(
  context: any,
  state: ProjectState,
  // The content is handed back so the pipeline can push it straight to the
  // frontend, which then renders the file without a /file round trip.
  onResult?: (result: { written: string; content: string }) => void | Promise<void>,
) {
  return defineClaudeTool(
    'write_project_file',
    'Create or replace exactly one complete UTF-8 project file under appDir. Call separately for every file and wait for each result. Keep files modular and reasonably small — prefer multiple focused files over one giant HTML/JS blob so each write finishes faster for the user. Path must be relative to appDir itself (package.json, src/App.tsx) — never prefix with the appDir path.',
    writeProjectFileInputSchema,
    async (input) => {
      try {
        const file = input as { path?: unknown; content?: unknown };
        if (typeof file.path !== 'string' || typeof file.content !== 'string') {
          throw new Error('Call write_project_file with {"path":"src/App.tsx","content":"complete file contents"}.');
        }
        const relPath = toAppRelPath(file.path, state.appDir);
        if (!relPath) {
          throw new Error(
            `Invalid file path: ${file.path}. Use a path relative to ${state.appDir} (example: src/App.tsx), not ${state.appDir}/src/App.tsx.`,
          );
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
        state.created = true;
        await onResult?.({ written: relPath, content: file.content });
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

export function buildPublishPreviewTool(
  context: any,
  state: ProjectState,
  onResult?: (result: { url?: string; sandboxDebugUrl?: string }) => void,
  restartSignal?: PreviewRestartSignal,
) {
  return defineClaudeTool(
    'publish_preview',
    'Publish the project preview. Reuse the running service on internal port 3000 when /preview/ is already HTTP-ready and this turn did not install dependencies or rewrite package.json / Vite / Next config. Otherwise start or restart the service, wait until /preview/ is ready, then return the public preview URL from sandbox.getHost(9000)/preview/ plus envdAccessToken and an optional sandboxDebugUrl. Do not synthesize either field.',
    {},
    async () => {
      return publishPreview(context, state, onResult, restartSignal);
    },
  ) as ClaudeMcpTool;
}

async function publishPreview(
  context: any,
  state: ProjectState,
  onResult?: (result: { url?: string; sandboxDebugUrl?: string }) => void,
  restartSignal?: PreviewRestartSignal,
) {
  try {
    await assertPreviewableProject(context, state);
    const reused = shouldReusePreviewServer(
      await isPreviewServerReady(context),
      restartSignal?.mustRestart === true,
    );
    if (!reused) {
      await startPreviewServer(context, state);
    }
    const links = await resolvePublicLinks(context);
    state.previewUrl = links.previewUrl;
    state.sandboxDebugUrl = links.sandboxDebugUrl;
    // Durable signal for resume — do not clear this when a later live URL expires.
    state.previewPublished = true;
    onResult?.({
      url: state.previewUrl,
      sandboxDebugUrl: state.sandboxDebugUrl,
    });
    return {
      content: [{
        type: 'text' as const,
        text: stringifyToolResult({
          url: state.previewUrl,
          sandboxDebugUrl: state.sandboxDebugUrl,
          reused,
        }),
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
