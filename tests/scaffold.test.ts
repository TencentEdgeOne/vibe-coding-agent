import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { repairNestedAppDirLayout } from '../agents/_lib/project/layout.ts';
import { projectState } from './helpers/fixtures.ts';

const execFileAsync = promisify(execFile);

async function scaffoldFixture(files: Record<string, string> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'makers-scaffold-'));
  const state = projectState('projects/demo');
  const abs = (relative: string) => path.join(root, relative);

  for (const [relative, content] of Object.entries(files)) {
    await mkdir(path.dirname(abs(relative)), { recursive: true });
    await writeFile(abs(relative), content);
  }

  const calls = { makeDir: 0, exists: 0, commands: [] as string[] };
  const context = {
    sandbox: {
      files: {
        makeDir: async (target: string) => {
          calls.makeDir += 1;
          await mkdir(abs(target), { recursive: true });
        },
        exists: async (target: string) => {
          calls.exists += 1;
          return existsSync(abs(target));
        },
        write: async (target: string, content: string) => {
          await mkdir(path.dirname(abs(target)), { recursive: true });
          await writeFile(abs(target), content);
        },
      },
      commands: {
        run: async (command: string, options: { cwd?: string } = {}) => {
          calls.commands.push(command);
          const { stdout, stderr } = await execFileAsync('sh', ['-c', command], {
            cwd: abs(options.cwd || '.'),
          });
          return { exitCode: 0, stdout, stderr };
        },
      },
    },
  };

  return {
    context,
    state,
    calls,
    exists: (relative: string) => existsSync(abs(relative)),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test('a sandbox that fails the repair command does not fail the turn', async () => {
  const fixture = await scaffoldFixture({
    'projects/demo/app/projects/demo/app/package.json': '{"name":"nested"}',
  });
  fixture.context.sandbox.commands.run = async (command: string) => {
    fixture.calls.commands.push(command);
    if (command.includes('NESTED=')) {
      throw new Error(
        'Sandbox command failed [instanceId=test]: exit status 1 '
        + '(code=SANDBOX_UNKNOWN_ERROR, operation=command)',
      );
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };

  try {
    assert.equal(await repairNestedAppDirLayout(fixture.context, fixture.state), false);
  } finally {
    await fixture.cleanup();
  }
});

test('a nested app directory is lifted back to the project root', async () => {
  const fixture = await scaffoldFixture({
    'projects/demo/app/projects/demo/app/package.json': '{"name":"nested"}',
    'projects/demo/app/projects/demo/app/src/App.tsx': 'export default () => null;\n',
  });
  try {
    assert.equal(await repairNestedAppDirLayout(fixture.context, fixture.state), true);

    assert.equal(fixture.exists('projects/demo/app/package.json'), true);
    assert.equal(fixture.exists('projects/demo/app/src/App.tsx'), true);
    assert.equal(fixture.exists('projects/demo/app/projects'), false);
  } finally {
    await fixture.cleanup();
  }
});

test('a healthy project is left untouched by the repair', async () => {
  const fixture = await scaffoldFixture({
    'projects/demo/app/package.json': '{"name":"healthy"}',
  });
  try {
    assert.equal(await repairNestedAppDirLayout(fixture.context, fixture.state), false);
    assert.equal(fixture.exists('projects/demo/app/package.json'), true);
  } finally {
    await fixture.cleanup();
  }
});

test('a nested directory with no project in it is not lifted', async () => {
  const fixture = await scaffoldFixture({
    'projects/demo/app/package.json': '{"name":"real"}',
    'projects/demo/app/projects/demo/app/notes.txt': 'not a project\n',
  });
  try {
    assert.equal(await repairNestedAppDirLayout(fixture.context, fixture.state), false);
    assert.equal(fixture.exists('projects/demo/app/notes.txt'), false);
    assert.equal(fixture.exists('projects/demo/app/package.json'), true);
  } finally {
    await fixture.cleanup();
  }
});
