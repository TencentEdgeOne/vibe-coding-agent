'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Highlight, type PrismTheme } from 'prism-react-renderer';
import type { FileCopy } from '../i18n';
import type { FileTree, FileTreeItem } from '../types/workspace';
import type { FileContentCache } from '../hooks/use-file-content-cache';
import { getOrCreateCachedConversationId } from '../lib/conversation';
import { Spinner } from './markdown-message';

export type FilePreviewState =
  | { status: 'idle' }
  | { status: 'loading'; path: string }
  | {
      status: 'ready';
      path: string;
      content: string;
      truncated: boolean;
      size: number;
    }
  | { status: 'error'; path: string; error: string };

export type FileReadResult = {
  ok?: boolean;
  path?: string;
  content?: string;
  size?: number;
  truncated?: boolean;
  error?: string;
};

export const FILE_PREFETCH_MAX_FILES = 8;
export const FILE_PREFETCH_MAX_BYTES = 384 * 1024;
export const FILE_PREFETCH_MAX_SINGLE_BYTES = 128 * 1024;
export const PREFETCH_TEXT_EXTENSION = /\.(?:[cm]?[jt]sx?|json|css|scss|sass|html?|mdx?|ya?ml|py|go|rs|sh|vue|svelte|toml)$/i;

export function canPrefetchFile(item: FileTreeItem) {
  return (
    item.type === 'file'
    && (item.size === undefined || item.size <= FILE_PREFETCH_MAX_SINGLE_BYTES)
    && (
      PREFETCH_TEXT_EXTENSION.test(item.path)
      || /(?:^|\/)(?:dockerfile|makefile|\.env(?:\..*)?)$/i.test(item.path)
    )
  );
}

export function selectFilesToPrefetch(tree: FileTree, isCached: (path: string) => boolean) {
  const priorityPaths = [
    'package.json',
    'src/App.tsx',
    'src/App.jsx',
    'src/main.tsx',
    'src/main.jsx',
    'app/page.tsx',
    'app/layout.tsx',
    'app/globals.css',
    'index.html',
    'README.md',
  ];
  const priority = new Map(priorityPaths.map((path, index) => [path.toLowerCase(), index]));
  const candidates = tree.items
    .filter((item) => (
      canPrefetchFile(item)
      && !isCached(item.path)
    ))
    .sort((a, b) => {
      const aPriority = priority.get(a.path.toLowerCase()) ?? priorityPaths.length;
      const bPriority = priority.get(b.path.toLowerCase()) ?? priorityPaths.length;
      return aPriority - bPriority || (a.size ?? 0) - (b.size ?? 0);
    });

  const selected: string[] = [];
  let bytes = 0;
  for (const item of candidates) {
    const estimatedBytes = item.size ?? 32 * 1024;
    if (selected.length >= FILE_PREFETCH_MAX_FILES) break;
    if (bytes + estimatedBytes > FILE_PREFETCH_MAX_BYTES) continue;
    selected.push(item.path);
    bytes += estimatedBytes;
  }
  return selected;
}

