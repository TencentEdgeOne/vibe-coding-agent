import assert from 'node:assert/strict';
import test from 'node:test';
import JSZip from 'jszip';
import {
  rewritePreviewPathsForPublish,
  rewritePublishZip,
} from '../agents/project/_publish-rewrite.ts';

test('vite base /preview/ is rewritten to site root for Pages publish', () => {
  const source = [
    'import { defineConfig } from "vite";',
    'import react from "@vitejs/plugin-react";',
    'export default defineConfig({',
    "  base: '/preview/',",
    '  plugins: [react()],',
    '});',
    '',
  ].join('\n');

  const rewritten = rewritePreviewPathsForPublish(source, 'vite.config.ts');
  assert.ok(rewritten.includes("base: '/'"));
  assert.equal(rewritten.includes('/preview'), false);
});

test('built index.html asset URLs lose the sandbox /preview/ prefix', () => {
  const html = [
    '<!doctype html>',
    '<title>Todolist</title>',
    '<script type="module" crossorigin src="/preview/assets/index-CKzTfBPw.js"></script>',
    '<link rel="stylesheet" crossorigin href="/preview/assets/index-C4JxE7Dt.css">',
    '',
  ].join('\n');

  const rewritten = rewritePreviewPathsForPublish(html, 'index.html');
  assert.ok(rewritten.includes('src="/assets/index-CKzTfBPw.js"'));
  assert.ok(rewritten.includes('href="/assets/index-C4JxE7Dt.css"'));
  assert.equal(rewritten.includes('/preview/'), false);
});

test('next basePath /preview is cleared rather than set to slash', () => {
  const source = "const config = { basePath: '/preview' };";
  const rewritten = rewritePreviewPathsForPublish(source, 'next.config.mjs');
  assert.ok(rewritten.includes("basePath: ''"));
  assert.equal(rewritten.includes('/preview'), false);
});

test('rewritePublishZip patches vite.config inside a zip', async () => {
  const zip = new JSZip();
  zip.file('vite.config.ts', "export default { base: '/preview/' };\n");
  zip.file('src/App.tsx', 'export default function App() { return <div />; }\n');
  const input = await zip.generateAsync({ type: 'uint8array' });

  const output = await rewritePublishZip(input);
  const loaded = await JSZip.loadAsync(output);
  const config = await loaded.file('vite.config.ts')?.async('string');
  assert.equal(config, "export default { base: '/' };\n");
});

test('agent prompt does not tell Vite projects to hard-code the sandbox preview base', async () => {
  const { readFile } = await import('node:fs/promises');
  const agent = await readFile(new URL('../agents/_agent.ts', import.meta.url), 'utf8');
  assert.match(agent, /Do not hard-code base/);
  assert.equal(agent.includes('use base ${PREVIEW_PATH_PREFIX}'), false);
});
