import assert from 'node:assert/strict';
import test from 'node:test';
import { TRANSLATIONS } from '../app/i18n.ts';
import { presentToolActivity } from '../app/lib/tool-activity.ts';

test('deploy_to_makers is create preview, not a command', () => {
  const deploy = presentToolActivity({ name: 'mcp__edgeone-sandbox__deploy_to_makers' });
  assert.equal(deploy.action, 'Create preview');
  assert.equal(deploy.target, undefined);
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

test('Skill names the skill it loads instead of falling back to run command', () => {
  const skill = presentToolActivity({ name: 'Skill', inputSummary: 'edgeone-makers-tools' });
  assert.equal(skill.action, 'Load skill');
  assert.equal(skill.target, 'edgeone-makers-tools');
});

test('a persisted Skill activity summarized as JSON still names the skill', () => {
  const skill = presentToolActivity({
    name: 'Skill',
    inputSummary: JSON.stringify({ skill: 'edgeone-makers-tools' }, null, 2),
  });
  assert.equal(skill.action, 'Load skill');
  assert.equal(skill.target, 'edgeone-makers-tools');
});

test('specific Makers reference loader displays the reference name', () => {
  const skill = presentToolActivity({
    name: 'mcp__edgeone-sandbox__load_makers_skill',
    inputSummary: 'makers-agents',
  });
  assert.equal(skill.action, 'Load skill');
  assert.equal(skill.target, 'makers-agents');
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
    'Load skill',
    'Run command',
  ] as const;
  for (const action of actions) {
    assert.ok(TRANSLATIONS.zh.workspace.toolActions[action]);
    assert.ok(TRANSLATIONS.en.workspace.toolActions[action]);
  }
  assert.equal(TRANSLATIONS.zh.workspace.toolActions['Read file'], '读取文件');
  assert.equal(TRANSLATIONS.en.workspace.toolActions['Read file'], 'Read file');
});