export function FilesPanel({
  tree,
  refreshing,
  conversationId,
  copy,
  cache,
  focusPath = null,
}: {
  tree: FileTree | null;
  refreshing: boolean;
  conversationId: string | null;
  copy: FileCopy;
  cache: FileContentCache;
  // When set, open this file once it is present in the tree (or immediately from cache).
  focusPath?: string | null;
}) {
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(() => new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<FilePreviewState>({ status: 'idle' });
  // Track the latest requested path so slower responses cannot overwrite newer selections.
  const latestRequestRef = useRef<string | null>(null);
  const prefetchByPathRef = useRef<Map<string, Promise<void>>>(new Map());
  const focusedPathRef = useRef<string | null>(null);
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const cacheVersion = cache.version;
  const readCachedFile = cache.read;
  const writeCachedFile = cache.write;

  // Clear local file preview state when the conversation changes and the file tree root changes.
  useEffect(() => {
    setCollapsedDirs(new Set());
    setSelectedPath(null);
    setPreview({ status: 'idle' });
    latestRequestRef.current = null;
    focusedPathRef.current = null;
    prefetchByPathRef.current.clear();
  }, [tree?.root]);

  const visibleItems = useMemo(() => {
    if (!tree) {
      return [];
    }

    return tree.items.filter((item) => {
      for (const collapsedPath of collapsedDirs) {
        if (item.path !== collapsedPath && item.path.startsWith(`${collapsedPath}/`)) {
          return false;
        }
      }
      return true;
    });
  }, [collapsedDirs, tree]);

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

  const prefetchFiles = useCallback((paths: string[]) => {
    const requested = [...new Set(paths)].filter(
      (path) => !readCachedFile(path) && !prefetchByPathRef.current.has(path),
    );
    if (requested.length === 0) return Promise.resolve();

    let request: Promise<void>;
    request = (async () => {
      try {
        const headers: HeadersInit = {};
        const cid = conversationId || getOrCreateCachedConversationId();
        if (cid) {
          headers['makers-conversation-id'] = cid;
          headers['conversationId'] = cid;
        }
        const query = new URLSearchParams({ paths: requested.join(',') });
        const resp = await fetch(`/file?${query.toString()}`, { method: 'GET', headers });
        const data = (await resp.json()) as { ok?: boolean; files?: FileReadResult[] };
        if (!data.ok || !Array.isArray(data.files)) return;

        const currentItems = new Map(
          (treeRef.current?.items || [])
            .filter((item) => item.type === 'file')
            .map((item) => [item.path, item]),
        );
        for (const file of data.files) {
          if (!file.ok || !file.path || typeof file.content !== 'string') continue;
          const item = currentItems.get(file.path);
          writeCachedFile(file.path, {
            content: file.content,
            size: typeof file.size === 'number' ? file.size : file.content.length,
            truncated: Boolean(file.truncated),
            mtime: item?.mtime,
          });
        }
      } catch {
        // Prefetch is opportunistic. A click retries through the single-file path.
      }
    })().finally(() => {
      for (const path of requested) {
        if (prefetchByPathRef.current.get(path) === request) {
          prefetchByPathRef.current.delete(path);
        }
      }
    });
    for (const path of requested) {
      prefetchByPathRef.current.set(path, request);
    }
    return request;
  }, [conversationId, readCachedFile, writeCachedFile]);

  // Warm the most likely entry/config/source files whenever a new tree arrives.
  // One batch request replaces several route and sandbox round trips.
  useEffect(() => {
    if (!tree) return;
    const paths = selectFilesToPrefetch(tree, (path) => Boolean(readCachedFile(path)));
    if (paths.length > 0) void prefetchFiles(paths);
  }, [prefetchFiles, readCachedFile, tree]);

  // This only runs for files that were neither streamed nor prefetched (or whose
  // cached copy went stale). It waits for an in-flight prefetch to avoid duplicate
  // reads when the user clicks immediately after the tree appears.
  const fetchFile = useCallback(async (path: string, options: { silent?: boolean } = {}) => {
    latestRequestRef.current = path;
    if (!options.silent) {
      setPreview({ status: 'loading', path });
    }
    try {
      const pendingPrefetch = prefetchByPathRef.current.get(path);
      if (pendingPrefetch) {
        await pendingPrefetch;
        const prefetched = readCachedFile(path);
        if (prefetched) {
          if (latestRequestRef.current === path) {
            setPreview({ status: 'ready', path, ...prefetched });
          }
          return;
        }
        if (latestRequestRef.current !== path) return;
      }

      const headers: HeadersInit = {};
      const cid = conversationId || getOrCreateCachedConversationId();
      if (cid) {
        headers['makers-conversation-id'] = cid;
        headers['conversationId'] = cid;
      }
      const resp = await fetch(`/file?path=${encodeURIComponent(path)}`, {
        method: 'GET',
        headers,
      });
      const data = (await resp.json()) as FileReadResult;
      // Discard this response if the user selected another file while it was loading.
      if (latestRequestRef.current !== path) {
        return;
      }
      if (!data.ok) {
        setPreview({ status: 'error', path, error: data.error || copy.readFailed });
        return;
      }
      // No mtime yet: like streamed content, the next file listing stamps it. Doing
      // it here would risk pinning the content to a listing it does not belong to.
      const entry = {
        content: data.content || '',
        size: typeof data.size === 'number' ? data.size : 0,
        truncated: Boolean(data.truncated),
      };
      writeCachedFile(path, entry);
      setPreview({ status: 'ready', path, ...entry });
    } catch (err) {
      if (latestRequestRef.current !== path) {
        return;
      }
      setPreview({
        status: 'error',
        path,
        error: err instanceof Error ? err.message : copy.requestFailed,
      });
    }
  }, [conversationId, copy, readCachedFile, writeCachedFile]);

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

  // Open the path the parent asked for (first generated file). Prefer waiting until
  // the tree lists it so parent dirs can expand; fall back to cache-only so a
  // file_content that arrives before file_tree still shows immediately.
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
    // Ensure ancestor directories are expanded so the selection is visible in the list.
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

  // Keep the open file current. When the agent rewrites it the new text arrives in
  // the cache and swaps in silently; when the cache entry is dropped because the
  // file changed in a way we could not observe, refetch instead of leaving stale
  // code on screen.
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

  if (!tree || tree.items.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-card px-6 text-center text-muted-foreground">
        {refreshing ? (
          <>
            <Spinner />
            <p>{copy.refreshing}</p>
          </>
        ) : (
          <p>{copy.empty}</p>
        )}
      </div>
    );
  }

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[190px_minmax(0,1fr)] overflow-hidden bg-card text-secondary-foreground">
      <aside className="flex min-h-0 flex-col border-r border-[#eef0f3] bg-[#fafbfd]">
        <div className="min-h-0 flex-1 overflow-auto p-2">
          <div className="px-2 pt-1.5 pb-1 text-[10px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
            {copy.projectFiles}
          </div>
          <div className="space-y-0.5 font-mono text-[12.5px] leading-5">
            {visibleItems.map((item) => {
              const isDirectory = item.type === 'directory';
              const isCollapsed = collapsedDirs.has(item.path);
              const isSelected = !isDirectory && selectedPath === item.path;

              return (
                <button
                  key={item.path}
                  type="button"
                  onClick={() => {
                    if (isDirectory) {
                      toggleDirectory(item.path);
                    } else {
                      loadFile(item.path);
                    }
                  }}
                  onMouseEnter={() => {
                    if (canPrefetchFile(item) && !readCachedFile(item.path)) {
                      void prefetchFiles([item.path]);
                    }
                  }}
                  className={`flex w-full min-w-max items-center gap-2 rounded-[7px] px-2 py-1.5 text-left transition ${
                    isSelected
                      ? 'bg-accent font-semibold text-accent-foreground'
                      : 'text-secondary-foreground hover:bg-[#eef2f8]'
                  }`}
                  style={{ paddingLeft: `${8 + item.depth * 18}px` }}
                >
                  {isDirectory && (
                    <span className="text-muted-foreground" aria-hidden="true">
                      {isCollapsed ? '▸' : '▾'}
                    </span>
                  )}
                  <span>{item.name}</span>
                </button>
              );
            })}
          </div>
        </div>
      </aside>

      <div className="flex min-h-0 flex-col">
        <FileContentView preview={preview} copy={copy} />
      </div>
    </div>
  );
}

