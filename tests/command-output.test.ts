import assert from 'node:assert/strict';
import test from 'node:test';
import { formatCommandOutput, looksLikeCommandLog } from '../shared/command-output.ts';

test('npm http fetch lines collapse to a single count', () => {
  const output = formatCommandOutput([
    'npm info using npm@10.8.2',
    'npm info using node@v20.20.2',
    'npm http fetch GET 200 https://registry.npmjs.org/react 3292ms',
    'npm http fetch GET 200 https://registry.npmjs.org/vite 1501ms',
    'npm http cache https://registry.npmjs.org/postcss',
    'added 18 packages in 4s',
  ].join('\n'));

  assert.equal(output, [
    'npm info using npm@10.8.2',
    'npm info using node@v20.20.2',
    'npm http fetch ×3',
    'added 18 packages in 4s',
  ].join('\n'));
  assert.doesNotMatch(output, /truncated/i);
});

test('long command logs keep the tail instead of the noisy prefix', () => {
  const prefix = Array.from({ length: 80 }, (_, index) => `noise-${index}`).join('\n');
  const output = formatCommandOutput(`${prefix}\nadded 18 packages in 4s`, {
    lineLimit: 8,
  });

  assert.doesNotMatch(output, /noise-0/);
  assert.match(output, /added 18 packages in 4s$/);
  assert.doesNotMatch(output, /truncated/i);
});

test('legacy truncation markers are stripped', () => {
  const output = formatCommandOutput('added 18 packages in 4s\n... truncated');
  assert.equal(output, 'added 18 packages in 4s');
});

test('npm installer logs are recognized as command output', () => {
  assert.equal(looksLikeCommandLog('npm info using npm@10.8.2'), true);
  assert.equal(looksLikeCommandLog('{"written":"package.json"}'), false);
});

test('already-collapsed fetch counts are left alone', () => {
  const collapsed = [
    'npm info using npm@10.8.2',
    'npm http fetch ×3',
    'added 18 packages in 4s',
  ].join('\n');
  assert.equal(formatCommandOutput(collapsed), collapsed);
});
