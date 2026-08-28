import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  compactUserFacingReply,
  withLiveDeploymentUrl,
} from '../shared/user-facing-reply.ts';

const LIVE_URL = 'https://vibe-coding-playground.edgeone.app/?eo_token=abc123def456&eo_time=1787882262';

test('Chinese fallback stays concise and localized', async () => {
  const source = await readFile('agents/pipelines/_helpers.ts', 'utf8');
  assert.match(source, /已按你的需求完成/);
  assert.match(source, /右侧预览已就绪/);
});

test('successful replies keep only the user-facing outcome paragraph', () => {
  const reply = compactUserFacingReply(
    [
      'AI 聊天网站已修复，右侧预览现在可以直接使用。',
      '',
      '问题根因：fetch("/chat") 绕过了 /preview/，模型也使用了错误 ID。',
      '- agents/chat.js',
      '- HTTP 401',
    ].join('\n'),
    'fallback',
  );
  assert.equal(reply, 'AI 聊天网站已修复，右侧预览现在可以直接使用。');
});

test('step narration is streamed to the user while the summary stays compact', async () => {
  const chat = await readFile('agents/pipelines/_chat.ts', 'utf8');
  const prompt = await readFile('agents/_prompt.ts', 'utf8');
  assert.match(chat, /if \(event\.type === 'text_segment'\)/);
  assert.match(chat, /recordProgress\(narration\)/);
  assert.match(chat, /send\(narration as unknown as Record<string, unknown>\)/);
  assert.match(prompt, /Keep narrating as you work/);
  assert.match(prompt, /always write it in the user language/);
});

test('overlong technical replies fall back to a concise result', () => {
  assert.equal(
    compactUserFacingReply('技术细节'.repeat(100), '已完成，预览已就绪。'),
    '已完成，预览已就绪。',
  );
});

// Sentence splitting breaks on the dots and question mark inside a URL, and a
// signed deployment address is long enough on its own to trip the length cap.
test('a live URL survives compaction whole', () => {
  const compacted = compactUserFacingReply(
    `Todolist 已发布到线上。线上地址：${LIVE_URL}`,
    'fallback',
  );
  assert.ok(compacted.includes(LIVE_URL), compacted);

  assert.equal(
    compactUserFacingReply(`部署完成。${LIVE_URL}`, 'fallback'),
    `部署完成。${LIVE_URL}`,
  );
});

test('the live URL is guaranteed in the reply, in the reply language', () => {
  assert.equal(
    withLiveDeploymentUrl('已发布到线上环境。', LIVE_URL),
    `已发布到线上环境。\n\n线上地址：${LIVE_URL}`,
  );
  assert.equal(
    withLiveDeploymentUrl('The site is live.', LIVE_URL),
    `The site is live.\n\nLive URL: ${LIVE_URL}`,
  );

  // Already stated by the model, so it is not repeated.
  const withUrl = `已发布。线上地址：${LIVE_URL}`;
  assert.equal(withLiveDeploymentUrl(withUrl, LIVE_URL), withUrl);
  assert.equal(withLiveDeploymentUrl('预览已就绪。'), '预览已就绪。');
});

// state.deployment survives the turn that created it, so an unrelated later
// reply must not pick up a stale address.
test('only the deployment from the current turn reaches the reply', async () => {
  const chat = await readFile('agents/pipelines/_chat.ts', 'utf8');
  assert.match(chat, /modelResult\.deploymentTouched\s*\n?\s*&& state\.deployment\?\.status === 'success'/);
  assert.match(chat, /withLiveDeploymentUrl\(/);
});

test('the prompt separates the sandbox preview from a live deployment', async () => {
  const prompt = await readFile('agents/_prompt.ts', 'utf8');
  assert.match(prompt, /Do not include preview buttons, preview links, preview URLs/);
  assert.match(prompt, /write its complete URL, query string included/);
  assert.match(prompt, /A deployment never replaces the right-hand preview/);
});
