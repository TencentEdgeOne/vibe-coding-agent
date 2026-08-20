import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('the page itself never scrolls, in any workspace state', async () => {
  const css = await readFile('app/globals.css', 'utf8');
  const screen = await readFile('app/features/workspace/workspace-screen.tsx', 'utf8');

  assert.match(css, /html,\nbody \{[^}]*height: 100%;[^}]*overflow: hidden;/);
  assert.match(css, /\.app-shell \{[^}]*height: 100dvh;[^}]*overflow: hidden;/);
  assert.match(css, /\.home-stage \{[^}]*overflow-y: auto;/);
  assert.doesNotMatch(screen, /min-h-screen|h-screen/);
});

test('scroll containers are containing blocks, so sr-only labels cannot stretch the page', async () => {
  const css = await readFile('app/globals.css', 'utf8');

  assert.match(css, /\.conversation-scroll \{[^}]*position: relative;/);
  assert.match(css, /\.tool-activity-trigger \{[^}]*position: relative;/);
});

test('the stacked workspace fits one viewport instead of scrolling past its panes', async () => {
  const css = await readFile('app/globals.css', 'utf8');
  const stacked = css.slice(css.indexOf('@media (max-width: 900px)'));

  assert.doesNotMatch(stacked, /52vh/);
  assert.doesNotMatch(stacked, /70vh/);
  assert.match(stacked, /\.workspace-shell \{[^}]*overflow: hidden;/);
  assert.match(stacked, /flex: 1 1 45%/);
  assert.match(stacked, /flex: 1 1 55%/);
});

test('the landing hero centers without clipping its own top', async () => {
  const stage = await readFile('app/features/workspace/components/home-stage.tsx', 'utf8');

  assert.doesNotMatch(stage, /home-stage[^"]*justify-center/);
  assert.match(stage, /className="my-auto w-full max-w-\[820px\]"/);
});
