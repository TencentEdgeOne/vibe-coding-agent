'use client';

import { PreviewFrame, type PreviewFrameCopy } from '../preview-frame';
import type { PreviewSurfaceApi } from '../../hooks/use-preview-surface';
import type { WorkspaceStateApi } from '../../hooks/use-workspace-state';

export function PreviewPane({
  workspace,
  preview,
  restoring,
  restoringLabel,
  previewStarting,
  previewEmpty,
  constructionDisclaimer,
  previewFrameCopy,
}: {
  workspace: WorkspaceStateApi;
  preview: PreviewSurfaceApi;
  restoring: boolean;
  restoringLabel: string;
  previewStarting: string;
  previewEmpty: string;
  constructionDisclaimer: string;
  previewFrameCopy: PreviewFrameCopy;
}) {
  return (
    <div className={`workspace-panel-pane ${workspace.sandboxTab === 'preview' ? '' : 'is-hidden'}`}>
      {preview.preview?.url ? (
        <PreviewFrame
          activeSlot={preview.activePreviewSlot}
          activeUrl={preview.activePreviewUrl}
          activeRevision={preview.activePreviewRevision}
          pendingUrl={preview.pendingPreviewUrl}
          pendingRevision={preview.pendingPreviewRevision}
          viewport={preview.previewViewport}
          loaded={preview.activePreviewLoaded}
          refreshFailed={preview.previewRefreshFailed}
          copy={previewFrameCopy}
          onActiveLoad={preview.handleActivePreviewLoad}
          onPendingLoad={preview.handlePendingPreviewLoad}
          onRetry={preview.handleRefreshPreview}
        />
      ) : (
        <div className="workspace-empty-state">
          {restoring ? (
            <>
              <span
                className="size-8 animate-spin rounded-full border-2 border-primary/30 border-t-primary"
                aria-hidden="true"
              />
              <p>{restoringLabel}</p>
              <p className="max-w-xl text-xs leading-5 text-muted-foreground">
                {previewStarting}
              </p>
            </>
          ) : (
            <>
              <p>{previewEmpty}</p>
              <p className="workspace-empty-disclaimer">
                {constructionDisclaimer}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
