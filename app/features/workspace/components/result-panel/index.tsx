'use client';

import type { FileCopy, SessionCopy, UiCopy } from '@/app/i18n';
import type { FileContentCache } from '@/app/hooks/use-file-content-cache';
import type { PreviewFrameCopy } from '../preview-frame';
import type { PreviewAddressCopy } from '../preview-address-bar';
import { WorkspaceErrorBar } from '../workspace-error-bar';
import { SessionPanel } from '../lazy-panels';
import type { PreviewSurfaceApi } from '../../hooks/use-preview-surface';
import type { WorkspaceStateApi } from '../../hooks/use-workspace-state';
import { FilesPane } from './files-pane';
import { PreviewPane } from './preview-pane';
import { ResultPanelTopbar, SHOW_SESSION_TAB } from './result-panel-topbar';

export { ResultPanelToggle } from './result-panel-toggle';
export { SHOW_SESSION_TAB };

export function ResultPanel({
  presence,
  onExited,
  workspace,
  preview,
  t,
  previewDisplayPath,
  previewAddressCopy,
  deployHint,
  downloadHint,
  canDeployProject,
  publishing,
  conversationId,
  previewFrameCopy,
  restoring,
  cache,
  loading,
  handleDeployProject,
}: {
  presence: 'entering' | 'exiting';
  onExited: () => void;
  workspace: WorkspaceStateApi;
  preview: PreviewSurfaceApi;
  t: UiCopy;
  previewDisplayPath: string;
  previewAddressCopy: PreviewAddressCopy;
  deployHint: string;
  downloadHint: string;
  canDeployProject: boolean;
  publishing: boolean;
  conversationId: string | null;
  previewFrameCopy: PreviewFrameCopy;
  restoring: boolean;
  cache: FileContentCache;
  loading: boolean;
  handleDeployProject: () => void;
}) {
  const filesCopy: FileCopy = t.files;
  const sessionCopy: SessionCopy = t.session;

  return (
    <div
      id="workspace-result-panel"
      className="workspace-result-panel"
      data-presence={presence}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget && presence === 'exiting') {
          onExited();
        }
      }}
    >
      <ResultPanelTopbar
        workspace={workspace}
        preview={preview}
        t={t}
        copy={{
          preview: t.workspace.preview,
          code: t.workspace.code,
          session: t.workspace.session,
          showPanel: t.workspace.showPanel,
          hidePanel: t.workspace.hidePanel,
        }}
        previewDisplayPath={previewDisplayPath}
        previewAddressCopy={previewAddressCopy}
        deployHint={deployHint}
        downloadHint={downloadHint}
        canDeployProject={canDeployProject}
        publishing={publishing}
        conversationId={conversationId}
        handleDeployProject={handleDeployProject}
      />

      <div className="workspace-panel-content">
        {!workspace.sandboxTab && (
          <div className="workspace-empty-state">
            <p>{t.workspace.choosePanel}</p>
          </div>
        )}
        <PreviewPane
          workspace={workspace}
          preview={preview}
          restoring={restoring}
          restoringLabel={t.workspace.restoringWorkspace}
          previewStarting={t.workspace.previewStarting}
          previewEmpty={t.workspace.previewEmpty}
          constructionDisclaimer={t.workspace.constructionDisclaimer}
          previewFrameCopy={previewFrameCopy}
        />
        <FilesPane
          workspace={workspace}
          conversationId={conversationId}
          copy={filesCopy}
          cache={cache}
        />
        {SHOW_SESSION_TAB && workspace.sandboxTab === 'session' && (
          <div className="workspace-panel-pane">
            <SessionPanel
              conversationId={conversationId}
              live={loading}
              copy={sessionCopy}
            />
          </div>
        )}
      </div>

      <WorkspaceErrorBar
        build={workspace.build?.status === 'failed'
          ? (workspace.build.autoFixApplied && workspace.build.autoFixAttempts
            ? t.workspace.buildFailedAfter(workspace.build.autoFixAttempts)
            : t.workspace.buildFailedMessage)
          : ''}
        preview={preview.preview?.error ? `${t.workspace.previewError}${preview.preview.error}` : ''}
        download={workspace.download?.error ? `${t.workspace.downloadError}${workspace.download.error}` : ''}
      />
    </div>
  );
}
