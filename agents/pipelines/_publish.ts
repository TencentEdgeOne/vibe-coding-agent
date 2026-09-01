import { unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Makers, MakersError } from '@edgeone/makers-sdk';
import { resolveMakersPublishTarget } from '../../shared/publish-target.ts';
import { getProjectState, saveProjectState } from '../_memory';
import { rewritePublishZip } from '../project/_publish-rewrite.ts';
import { createProjectArchive, restorePersistedProject } from '../_project';
import { createSSEResponse, sseEvent } from '../_shared';
import { resolveConversationId } from '../utils/_request';
import { safeSegment } from '../utils/_paths';
import { debugLog } from '../utils/_debug';

function jsonError(error: string, status = 400) {
  return new Response(
    JSON.stringify({ ok: false, error }),
    { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } },
  );
}

function makersProjectName(conversationId: string) {
  return `vibe-${conversationId.replace(/-/g, '').slice(0, 16)}`;
}

function publishErrorMessage(error: unknown) {
  if (error instanceof MakersError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Publish failed.';
}

function isZipArchive(archive: { filename: string; contentType: string }) {
  if (archive.filename.endsWith('.tar.gz') || archive.contentType === 'application/gzip') {
    return false;
  }
  return archive.filename.endsWith('.zip') || archive.contentType === 'application/zip';
}

function createEventPump() {
  const queue: string[] = [];
  let wake: (() => void) | null = null;
  let closed = false;

  const push = (chunk: string) => {
    if (closed) return;
    queue.push(chunk);
    const pending = wake;
    wake = null;
    pending?.();
  };

  const close = () => {
    closed = true;
    const pending = wake;
    wake = null;
    pending?.();
  };

  async function* consume() {
    while (!closed || queue.length > 0) {
      if (queue.length > 0) {
        yield queue.shift() as string;
        continue;
      }
      if (closed) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  }

  return { push, close, consume };
}

export async function runProjectPublishPipeline(context: any): Promise<Response> {
  const { conversationId } = resolveConversationId(context);
  if (!conversationId) {
    return jsonError('missing conversation_id');
  }

  const token = String(context.env?.MAKERS_API_TOKEN || '').trim();
  if (!token) {
    return jsonError('MAKERS_API_TOKEN is not configured. Add it to the project environment variables.');
  }

  const siteDomain = String(context?.request?.body?.siteDomain || '').trim();
  const state = await getProjectState(context, conversationId);
  const tmpZip = join(tmpdir(), `eo-publish-${safeSegment(conversationId)}.zip`);

  return createSSEResponse(async function* (signal) {
    try {
      yield sseEvent({ type: 'status', stage: 'packaging' });
      if (signal?.aborted) return;

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
        yield sseEvent({
          type: 'error',
          error: error instanceof Error ? error.message : 'Failed to package the project.',
        });
        return;
      }

      if (!archive.ok) {
        yield sseEvent({ type: 'error', error: archive.error });
        return;
      }
      if (!isZipArchive(archive)) {
        yield sseEvent({
          type: 'error',
          error: 'Publishing requires a zip archive. The sandbox produced tar.gz, which is not supported.',
        });
        return;
      }

      const rewritten = await rewritePublishZip(Buffer.from(archive.base64, 'base64'));
      await writeFile(tmpZip, rewritten);
      if (signal?.aborted) return;

      yield sseEvent({ type: 'status', stage: 'uploading' });

      const { region, area } = resolveMakersPublishTarget(siteDomain);
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

      if (signal?.aborted) return;

      yield sseEvent({ type: 'status', stage: 'deploying' });

      const pump = createEventPump();
      const deployPromise = makers.deployments.deploy({
        projectId,
        artifact: { archive: tmpZip },
        wait: true,
        onStatusChange: (event) => {
          debugLog(context, '[publish] status', event.deployment.status);
          pump.push(sseEvent({
            type: 'status',
            stage: 'deploying',
            status: event.deployment.status,
          }));
        },
      }).finally(() => {
        pump.close();
      });

      for await (const chunk of pump.consume()) {
        if (signal?.aborted) return;
        yield chunk;
      }

      const deployment = await deployPromise;
      if (signal?.aborted) return;

      if (deployment.previewUrl) {
        state.makersPreviewUrl = deployment.previewUrl;
        await saveProjectState(context, conversationId, state);
      }

      yield sseEvent({
        type: 'result',
        data: {
          ok: true,
          previewUrl: deployment.previewUrl,
          projectId,
          deploymentId: deployment.deploymentId,
        },
      });
    } catch (error) {
      yield sseEvent({
        type: 'error',
        error: publishErrorMessage(error),
      });
    } finally {
      await unlink(tmpZip).catch(() => {});
    }
  }, context?.request?.signal);
}
