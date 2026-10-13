'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import type { FileTree } from '../types/workspace';

type FileCacheEntry = {
  content: string;
  size: number;
  truncated: boolean;
  // The tree mtime this content belongs to. `undefined` means the content was just
  // streamed from a write and is waiting for the next file_tree to stamp it.
  mtime?: number;
};

// Remembers a file after the user opens it, so opening it again does not cost a
// /file request. A later write drops that path; the next click reads it again.
// The sandbox mtime/size reported by the file tree decides when an entry is still good.
export function useFileContentCache() {
  const cacheRef = useRef<Map<string, FileCacheEntry>>(new Map());
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((current) => current + 1), []);

  const read = useCallback((path: string) => cacheRef.current.get(path), []);

  const write = useCallback((path: string, entry: FileCacheEntry) => {
    cacheRef.current.set(path, entry);
    bump();
  }, [bump]);

  const clear = useCallback(() => {
    if (cacheRef.current.size === 0) return;
    cacheRef.current.clear();
    bump();
  }, [bump]);

  const forget = useCallback((paths: string[]) => {
    const cache = cacheRef.current;
    let changed = false;
    for (const path of paths) {
      if (cache.delete(path)) changed = true;
    }
    if (changed) bump();
  }, [bump]);

  const reconcile = useCallback((tree: FileTree | null) => {
    const cache = cacheRef.current;
    if (cache.size === 0) return;
    if (!tree) {
      cache.clear();
      bump();
      return;
    }

    const items = new Map(
      tree.items.filter((item) => item.type === 'file').map((item) => [item.path, item]),
    );
    let changed = false;
    for (const [path, entry] of cache) {
      const item = items.get(path);
      // Gone from the project, or the sandbox cannot report mtime/size at all
      // (busybox find) — in the latter case caching is unsafe, so drop it and let
      // clicks fall back to /file.
      if (!item || (item.mtime === undefined && item.size === undefined)) {
        cache.delete(path);
        changed = true;
        continue;
      }
      // A size mismatch means the file moved on underneath us — most likely a
      // shell command rewrote what we had just streamed.
      if (item.size !== undefined && item.size !== entry.size) {
        cache.delete(path);
        changed = true;
        continue;
      }
      if (entry.mtime === undefined) {
        cache.set(path, { ...entry, mtime: item.mtime });
        changed = true;
        continue;
      }
      if (entry.mtime !== item.mtime) {
        cache.delete(path);
        changed = true;
      }
    }
    if (changed) bump();
  }, [bump]);

  return useMemo(
    () => ({ version, read, write, clear, forget, reconcile }),
    [version, read, write, clear, forget, reconcile],
  );
}

export type FileContentCache = ReturnType<typeof useFileContentCache>;

