import { tool as defineClaudeTool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  assertPreviewServerReady,
  deployProjectToMakers,
  ensureProjectScaffold,
  resolvePublicLinks,
  runSandboxCommand,
  startPreviewServer,
} from '../_project';
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

export function buildPreviewLinkTool(
  context: any,
  state: ProjectState,
  onResult?: (result: { url?: string; sandboxDebugUrl?: string; kind?: 'sandbox' | 'makers' }) => void,
) {
  return defineClaudeTool(
    'get_preview_link',
    'Legacy alias for publish_preview. Start or refresh edgeone makers dev in the sandbox (not a cloud deploy), wait until the /preview/ entry is ready, then return the public preview URL. Do not run the edgeone CLI yourself or synthesize the URL.',
    {},
    async () => {
      return publishPreview(context, state, onResult);
    },
  ) as ClaudeMcpTool;
}

export function buildPublishPreviewTool(
  context: any,
  state: ProjectState,
  onResult?: (result: { url?: string; sandboxDebugUrl?: string; kind?: 'sandbox' | 'makers' }) => void,
) {
  return defineClaudeTool(
    'publish_preview',
    'Publish the project preview. Starts edgeone makers dev in the sandbox (not a cloud deploy), waits until it is ready, and returns the public /preview/ URL. Do not run the edgeone CLI yourself, and do not call deploy_to_makers for this preview.',
    {},
    async () => {
      return publishPreview(context, state, onResult);
    },
  ) as ClaudeMcpTool;
}

async function publishPreview(
  context: any,
  state: ProjectState,
  onResult?: (result: { url?: string; sandboxDebugUrl?: string; kind?: 'sandbox' | 'makers' }) => void,
) {
  try {
    await assertPreviewableProject(context, state);
    await assertPreviewCompatibility(context, state);
    const server = await startPreviewServer(context, state);
    await assertPreviewServerReady(context, server.readyPath);
    const links = await resolvePublicLinks(context);
    state.previewUrl = links.previewUrl;
    state.sandboxDebugUrl = links.sandboxDebugUrl;
    state.previewKind = 'sandbox';
    // Durable signal for resume — do not clear this when a later live URL expires.
    state.previewPublished = true;
    onResult?.({
      url: state.previewUrl,
      sandboxDebugUrl: state.sandboxDebugUrl,
      kind: 'sandbox',
    });
    const preview = {
      url: state.previewUrl,
      sandboxDebugUrl: state.sandboxDebugUrl,
      kind: 'sandbox' as const,
      server,
    };
    return {
      content: [{
        type: 'text' as const,
        text: stringifyToolResult(preview),
      }],
    };
  } catch (error) {
    if (state.previewKind !== 'makers') {
      state.previewUrl = undefined;
      state.sandboxDebugUrl = undefined;
      state.previewKind = undefined;
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text' as const, text: message }],
      isError: true,
    };
  }
}

async function assertPreviewCompatibility(context: any, state: ProjectState) {
  const script = String.raw`
const fs = require('fs');
const path = require('path');
const errors = [];
const ignored = new Set(['node_modules', '.edgeone', '.git', 'dist', 'build', '.next']);
const frontendFiles = [];
const agentFiles = [];

function walk(dir, relative = '') {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const rel = relative ? relative + '/' + entry.name : entry.name;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(abs, rel);
      continue;
    }
    if (!/\.(?:html|js|jsx|ts|tsx|vue|svelte)$/.test(entry.name)) continue;
    if (rel.startsWith('agents/')) agentFiles.push(rel);
    else if (!rel.startsWith('cloud-functions/') && !rel.startsWith('edge-functions/')) frontendFiles.push(rel);
  }
}

walk('.');
for (const file of frontendFiles) {
  const source = fs.readFileSync(file, 'utf8');
  if (/\bfetch\s*\(\s*(['"])\/(?:api\/|chat(?:\1|[/?]))/.test(source)) {
    errors.push(file + ': root-absolute fetch bypasses sandbox preview. Resolve the API path from window.location.href and preserve access_token.');
  }
}

if (agentFiles.length > 0) {
  if (!fs.existsSync('edgeone.json')) {
    errors.push('edgeone.json: required for an agents/ project and must declare agents.framework.');
  } else {
    try {
      const config = JSON.parse(fs.readFileSync('edgeone.json', 'utf8'));
      if (!config.agents || !config.agents.framework) {
        errors.push('edgeone.json: agents.framework is required.');
      }
    } catch {
      errors.push('edgeone.json: invalid JSON.');
    }
  }
  if (!fs.existsSync('.env.example')) {
    errors.push('.env.example: declare AI_GATEWAY_API_KEY, AI_GATEWAY_BASE_URL, and AI_GATEWAY_MODEL.');
  }
  for (const file of agentFiles) {
    const source = fs.readFileSync(file, 'utf8');
    if (/gpt-4o-mini/.test(source)) {
      errors.push(file + ': gpt-4o-mini is not a valid default. Use context.env.AI_GATEWAY_MODEL || "@makers/hy3-preview".');
    }
  }
}

if (errors.length) {
  process.stderr.write(errors.join('\n'));
  process.exit(2);
}
`;
  const validationScriptPath = `${state.sessionDir}/.preview-compat-check.cjs`;
  await context.sandbox.files.write(validationScriptPath, script);
  const result = await runSandboxCommand(
    context,
    'node ../.preview-compat-check.cjs',
    { cwd: state.appDir, timeout: 20 },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Preview compatibility check failed:\n${result.stderr || result.stdout}\nFix only these files, then call publish_preview again. Do not run diagnostic commands.`,
    );
  }
}

export function buildDeployToMakersTool(
  context: any,
  state: ProjectState,
  onResult?: (result: { url?: string; sandboxDebugUrl?: string; kind?: 'sandbox' | 'makers' }) => void,
) {
  return defineClaudeTool(
    'deploy_to_makers',
    'Deploy the generated project to a live EdgeOne Makers URL. Do not use this for the right-hand preview panel — call publish_preview instead (local makers-dev). Only call this when the user explicitly asks to publish a live Makers URL. Do not pass a token or project name — the host injects them. Do not run the edgeone CLI yourself.',
    {},
    async () => {
      try {
        await assertPreviewableProject(context, state);
        const result = await deployProjectToMakers(context, state);
        if (!result.ok) {
          return {
            content: [{ type: 'text' as const, text: result.error }],
            isError: true,
          };
        }
        state.previewUrl = result.url;
        state.sandboxDebugUrl = undefined;
        state.previewKind = 'makers';
        state.previewPublished = true;
        onResult?.({
          url: result.url,
          kind: 'makers',
        });
        return {
          content: [{
            type: 'text' as const,
            text: stringifyToolResult({
              ok: true,
              url: result.url,
              httpStatus: result.httpStatus,
              verified: result.verified,
              ...(result.warning ? { warning: result.warning } : {}),
              ...(result.projectId ? { projectId: result.projectId } : {}),
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
