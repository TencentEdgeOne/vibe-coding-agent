import assert from 'node:assert/strict';
import test from 'node:test';
import {
  finishProjectWrite,
  guardProjectWrite,
  type ProjectWriteHost,
} from '../agents/_lib/tools/project-write-hooks.ts';
import { projectState } from './helpers/fixtures.ts';
import { TENCENT_NPM_REGISTRY } from '../agents/_lib/makers/npm-install.ts';

function host(overrides: Partial<ProjectWriteHost> = {}): ProjectWriteHost {
  const made: string[] = [];
  return {
    context: {
      sandbox: {
        files: {
          makeDir: async (path: string) => { made.push(path); },
          write: async () => undefined,
        },
        commands: { run: async () => ({ stdout: '', stderr: '', exitCode: 0 }) },
      },
    } as ProjectWriteHost['context'],
    state: projectState(),
    ...overrides,
  };
}

function decision(result: Awaited<ReturnType<typeof guardProjectWrite>>) {
  const specific = result.hookSpecificOutput;
  if (!specific || specific.hookEventName !== 'PreToolUse') return undefined;
  return specific.permissionDecision;
}

test('a project write is rewritten onto the sandbox path and its parent is created', async () => {
  const made: string[] = [];
  const result = await guardProjectWrite(host({
    context: {
      sandbox: {
        files: { makeDir: async (path: string) => { made.push(path); } },
      },
    } as ProjectWriteHost['context'],
  }), {
    toolName: 'mcp__edgeone-sandbox__files_write',
    toolInput: { path: 'src/App.tsx', content: 'export default () => null;\n' },
  });

  const specific = result.hookSpecificOutput;
  assert.equal(specific?.hookEventName, 'PreToolUse');
  assert.equal(decision(result), undefined);
  if (specific?.hookEventName !== 'PreToolUse') return;
  assert.equal(specific.updatedInput?.path, 'projects/demo/app/src/App.tsx');
  assert.deepEqual(made, ['projects/demo/app/src']);
});

test('an appDir prefix is stripped before the sandbox path is joined', async () => {
  const result = await guardProjectWrite(host(), {
    toolName: 'files_write',
    toolInput: { path: 'projects/demo/app/package.json', content: '{}\n' },
  });
  const specific = result.hookSpecificOutput;
  assert.equal(specific?.hookEventName, 'PreToolUse');
  if (specific?.hookEventName !== 'PreToolUse') return;
  assert.equal(specific.updatedInput?.path, 'projects/demo/app/package.json');
});

test('blocked and escaping paths are refused before anything is written', async () => {
  const env = await guardProjectWrite(host(), {
    toolName: 'files_write',
    toolInput: { path: '.env', content: 'AI_GATEWAY_API_KEY=sk-test\n' },
  });
  assert.equal(decision(env), 'deny');

  const escape = await guardProjectWrite(host(), {
    toolName: 'files_write',
    toolInput: { path: '../secret.txt', content: 'nope' },
  });
  assert.equal(decision(escape), 'deny');
});

test('other tools and a failed write do not run the after-write work', async () => {
  const written: string[] = [];
  const target = host({ onWritten: ({ path }) => { written.push(path); } });
  assert.deepEqual(await guardProjectWrite(target, {
    toolName: 'mcp__edgeone-sandbox__commands',
    toolInput: { cmd: 'npm install' },
  }), {});
  assert.deepEqual(await finishProjectWrite(target, {
    toolName: 'files_write',
    toolInput: { path: 'src/App.tsx', content: 'x' },
    toolResponse: { isError: true },
  }), {});
  assert.deepEqual(written, []);
});

test('the package.json warmup uses the Tencent npm registry', async () => {
  let options: Record<string, unknown> = {};
  const target = host({
    state: projectState('projects/demo', { siteDomain: 'edgeone.cool' }),
    context: {
      sandbox: {
        files: {
          makeDir: async () => undefined,
          read: async () => { throw new Error('missing'); },
          write: async () => undefined,
        },
        commands: {
          run: async (_command: string, received?: Record<string, unknown>) => {
            options = received || {};
            return { stdout: '', stderr: '', exitCode: 0 };
          },
        },
      },
    } as ProjectWriteHost['context'],
  });

  await finishProjectWrite(target, {
    toolName: 'files_write',
    toolInput: { path: 'package.json', content: '{"name":"demo"}\n' },
  });

  assert.deepEqual(options.env, { NPM_CONFIG_REGISTRY: TENCENT_NPM_REGISTRY });
});
