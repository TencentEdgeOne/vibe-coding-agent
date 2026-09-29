import assert from 'node:assert/strict';
import { access, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

async function sourceFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [target] : [];
  }));
  return nested.flat();
}

test('frontend UI and helpers live under app/, not the repo root', async () => {
  const topLevel = await readdir('.', { withFileTypes: true });
  const directories = new Set(topLevel.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  assert.ok(
    !directories.has('components'),
    'root components/ is leftover shadcn layout; keep UI under app/components/',
  );
  assert.ok(
    !directories.has('lib'),
    'root lib/ is leftover shadcn layout; keep helpers under app/lib/',
  );
});

test('frontend never imports the agent runtime', async () => {
  for (const file of await sourceFiles('app')) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(
      source,
      /(?:from\s+|import\s*)['"][^'"]*agents\//,
      `${file} crosses the app → agents boundary; move the contract to shared/`,
    );
  }
});

test('edge functions never import the agent runtime', async () => {
  for (const file of await sourceFiles('edge-functions')) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(
      source,
      /(?:from\s+|import\s*)['"][^'"]*agents\//,
      `${file} crosses the edge-functions → agents boundary; move the contract to shared/`,
    );
  }
});

test('shared modules remain runtime agnostic', async () => {
  for (const file of await sourceFiles('shared')) {
    const source = await readFile(file, 'utf8');
    assert.doesNotMatch(
      source,
      /(?:from\s+|import\s*)['"](?:react|next|@anthropic-ai|\.\.\/app|\.\.\/agents|node:)/,
      `${file} contains a framework or runtime dependency`,
    );
  }
});

const AGENT_ROUTE_FILES = new Set([
  'agents/session.ts',
  'agents/prompt.ts',
  'agents/preview.ts',
  'agents/stop.ts',
  'agents/file.ts',
  'agents/download.ts',
  'agents/transcript.ts',
  'agents/workspace.ts',
]);

test('agent routes stay at agents/ and implementation lives in agents/_lib/', async () => {
  const topLevel = await readdir('agents', { withFileTypes: true });
  for (const entry of topLevel) {
    if (entry.name === '_lib') {
      assert.ok(entry.isDirectory(), 'agents/_lib must be the private implementation directory');
      continue;
    }
    assert.ok(
      entry.isFile() && AGENT_ROUTE_FILES.has(path.join('agents', entry.name)),
      `${entry.name} is not a known agent route; move internals under agents/_lib/`,
    );
  }

  for (const file of await sourceFiles(path.join('agents', '_lib'))) {
    assert.ok(
      !path.basename(file).startsWith('_'),
      `${file} is already private via agents/_lib/; drop the underscore prefix`,
    );
  }
});

test('workspace screen is assembled from session, live, preview, and workspace hooks', async () => {
  const hooks = await readdir(path.join('app', 'features', 'workspace', 'hooks'));
  for (const name of [
    'use-session-resume.ts',
    'use-live-turn.ts',
    'use-preview-surface.ts',
    'use-workspace-state.ts',
    'use-workspace-split.ts',
  ]) {
    assert.ok(hooks.includes(name), `missing workspace hook ${name}`);
  }
});

test('retired session-truth modules stay gone', async () => {
  for (const target of [
    'agents/_lib/memory.ts',
    'agents/_lib/agent.ts',
    'agents/_lib/chat-tasks.ts',
    'agents/_lib/shared.ts',
    'agents/_lib/pipelines',
    'agents/_lib/project/templates.ts',
    'scripts/bake-templates.mjs',
    'agents/session-model.ts',
    'shared/makers-dev.ts',
    'shared/makers-deploy.ts',
    'shared/npm-install.ts',
    'shared/tool-phase.ts',
    'shared/sanitize-assistant-text.ts',
  ]) {
    await assert.rejects(access(target), `${target} should have been removed`);
  }
});

test('app/components only holds shared UI primitives', async () => {
  const names = await readdir('app/components');
  for (const name of [
    'agent-conversation.tsx',
    'files-panel.tsx',
    'session-panel.tsx',
    'model-picker.tsx',
  ]) {
    assert.ok(
      !names.includes(name),
      `${name} belongs under app/features/workspace/components, not app/components/`,
    );
  }
});

test('workspace feature component directories expose index.tsx', async () => {
  const root = path.join('app', 'features', 'workspace', 'components');
  for (const name of ['conversation', 'files', 'result-panel']) {
    await access(path.join(root, name, 'index.tsx'));
  }
});

test('app source files stay within size limits', async () => {
  for (const file of await sourceFiles('app')) {
    if (file.startsWith(`app${path.sep}components${path.sep}ui${path.sep}`)) continue;
    if (file.startsWith(`app${path.sep}i18n${path.sep}`)) continue;
    const source = await readFile(file, 'utf8');
    const lines = source.split(/\r?\n/).filter((line, index, all) => (
      index < all.length - 1 || line !== ''
    )).length;
    const limit = file.endsWith('.tsx') ? 300 : 350;
    assert.ok(
      lines <= limit,
      `${file} has ${lines} lines (limit ${limit})`,
    );
  }
});

test('session kernel and makers CLI live under agents/_lib', async () => {
  for (const target of [
    'agents/_lib/session/store.ts',
    'agents/_lib/session/transcript.ts',
    'agents/transcript.ts',
    'agents/_lib/session/live.ts',
    'agents/_lib/lazy/sandbox.ts',
    'agents/_lib/session/projection.ts',
    'agents/_lib/makers/session.ts',
    'agents/_lib/makers/cli-dev.ts',
    'agents/_lib/makers/preview-proxy-source.ts',
    'shared/timeline.ts',
    'shared/protocol.ts',
    'agents/prompt.ts',
  ]) {
    await access(target);
  }
});
