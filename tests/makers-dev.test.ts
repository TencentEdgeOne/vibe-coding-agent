import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  buildMakersDevBackgroundCommand,
  buildMakersDevLaunchCommand,
  buildPreviewProxyScript,
  parseMakersDevExitCode,
  previewCanonicalRedirect,
  previewProxyRevision,
  rewritePreviewProxyPath,
} from '../shared/makers-dev.ts';
import {
  MAKERS_DEV_PORT,
  PREVIEW_PATH_PREFIX,
  PREVIEW_PUBLIC_PORT,
  PREVIEW_SERVER_PORT,
} from '../agents/_constants.ts';

test('rewrites the public preview prefix onto Makers dev root paths', () => {
  assert.equal(rewritePreviewProxyPath('/preview/'), '/');
  assert.equal(rewritePreviewProxyPath('/preview'), '/');
  assert.equal(rewritePreviewProxyPath('/preview/api/hello'), '/api/hello');
  assert.equal(rewritePreviewProxyPath('/preview/?q=1'), '/?q=1');
  assert.equal(rewritePreviewProxyPath('/preview?q=1'), '/?q=1');
  assert.equal(rewritePreviewProxyPath('/api/hello'), '/api/hello');
});

// Without the trailing slash the browser resolves every relative URL on the
// page against the host root, which the gateway does not publish: stylesheets,
// scripts, and API calls all 404 at once, and the page looks like it silently
// stopped working.
test('the preview root keeps its trailing slash, and its access token', () => {
  assert.equal(previewCanonicalRedirect('/preview'), '/preview/');
  assert.equal(
    previewCanonicalRedirect('/preview?access_token=abc'),
    '/preview/?access_token=abc',
  );
  // Already canonical, or not the prefix root at all: nothing to redirect.
  assert.equal(previewCanonicalRedirect('/preview/'), undefined);
  assert.equal(previewCanonicalRedirect('/preview/api/hello'), undefined);
  assert.equal(previewCanonicalRedirect('/previewing'), undefined);
  assert.equal(previewCanonicalRedirect('/api/hello'), undefined);
  assert.equal(previewCanonicalRedirect('/preview', '/'), undefined);

  const script = buildPreviewProxyScript(
    PREVIEW_SERVER_PORT,
    MAKERS_DEV_PORT,
    PREVIEW_PATH_PREFIX,
  );
  assert.match(script, /canonicalRedirect/);
  assert.match(script, /writeHead\(308/);
});

test('makers-dev launch is non-interactive and does not pass a token flag', () => {
  const command = buildMakersDevLaunchCommand(MAKERS_DEV_PORT, 'vibe-coding-playground');
  assert.match(command, new RegExp(`edgeone makers dev --port ${MAKERS_DEV_PORT}`));
  assert.match(command, /--skip-env-sync/);
  assert.match(command, /--name 'vibe-coding-playground'/);
  assert.doesNotMatch(command, / -t /);
  assert.doesNotMatch(command, /makers deploy/);
});

test('preview topology keeps CLI, path adapter, and public gateway separate', () => {
  assert.equal(MAKERS_DEV_PORT, 8088);
  assert.equal(PREVIEW_SERVER_PORT, 3000);
  assert.equal(PREVIEW_PUBLIC_PORT, 9000);
  assert.equal(PREVIEW_PATH_PREFIX, '/preview/');
});

test('preview proxy strips the prefix and forwards HTTP and WebSocket upgrades', () => {
  const script = buildPreviewProxyScript(
    PREVIEW_SERVER_PORT,
    MAKERS_DEV_PORT,
    PREVIEW_PATH_PREFIX,
  );
  assert.match(script, /LISTEN_PORT = 3000/);
  assert.match(script, /TARGET_PORT = 8088/);
  assert.match(script, /server\.on\('upgrade'/);
  assert.match(script, /function rewritePath/);
  assert.match(script, /x-edgeone-preview-proxy/);
  assert.doesNotThrow(() => new Function(script));
});

// makers dev forwards to its function runtime through http-proxy with xfwd,
// which appends to x-forwarded-proto instead of replacing it. Passing the
// gateway's value through makes the runtime build "http,http://host/path",
// throw ERR_INVALID_URL, and then fail again inside its own error handler, so
// no response is ever written: the preview hangs while a direct curl (which
// sends no such header) still answers 200.
test('the preview proxy does not forward the gateway x-forwarded-proto', () => {
  const script = buildPreviewProxyScript(
    PREVIEW_SERVER_PORT,
    MAKERS_DEV_PORT,
    PREVIEW_PATH_PREFIX,
  );
  assert.match(script, /delete headers\['x-forwarded-proto'\]/);
  // Both the HTTP and the WebSocket upgrade path have to be sanitized.
  assert.equal(script.match(/const headers = forwardHeaders\(req\);/g)?.length, 2);
  assert.doesNotThrow(() => new Function(script));
});

// Nothing else notices a stale proxy: it passes every health probe while still
// mangling requests, and the warm path reuses it because it is healthy. Without
// this the fix above would never reach a sandbox that is already running one.
test('a preview proxy from an older agent is replaced rather than reused', () => {
  const revision = previewProxyRevision(
    PREVIEW_SERVER_PORT,
    MAKERS_DEV_PORT,
    PREVIEW_PATH_PREFIX,
  );
  const script = buildPreviewProxyScript(
    PREVIEW_SERVER_PORT,
    MAKERS_DEV_PORT,
    PREVIEW_PATH_PREFIX,
  );
  assert.match(script, new RegExp(`'x-edgeone-preview-proxy': '${revision}'`));

  const command = buildMakersDevBackgroundCommand({
    makersPort: MAKERS_DEV_PORT,
    previewPort: PREVIEW_SERVER_PORT,
    previewPath: PREVIEW_PATH_PREFIX,
    projectName: 'vibe-coding-playground',
  });
  assert.match(command, new RegExp(`x-edgeone-preview-proxy: ${revision}`));

  // The revision has to follow the script, or the check passes on a proxy the
  // agent would no longer write.
  const changed = previewProxyRevision(PREVIEW_SERVER_PORT, MAKERS_DEV_PORT, '/other');
  assert.notEqual(changed, revision);
});

test('makers-dev runs behind the prefix-stripping preview proxy', () => {
  const command = buildMakersDevBackgroundCommand({
    makersPort: MAKERS_DEV_PORT,
    previewPort: PREVIEW_SERVER_PORT,
    previewPath: PREVIEW_PATH_PREFIX,
    projectName: 'vibe-coding-playground',
  });
  assert.match(command, new RegExp(`nohup edgeone makers dev --port ${MAKERS_DEV_PORT}`));
  assert.match(command, /edgeone-preview-proxy\.cjs/);
  assert.match(
    command,
    new RegExp(`http://127\\.0\\.0\\.1:${PREVIEW_SERVER_PORT}/preview/`),
  );
  assert.match(command, /MAKERS_DEV_READY=started/);
  assert.match(command, /MAKERS_DEV_EXIT:\$dev_status/);
  assert.match(command, /exit 0/);
});

test('makers-dev captured exit markers preserve CLI failures', () => {
  assert.equal(parseMakersDevExitCode('log\nMAKERS_DEV_EXIT:127\n'), 127);
  assert.equal(parseMakersDevExitCode('MAKERS_DEV_EXIT:0\n'), 0);
  assert.equal(parseMakersDevExitCode('no marker'), undefined);
});

test('sandbox preview publishes the fixed gateway path through a local adapter', async () => {
  const preview = await readFile('agents/project/_preview.ts', 'utf8');
  assert.doesNotMatch(preview, /ensureEdgeoneCli|npm install -g edgeone/);
  assert.match(preview, /buildMakersDevLaunchCommand/);
  assert.match(preview, /buildMakersDevBackgroundCommand/);
  assert.match(preview, /getHost\(PREVIEW_PUBLIC_PORT\)/);
  assert.match(
    preview,
    /127\.0\.0\.1:\$\{PREVIEW_SERVER_PORT\}\$\{PREVIEW_PATH_PREFIX\}chat/,
  );
  assert.match(preview, /proxyPath: PREVIEW_PATH_PREFIX/);
  assert.doesNotMatch(preview, /makers deploy/);
});
