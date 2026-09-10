import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  previewTargetsMatch,
  resolvePreviewUrl,
} from '../agents/core/_preview-url.ts';
import { previewDisplayPathFromPath } from '../shared/preview-display-path.ts';

test('preview address bar shows the current path, not the sandbox host or preview prefix', async () => {
  const screen = await readFile('app/features/workspace/workspace-screen.tsx', 'utf8');

  // The address chip renders the mirrored route (previewDisplayPath) rather than
  // the raw shareablePreviewUrl host, so the sandbox domain is never shown.
  assert.match(screen, /previewDisplayPath/);
  assert.match(screen, /previewDisplayPathFromPath/);
  assert.doesNotMatch(
    screen,
    /shareablePreviewUrl\.replace/,
    'the address bar must not strip-and-display the sandbox host domain',
  );
});

test('preview address chip hides the gateway prefix and access_token', () => {
  assert.equal(previewDisplayPathFromPath(''), '/');
  assert.equal(previewDisplayPathFromPath('/preview/'), '/');
  assert.equal(
    previewDisplayPathFromPath('/preview/?access_token=sit_EopBYgXXf5X2fz2kx1gl0U5BEtTEzf240kR7BWuzCLQ'),
    '/',
  );
  assert.equal(
    previewDisplayPathFromPath('/?access_token=sit_secret'),
    '/',
  );
  assert.equal(
    previewDisplayPathFromPath('/preview/about?q=docs&access_token=sit_secret#intro'),
    '/about?q=docs#intro',
  );
  assert.equal(previewDisplayPathFromPath('/preview/blog/first-post'), '/blog/first-post');
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
  // The URL logic moved to agents/core/_preview-url.ts, so assert the behavior
  // itself rather than the shape of the source that implements it.
  const browserWins = resolvePreviewUrl({
    previewHost: 'raw-host.example.com',
    browserLiveUrl: 'https://live-host.example.com/session/abc',
    accessToken: 'token-1',
  });
  assert.equal(new URL(browserWins!).hostname, 'live-host.example.com');

  // Without a browser live URL the raw port host is used.
  const rawHost = resolvePreviewUrl({
    previewHost: 'raw-host.example.com',
    accessToken: 'token-1',
  });
  assert.equal(new URL(rawHost!).hostname, 'raw-host.example.com');

  // Host, port, and path identify a preview target; the rotating token does not.
  assert.equal(
    previewTargetsMatch(
      'https://host.example.com/preview/?access_token=old',
      'https://host.example.com/preview/?access_token=new',
    ),
    true,
  );
  assert.equal(
    previewTargetsMatch('https://host-a.example.com/preview/', 'https://host-b.example.com/preview/'),
    false,
  );
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
