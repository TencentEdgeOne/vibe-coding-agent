import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  compactUserFacingReply,
  resolveFinishedTurn,
  withLiveDeploymentUrl,
} from '../shared/user-facing-reply.ts';
import { stripReturnedPreviewLinks } from '../agents/_lib/turn/checkpoint.ts';

const LIVE_URL = 'https://vibe-coding-playground.edgeone.app/?eo_token=abc123def456&eo_time=1787882262';

test('Chinese fallback stays concise and localized', async () => {
  const source = await readFile('agents/_lib/turn/checkpoint.ts', 'utf8');
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
  const chat = await readFile('agents/_lib/turn/chat.ts', 'utf8');
  const prompt = await readFile('agents/_lib/prompt.ts', 'utf8');
  assert.match(chat, /if \(event\.type === 'text_segment'\)/);
  assert.match(chat, /recordProgress\(narration\)/);
  assert.match(chat, /send\(narration\)/);
  assert.match(chat, /stripReturnedPreviewLinks\(event\.data\?\.text \|\| '', state\.previewUrl\)/);
  assert.match(chat, /state\.previewUrl\)\.trim\(\)/);
  assert.match(prompt, /Keep narrating as you work/);
  assert.match(prompt, /always write it in the user language/);
});

test('stripping preview links from streamed chunks preserves word spacing', () => {
  const previewUrl = 'https://sandbox.example.com/preview/?access_token=token';
  const chunks = ['Your ', 'guestbook ', 'is ready. ', `[Open preview](${previewUrl})`];

  const streamed = chunks
    .map((chunk) => stripReturnedPreviewLinks(chunk, previewUrl))
    .join('');

  assert.equal(streamed.trim(), 'Your guestbook is ready.');
});

test('stripping preview links from a complete reply still trims its edges', () => {
  const previewUrl = 'https://sandbox.example.com/preview/?access_token=token';

  assert.equal(
    stripReturnedPreviewLinks(`\n\nDone.\n\n[Open preview](${previewUrl})\n\n`, previewUrl).trim(),
    'Done.',
  );
});

const QUESTION_TURN = `我先和你确认一个关键点，避免做完无法运行：

EdgeOne 这边的全栈托管主要支持 Next.js / Nuxt 这类自带 SSR 运行时的框架。

你希望我怎么做？

1. 按 TanStack Router 前端 + 平台边缘函数做一个能在预览里直接跑的全栈项目。
2. 换成受支持的 SSR 方案（例如 Next.js）。`;

// The turn this reproduces: the model scaffolded, read four references, and
// stopped to ask the user which of three approaches to take. It wrote no files
// and never attempted a preview, and the pipeline judged it by a missing
// preview URL — so the question was replaced by "项目已生成，但预览暂时不可用，
// 请重试", the turn was recorded as failed, and on reload the question was gone.
test('a turn that stopped to ask a question is not a preview that failed', () => {
  const outcome = resolveFinishedTurn({
    filesWritten: false,
    previewUrl: '',
    buildFailed: false,
    modelReply: QUESTION_TURN,
    fallbackReply: '已按你的需求生成项目：全栈项目。',
    failureReply: '项目已生成，但预览暂时不可用，请重试。',
  });

  assert.equal(outcome.failed, false);
  assert.equal(outcome.previewMissing, false);
  // Whole, including the options — compaction would have kept the preamble and
  // dropped everything the user was being asked to choose between.
  assert.equal(outcome.reply, QUESTION_TURN);
});

test('waiting for a clarifying question is not a preview that failed', () => {
  const outcome = resolveFinishedTurn({
    filesWritten: true,
    previewUrl: '',
    buildFailed: false,
    waitingForUser: true,
    modelReply: 'AI 聊天助手已经做好了：支持流式输出、多轮对话。',
    fallbackReply: '已按你的需求完成。',
    failureReply: '项目已生成，但预览暂时不可用，请重试。',
  });

  assert.equal(outcome.failed, false);
  assert.equal(outcome.previewMissing, false);
});

