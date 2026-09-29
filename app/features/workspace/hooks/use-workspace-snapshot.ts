'use client';

import { useCallback } from 'react';
import type { FileContentCache } from '@/app/hooks/use-file-content-cache';
import type { ResumeData, WorkspaceSnapshot } from '../../../../shared/protocol';
import {
  fetchFileBatch,
  fetchWorkspaceSnapshot,
} from '../workspace-api';
import type { PreviewSurfaceApi } from './use-preview-surface';
import type { WorkspaceStateApi } from './use-workspace-state';

export function useWorkspaceSnapshot(options: {
  workspace: WorkspaceStateApi;
  preview: PreviewSurfaceApi;
  fileCache: FileContentCache;
}) {
  const { workspace, preview, fileCache } = options;

  const applySnapshot = useCallback((data: WorkspaceSnapshot | ResumeData) => {
    if (data.files) workspace.setFileTree(data.files);
    if (data.download?.url) workspace.setDownload(data.download);
    if (data.deployment) workspace.setDeployment(data.deployment);
    if ('build' in data && data.build) workspace.setBuild(data.build);
    if (data.preview?.url) {
      // A stored URL is proof this conversation published a preview, which is
      // what later lets the Preview tab restore it instead of staying empty.
      workspace.setHasPublishedPreview(true);
      preview.applyResumedPreview(data.preview);
    }
  }, [preview, workspace]);

  const refresh = useCallback(async (
    conversationId: string,
    options: { includePreview?: boolean } = {},
  ) => {
    const snapshot = await fetchWorkspaceSnapshot(conversationId);
    if (snapshot?.ok) {
      if (options.includePreview === false) {
        const { preview: _preview, ...rest } = snapshot;
        applySnapshot(rest);
      } else {
        applySnapshot(snapshot);
      }
    }
    return snapshot;
  }, [applySnapshot]);

  const pullFiles = useCallback(async (conversationId: string, paths: string[]) => {
    if (paths.length === 0) return [];
    const files = await fetchFileBatch(conversationId, paths);
    for (const file of files) {
      if (!file.path || !file.ok || typeof file.content !== 'string') continue;
      fileCache.write(file.path, {
        content: file.content,
        size: typeof file.size === 'number' ? file.size : file.content.length,
        truncated: Boolean(file.truncated),
      });
    }
    return files;
  }, [fileCache]);

  return { applySnapshot, refresh, pullFiles };
}

export type WorkspaceSnapshotApi = ReturnType<typeof useWorkspaceSnapshot>;
