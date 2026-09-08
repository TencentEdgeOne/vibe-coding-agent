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

test('vite preview config injects a path tracker and exposes the track env flag', async () => {
  const preview = await readFile('agents/project/_preview.ts', 'utf8');
  assert.match(preview, /EDGEONE_PREVIEW_TRACK_PATH/);
  assert.match(preview, /edgeone-preview-path-tracker/);
  assert.match(preview, /__edgeonePreviewPath/);
  assert.match(preview, /failed to load user Vite config/);
  assert.match(preview, /__PREVIEW_READY__/);
  assert.match(preview, /__PREVIEW_NOT_READY__/);
});

test('expired preview credentials never fall back to the stale iframe URL', async () => {
  const screen = await readFile('app/features/workspace/workspace-screen.tsx', 'utf8');

  assert.match(screen, /PREVIEW_CREDENTIAL_REFRESH_MS/);
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

test('preview links use the browser live sandbox host when the SDK returns mismatched hosts', async () => {
  const preview = await readFile('agents/project/_preview.ts', 'utf8');

  assert.match(preview, /publicUrlOrigin\(browserLiveUrl\)/);
  assert.match(preview, /\|\| normalizePublicUrl\(previewHost\)/);
  assert.match(preview, /function previewTargetsMatch/);
  assert.match(preview, /left\.hostname === right\.hostname/);
});

test('resume only rotates a token when the old and current preview hosts match', async () => {
  const resume = await readFile('agents/pipelines/_resume.ts', 'utf8');

  assert.match(resume, /previewTargetsMatch/);
  assert.match(resume, /previewUrl && accessToken && warmLinks\.previewUrl/);
  assert.match(resume, /rewritePreviewAccessToken\(state\.previewUrl, accessToken\)/);
});

test('workspace resume remints a warm preview and leaves cold start to stage=preview', async () => {
  const resume = await readFile('agents/pipelines/_resume.ts', 'utf8');

  assert.match(resume, /async function remintWarmPreview/);
  assert.match(resume, /async function restartColdPreview/);
  assert.match(resume, /DEPENDENCY_INSTALL_BUDGET_MS/);
  assert.match(resume, /hasPreview: hadPreview/);
  assert.match(resume, /\/resume\?stage=preview/);
  assert.doesNotMatch(
    resume,
    /preview = \{\};/,
    'a failed preview remint must not collapse to an empty object',
  );
});

test('resume recovers a published preview when workspace returns files without a URL', async () => {
  const screen = await readFile('app/features/workspace/workspace-screen.tsx', 'utf8');
  const client = await readFile('app/features/workspace/workspace-api.ts', 'utf8');

  assert.match(screen, /hadPublishedPreview/);
  assert.match(screen, /fetchResumePreview/);
  assert.match(screen, /shouldRecoverPreview/);
  assert.match(screen, /previewRefreshFailed \|\| hadPublishedPreview/);
  assert.match(screen, /!shareablePreviewUrl && !hadPublishedPreview/);
  assert.match(client, /RESUME_CLIENT_TIMEOUT_MS = 380_000/);
});
