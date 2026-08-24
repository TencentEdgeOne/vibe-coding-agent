import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  buildReplyLanguageDirective,
  buildReplyLanguageReminder,
  buildStoppedReply,
  detectReplyLanguage,
} from '../shared/reply-language.ts';

test('detects the language of the latest request by script', () => {
  assert.equal(detectReplyLanguage('把按钮改成蓝色')?.code, 'zh');
  assert.equal(detectReplyLanguage('Make the button blue please')?.code, 'en');
  assert.equal(detectReplyLanguage('ボタンを青くしてください')?.code, 'ja');
  assert.equal(detectReplyLanguage('버튼을 파란색으로 바꿔주세요')?.code, 'ko');
  assert.equal(detectReplyLanguage('Сделай кнопку синей')?.code, 'ru');
});

test('a quoted foreign label does not flip the request language', () => {
  assert.equal(
    detectReplyLanguage('Add a primary button labeled 提交 to the top of the page')?.code,
    'en',
  );
});

test('code, paths, and urls do not count as language signal', () => {
  assert.equal(
    detectReplyLanguage('修一下 `src/App.tsx` 里的 https://example.com/docs 链接')?.code,
    'zh',
  );
});

test('unknown language falls back to mirroring the request', () => {
  assert.equal(detectReplyLanguage(''), null);
  assert.equal(detectReplyLanguage('42 :) ---'), null);
  assert.match(buildReplyLanguageDirective(''), /the same language as the current user request/);
  assert.match(buildReplyLanguageReminder(''), /the language of the request above/);
});

test('the named language is what the directive asks for', () => {
  assert.match(
    buildReplyLanguageDirective('Make the header sticky'),
    /write every user-visible word[^.]*in English/,
  );
  assert.match(buildReplyLanguageReminder('把按钮改成蓝色'), /Reply language for this turn: Chinese\./);
});

// The system prompt used to show a Chinese narration example and a Chinese
// identity answer, which the model copied into English conversations.
test('the system prompt states the language rule and carries no example to copy from', async () => {
  const source = await readFile('agents/_agent.ts', 'utf8');
  const promptBody = source.slice(
    source.indexOf('export function buildPrompt'),
    source.indexOf('export async function runCodingAgent'),
  );
  assert.match(promptBody, /buildReplyLanguageDirective\(languageAnchorMessage\)/);
  assert.match(promptBody, /buildReplyLanguageReminder\(languageAnchorMessage\)/);
  assert.doesNotMatch(promptBody, /[\u4e00-\u9fff]/);
});

test('stopped notices follow the stopped request', () => {
  assert.equal(buildStoppedReply('把按钮改成蓝色'), '已停止本次生成，你可以继续描述下一步修改。');
  assert.equal(
    buildStoppedReply('Make the button blue'),
    'Generation stopped. You can continue with another change.',
  );
});
