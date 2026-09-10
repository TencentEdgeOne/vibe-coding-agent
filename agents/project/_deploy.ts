import { unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Makers, MakersError } from '@edgeone/makers-sdk';
import { resolveMakersPublishTarget } from '../../shared/publish-target.ts';
import type { PublishResult, PublishStage } from '../../shared/protocol.ts';
import { saveProjectState } from '../_memory.ts';
import type { ProjectState } from '../_types.ts';
import { createProjectArchive, restorePersistedProject } from '../_project.ts';
import { debugLog } from '../utils/_debug.ts';
import { safeSegment } from '../utils/_paths.ts';
import { rewritePublishZip } from './_publish-rewrite.ts';

export function formatDeployStage(stage: PublishStage, status?: string) {
  if (stage === 'uploading') return 'Uploading the artifact';
  if (stage === 'deploying') {
    return status ? `Deploying to EdgeOne Pages (${status})` : 'Deploying to EdgeOne Pages';
  }
  return 'Packaging the project';
}

export function publishErrorMessage(error: unknown) {
  if (error instanceof MakersError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Publish failed.';
}

function makersProjectName(conversationId: string) {
  return `vibe-${conversationId.replace(/-/g, '').slice(0, 16)}`;
}

function isZipArchive(archive: { filename: string; contentType: string }) {
  if (archive.filename.endsWith('.tar.gz') || archive.contentType === 'application/gzip') {
    return false;
  }
  return archive.filename.endsWith('.zip') || archive.contentType === 'application/zip';
}

function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    const error = new Error('Publish cancelled.');
    error.name = 'AbortError';
    throw error;
  }
}

export async function deployProjectToMakers(
  context: any,
  conversationId: string,
  state: ProjectState,
  options: {
    siteDomain: string;
    onStage: (stage: PublishStage, status?: string) => void;
    signal?: AbortSignal;
  },
): Promise<PublishResult> {
  const token = String(context.env?.API_TOKEN || '').trim();
  if (!token) {
    throw new Error('API_TOKEN is not configured. Add it to the project environment variables.');
  }

  const tmpZip = join(tmpdir(), `eo-publish-${safeSegment(conversationId)}.zip`);
  try {
    options.onStage('packaging');
    assertNotAborted(options.signal);

    let archive;
    try {
      archive = await createProjectArchive(context, state);
      if (!archive.ok) {
        const restored = await restorePersistedProject(context, conversationId, state, {
          installDependencies: false,
        });
        if (restored.restored) archive = await createProjectArchive(context, state);
      }
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : 'Failed to package the project.');
    }

    if (!archive.ok) {
      throw new Error(archive.error || 'Failed to package the project.');
    }
    if (!isZipArchive(archive)) {
      throw new Error('Publishing requires a zip archive. The sandbox produced tar.gz, which is not supported.');
    }

    const rewritten = await rewritePublishZip(Buffer.from(archive.base64, 'base64'));
    await writeFile(tmpZip, rewritten);
    assertNotAborted(options.signal);

    options.onStage('uploading');

    const { region, area } = resolveMakersPublishTarget(options.siteDomain);
    const makers = new Makers({ token, source: 'sdk', region });

    let projectId = state.makersProjectId;
    if (!projectId) {
      const created = await makers.projects.create({
        name: makersProjectName(conversationId),
        area,
      });
      projectId = created.projectId;
      state.makersProjectId = projectId;
      await saveProjectState(context, conversationId, state);
    }

    assertNotAborted(options.signal);
    options.onStage('deploying');

    const deployment = await makers.deployments.deploy({
      projectId,
      artifact: { archive: tmpZip },
      wait: true,
      onStatusChange: (event) => {
        debugLog(context, '[publish] status', event.deployment.status);
        options.onStage('deploying', event.deployment.status);
      },
    });

    assertNotAborted(options.signal);

    if (deployment.previewUrl) {
      state.makersPreviewUrl = deployment.previewUrl;
      await saveProjectState(context, conversationId, state);
    }

    return {
      ok: true,
      previewUrl: deployment.previewUrl,
      projectId,
      deploymentId: deployment.deploymentId,
    };
  } finally {
    await unlink(tmpZip).catch(() => {});
  }
}
