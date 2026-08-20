import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('preview address bar shows the current path, not the sandbox host or preview prefix', async () => {
  const screen = await readFile('app/features/workspace/workspace-screen.tsx', 'utf8');

  // The address chip renders the mirrored route (previewDisplayPath) rather than
  // the raw shareablePreviewUrl host, so the sandbox domain is never shown.
  assert.match(screen, /previewDisplayPath/);
  assert.doesNotMatch(
    screen,
    /shareablePreviewUrl\.replace/,
    'the address bar must not strip-and-display the sandbox host domain',
  );
  // The display helper strips the preview base prefix and falls back to a bare
  // root ('/') before the first message arrives — never the '/preview/' prefix.
  assert.match(screen, /function previewDisplayPathFromPath/);
  assert.match(screen, /if \(!path\) return '\/';/);
  assert.match(screen, /path\.startsWith\(PREVIEW_PATH_PREFIX\)/);
});

test('parent listens for the preview route posted by the injected tracker', async () => {
  const screen = await readFile('app/features/workspace/workspace-screen.tsx', 'utf8');
  assert.match(screen, /__edgeonePreviewPath/);
  assert.match(screen, /addEventListener\('message'/);
});

test('sandbox preview starts makers-dev instead of injecting a Vite /preview/ config', async () => {
  const preview = await readFile('agents/project/_preview.ts', 'utf8');
  const makersDev = await readFile('shared/makers-dev.ts', 'utf8');
  assert.match(preview, /makers-dev/);
  assert.match(preview, /buildMakersDevLaunchCommand/);
  assert.match(makersDev, /edgeone makers dev/);
  assert.match(makersDev, /skip-env-sync/);
  assert.doesNotMatch(preview, /edgeone-preview-path-tracker/);
  assert.doesNotMatch(preview, /python3 -m http\.server/);
});

test('agent chat previews are smoke-tested before being published', async () => {
  const preview = await readFile('agents/project/_preview.ts', 'utf8');
  assert.match(preview, /assertGeneratedAgentChatReady/);
  assert.match(preview, /makers-conversation-id: preview-smoke-test/);
  assert.match(preview, /Generated \/chat endpoint returned an SSE error event/);
  assert.match(preview, /DONE/);
});

test('healthy makers-dev previews are reused on follow-up turns', async () => {
  const preview = await readFile('agents/project/_preview.ts', 'utf8');
  assert.match(preview, /\[preview-reuse\]/);
  assert.match(preview, /return previewServerInfo\(launchCommand\)/);
  assert.match(preview, /\[preview-reuse-fallback\]/);
});

test('cold preview probes do not throw on curl connection refused', async () => {
  const preview = await readFile('agents/project/_preview.ts', 'utf8');
  assert.match(preview, /probePreviewReadyCommand/);
  assert.match(preview, /runCommandCapturingExit/);
  assert.match(preview, /set \+e/);
  assert.match(preview, /echo EXIT:\$\?/);
  assert.match(preview, /SANDBOX_UNKNOWN_ERROR/);
});

test('expired preview credentials never fall back to the stale iframe URL', async () => {
  const screen = await readFile('app/features/workspace/workspace-screen.tsx', 'utf8');

  assert.match(screen, /PREVIEW_CREDENTIAL_REFRESH_MS/);
  assert.match(screen, /isMakersPreviewRef/);
  assert.match(screen, /setPreviewRefreshFailed\(true\)/);
  assert.match(screen, /previewUnavailable/);
  assert.doesNotMatch(
    screen,
    /setActivePreviewUrl\(previousActiveUrl\)/,
    'a failed credential remint must not reveal the gateway auth response',
  );
  assert.doesNotMatch(
    screen,
    /reload the current iframe src \(same token\)/,
    'manual refresh must not retry an expired access token',
  );
});
