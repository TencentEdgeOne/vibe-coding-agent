import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { stripReturnedPreviewLinks } from '../shared/preview-links.ts';

const PREVIEW_URL = 'https://sandbox.example.com/preview/?envdAccessToken=abc';

// Regression: trimming every streamed delta glued the tokens together, so the
// narration read "Icanonlyhelpcreateormodifywebprojects." and no longer matched
// the final reply, which then rendered a second time.
test('streamed deltas keep the whitespace between tokens', () => {
  const deltas = ['I', ' can', ' only', ' help', ' create', ' or', ' modify', ' web', ' projects.'];
  const streamed = deltas
    .map((delta) => stripReturnedPreviewLinks(delta, PREVIEW_URL, { preserveEdges: true }))
    .join('');
  assert.equal(streamed, 'I can only help create or modify web projects.');
});

test('a preview link is still removed from a streamed delta', () => {
  assert.equal(
    stripReturnedPreviewLinks(` open ${PREVIEW_URL} `, PREVIEW_URL, { preserveEdges: true }),
    ' open ',
  );
  assert.equal(
    stripReturnedPreviewLinks(`Done. [preview](${PREVIEW_URL})`, PREVIEW_URL, { preserveEdges: true }),
    'Done.',
  );
});

test('a finished reply is still trimmed', () => {
  assert.equal(
    stripReturnedPreviewLinks(`\n  Built the timer. ${PREVIEW_URL}\n`, PREVIEW_URL),
    'Built the timer.',
  );
});

test('text is untouched when the conversation has no preview yet', () => {
  assert.equal(stripReturnedPreviewLinks(' partial ', undefined), ' partial ');
});

test('the chat pipeline streams narration without trimming the fragments', async () => {
  const source = await readFile('agents/pipelines/_chat.ts', 'utf8');
  assert.match(
    source,
    /stripReturnedPreviewLinks\(event\.data\.text, state\.previewUrl, \{ preserveEdges: true \}\)/,
  );
});
