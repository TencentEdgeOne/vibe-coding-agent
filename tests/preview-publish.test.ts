import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { shouldReusePreviewServer } from '../shared/tool-phase.ts';

test('reuses a ready preview only when this turn does not require a restart', () => {
  assert.equal(shouldReusePreviewServer(true, false), true);
  assert.equal(shouldReusePreviewServer(true, true), false);
  assert.equal(shouldReusePreviewServer(false, false), false);
  assert.equal(shouldReusePreviewServer(false, true), false);
});

test('publish_preview reuses or restarts from the turn signal and returns a small payload', async () => {
  const tools = await readFile('agents/tools/_project-tools.ts', 'utf8');

  assert.match(tools, /shouldReusePreviewServer\(/);
  assert.match(tools, /isPreviewServerReady\(context\)/);
  assert.match(tools, /restartSignal\?\.mustRestart === true/);
  assert.match(tools, /if \(!reused\) \{\s*await startPreviewServer/);
  assert.doesNotMatch(tools, /assertPreviewServerReady/);
  assert.match(tools, /stringifyToolResult\(\{[\s\S]*reused,/);
  assert.doesNotMatch(tools, /\bserver,/);
  assert.doesNotMatch(tools, /buildPreviewLinkTool/);
  assert.doesNotMatch(tools, /get_preview_link/);
});

test('the agent no longer exposes get_preview_link', async () => {
  const agent = await readFile('agents/_agent.ts', 'utf8');
  const promptBody = agent.slice(
    agent.indexOf('export function buildPrompt'),
    agent.indexOf('export async function runCodingAgent'),
  );

  assert.doesNotMatch(promptBody, /get_preview_link/);
  assert.doesNotMatch(agent, /mcp__\$\{mcpServerName\}__get_preview_link/);
  assert.match(agent, /isPreviewRestartConfigPath/);
  assert.match(agent, /isInstallCommand\(command\)/);
  assert.match(agent, /previewRestart\.mustRestart = true/);
});

test('preview start sleeps only after killing a process on 3000', async () => {
  const preview = await readFile('agents/project/_preview.ts', 'utf8');
  const start = preview.slice(
    preview.indexOf('export async function startPreviewServer'),
    preview.indexOf('export async function isPreviewServerReady'),
  );

  assert.match(start, /if \[ "\$killed" = 1 \]; then sleep 1; fi/);
  assert.doesNotMatch(start, /fi;\s*sleep 1/);
});
