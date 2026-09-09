import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractToolUseId,
  withLineBufferedCommand,
  wrapSandboxToolsForVerification,
} from '../agents/tools/_commands-wrap.ts';
import type { ClaudeMcpTool } from '../agents/_types.ts';
import type { CommandStreamChunk } from '../agents/utils/_command-stream.ts';

test('wraps verification commands with EXIT echo without marking protocol error', async () => {
  let received = '';
  const commandsTool = {
    name: 'commands',
    description: 'run',
    inputSchema: {},
    handler: async (args: { command?: string }) => {
      received = args.command || '';
      return {
        content: [{ type: 'text', text: JSON.stringify({ stdout: 'error TS6133\nEXIT:1\n', exitCode: 0 }) }],
      };
    },
  } as unknown as ClaudeMcpTool;

  const [wrapped] = wrapSandboxToolsForVerification([commandsTool]);
  const result = await wrapped.handler({ command: 'npm run build' }, {});

  assert.equal(received, 'npm run build; echo EXIT:$?');
  assert.equal(result.isError, undefined);
});

test('does not wrap install commands', async () => {
  let received = '';
  const commandsTool = {
    name: 'commands',
    description: 'run',
    inputSchema: {},
    handler: async (args: { command?: string }) => {
      received = args.command || '';
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  } as unknown as ClaudeMcpTool;

  const [wrapped] = wrapSandboxToolsForVerification([commandsTool]);
  const result = await wrapped.handler({ command: 'npm install' }, {});

  assert.equal(received, 'npm install');
  assert.equal(result.isError, undefined);
});

test('notifies onCommand with the original sandbox command', async () => {
  const seen: string[] = [];
  const commandsTool = {
    name: 'commands',
    description: 'run',
    inputSchema: {},
    handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  } as unknown as ClaudeMcpTool;

  const [wrapped] = wrapSandboxToolsForVerification([commandsTool], {
    onCommand: (command) => seen.push(command),
  });
  await wrapped.handler({ command: 'npm install' }, {});
  await wrapped.handler({ command: 'npm run build' }, {});

  assert.deepEqual(seen, ['npm install', 'npm run build']);
});

test('streams sandbox stdout/stderr while the commands tool is still running', async () => {
  const chunks: CommandStreamChunk[] = [];
  const seen: string[] = [];
  const commandsTool = {
    name: 'commands',
    description: 'run',
    inputSchema: {},
    handler: async () => {
      throw new Error('original handler should not run when runCommand is provided');
    },
  } as unknown as ClaudeMcpTool;

  const [wrapped] = wrapSandboxToolsForVerification([commandsTool], {
    onCommandOutput: (chunk) => chunks.push(chunk),
    runCommand: async (command, options) => {
      seen.push(command);
      options?.onStdout?.('downloading\n');
      options?.onStderr?.('warn\n');
      return { stdout: 'downloading\n', stderr: 'warn\n', exitCode: 0 };
    },
  });
  const result = await wrapped.handler({ command: 'npm install' }, { toolUseId: 'tool-1' });

  assert.match(seen[0] || '', /npm install/);
  assert.equal(seen.length, 1);
  assert.deepEqual(chunks, [
    { stream: 'stdout', data: 'downloading\n' },
    { stream: 'stderr', data: 'warn\n' },
  ]);
  assert.equal(
    result.content[0].text,
    JSON.stringify({ stdout: 'downloading\n', stderr: 'warn\n', exitCode: 0 }, null, 2),
  );
});

test('extractToolUseId reads common SDK extra shapes', () => {
  assert.equal(extractToolUseId({ toolUseId: 'a1' }), 'a1');
  assert.equal(extractToolUseId({ tool_use_id: 'b2' }), 'b2');
  assert.equal(extractToolUseId({ _meta: { toolUseId: 'c3' } }), 'c3');
  assert.equal(extractToolUseId({}), '');
});

test('line-buffered wrap keeps the original command and prefers stdbuf', () => {
  const wrapped = withLineBufferedCommand('cd app && npm install');
  assert.match(wrapped, /stdbuf -oL -eL bash -c/);
  assert.match(wrapped, /cd app && npm install/);
  assert.doesNotMatch(wrapped, /bash -lc/);
});
