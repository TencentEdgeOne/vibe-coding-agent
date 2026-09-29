import assert from 'node:assert/strict';
import test from 'node:test';
import { previewRoutesFromFileTree } from '../shared/preview-routes.ts';
import type { FileTreeItem } from '../shared/protocol.ts';
import { createProjectState } from '../agents/_lib/project/state.ts';
import { clearPreview, publishPreview } from '../agents/_lib/project/workspace-store.ts';

function files(...paths: string[]): FileTreeItem[] {
  return paths.map((path) => ({
    path,
    name: path.split('/').pop() || path,
    type: 'file' as const,
    depth: path.split('/').length - 1,
  }));
}

test('Next.js App Router pages become routes, route groups collapse', () => {
  const routes = previewRoutesFromFileTree(files(
    'app/page.tsx',
    'app/about/page.tsx',
    'app/(marketing)/pricing/page.tsx',
    'app/blog/[slug]/page.tsx',
  ));
  assert.deepEqual(routes.map((route) => route.path), ['/', '/about', '/pricing']);
});

test('Next.js Pages Router pages become routes and api/ is excluded', () => {
  const routes = previewRoutesFromFileTree(files(
    'pages/index.tsx',
    'pages/about.tsx',
    'pages/blog/first.tsx',
    'pages/api/hello.ts',
  ));
  assert.deepEqual(routes.map((route) => route.path), ['/', '/about', '/blog/first']);
});

test('other framework page conventions are recognized', () => {
  assert.deepEqual(
    previewRoutesFromFileTree(files('src/routes/+page.svelte', 'src/routes/about/+page.svelte'))
      .map((route) => route.path),
    ['/', '/about'],
  );
  assert.deepEqual(
    previewRoutesFromFileTree(files('src/pages/index.astro', 'src/pages/about.astro'))
      .map((route) => route.path),
    ['/', '/about'],
  );
  assert.deepEqual(
    previewRoutesFromFileTree(files('app/pages/index.vue', 'app/pages/about.vue'))
      .map((route) => route.path),
    ['/', '/about'],
  );
  assert.deepEqual(
    previewRoutesFromFileTree(files('pages/index/+Page.tsx', 'pages/about/+Page.tsx'))
      .map((route) => route.path),
    ['/', '/about'],
  );
});

test('dynamic and parameterized routes are skipped rather than guessed', () => {
  const routes = previewRoutesFromFileTree(files(
    'app/blog/[slug]/page.tsx',
    'src/routes/posts/$postId.tsx',
    'src/pages/[category]/index.astro',
  ));
  assert.deepEqual(routes, []);
});

test('static HTML pages are offered, but the 404 page is not', () => {
  const routes = previewRoutesFromFileTree(files(
    'index.html',
    'about.html',
    'docs/index.html',
    '404.html',
  ));
  assert.deepEqual(routes.map((route) => route.path), ['/', '/about', '/docs']);
});

// The route list rides on the preview link, so the one place that writes a
// preview decides whether an update clears it. A URL-only republish — the
// agent's own `start_preview` — must keep the list; an explicit scan replaces
// it, including with an empty result after the pages were deleted.
test('a URL-only republish keeps routes and an explicit scan replaces them', () => {
  const state = createProjectState('cid');
  publishPreview(state, {
    url: 'https://preview.example/preview/',
    kind: 'sandbox',
    routes: [{ path: '/' }, { path: '/about' }],
  });
  assert.deepEqual(state.previewRoutes, [{ path: '/' }, { path: '/about' }]);

  publishPreview(state, { url: 'https://preview.example/preview/?token=2', kind: 'sandbox' });
  assert.deepEqual(state.previewRoutes, [{ path: '/' }, { path: '/about' }]);

  publishPreview(state, { url: 'https://preview.example/preview/', kind: 'sandbox', routes: [] });
  assert.deepEqual(state.previewRoutes, []);

  clearPreview(state);
  assert.equal(state.previewRoutes, undefined);
});
