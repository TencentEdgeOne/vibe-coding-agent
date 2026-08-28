import { tool as defineClaudeTool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { ensureProjectScaffold } from '../_project';
import type { ClaudeMcpTool, ProjectState, ScaffoldLog } from '../_types';
import { getBlockedProjectWriteReason, toAppRelPath } from '../utils/_paths';
import { stringifyToolResult } from '../utils/_text';

const writeProjectFileInputSchema = {
  path: z.string().describe(
    'Path relative to the project appDir only (e.g. package.json, src/App.tsx). Do not include the appDir prefix.',
  ),
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
              writePathHint: 'write_project_file path is relative to appDir (e.g. package.json, src/App.tsx), never prefix with appDir',
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