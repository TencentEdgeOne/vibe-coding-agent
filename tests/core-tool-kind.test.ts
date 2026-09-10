import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyTool,
  extractCommandFromInput,
  shortenToolName,
} from '../agents/core/_tool-kind.ts';
import { isInstallCommand, isPreviewCommand } from '../agents/utils/_tool-phase.ts';

const HELPERS = { isInstallCommand, isPreviewCommand };
const kind = (name: string, input?: unknown) => classifyTool(name, input, HELPERS);

test('the MCP server prefix is stripped before classifying', () => {
  assert.equal(shortenToolName('mcp__edgeone-sandbox__write_project_file'), 'write_project_file');
  assert.equal(shortenToolName('write_project_file'), 'write_project_file');
  assert.equal(kind('mcp__edgeone-sandbox__publish_preview'), 'preview.publish');
});

test('write, read, remove, and mkdir tools map to distinct kinds', () => {
  for (const name of ['write_project_file', 'write_project_files', 'files_write', 'write_files']) {
    assert.equal(kind(name), 'file.write', name);
  }
  assert.equal(kind('files_read'), 'file.read');
  assert.equal(kind('files_remove'), 'file.remove');
  assert.equal(kind('files_make_dir'), 'dir.create');
});

test('preview tools map to preview.publish', () => {
  assert.equal(kind('publish_preview'), 'preview.publish');
  assert.equal(kind('get_preview_link'), 'preview.publish');
});

test('publish_project maps to project.deploy', () => {
  assert.equal(kind('publish_project'), 'project.deploy');
  assert.equal(kind('mcp__edgeone-deploy__publish_project'), 'project.deploy');
});

test('ensure_project_scaffold is its own kind', () => {
  assert.equal(kind('ensure_project_scaffold'), 'scaffold');
});

// A shell command is classified by what it runs, not by the tool name.
test('a command tool is classified from the command it runs', () => {
  assert.equal(kind('commands', { command: 'npm install' }), 'dependency.install');
  assert.equal(kind('commands', { command: 'npm run dev' }), 'preview.publish');
  assert.equal(kind('commands', { command: 'ls -la' }), 'command.run');
  // No command at all is still a command run, not an unknown tool.
  assert.equal(kind('commands', {}), 'command.run');
});

test('an unrecognized tool is other rather than a wrong guess', () => {
  assert.equal(kind('some_future_tool'), 'other');
  assert.equal(kind(''), 'other');
});

test('a command is read from either the command or cmd field', () => {
  assert.equal(extractCommandFromInput({ command: '  npm install  ' }), 'npm install');
  assert.equal(extractCommandFromInput({ cmd: 'npm test' }), 'npm test');
  assert.equal(extractCommandFromInput({}), '');
  assert.equal(extractCommandFromInput(null), '');
  assert.equal(extractCommandFromInput('a string'), '');
});

/**
 * The original inferToolProgress, kept verbatim as the reference for the
 * behavior _agent.ts must continue to produce now that phases are derived from
 * ToolKind. If these ever disagree, the refactor changed the UI.
 */
function legacyInferToolProgress(name: string, input: unknown) {
  const toolName = shortenToolName(name);
  if (toolName === 'publish_preview' || toolName === 'get_preview_link') {
    return { phaseHint: 'preview' as const };
  }
  if (
    toolName === 'files_write'
    || toolName === 'write_files'
    || toolName === 'files_make_dir'
    || toolName === 'files_remove'
  ) {
    return { phaseHint: 'code' as const };
  }
  if (toolName === 'write_project_file') {
    return { phaseHint: 'code' as const, fileCount: 1 };
  }
  if (toolName === 'commands') {
    const cmd = extractCommandFromInput(input);
    if (isInstallCommand(cmd)) return { phaseHint: 'install' as const };
    if (isPreviewCommand(cmd)) return { phaseHint: 'preview' as const };
  }
  return {};
}

const PHASE_BY_TOOL_KIND: Record<string, string | undefined> = {
  'file.write': 'code',
  'file.remove': 'code',
  'dir.create': 'code',
  'dependency.install': 'install',
  'preview.publish': 'preview',
};

function derivedInferToolProgress(name: string, input: unknown) {
  const phaseHint = PHASE_BY_TOOL_KIND[kind(name, input)];
  const fileCount = shortenToolName(name) === 'write_project_file' ? 1 : undefined;
  return {
    ...(phaseHint ? { phaseHint } : {}),
    ...(fileCount ? { fileCount } : {}),
  };
}

test('deriving phases from ToolKind reproduces the original classification', () => {
  const cases: Array<[string, unknown]> = [
    ['mcp__edgeone-sandbox__write_project_file', { path: 'a.tsx' }],
    ['write_project_file', { path: 'a.tsx' }],
    ['files_write', { path: 'a.tsx' }],
    ['write_files', {}],
    ['files_make_dir', { path: 'src' }],
    ['files_remove', { path: 'a.tsx' }],
    ['publish_preview', {}],
    ['get_preview_link', {}],
    ['commands', { command: 'npm install' }],
    ['commands', { command: 'npm ci' }],
    ['commands', { command: 'npm run dev' }],
    ['commands', { command: 'ls -la' }],
    ['commands', {}],
    ['files_read', { path: 'a.tsx' }],
    ['some_future_tool', {}],
  ];

  for (const [name, input] of cases) {
    assert.deepEqual(
      derivedInferToolProgress(name, input),
      legacyInferToolProgress(name, input),
      `${name} ${JSON.stringify(input)}`,
    );
  }
});

test('classification needs no host runtime', async () => {
  const source = await import('node:fs/promises')
    .then((fs) => fs.readFile('agents/core/_tool-kind.ts', 'utf8'));
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  assert.doesNotMatch(code, /context/);
  assert.doesNotMatch(code, /sandbox\./);
});
