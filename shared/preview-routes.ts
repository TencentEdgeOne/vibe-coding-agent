/**
 * Frontend routes a generated project serves, derived from its file tree.
 *
 * The preview panel cannot read the iframe's history cross-origin, and the
 * tracker only reports the route already on screen. This is the other half:
 * a small, conservative list of the page routes the project declared, so the
 * address bar can offer route switching without inventing URLs.
 *
 * Keep this runtime-agnostic — the agent embeds the result in preview payloads
 * and the browser renders it. Dynamic segments are skipped rather than guessed:
 * a `[id]` route has no single address to offer, and showing one that 404s is
 * worse than showing nothing.
 */
import type { FileTreeItem } from './protocol.ts';

const NEXT_EXTENSIONS = new Set([
  'js',
  'jsx',
  'md',
  'mdx',
  'ts',
  'tsx',
]);

const PAGE_EXTENSIONS = new Set([
  ...NEXT_EXTENSIONS,
  'astro',
  'svelte',
  'vue',
]);

const MAX_PREVIEW_ROUTES = 80;

type RouteRule = {
  /** Lower runs first and wins a duplicate route. */
  priority: number;
  match: (path: string) => boolean;
  toPath: (path: string) => string | undefined;
};

function splitExtension(path: string) {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  if (dot <= slash) return null;
  return {
    stem: path.slice(0, dot),
    extension: path.slice(dot + 1).toLowerCase(),
  };
}

function isPageExtension(extension: string) {
  return PAGE_EXTENSIONS.has(extension);
}

function isNextExtension(extension: string) {
  return NEXT_EXTENSIONS.has(extension);
}

/** Dynamic and catch-all segments need parameters, so they cannot be offered. */
function isDynamicSegment(segment: string) {
  return segment.startsWith('[')
    || segment.startsWith('$')
    || segment.startsWith(':')
    || (segment.startsWith('<') && segment.endsWith('>'));
}

function routeFromSegments(
  segments: string[],
  options: { dropRouteGroups?: boolean } = {},
) {
  const parts: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === 'index') continue;
    if (options.dropRouteGroups && /^\(.+\)$/.test(segment)) continue;
    if (isDynamicSegment(segment)) return undefined;
    if (segment.startsWith('_') || segment.startsWith('+')) continue;
    parts.push(segment);
  }
  return parts.length > 0 ? `/${parts.join('/')}` : '/';
}

function nextAppRoute(path: string) {
  for (const root of ['app', 'src/app']) {
    if (!path.startsWith(`${root}/`)) continue;
    const split = path.lastIndexOf('.');
    if (split < 0) continue;
    const extension = path.slice(split + 1).toLowerCase();
    if (!isNextExtension(extension)) continue;
    const stem = path.slice(0, split);
    if (!stem.endsWith('/page')) continue;
    const routeSegments = stem
      .slice(root.length + 1, -'/page'.length)
      .split('/')
      .filter(Boolean);
    return routeFromSegments(routeSegments, { dropRouteGroups: true });
  }
  return undefined;
}

function nextPagesRoute(path: string) {
  for (const root of ['pages', 'src/pages']) {
    if (!path.startsWith(`${root}/`)) continue;
    const split = splitExtension(path);
    if (!split || !isNextExtension(split.extension)) continue;
    const relative = split.stem.slice(root.length + 1);
    const segments = relative.split('/').filter(Boolean);
    const last = segments.at(-1);
    if (!last || last.startsWith('_')) return undefined;
    if (segments[0] === 'api') return undefined;
    return routeFromSegments(segments);
  }
  return undefined;
}

function nuxtRoute(path: string) {
  for (const root of ['pages', 'app/pages']) {
    if (!path.startsWith(`${root}/`)) continue;
    const split = splitExtension(path);
    if (!split || split.extension !== 'vue') continue;
    return routeFromSegments(split.stem.slice(root.length + 1).split('/'));
  }
  return undefined;
}

function svelteKitRoute(path: string) {
  const split = splitExtension(path);
  if (!split || !path.startsWith('src/routes/')) return undefined;
  if (!split.stem.endsWith('+page')) return undefined;
  if (!isPageExtension(split.extension)) return undefined;
  const relative = split.stem.slice('src/routes/'.length, -'+page'.length);
  return routeFromSegments(relative.split('/').filter(Boolean));
}

