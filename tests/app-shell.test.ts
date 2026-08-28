import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const STYLES_DIR = 'app/styles';

function withoutComments(css: string): string {
  return css.replaceAll(/\/\*[\s\S]*?\*\//g, '');
}

// The entry sheet only wires imports together; the rules live in the surface
// partials, so the invariants below are checked against all of them at once.
async function stylesheet(): Promise<string> {
  const entries = await readdir(STYLES_DIR);
  const partials = await Promise.all(
    entries
      .filter((entry) => entry.endsWith('.css'))
      .sort()
      .map((entry) => readFile(path.join(STYLES_DIR, entry), 'utf8')),
  );
  const entrySheet = await readFile('app/globals.css', 'utf8');
  return [entrySheet, ...partials].join('\n');
}

test('the page itself never scrolls, in any workspace state', async () => {
  const css = await stylesheet();
  const screen = await readFile('app/features/workspace/workspace-screen.tsx', 'utf8');

  assert.match(css, /html,\nbody \{[^}]*height: 100%;[^}]*overflow: hidden;/);
  assert.match(css, /\.app-shell \{[^}]*height: 100dvh;[^}]*overflow: hidden;/);
  assert.match(css, /\.home-stage \{[^}]*overflow-y: auto;/);
  assert.doesNotMatch(screen, /min-h-screen|h-screen/);
});

test('scroll containers are containing blocks, so sr-only labels cannot stretch the page', async () => {
  const css = await stylesheet();

  assert.match(css, /\.conversation-scroll \{[^}]*position: relative;/);
  assert.match(css, /\.tool-activity-trigger \{[^}]*position: relative;/);
});

test('the stacked workspace fits one viewport instead of scrolling past its panes', async () => {
  const css = await stylesheet();
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
  assert.match(stage, /className="home-inner my-auto"/);
});

// An action that vanishes when it is unavailable teaches nothing: the user is
// left looking for a button that was there a moment ago. Everything the
// workspace offers stays in the bar and explains itself when it cannot run.
test('workspace actions stay in place and go quiet instead of disappearing', async () => {
  const header = await readFile('app/features/workspace/components/site-header.tsx', 'utf8');

  assert.match(header, /disabled=\{downloadBusy \|\| !canDownload\}/);
  assert.doesNotMatch(header, /hasWorkspace && canDownload/);
  // A disabled button receives neither hover nor a native title, so the hint
  // has to hang off the wrapper to be readable exactly when it is needed.
  assert.match(header, /<span className="site-hint" data-hint=\{downloadHint\}>/);
  assert.doesNotMatch(header, /title=\{(downloadHint|exportHint|deployHint)\}/);
  // Leaving the project reads as going back, and lives next to the wordmark
  // rather than among the actions that operate on the project.
  const brandCluster = header.slice(
    header.indexOf('site-brand-cluster'),
    header.indexOf('site-topbar-actions'),
  );
  assert.match(brandCluster, /onClick=\{onBack\}/);
  assert.match(brandCluster, /<ArrowLeft \/>/);
});

// Tailwind emits its utilities inside @layer utilities and unlayered CSS
// outranks every layer, so the handwritten chrome never needs !important to
// win. Reintroducing one means a selector is fighting itself again.
test('surface styles override the utility layer without !important', async () => {
  const css = withoutComments(await stylesheet());

  assert.doesNotMatch(css, /!important/);
});

test('surfaces consume design tokens instead of raw colour values', async () => {
  const entries = await readdir(STYLES_DIR);
  const surfaces = entries.filter((entry) => entry.endsWith('.css') && entry !== 'tokens.css');

  for (const surface of surfaces) {
    const css = withoutComments(await readFile(path.join(STYLES_DIR, surface), 'utf8'));
    assert.doesNotMatch(
      css,
      /#[0-9a-fA-F]{3,8}\b|\brgba?\(/,
      `${surface} hardcodes a colour; add it to tokens.css instead`,
    );
  }
});
