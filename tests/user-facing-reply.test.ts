import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { compactUserFacingReply } from '../shared/user-facing-reply.ts';

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
  const prompt = await readFile('agents/_agent.ts', 'utf8');
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
