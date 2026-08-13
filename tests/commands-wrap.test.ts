import assert from 'node:assert/strict';
import test from 'node:test';
import { wrapSandboxToolsForVerification } from '../agents/tools/_commands-wrap.ts';
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
