'use client';

import { Code2, Download, Eye, Rocket, ScrollText } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger } from '@/app/components/ui/tabs';
import { PreviewAddressBar, type PreviewAddressCopy } from '../preview-address-bar';
import type { UiCopy } from '@/app/i18n';
import type { PreviewSurfaceApi } from '../../hooks/use-preview-surface';
import type { SandboxTab, WorkspaceStateApi } from '../../hooks/use-workspace-state';
import { ResultPanelToggle } from './result-panel-toggle';

export const SHOW_SESSION_TAB = process.env.NODE_ENV === 'development';

export function ResultPanelTopbar({
  workspace,
  preview,
  t,
  copy,
  previewDisplayPath,
  previewAddressCopy,
  deployHint,
  downloadHint,
  canDeployProject,
  publishing,
  conversationId,
  handleDeployProject,
}: {
  workspace: WorkspaceStateApi;
  preview: PreviewSurfaceApi;
  t: UiCopy;
  copy: {
    preview: string;
    code: string;
    session: string;
    showPanel: string;
    hidePanel: string;
  };
  previewDisplayPath: string;
  previewAddressCopy: PreviewAddressCopy;
  deployHint: string;
  downloadHint: string;
  canDeployProject: boolean;
  publishing: boolean;
  conversationId: string | null;
  handleDeployProject: () => void;
}) {
  const showPreviewBar = workspace.sandboxTab === 'preview'
    && Boolean(preview.shareablePreviewUrl)
    && !preview.previewRefreshing
    && !preview.previewRefreshFailed;

  // The narrow-panel layout moves the address bar to its own row, so the flag is
  // only set when the bar is actually there — an empty second row would
  // otherwise add height to the Code and Session tabs.
  return (
    <div className={`workspace-topbar${showPreviewBar ? ' has-preview-bar' : ''}`}>
      <div className="workspace-topbar-tabs">
        <ResultPanelToggle
          open
          showLabel={copy.showPanel}
          hideLabel={copy.hidePanel}
          onToggle={() => workspace.setResultPanelOpen(false)}
        />
        <Tabs
          value={workspace.sandboxTab ?? ''}
          onValueChange={(value) => workspace.setSandboxTab(value as SandboxTab)}
          className="workspace-topbar-tablist"
        >
          <TabsList className="workspace-tabs">
            <TabsTrigger value="preview" className="workspace-tab">
              <Eye />
              {/* The outer box owns the animation and the inner one clips. An
                  animatable grid track is what lets an auto-width label open
                  and close over one fixed duration in both directions. */}
              <span className="workspace-tab-label">
                <span>{copy.preview}</span>
              </span>
            </TabsTrigger>
            {/* An icon-only tab still has to name itself, and the collapsed
                label stays in the accessibility tree — this is for the pointer. */}
            <TabsTrigger value="files" className="workspace-tab" title={copy.code}>
              <Code2 />
              <span className="workspace-tab-label">
                <span>{copy.code}</span>
              </span>
            </TabsTrigger>
            {SHOW_SESSION_TAB && (
              <TabsTrigger value="session" className="workspace-tab" title={copy.session}>
                <ScrollText />
                <span className="workspace-tab-label">
                  <span>{copy.session}</span>
                </span>
              </TabsTrigger>
            )}
          </TabsList>
        </Tabs>
      </div>

      <div className="workspace-topbar-center">
        {showPreviewBar && (
          <PreviewAddressBar
            displayPath={previewDisplayPath}
            routes={preview.previewRoutes}
            viewport={preview.previewViewport}
            publishing={publishing}
            navigating={preview.previewNavigating}
            canGoBack={preview.previewCanGoBack}
            canGoForward={preview.previewCanGoForward}
            copy={previewAddressCopy}
            onSelectRoute={preview.handlePreviewRouteSelect}
            onBack={preview.handlePreviewBack}
            onForward={preview.handlePreviewForward}
            onToggleViewport={() => preview.setPreviewViewport(
              preview.previewViewport === 'desktop' ? 'mobile' : 'desktop',
            )}
            onOpen={preview.handleOpenPreview}
            onRefresh={preview.handleRefreshPreview}
          />
        )}
      </div>

      <div className="workspace-topbar-actions">
        <div className="workspace-topbar-group">
          <button
            type="button"
            onClick={handleDeployProject}
            disabled={!canDeployProject}
            className="workspace-icon-button is-publish"
            aria-label={deployHint}
            data-tooltip={deployHint}
          >
            <Rocket className="size-3.5" />
          </button>
          {/* Download ships the source, and the source is what the Code tab is
              showing — the button has nothing to belong to on Preview. */}
          {workspace.sandboxTab === 'files' && (
            <button
              type="button"
              onClick={() => void workspace.handleDownload(conversationId, t.workspace.downloadFailed)}
              disabled={workspace.downloadBusy || !workspace.download?.url}
              className="workspace-icon-button"
              aria-label={downloadHint}
              data-tooltip={downloadHint}
            >
              {workspace.downloadBusy
                ? <span className="workspace-icon-spinner" />
                : <Download className="size-3.5" />}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
