import { unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConflictError, Makers } from '@edgeone/makers-sdk';
import type { AgentContext } from '../runtime/context.ts';
import { PREVIEW_SERVER_PORT } from '../constants.ts';
import type { ProjectState } from '../types.ts';
import { createProjectArchive } from '../project/archive.ts';
import { runCommandCapturingExit } from '../project/commands.ts';
import {
  resolveConversationPublishArea,
  resolveMakersProjectName,
} from '../makers/project.ts';
import { readBuildScript } from './preview-launch.ts';
import { rewritePublishZip } from './rewrite.ts';

export class SiteBuildError extends Error {
  constructor(log: string) {
    super(log);
    this.name = 'SiteBuildError';
  }
}

const BUILD_TIMEOUT_SECONDS = 180;

function publishToken(context: AgentContext) {
  const token = context?.env?.API_TOKEN;
  return typeof token === 'string' ? token.trim() : '';
}

function buildLog(stdout: string, stderr: string) {
  const text = [stdout, stderr].filter(Boolean).join('\n').trim();
  if (text.length <= 4000) return text;
  return text.slice(-4000);
}

async function stopPreview(context: AgentContext) {
  await runCommandCapturingExit(
    context,
    [
      'if command -v fuser >/dev/null 2>&1; then',
      `  fuser -k ${PREVIEW_SERVER_PORT}/tcp >/dev/null 2>&1 || true`,
      'fi',
      'exit 0',
    ].join('\n'),
    { timeout: 15 },
  );
}

async function runBuild(context: AgentContext, state: ProjectState) {
  await stopPreview(context);
  const result = await runCommandCapturingExit(
    context,
    'npm run build',
    { cwd: state.appDir, timeout: BUILD_TIMEOUT_SECONDS },
  );
  if (result.exitCode === 0) return;
  throw new SiteBuildError(buildLog(result.stdout, result.stderr) || 'npm run build failed.');
}

async function ensurePublishProject(
  token: string,
  projectName: string,
  area: string,
  region?: ProjectState['makersApiRegion'],
) {
  const makers = new Makers({
    token,
    ...(region === 'china' || region === 'global' ? { region } : {}),
  });
  const publishArea = area === 'overseas' ? 'overseas' as const : 'global' as const;
  const listed = await makers.projects.list({ name: projectName, pageSize: 10 }).catch(() => null);
  const existing = listed?.items.find((project) => project.name === projectName);
  if (existing) return { makers, projectId: existing.projectId };

  try {
    const created = await makers.projects.create({ name: projectName, area: publishArea });
    return { makers, projectId: created.projectId };
  } catch (error) {
    if (!(error instanceof ConflictError)) throw error;
    const again = await makers.projects.list({ name: projectName, pageSize: 10 });
    const found = again.items.find((project) => project.name === projectName);
    if (!found) throw error;
    return { makers, projectId: found.projectId };
  }
}

export type SitePublishProgress = (text: string) => void;

/**
 * Build the static site when it has a build script, pack it, and publish with
 * the runtime token. One repair callback may run between the two builds.
 * A site with no build script is packed as it stands.
 */
export async function publishStaticSite(
  context: AgentContext,
  state: ProjectState,
  options: {
    onProgress?: SitePublishProgress;
    repair?: (log: string) => Promise<void>;
  } = {},
) {
  const token = publishToken(context);
  if (!token) {
    throw new Error('API_TOKEN is not configured. Add it to the project environment variables.');
  }

  const buildScript = await readBuildScript(context, state);
  if (buildScript) {
    options.onProgress?.('Building the site');
    try {
      await runBuild(context, state);
    } catch (error) {
      if (!(error instanceof SiteBuildError) || !options.repair) throw error;
      options.onProgress?.('Fixing the build');
      await options.repair(error.message);
      options.onProgress?.('Building the site again');
      await runBuild(context, state);
    }
  }

  options.onProgress?.('Packaging the site');
  const archive = await createProjectArchive(context, state);
  if (!archive.ok) {
    throw new Error(archive.error || 'Failed to package the site.');
  }
  if (archive.filename.endsWith('.tar.gz') || archive.contentType === 'application/gzip') {
    throw new Error('Publishing requires a zip archive.');
  }

  const rewritten = await rewritePublishZip(Buffer.from(archive.base64, 'base64'));
  const tmpZip = join(tmpdir(), `eo-publish-${Date.now()}.zip`);
  await writeFile(tmpZip, rewritten);

  try {
    options.onProgress?.('Publishing the site');
    const projectName = resolveMakersProjectName(context, state);
    const { makers, projectId } = await ensurePublishProject(
      token,
      projectName,
      resolveConversationPublishArea(state),
      state.makersApiRegion,
    );
    const deployment = await makers.deployments.deploy({
      projectId,
      artifact: { archive: tmpZip },
      wait: true,
      onStatusChange: (event) => {
        const status = event.deployment.status;
        if (status) options.onProgress?.(`Publishing the site (${status})`);
      },
    });
    if (!deployment.previewUrl) {
      throw new Error('Publish finished without a site URL.');
    }
    return {
      url: deployment.previewUrl,
      projectId,
      deploymentId: deployment.deploymentId,
      projectName,
    };
  } finally {
    await unlink(tmpZip).catch(() => {});
  }
}
