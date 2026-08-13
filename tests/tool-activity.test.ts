import assert from 'node:assert/strict';
import test from 'node:test';
import { TRANSLATIONS } from '../app/i18n.ts';
import { presentToolActivity } from '../app/lib/tool-activity.ts';

test('publish_preview is create preview, not a command', () => {
  const preview = presentToolActivity({ name: 'mcp__edgeone-sandbox__publish_preview' });
  assert.equal(preview.action, 'Create preview');
  assert.equal(preview.target, undefined);
});

test('npm run build is a run command', () => {
  const build = presentToolActivity({
    name: 'mcp__edgeone-sandbox__commands',
    inputSummary: 'cd <project> && npm run build',
  });
  assert.equal(build.action, 'Run command');
  assert.equal(build.target, 'cd <project> && npm run build');
});

test('npm run dev is a run command, not create preview', () => {
  const dev = presentToolActivity({
    name: 'commands',
    inputSummary: 'npm run dev -- --host 0.0.0.0 --port 3000',
  });
  assert.equal(dev.action, 'Run command');
});

test('files_make_dir is create folder, not a command', () => {
  const mkdir = presentToolActivity({
    name: 'mcp__edgeone-sandbox__files_make_dir',
    inputSummary: JSON.stringify({ path: 'src/lib' }, null, 2),
  });
  assert.equal(mkdir.action, 'Create folder');
  assert.equal(mkdir.target, 'src/lib');
});

test('zh and en tool action labels cover every action', () => {
  const actions = [
    'Environment Preparing',
    'Glob',
    'Read file',
    'Write file',
    'Edit file',
    'Create folder',
    'Delete file',
    'Create preview',
    'Run command',
  ] as const;
  for (const action of actions) {
    assert.ok(TRANSLATIONS.zh.workspace.toolActions[action]);
    assert.ok(TRANSLATIONS.en.workspace.toolActions[action]);
  }
  assert.equal(TRANSLATIONS.zh.workspace.toolActions['Read file'], '读取文件');
  assert.equal(TRANSLATIONS.en.workspace.toolActions['Read file'], 'Read file');
});
