import assert from 'node:assert/strict';
import test from 'node:test';
import { wrapSandboxTools } from '../agents/_lib/tools/commands-wrap.ts';
import { resolveMakersProjectName } from '../agents/_lib/makers/project.ts';
import {
  MAKERS_DEV_PORT,
  PREVIEW_PATH_PREFIX,
  PREVIEW_PUBLIC_PORT,
  PREVIEW_SERVER_PORT,
} from '../agents/_lib/constants.ts';
import {
  MAKERS_DEV_FRONTEND_EXIT,
  MAKERS_DEV_LAUNCH_TIMEOUT_SECONDS,
} from '../agents/_lib/makers/cli-dev.ts';
import {
  OFFICIAL_NPM_REGISTRY,
  TENCENT_NPM_REGISTRY,
} from '../agents/_lib/makers/npm-install.ts';
import type {
  ClaudeMcpTool,
  DeploymentInfo,
} from '../agents/_lib/types.ts';
import { projectState } from './helpers/fixtures.ts';

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

  const [wrapped] = wrapSandboxTools([commandsTool]);
  const result = await wrapped.handler({ command: 'npm run build' }, {});

  assert.ok(received.endsWith('npm run build; echo EXIT:$?'), received);
  assert.equal(result.isError, undefined);
});

test('wraps install commands so a failed resolve keeps its output', async () => {
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

  const [wrapped] = wrapSandboxTools([commandsTool]);
  const result = await wrapped.handler({ command: 'npm install' }, {});

  assert.ok(received.includes('npm install; echo EXIT:$?'), received);
  assert.equal(result.isError, undefined);

  // The cache reclaim follows the install, and it has to follow the echo too:
  // the sandbox reads the exit code from that marker and throws the output away
  // whenever the script ends non-zero, which a cache clean on a full disk does.
  // lastIndexOf, because the handoff carries a cache clean of its own for the
  // warmup that died of ENOSPC, and that one runs before the install.
  const echoed = received.indexOf('npm install; echo EXIT:$?');
  const reclaimed = received.lastIndexOf('npm cache clean --force');
  assert.ok(reclaimed > echoed, `the reclaim must come after the exit marker: ${received}`);
});

