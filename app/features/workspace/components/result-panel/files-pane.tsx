'use client';

import type { FileCopy } from '@/app/i18n';
import type { FileContentCache } from '@/app/hooks/use-file-content-cache';
import { FilesPanel } from '../files';
import type { WorkspaceStateApi } from '../../hooks/use-workspace-state';

export function FilesPane({
  workspace,
  conversationId,
  copy,
  cache,
}: {
  workspace: WorkspaceStateApi;
  conversationId: string | null;
  copy: FileCopy;
  cache: FileContentCache;
}) {
  if (workspace.sandboxTab !== 'files') return null;
  return (
    <div className="workspace-panel-pane">
      <FilesPanel
        tree={workspace.fileTree}
        conversationId={conversationId}
        copy={copy}
        cache={cache}
        focusPath={workspace.filesFocusPath}
        loading={workspace.filesLoading}
      />
    </div>
  );
}
