'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileCopy } from '@/app/i18n';
import type { FileTree } from '@/app/types/workspace';
import type { FileContentCache } from '@/app/hooks/use-file-content-cache';
import { getOrCreateCachedConversationId } from '@/app/lib/conversation';
import type { FilePreviewState } from './format';

type FileReadResult = {
  ok?: boolean;
  path?: string;
  content?: string;
  size?: number;
  truncated?: boolean;
  error?: string;
};

export function useFilePreview({
  tree,
  conversationId,
  copy,
  cache,
  focusPath = null,
}: {
  tree: FileTree | null;
  conversationId: string | null;
  copy: FileCopy;
  cache: FileContentCache;
  focusPath?: string | null;
}) {
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(() => new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<FilePreviewState>({ status: 'idle' });
  const latestRequestRef = useRef<string | null>(null);
  const inFlightRef = useRef<AbortController | null>(null);
  const focusedPathRef = useRef<string | null>(null);

  useEffect(() => () => {
    inFlightRef.current?.abort();
    inFlightRef.current = null;
  }, []);
  const cacheVersion = cache.version;
  const readCachedFile = cache.read;
  const writeCachedFile = cache.write;

  useEffect(() => {
    setCollapsedDirs(new Set());
    setSelectedPath(null);
    setPreview({ status: 'idle' });
    latestRequestRef.current = null;
    focusedPathRef.current = null;
  }, [tree?.root]);

  const fetchFile = useCallback(async (path: string, options: { silent?: boolean } = {}) => {
    latestRequestRef.current = path;
    inFlightRef.current?.abort();
    const controller = new AbortController();
    inFlightRef.current = controller;
    if (!options.silent) {
      setPreview({ status: 'loading', path });
    }
    try {
      const headers: HeadersInit = {};
      const cid = conversationId || getOrCreateCachedConversationId();
      if (cid) {
        headers['makers-conversation-id'] = cid;
        headers['conversationId'] = cid;
      }
      const resp = await fetch(`/file?path=${encodeURIComponent(path)}`, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      const data = (await resp.json()) as FileReadResult;
      if (controller.signal.aborted || latestRequestRef.current !== path) {
        return;
      }
      if (!data.ok) {
        setPreview({ status: 'error', path, error: data.error || copy.readFailed });
        return;
      }
      const entry = {
        content: data.content || '',
        size: typeof data.size === 'number' ? data.size : 0,
        truncated: Boolean(data.truncated),
      };
      writeCachedFile(path, entry);
      setPreview({ status: 'ready', path, ...entry });
    } catch (err) {
      if (controller.signal.aborted || latestRequestRef.current !== path) {
        return;
      }
      setPreview({
        status: 'error',
        path,
        error: err instanceof Error ? err.message : copy.requestFailed,
      });
    } finally {
      if (inFlightRef.current === controller) {
        inFlightRef.current = null;
      }
    }
  }, [conversationId, copy, writeCachedFile]);

  const loadFile = useCallback((path: string) => {
    setSelectedPath(path);
    const cached = readCachedFile(path);
    if (cached) {
      latestRequestRef.current = path;
      setPreview({
        status: 'ready',
        path,
        content: cached.content,
        truncated: cached.truncated,
        size: cached.size,
      });
      return;
    }
    void fetchFile(path);
  }, [fetchFile, readCachedFile]);

  useEffect(() => {
    if (!focusPath || focusedPathRef.current === focusPath) {
      return;
    }
    const inTree = tree?.items.some((item) => item.type === 'file' && item.path === focusPath);
    const cached = readCachedFile(focusPath);
    if (!inTree && !cached) {
      return;
    }
    focusedPathRef.current = focusPath;
    if (tree) {
      const parts = focusPath.split('/');
      if (parts.length > 1) {
        setCollapsedDirs((current) => {
          let changed = false;
          const next = new Set(current);
          for (let i = 1; i < parts.length; i += 1) {
            const dir = parts.slice(0, i).join('/');
            if (next.has(dir)) {
              next.delete(dir);
              changed = true;
            }
          }
          return changed ? next : current;
        });
      }
    }
    loadFile(focusPath);
  }, [focusPath, loadFile, readCachedFile, tree]);

  const previewStatus = preview.status;
  const previewPath = preview.status === 'idle' ? null : preview.path;
  useEffect(() => {
    const path = selectedPath;
    if (!path) return;
    const cached = readCachedFile(path);
    if (cached) {
      setPreview((current) => (
        current.status === 'ready' && current.path === path && current.content === cached.content
          ? current
          : {
            status: 'ready',
            path,
            content: cached.content,
            truncated: cached.truncated,
            size: cached.size,
          }
      ));
      return;
    }
    if (previewStatus === 'ready' && previewPath === path) {
      void fetchFile(path, { silent: true });
    }
  }, [cacheVersion, fetchFile, previewPath, previewStatus, readCachedFile, selectedPath]);

  const toggleDirectory = (path: string) => {
    setCollapsedDirs((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const closeFile = () => {
    inFlightRef.current?.abort();
    inFlightRef.current = null;
    latestRequestRef.current = null;
    focusedPathRef.current = null;
    setSelectedPath(null);
    setPreview({ status: 'idle' });
  };

  return {
    collapsedDirs,
    selectedPath,
    preview,
    loadFile,
    toggleDirectory,
    closeFile,
  };
}