// Light syntax theme mirroring the GitHub-light tokens in plan/design-mockup.html
// (tok-kw #cf222e, tok-fn #8250df, tok-str #0a7d33, tok-cm #8b949e, tok-tag #116329,
// tok-num/attr #0550ae). Background stays transparent so the code surface shows through.
export const CODE_THEME: PrismTheme = {
  plain: { color: '#24292f', backgroundColor: 'transparent' },
  styles: [
    { types: ['comment', 'prolog', 'doctype', 'cdata'], style: { color: '#8b949e', fontStyle: 'italic' } },
    { types: ['punctuation'], style: { color: '#24292f' } },
    { types: ['keyword', 'operator', 'boolean', 'important', 'atrule'], style: { color: '#cf222e' } },
    { types: ['function', 'function-variable', 'method'], style: { color: '#8250df' } },
    { types: ['string', 'char', 'attr-value', 'template-string', 'regex', 'url'], style: { color: '#0a7d33' } },
    { types: ['number', 'unit'], style: { color: '#0550ae' } },
    { types: ['tag', 'selector'], style: { color: '#116329' } },
    { types: ['attr-name', 'constant', 'builtin', 'symbol'], style: { color: '#0550ae' } },
    { types: ['class-name', 'maybe-class-name'], style: { color: '#953800' } },
    { types: ['property', 'variable', 'parameter'], style: { color: '#24292f' } },
    { types: ['deleted'], style: { color: '#cf222e' } },
    { types: ['inserted'], style: { color: '#0a7d33' } },
  ],
};

