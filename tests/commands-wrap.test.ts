import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractToolUseId,
  wrapSandboxToolsForVerification,
} from '../agents/tools/_commands-wrap.ts';
import type { ClaudeMcpTool } from '../agents/_types.ts';

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

test('reports the tool use id from the SDK extra to onCommand', async () => {
  const seen: { command: string; toolUseId?: string }[] = [];
  const commandsTool = {
    name: 'commands',
    description: 'run',
    inputSchema: {},
    handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  } as unknown as ClaudeMcpTool;

  const [wrapped] = wrapSandboxToolsForVerification([commandsTool], {
    onCommand: (command, meta) => seen.push({ command, toolUseId: meta?.toolUseId }),
  });
  await wrapped.handler({ command: 'npm install' }, { toolUseId: 'tool-1' });

  assert.deepEqual(seen, [{ command: 'npm install', toolUseId: 'tool-1' }]);
});

test('extractToolUseId reads common SDK extra shapes', () => {
  assert.equal(extractToolUseId({ toolUseId: 'a1' }), 'a1');
  assert.equal(extractToolUseId({ tool_use_id: 'b2' }), 'b2');
  assert.equal(extractToolUseId({ _meta: { toolUseId: 'c3' } }), 'c3');
  assert.equal(extractToolUseId({}), '');
});