test('a preview that was attempted and never came up is still a failure', () => {
  const outcome = resolveFinishedTurn({
    filesWritten: true,
    previewUrl: '',
    buildFailed: false,
    modelReply: '',
    fallbackReply: '已按你的需求生成项目：全栈项目。',
    failureReply: '项目已生成，但预览暂时不可用，请重试。',
  });

  assert.equal(outcome.failed, true);
  assert.equal(outcome.previewMissing, true);
  assert.equal(outcome.reply, '项目已生成，但预览暂时不可用，请重试。');
});

// The model is required to say whether the preview works and cannot see the
// iframe. That sentence must not survive a turn that never published a URL.
test('a missing preview is not reported as ready just because the model said so', () => {
  const outcome = resolveFinishedTurn({
    filesWritten: true,
    previewUrl: '',
    buildFailed: false,
    modelReply: 'Astro 博客站点已经搭好，构建已验证通过。右侧预览可以直接查看。',
    fallbackReply: '已按你的需求生成项目：Astro 博客。',
    failureReply: '项目已生成，但预览暂时不可用，请重试。',
  });

  assert.equal(outcome.failed, true);
  assert.equal(outcome.previewMissing, true);
  assert.equal(outcome.reply, '项目已生成，但预览暂时不可用，请重试。');
});

// A build failure with a live preview still keeps the model's own words —
// those name the check that failed, which the canned line cannot.
test('a build failure keeps what the model said when a preview is already up', () => {
  const outcome = resolveFinishedTurn({
    filesWritten: true,
    previewUrl: 'https://sandbox.example.com/preview/',
    buildFailed: true,
    modelReply: '构建失败：edgeone.json 缺少 agents.framework，我正在补上。',
    fallbackReply: '已按你的需求生成项目：全栈项目。',
    failureReply: '项目已生成，但检查未通过，我还需要继续修复。',
  });

  assert.equal(outcome.failed, true);
  assert.equal(outcome.previewMissing, false);
  assert.match(outcome.reply, /缺少 agents\.framework/);
});

// Found by the test above, which first asserted the mangled output: sentence
// splitting treated the dot in a dotted key as a full stop, so the reply ended
// at "缺少 agents." and named nothing.
test('a dotted key or filename is not mistaken for the end of a sentence', () => {
  assert.equal(
    compactUserFacingReply('edgeone.json 缺少 agents.framework，已补上。', '兜底'),
    'edgeone.json 缺少 agents.framework，已补上。',
  );
  // A real full stop still ends a sentence, so the two-sentence budget holds.
  assert.equal(
    compactUserFacingReply('First. Second. Third.', 'fallback'),
    'First. Second.',
  );
});

// A built turn still gets the compact outcome, so fixing the question case did
// not turn every successful reply back into the model's full write-up.
test('a finished build still reports itself in two sentences', () => {
  const outcome = resolveFinishedTurn({
    filesWritten: true,
    previewUrl: 'https://sandbox.example.com/preview/',
    buildFailed: false,
    modelReply: '已完成全栈项目。右侧预览已就绪。\n\n技术细节：app/page.js、cloud-functions/api/ping.js。',
    fallbackReply: '已按你的需求完成：全栈项目。右侧预览已就绪。',
    failureReply: '项目已生成，但预览暂时不可用，请重试。',
  });

  assert.equal(outcome.failed, false);
  assert.equal(outcome.reply, '已完成全栈项目。右侧预览已就绪。');
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
  const chat = await readFile('agents/_lib/turn/chat.ts', 'utf8');
  assert.match(chat, /modelResult\.deploymentTouched\s*\n?\s*&& state\.deployment\?\.status === 'success'/);
  assert.match(chat, /withLiveDeploymentUrl\(/);
});

test('the prompt separates the sandbox preview from a live deployment', async () => {
  const prompt = await readFile('agents/_lib/prompt.ts', 'utf8');
  assert.match(prompt, /Do not include preview buttons, preview links, preview URLs/);
  assert.match(prompt, /write its complete URL, query string included/);
  assert.match(prompt, /A deployment never replaces the right-hand preview/);
});
