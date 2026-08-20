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

test('blocks edgeone CLI and Pages API commands before they run', async () => {
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
  const blocked = await wrapped.handler({
    command: "edgeone makers deploy -n demo -t 'secret' --json",
  }, {});

  assert.equal(received, '');
  assert.equal(blocked.isError, true);
  assert.match((blocked.content[0] as { text: string }).text, /Do not run the edgeone CLI/);

  const api = await wrapped.handler({
    command: 'curl -s -X POST https://pages-api.cloud.tencent.com/v1 -d \'{"Action":"DeletePagesProject"}\'',
  }, {});
  assert.equal(api.isError, true);
  assert.match((api.content[0] as { text: string }).text, /Do not call Makers\/Pages APIs/);

  const scoped = await wrapped.handler({
    command: 'npm view @edgeone/pages-blob versions --json',
  }, {});
  assert.equal(received, 'npm view @edgeone/pages-blob versions --json');
  assert.equal(scoped.isError, undefined);
});
