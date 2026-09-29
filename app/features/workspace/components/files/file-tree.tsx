'use client';

import { ChevronRight, FileCode2, Folder, FolderOpen } from 'lucide-react';
import type { FileCopy } from '@/app/i18n';
import type { FileTree } from '@/app/types/workspace';
import { makersFileSemantic } from '../../../../../shared/makers-file-semantics';

export function FileTreeList({
  tree,
  collapsedDirs,
  selectedPath,
  copy,
  onToggleDirectory,
  onOpenFile,
  className = '',
}: {
  tree: FileTree;
  collapsedDirs: Set<string>;
  selectedPath: string | null;
  copy: FileCopy;
  onToggleDirectory: (path: string) => void;
  onOpenFile: (path: string) => void;
  className?: string;
}) {
  const visibleItems = tree.items.filter((item) => {
    for (const collapsedPath of collapsedDirs) {
      if (item.path !== collapsedPath && item.path.startsWith(`${collapsedPath}/`)) {
        return false;
      }
    }
    return true;
  });

  return (
    <aside className={`flex min-h-0 flex-col border-r border-[var(--border)] bg-[var(--code-rail)] ${className}`}>
      <div className="min-h-0 flex-1 overflow-auto px-2 py-2.5">
        <div className="flex h-8 items-center px-2 text-[11px] font-semibold text-[var(--n-700)]">
          {copy.projectFiles}
        </div>
        <div className="flex flex-col gap-px text-[12px] leading-5">
          {visibleItems.map((item) => {
            const isDirectory = item.type === 'directory';
            const isCollapsed = collapsedDirs.has(item.path);
            const isSelected = !isDirectory && selectedPath === item.path;
            const semantic = makersFileSemantic(item);
            const capabilityLabel = semantic
              ? copy.capabilities[semantic.capability]
              : '';
            const semanticTitle = semantic
              ? [
                  capabilityLabel,
                  semantic.route ? copy.route(semantic.route) : '',
                ].filter(Boolean).join(' · ')
              : '';

            return (
              <button
                key={item.path}
                type="button"
                onClick={() => {
                  if (isDirectory) {
                    onToggleDirectory(item.path);
                  } else {
                    onOpenFile(item.path);
                  }
                }}
                className={`group relative flex min-h-7 w-full min-w-0 items-center gap-1.5 rounded-[5px] py-1 pr-2 text-left transition-colors ${
                  isSelected
                    ? 'bg-[var(--cap-agent-soft)] font-medium text-[var(--code-selected-text)]'
                    : 'text-[var(--n-700)] hover:bg-[var(--secondary)] hover:text-[var(--n-900)]'
                }`}
                style={{ paddingLeft: `${7 + item.depth * 16}px` }}
                title={semanticTitle || item.path}
              >
                {isDirectory ? (
                  <>
                    <ChevronRight className={`size-3 shrink-0 text-[var(--n-500)] transition-transform ${isCollapsed ? '' : 'rotate-90'}`} aria-hidden="true" />
                    {isCollapsed ? <Folder className="size-3.5 shrink-0 text-[var(--code-icon-folder)]" /> : <FolderOpen className="size-3.5 shrink-0 text-[var(--code-icon-folder-open)]" />}
                  </>
                ) : (
                  <>
                    <span className="size-3 shrink-0" aria-hidden="true" />
                    <FileCode2 className={`size-3.5 shrink-0 ${isSelected ? 'text-[var(--brand)]' : 'text-[var(--code-icon)]'}`} aria-hidden="true" />
                  </>
                )}
                <span className="flex min-w-0 flex-1 flex-col justify-center">
                  <span className="flex min-w-0 items-center gap-1">
                    <span className="truncate">{item.name}</span>
                    {semantic ? (
                      <span
                        className="capability-badge"
                        data-capability={semantic.capability}
                        aria-label={capabilityLabel}
                      >
                        {semantic.badge}
                      </span>
                    ) : null}
                  </span>
                  {semantic?.route ? (
                    <span className="truncate font-mono text-[9px] font-normal leading-3 text-[var(--code-subtle)]">
                      {copy.route(semantic.route)}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
