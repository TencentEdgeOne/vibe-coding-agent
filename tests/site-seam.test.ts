import assert from 'node:assert/strict';
import test from 'node:test';
import { isSitePublishRequest } from '../shared/site-publish.ts';
import { rewritePreviewPathsForPublish } from '../agents/_lib/site/rewrite.ts';
import { resolveMakersProjectName } from '../agents/_lib/makers/project.ts';
import { buildPrompt } from '../agents/_lib/prompt.ts';

test('a publish button sentence is recognized and a coding request is not', () => {
  assert.equal(isSitePublishRequest('把当前站点发布上线'), true);
  assert.equal(isSitePublishRequest('Publish this site'), true);
  assert.equal(isSitePublishRequest('做一个产品落地页'), false);
});

test('published Vite config drops the sandbox preview prefix', () => {
  const source = "export default { base: '/preview/' }";
  assert.equal(
    rewritePreviewPathsForPublish(source, 'vite.config.ts'),
    "export default { base: '/' }",
  );
});

test('a conversation owns a vibe- site name without embedding its id', () => {
  const name = resolveMakersProjectName(
    { env: {} },
    { created: false, sessionDir: 'projects/conversation-1', appDir: 'projects/conversation-1/app' },
  );
  assert.match(name, /^vibe-[0-9a-f]{10}$/);
  assert.equal(name.includes('conversation'), false);
});

test('the system prompt asks for a static site and not for platform skills', () => {
  const prompt = buildPrompt(
    { created: false, appDir: 'projects/c1/app', sessionDir: 'projects/c1' },
    'edgeone-sandbox',
  );
  assert.match(prompt, /Vite and React/);
  assert.match(prompt, /start_preview/);
  assert.match(prompt, /deploy_project/);
  assert.doesNotMatch(prompt, /load_makers_skill/);
});
