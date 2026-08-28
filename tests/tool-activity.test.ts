import assert from 'node:assert/strict';
import test from 'node:test';
import { TRANSLATIONS } from '../app/i18n.ts';
import {
  appendNarrationChunk,
  dropTrailingSummaryEcho,
  presentToolActivity,
} from '../app/lib/tool-activity.ts';

test('direct Makers CLI dev and deploy commands have distinct actions', () => {
  const deploy = presentToolActivity({
    name: 'mcp__edgeone-sandbox__commands',
    inputSummary: 'edgeone makers deploy -n demo --json',
  });
  assert.equal(deploy.action, 'Deploy project');
  const dev = presentToolActivity({
    name: 'commands',
    inputSummary: 'edgeone makers dev --port 8088 --skip-env-sync --name demo',
  });
  assert.equal(dev.action, 'Create preview');
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
    'Deploy project',
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

// The example chips are the only thing a user sees before typing, so a chip
// that exists in one language but not the other silently changes what the
// product looks capable of.
test('the landing examples stay in sync across languages', () => {
  const { zh, en } = TRANSLATIONS;
  assert.equal(zh.home.examples.length, en.home.examples.length);
  for (const example of [...zh.home.examples, ...en.home.examples]) {
    assert.ok(example.trim().length > 0, 'an empty example chip would render as a blank button');
  }
});

test('the landing platform cards stay in sync across languages', () => {
  const { zh, en } = TRANSLATIONS;
  assert.deepEqual(
    zh.home.features.map((feature) => feature.icon),
    en.home.features.map((feature) => feature.icon),
    'both languages must describe the same capabilities in the same order',
  );
  for (const feature of [...zh.home.features, ...en.home.features]) {
    for (const field of [feature.title, feature.desc]) {
      assert.ok(field.trim().length > 0, 'an empty field would render as a blank card');
    }
  }
  assert.equal(zh.home.pipeline.length, en.home.pipeline.length);
});

// The browser sees the same token-sized chunks the runtime does, so the same
// rule applies: a short chunk is text, never a replay to skip.
test('streamed chunks are appended even when they repeat what came before', () => {
  const url = 'https://vibe-coding-e2b8952eaf-yy3vnimd.test-global.qcdntest.cn?eo_token=7d44f02fce5648fdb18832f92dbd1caa';
  const activities = ['站点已上线。https://vibe-coding-e2b8952eaf-y', 'y', '3vnimd.test-global.qcdntest.cn?eo_token=7d44f02fce5648fdb18832f92dbd1ca', 'a']
    .reduce<ReturnType<typeof appendNarrationChunk>>(
      (current, chunk) => appendNarrationChunk(current, chunk),
      [],
    );

  assert.deepEqual(activities, [{ kind: 'text', content: `站点已上线。${url}` }]);

  // A resumed turn replays whole blocks, and those are long enough to tell.
  const replayed = appendNarrationChunk(activities, `站点已上线。${url}`);
  assert.deepEqual(replayed, activities);

  // Narration that follows a tool call starts its own block.
  const tool = { kind: 'tool' as const, toolUseId: 'a', name: 'commands', status: 'completed' as const };
  assert.deepEqual(
    appendNarrationChunk([tool], '好的'),
    [tool, { kind: 'text', content: '好的' }],
  );
});

// A deploy turn ends with the model announcing the result, and that same
// sentence comes back as the turn summary. Rendering both makes the agent look
// like it is repeating itself at the one moment the user is reading closely.
test('the closing narration gives way to the turn summary', () => {
  const narration = { kind: 'text' as const, content: '部署成功，Todolist 已发布到 EdgeOne Makers 线上环境。' };
  const tool = { kind: 'tool' as const, toolUseId: 'a', name: 'commands', status: 'completed' as const };

  // The summary carries the live URL the narration lacks, and the streamed
  // deltas broke the product name across chunks, so only whitespace-insensitive
  // containment recognises the echo.
  const deployed = dropTrailingSummaryEcho(
    [tool, { ...narration, content: '部署成功，Todolist已发布到EdgeOneMakers线上环境。' }],
    `${narration.content}\n\n线上地址：https://example.edgeone.app`,
  );
  assert.deepEqual(deployed, [tool]);

  // Compaction can also cut the narration down rather than extend it: the
  // dropped tail was judged not user-facing, so re-showing it above the summary
  // would put back exactly what compaction removed.
  assert.deepEqual(
    dropTrailingSummaryEcho(
      [tool, { ...narration, content: `${narration.content}构建产物在 dist 目录，用时 12 秒。` }],
      narration.content,
    ),
    [tool],
  );

  // The summary lifts the deployment URL onto its own line, sometimes behind a
  // label, so only the prose is comparable.
  assert.deepEqual(
    dropTrailingSummaryEcho(
      [tool, { ...narration, content: '部署已完成，站点已上线。https://demo.edgeone.app?eo_token=abc' }],
      '部署已完成，站点已上线。\n\n线上地址：https://demo.edgeone.app?eo_token=abc',
    ),
    [tool],
  );

  // Narration that says something the summary does not is progress, not an echo.
  assert.deepEqual(
    dropTrailingSummaryEcho([tool, narration], '预览已刷新，可以在右侧查看。'),
    [tool, narration],
  );
  // Only the trailing block is a candidate; earlier steps stay.
  assert.deepEqual(
    dropTrailingSummaryEcho([narration, tool], narration.content),
    [narration, tool],
  );
});