// Both of the above also stop the dev server first, and that is not incidental:
// `next build` and `next dev` share .next, and npm renames inside node_modules
// while the server holds files open there. Neither failure names the dev
// server — one run read every file it had written looking for a `<Html>` import
// that was never there, and another got ENOTEMPTY on node_modules/next.
test('an install or a build stops the dev server before it runs', async () => {
  const seen: string[] = [];
  const commandsTool = {
    name: 'commands',
    description: 'run',
    inputSchema: {},
    handler: async (args: { command?: string }) => {
      seen.push(args.command || '');
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  } as unknown as ClaudeMcpTool;

  const [wrapped] = wrapSandboxTools([commandsTool]);
  await wrapped.handler({ command: 'npm install next@15' }, {});
  await wrapped.handler({ command: 'npm run build' }, {});
  await wrapped.handler({ command: 'ls -la' }, {});

  const [install, build, listing] = seen;
  for (const command of [install, build]) {
    assert.match(command, /^stop_announce=/);
    assert.match(command, /stop_makers_dev/);
    // Said out loud, or the model goes on describing a preview that is down.
    assert.match(command, /edgeone makers dev/);
  }
  // Everything else is left alone: reading a file or listing a directory does
  // not contend with the server, and tearing down a working preview to run one
  // would make the preview the least reliable thing in the session.
  assert.equal(listing, 'ls -la');
});

test('a command that only mentions npm install in quotes does not stop the preview', async () => {
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

  const [wrapped] = wrapSandboxTools([commandsTool]);
  await wrapped.handler({ command: 'pgrep -af "npm install|npm ci"' }, {});

  assert.equal(received, 'pgrep -af "npm install|npm ci"');
  assert.doesNotMatch(received, /stop_makers_dev/);
});

test('commands in a .cool sandbox inherit the Tencent npm registry', async () => {
  let received: Record<string, unknown> = {};
  const commandsTool = {
    name: 'commands',
    description: 'run',
    inputSchema: {},
    handler: async (args: Record<string, unknown>) => {
      received = args;
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  } as unknown as ClaudeMcpTool;
  const [wrapped] = wrapSandboxTools([commandsTool], {
    conversationId: 'cid-cool-registry',
    context: {} as never,
    state: projectState('projects/demo', { siteDomain: 'edgeone.cool' }),
  });

  await wrapped.handler({
    command: 'npm view react version',
    env: { KEEP_ME: 'yes', NPM_CONFIG_REGISTRY: 'https://registry.npmjs.org' },
  }, {});

  assert.deepEqual(received.env, {
    KEEP_ME: 'yes',
    NPM_CONFIG_REGISTRY: TENCENT_NPM_REGISTRY,
  });
});

test('.dev commands override their existing registry with the official source', async () => {
  let received: Record<string, unknown> = {};
  const commandsTool = {
    name: 'commands',
    description: 'run',
    inputSchema: {},
    handler: async (args: Record<string, unknown>) => {
      received = args;
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  } as unknown as ClaudeMcpTool;
  const [wrapped] = wrapSandboxTools([commandsTool], {
    conversationId: 'cid-dev-registry',
    context: {} as never,
    state: projectState('projects/demo', { siteDomain: 'edgeone.dev' }),
  });

  await wrapped.handler({
    command: 'npm view react version',
    env: { NPM_CONFIG_REGISTRY: 'https://registry.example.com' },
  }, {});

  assert.deepEqual(received.env, {
    NPM_CONFIG_REGISTRY: OFFICIAL_NPM_REGISTRY,
  });
});

test('local commands use the Tencent npm registry when no public domain is known', async () => {
  let received: Record<string, unknown> = {};
  const commandsTool = {
    name: 'commands',
    description: 'run',
    inputSchema: {},
    handler: async (args: Record<string, unknown>) => {
      received = args;
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  } as unknown as ClaudeMcpTool;
  const [wrapped] = wrapSandboxTools([commandsTool], {
    conversationId: 'cid-local-registry',
    context: {} as never,
    state: projectState(),
  });

  await wrapped.handler({ command: 'npm install react' }, {});

  assert.deepEqual(received.env, {
    NPM_CONFIG_REGISTRY: TENCENT_NPM_REGISTRY,
  });
});


test('edgeone makers dev and deploy are refused', async () => {
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

  const [wrapped] = wrapSandboxTools([commandsTool]);
  const preview = await wrapped.handler({ command: 'edgeone makers dev --port 8088' }, {});
  assert.equal(received, '');
  assert.equal(preview.isError, true);
  assert.match((preview.content[0] as { text: string }).text, /start_preview/);

  const deploy = await wrapped.handler({ command: 'edgeone makers deploy -n demo' }, {});
  assert.equal(received, '');
  assert.equal(deploy.isError, true);
  assert.match((deploy.content[0] as { text: string }).text, /deploy_project/);
});

test('version check reports a terminal error when the sandbox CLI is absent', async () => {
  const commandsTool = {
    name: 'commands',
    description: 'run',
    inputSchema: {},
    handler: async () => ({
      content: [{
        type: 'text',
        text: JSON.stringify({
          stdout: 'EDGEONE_VERSION_EXIT:127\n',
          stderr: '/bin/sh: 2: edgeone: not found\n',
          exitCode: 0,
        }),
      }],
    }),
  } as unknown as ClaudeMcpTool;
  const [wrapped] = wrapSandboxTools([commandsTool]);

  const result = await wrapped.handler({ command: 'edgeone --version' }, {});
  const output = result.content.map((item) => (
    item && typeof item === 'object' && 'text' in item ? item.text : ''
  )).join('\n');

  assert.equal(result.isError, true);
  assert.match(output, /MAKERS_CLI_UNAVAILABLE/);
  assert.match(output, /"retryable":false/);
  assert.match(output, /Do not inspect PATH/);
});


/**
 * The wrapper has to register a command before it runs and drop it after, and
 * the only thing that ties a chunk of sandbox output to a row is the tool-use
 * id the agent loop put in the MCP request `_meta`. Both halves are exercised
 * here through the real sink, because a chunk that arrives for a command the
 * wrapper never registered is silently discarded.
 */
test('live sandbox output patches the row of the command that produced it', async () => {
  const { installCommandOutputStream } = await import('../agents/_lib/tools/command-stream.ts');
  const sink: { handler?: (chunk: unknown) => void } = {};
  const context = {
    env: {},
    tools: {
      toClaudeMcpServer: () => ({ tools: [], allowedTools: [] }),
      setCommandOutputHandler: (handler: (chunk: unknown) => void) => {
        sink.handler = handler;
      },
    },
    sandbox: {
      files: { write: async () => {} },
      commands: { run: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
    },
  };
  const state = projectState();
  const sent: { type: string; data?: Record<string, unknown> }[] = [];
  const commandsTool = {
    name: 'commands',
    description: 'run',
    inputSchema: {},
    handler: async (args: { command?: string }, extra: unknown) => {
      const toolUseId = (extra as { _meta?: Record<string, string> })._meta?.['claudecode/toolUseId'];
      // The runtime emits with the id it read off the same request.
      sink.handler?.({ stream: 'stdout', data: 'Compiling…\n', command: args.command, toolUseId });
      sink.handler?.({ stream: 'stderr', data: 'warning: large chunk\n', command: args.command, toolUseId });
      return { content: [{ type: 'text', text: 'ok' }] };
    },
  } as unknown as ClaudeMcpTool;

  const stream = installCommandOutputStream({
    context: context as never,
    getSend: () => (event) => sent.push(event as never),
    getProjectDir: () => state.appDir,
    intervalMs: 0,
  });
  const [wrapped] = wrapSandboxTools([commandsTool], {
    conversationId: 'cid-commands-wrap',
    context: context as never,
    state,
    commandStream: stream,
  });

  await wrapped.handler({ command: 'npm run build' }, {
    _meta: { 'claudecode/toolUseId': 'toolu_live' },
  });

  const patches = sent.filter((event) => event.type === 'tool_use');
  assert.ok(patches.length >= 1, 'the running command repainted its row');
  const last = patches.at(-1);
  assert.equal(last?.data?.id, 'toolu_live');
  assert.match(String(last?.data?.outputSummary), /Compiling/);

  // Registered for exactly as long as the process lived: a chunk that arrives
  // after the call returned belongs to no row.
  sent.length = 0;
  sink.handler?.({ stream: 'stdout', data: 'late\n', command: 'npm run build', toolUseId: 'toolu_live' });
  assert.equal(sent.length, 0);
});

test('a command run without an output sink still executes', async () => {
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

  const [wrapped] = wrapSandboxTools([commandsTool], {
    conversationId: 'cid-commands-wrap',
    context: { env: {} } as never,
    state: projectState(),
    commandStream: null,
  });
  const result = await wrapped.handler({ command: 'ls -la' }, {});
  assert.equal(received, 'ls -la');
  assert.equal(result.isError, undefined);
});
