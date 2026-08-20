import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  buildMakersDevLaunchCommand,
  buildPreviewProxyScript,
  rewritePreviewProxyPath,
} from '../shared/makers-dev.ts';

test('rewrites the sandbox /preview prefix onto makers-dev root paths', () => {
  assert.equal(rewritePreviewProxyPath('/preview/'), '/');
  assert.equal(rewritePreviewProxyPath('/preview'), '/');
  assert.equal(rewritePreviewProxyPath('/preview/api/hello'), '/api/hello');
  assert.equal(rewritePreviewProxyPath('/preview/?q=1'), '/?q=1');
  assert.equal(rewritePreviewProxyPath('/preview?q=1'), '?q=1');
  assert.equal(rewritePreviewProxyPath('/api/hello'), '/api/hello');
});

test('makers-dev launch is non-interactive and does not pass a token flag', () => {
  const command = buildMakersDevLaunchCommand(8088, 'vibe-coding-playground');
  assert.match(command, /edgeone makers dev --port 8088/);
  assert.match(command, /--skip-env-sync/);
  assert.match(command, /--name 'vibe-coding-playground'/);
  assert.doesNotMatch(command, / -t /);
  assert.doesNotMatch(command, /makers deploy/);
});

test('preview proxy script forwards HTTP and WebSocket upgrades', () => {
  const script = buildPreviewProxyScript(3000, 8088, '/preview');
  assert.match(script, /LISTEN_PORT = 3000/);
  assert.match(script, /TARGET_PORT = 8088/);
  assert.match(script, /server\.on\('upgrade'/);
  assert.match(script, /function rewritePath/);
});

test('publish_preview starts makers-dev rather than cloud deploy', async () => {
  const preview = await readFile('agents/project/_preview.ts', 'utf8');
  assert.match(preview, /ensureEdgeoneCli/);
  assert.match(preview, /buildMakersDevLaunchCommand/);
  assert.match(preview, /buildPreviewProxyScript/);
  assert.doesNotMatch(preview, /makers deploy/);
});
