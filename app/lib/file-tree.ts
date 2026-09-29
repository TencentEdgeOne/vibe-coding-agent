import type { FileTree, FileTreeItem } from '../../shared/protocol';

type FileTreeWrite = {
  path: string;
  size?: number;
};

function parentPaths(path: string) {
  const parts = path.split('/').filter(Boolean);
  return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/'));
}

/**
 * Fold files just written by the agent into the tree already on screen.
 *
 * The host used to re-list the sandbox after every quiet period and push a
 * whole `file_tree`. That read belonged to the turn, and a write that landed
 * near the end could leave the Code tab empty until a refresh. The write event
 * already names every path that changed, so the browser can add them locally.
 */
export function mergeFileTreeWrites(
  tree: FileTree | null,
  writes: readonly FileTreeWrite[],
): FileTree | null {
  if (writes.length === 0) return tree;

  const items = new Map<string, FileTreeItem>(
    (tree?.items || []).map((item) => [item.path, item]),
  );

  for (const write of writes) {
    const path = write.path.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!path) continue;

    for (const directory of parentPaths(path)) {
      const existing = items.get(directory);
      if (existing?.type === 'directory') continue;
      items.set(directory, {
        path: directory,
        name: directory.split('/').pop() || directory,
        type: 'directory',
        depth: directory.split('/').length - 1,
      });
    }

    const existing = items.get(path);
    items.set(path, {
      path,
      name: path.split('/').pop() || path,
      type: 'file',
      depth: path.split('/').length - 1,
      ...(existing?.mtime !== undefined ? { mtime: existing.mtime } : {}),
      ...(write.size !== undefined
        ? { size: write.size }
        : existing?.size !== undefined ? { size: existing.size } : {}),
    });
  }

  return {
    root: tree?.root || '',
    items: [...items.values()].sort((left, right) => {
      if (left.path === right.path) return 0;
      return left.path.localeCompare(right.path);
    }),
  };
}
