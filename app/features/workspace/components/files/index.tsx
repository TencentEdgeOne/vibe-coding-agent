'use client';

import { memo } from 'react';
import type { FileCopy } from '@/app/i18n';
import type { FileTree } from '@/app/types/workspace';
import type { FileContentCache } from '@/app/hooks/use-file-content-cache';
import { FileContentView } from './file-content-view';
import { FileTreeList } from './file-tree';
import { useFilePreview } from './use-file-preview';

export const FilesPanel = memo(function FilesPanel({
  tree,
  conversationId,
  copy,
  cache,
  focusPath = null,
  loading = false,
}: {
  tree: FileTree | null;
  conversationId: string | null;
  copy: FileCopy;
  cache: FileContentCache;
  focusPath?: string | null;
  loading?: boolean;
}) {
  const {
    collapsedDirs,
    selectedPath,
    preview,
    loadFile,
    toggleDirectory,
    closeFile,
  } = useFilePreview({
    tree,
    conversationId,
    copy,
    cache,
    focusPath,
  });

  if (loading && (!tree || tree.items.length === 0)) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-card px-6 text-center text-muted-foreground">
        <span className="size-8 animate-spin rounded-full border-2 border-current border-t-transparent" />
        <p>{copy.loadingTree}</p>
      </div>
    );
  }

  if (!tree || tree.items.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-card px-6 text-center text-muted-foreground">
        <p>{copy.empty}</p>
      </div>
    );
  }

  const fileOpen = selectedPath !== null;

  return (
    <div className={`files-panel${fileOpen ? ' is-file-open' : ''}`}>
      <FileTreeList
        tree={tree}
        collapsedDirs={collapsedDirs}
        selectedPath={selectedPath}
        copy={copy}
        onToggleDirectory={toggleDirectory}
        onOpenFile={loadFile}
        className="files-panel-tree"
      />
      <div className="files-panel-content">
        <FileContentView
          preview={preview}
          copy={copy}
          onBack={fileOpen ? closeFile : undefined}
        />
      </div>
    </div>
  );
});
