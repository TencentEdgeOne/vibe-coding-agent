'use client';

import { useEffect, useRef } from 'react';
import { fetchPreviewRefresh } from '../workspace-api';
import type { PreviewSurfaceApi } from './use-preview-surface';
import type { WorkspaceSnapshotApi } from './use-workspace-snapshot';
import type { WorkspaceStateApi } from './use-workspace-state';

/**
 * The side panel stays closed until the user opens it. Code and preview each
 * boot their own backend the first time that tab is shown.
 */
export function useLazyPanel(options: {
  conversationId: string | null;
  workspace: WorkspaceStateApi;
  preview: PreviewSurfaceApi;
  snapshot: WorkspaceSnapshotApi;
}) {
  const { conversationId, workspace, preview, snapshot } = options;
  const refreshSnapshot = snapshot.refresh;
  const filesAttempt = useRef<'idle' | 'pending' | 'done'>('idle');
  const previewAttempt = useRef<'idle' | 'pending' | 'done'>('idle');
  const previewRevisions = useRef(new Map<string, number>());
  const previewApi = useRef(preview);
  previewApi.current = preview;

  useEffect(() => {
    filesAttempt.current = 'idle';
    previewAttempt.current = 'idle';
  }, [conversationId]);

  useEffect(() => {
    if (!workspace.resultPanelOpen || !conversationId) return;

    if (
      workspace.sandboxTab === 'files'
      && !workspace.fileTree
      && filesAttempt.current === 'idle'
    ) {
      filesAttempt.current = 'pending';
      workspace.setFilesLoading(true);
      void refreshSnapshot(conversationId, { includePreview: false }).then((result) => {
        filesAttempt.current = result?.ok ? 'done' : 'idle';
      }).catch(() => {
        filesAttempt.current = 'idle';
      }).finally(() => {
        workspace.setFilesLoading(false);
      });
    }

    // A URL minted by this visit (preview_ready) is already live. A stored URL
    // from an earlier visit is not, so the first time the tab opens we boot —
    // but only for a conversation that actually published one. Without that
    // gate, merely opening the tab booted a sandbox and a dev server for a
    // project whose agent had never asked for a preview, and the panel showed
    // "restoring" for work nobody requested.
    if (
      workspace.hasPublishedPreview
      && workspace.sandboxTab === 'preview'
      && previewAttempt.current === 'idle'
      && previewApi.current.previewRefreshedAtRef.current === 0
    ) {
      previewAttempt.current = 'pending';
      workspace.setPreviewLoading(true);
      void fetchPreviewRefresh(conversationId).then((data) => {
        if (data?.ok && data.preview?.url) {
          previewApi.current.activatePreview(data.preview, previewRevisions.current);
          previewAttempt.current = 'done';
          return;
        }
        if (data?.preview?.error) {
          previewApi.current.setPreview({ error: data.preview.error });
        }
        previewAttempt.current = 'idle';
      }).catch(() => {
        previewAttempt.current = 'idle';
      }).finally(() => {
        workspace.setPreviewLoading(false);
      });
    }
  }, [
    conversationId,
    refreshSnapshot,
    workspace.fileTree,
    workspace.hasPublishedPreview,
    workspace.resultPanelOpen,
    workspace.sandboxTab,
    workspace.setFilesLoading,
    workspace.setPreviewLoading,
  ]);
}