// Map a file path to a Prism language. Unknown extensions fall back to plain text
// (Prism renders a single token, so the file still shows uncolored but intact).
export function prismLanguage(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'ts':
      return 'typescript';
    case 'tsx':
      return 'tsx';
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'jsx':
      return 'jsx';
    case 'json':
      return 'json';
    case 'css':
      return 'css';
    case 'scss':
    case 'sass':
      return 'scss';
    case 'html':
    case 'htm':
    case 'xml':
    case 'svg':
    case 'vue':
      return 'markup';
    case 'md':
    case 'mdx':
    case 'markdown':
      return 'markdown';
    case 'py':
      return 'python';
    case 'sh':
    case 'bash':
    case 'zsh':
      return 'bash';
    case 'yml':
    case 'yaml':
      return 'yaml';
    case 'go':
      return 'go';
    case 'rs':
      return 'rust';
    default:
      return 'tsx';
  }
}

export function FileContentView({ preview, copy }: { preview: FilePreviewState; copy: FileCopy }) {
  if (preview.status === 'idle') {
    return (
      <div className="flex h-full min-h-0 items-center justify-center px-6 text-center text-muted-foreground">
        {copy.selectFile}
      </div>
    );
  }
  if (preview.status === 'loading') {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-2 border-b border-border bg-[#fafbfd] px-4 py-3 text-xs text-primary">
          <Spinner />
          <span className="truncate font-mono text-[11px] text-muted-foreground">
            {copy.loading(preview.path)}
          </span>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      </div>
    );
  }
  if (preview.status === 'error') {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="border-b border-border bg-[#fafbfd] px-4 py-3">
          <p className="truncate font-mono text-[11px] text-muted-foreground">{preview.path}</p>
        </div>
        <div className="flex flex-1 items-center justify-center px-6 text-center text-destructive">
          {preview.error}
        </div>
      </div>
    );
  }

  const lines = preview.content.split('\n');
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-[#fafbfd] px-4 py-3">
        <p className="min-w-0 truncate font-mono text-[11px] text-secondary-foreground">
          {preview.path}
        </p>
        <div className="flex shrink-0 items-center gap-2 font-mono text-[11px] text-muted-foreground">
          <span>{copy.lines(lines.length)}</span>
          <span>{formatFileSize(preview.size)}</span>
          {preview.truncated && (
            <span className="rounded-full bg-[color-mix(in_srgb,var(--gold)_15%,transparent)] px-2 py-0.5 text-[var(--gold)]">
              {copy.truncated}
            </span>
          )}
        </div>
      </div>
      <Highlight code={preview.content} language={prismLanguage(preview.path)} theme={CODE_THEME}>
        {({ tokens, getTokenProps }) => (
          <pre className="min-h-0 flex-1 overflow-auto bg-white py-3 font-mono text-[12px] leading-5 text-foreground">
            <code>
              {tokens.map((line, lineIndex) => (
                <span
                  key={lineIndex}
                  className="grid min-w-max grid-cols-[3.5rem_minmax(0,1fr)] gap-3 px-4"
                >
                  <span className="select-none text-right text-muted-foreground/60">
                    {lineIndex + 1}
                  </span>
                  <span className="whitespace-pre">
                    {line.map((token, key) => (
                      <span key={key} {...getTokenProps({ token })} />
                    ))}
                  </span>
                </span>
              ))}
            </code>
          </pre>
        )}
      </Highlight>
    </div>
  );
}

export function formatFileSize(bytes: number): string {
  if (!bytes || bytes < 1024) return `${bytes || 0} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}