function astroRoute(path: string) {
  if (!path.startsWith('src/pages/')) return undefined;
  const split = splitExtension(path);
  if (!split || !['astro', 'md', 'mdx'].includes(split.extension)) return undefined;
  const segments = split.stem.slice('src/pages/'.length).split('/').filter(Boolean);
  if (segments.some((segment) => segment === '404' || segment.startsWith('_'))) {
    return undefined;
  }
  return routeFromSegments(segments);
}

function tanStackRoute(path: string) {
  if (!path.startsWith('src/routes/')) return undefined;
  const split = splitExtension(path);
  if (!split || !isPageExtension(split.extension)) return undefined;
  const relative = split.stem.slice('src/routes/'.length);
  const segments = relative.split('/').filter(Boolean);
  if (segments.some((segment) => segment.startsWith('__') || segment.startsWith('-'))) {
    return undefined;
  }
  if (segments[0] === 'api') return undefined;
  return routeFromSegments(segments);
}

function reactRouterRoute(path: string) {
  if (!path.startsWith('app/routes/')) return undefined;
  const split = splitExtension(path);
  if (!split || !isPageExtension(split.extension)) return undefined;
  const flat = split.stem.slice('app/routes/'.length);
  const segments = flat
    .split('.')
    .flatMap((segment) => segment.split('/'))
    .filter(Boolean);
  if (segments[0] === 'api') return undefined;
  return routeFromSegments(segments);
}

function vikeRoute(path: string) {
  if (!path.startsWith('pages/')) return undefined;
  const split = splitExtension(path);
  if (!split || !split.stem.endsWith('+Page')) return undefined;
  if (!isPageExtension(split.extension)) return undefined;
  const relative = split.stem.slice('pages/'.length, -'+Page'.length);
  const segments = relative.split('/').filter(Boolean);
  if (segments.some((segment) => segment.startsWith('_') || segment.startsWith('@'))) {
    return undefined;
  }
  return routeFromSegments(segments);
}

function staticHtmlRoute(path: string) {
  const split = splitExtension(path);
  if (!split || split.extension !== 'html') return undefined;
  const segments = split.stem.split('/').filter(Boolean);
  const last = segments.at(-1);
  if (!last || last === '404') return undefined;
  if (last === 'index') segments.pop();
  return routeFromSegments(segments);
}

const ROUTE_RULES: RouteRule[] = [
  {
    priority: 0,
    match: (path) => /^(?:src\/)?app\/(?:.+\/)?page\.[^.]+$/.test(path),
    toPath: nextAppRoute,
  },
  {
    priority: 0,
    match: (path) => /^(?:src\/)?pages\//.test(path),
    toPath: nextPagesRoute,
  },
  {
    priority: 1,
    match: (path) => /^(?:app\/)?pages\/.+\.vue$/.test(path),
    toPath: nuxtRoute,
  },
  {
    priority: 0,
    match: (path) => path.startsWith('src/routes/') && path.includes('+page.'),
    toPath: svelteKitRoute,
  },
  {
    priority: 1,
    match: (path) => path.startsWith('src/pages/'),
    toPath: astroRoute,
  },
  {
    priority: 2,
    match: (path) => path.startsWith('src/routes/'),
    toPath: tanStackRoute,
  },
  {
    priority: 2,
    match: (path) => path.startsWith('app/routes/'),
    toPath: reactRouterRoute,
  },
  {
    priority: 1,
    match: (path) => path.startsWith('pages/') && path.includes('+Page.'),
    toPath: vikeRoute,
  },
  {
    priority: 3,
    match: (path) => /\.html$/.test(path),
    toPath: staticHtmlRoute,
  },
];

function routeFromFile(path: string) {
  for (const rule of ROUTE_RULES) {
    if (!rule.match(path)) continue;
    const route = rule.toPath(path);
    if (route) return { path: route, priority: rule.priority };
  }
  return undefined;
}

export function previewRoutesFromFileTree(items: readonly FileTreeItem[]) {
  const byPath = new Map<string, number>();
  for (const item of items) {
    if (item.type !== 'file') continue;
    const candidate = routeFromFile(item.path);
    if (!candidate) continue;
    const existing = byPath.get(candidate.path);
    if (existing == null || candidate.priority < existing) {
      byPath.set(candidate.path, candidate.priority);
    }
  }
  return [...byPath.keys()]
    .sort((left, right) => {
      if (left === right) return 0;
      if (left === '/') return -1;
      if (right === '/') return 1;
      return left.localeCompare(right);
    })
    .slice(0, MAX_PREVIEW_ROUTES)
    .map((path) => ({ path }));
}
