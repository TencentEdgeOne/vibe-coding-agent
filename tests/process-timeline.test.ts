import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isInstallCommand,
  isPreviewCommand,
  shortenToolName,
} from '../agents/utils/_tool-phase.ts';

test('shortens MCP tool names', () => {
  assert.equal(shortenToolName('mcp__edgeone-sandbox__files_write'), 'files_write');
  assert.equal(shortenToolName('write_project_file'), 'write_project_file');
});

test('detects install and preview commands', () => {
  assert.equal(isInstallCommand('npm install'), true);
  assert.equal(isInstallCommand('pnpm install --frozen-lockfile'), true);
  assert.equal(isInstallCommand('npm run build'), false);
  assert.equal(isPreviewCommand('npm run dev'), true);
  assert.equal(isPreviewCommand('vite dev --host'), true);
  assert.equal(isPreviewCommand('npm run lint'), false);
});
