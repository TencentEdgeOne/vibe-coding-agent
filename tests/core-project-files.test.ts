import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createProjectFiles,
  installProjectDependencies,
} from '../agents/core/_project-files.ts';
import { createLocalWorkspacePort } from '../agents/core/adapters/_local.ts';
import type { CommandResult, WorkspacePort } from '../agents/core/_ports.ts';

const PROJECT_DIR = 'projects/conv-1/app';

async function realProject() {
  const root = await mkdtemp(path.join(tmpdir(), 'vca-proj-'));
  const workspace = createLocalWorkspacePort(root);
  return { root, workspace, files: createProjectFiles(workspace, PROJECT_DIR) };
}

/** Records which paths were asked for, to pin down prefixing. */
function recordingWorkspace(existing: string[] = []) {
  const asked: string[] = [];
  const commands: string[] = [];
  const workspace: WorkspacePort = {
    files: {
      async exists(target) {
        asked.push(target);
        return existing.includes(target);
      },
      read: async () => '',
      write: async () => {},
      makeDir: async () => {},
    },
    commands: {
      async run(command): Promise<CommandResult> {
        commands.push(command);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
    persist: async () => {},
    restore: async () => {},
  };
  return { workspace, asked, commands };
}

test('paths are resolved under the project directory', () => {
  const { workspace } = recordingWorkspace();
  const files = createProjectFiles(workspace, PROJECT_DIR);

  assert.equal(files.resolve('package.json'), `${PROJECT_DIR}/package.json`);
  assert.equal(files.resolve('src/App.tsx'), `${PROJECT_DIR}/src/App.tsx`);
  // An empty relative path addresses the project directory itself.
  assert.equal(files.resolve(''), PROJECT_DIR);
});

test('the well-known project probes ask for the right paths', async () => {
  const { workspace, asked } = recordingWorkspace();
  const files = createProjectFiles(workspace, PROJECT_DIR);

  await files.hasPackageJson();
  await files.hasNodeModules();
  await files.projectExists();

  assert.deepEqual(asked, [
    `${PROJECT_DIR}/package.json`,
    `${PROJECT_DIR}/node_modules`,
    PROJECT_DIR,
  ]);
});

test('findFirst returns the first existing candidate and stops looking', async () => {
  const { workspace, asked } = recordingWorkspace([`${PROJECT_DIR}/vite.config.js`]);
  const files = createProjectFiles(workspace, PROJECT_DIR);

  const found = await files.findFirst(['vite.config.ts', 'vite.config.js', 'vite.config.mjs']);

  assert.equal(found, 'vite.config.js');
  // The third candidate is never probed.
  assert.deepEqual(asked, [
    `${PROJECT_DIR}/vite.config.ts`,
    `${PROJECT_DIR}/vite.config.js`,
  ]);
});

test('findFirst returns an empty string when nothing matches', async () => {
  const { workspace } = recordingWorkspace();
  const files = createProjectFiles(workspace, PROJECT_DIR);
  assert.equal(await files.findFirst(['a.ts', 'b.ts']), '');
});

test('writeFile creates the parent directory and lands on real disk', async () => {
  const { root, files } = await realProject();

  await files.writeFile('src/components/Button.tsx', 'export const Button = () => null;');

  const written = await readFile(
    path.join(root, PROJECT_DIR, 'src/components/Button.tsx'),
    'utf8',
  );
  assert.equal(written, 'export const Button = () => null;');
  assert.equal(await files.exists('src/components/Button.tsx'), true);
});

test('writeFile handles a root-level file with no parent segment', async () => {
  const { root, files } = await realProject();

  await files.writeFile('package.json', '{"name":"app"}');

  assert.equal(
    await readFile(path.join(root, PROJECT_DIR, 'package.json'), 'utf8'),
    '{"name":"app"}',
  );
  assert.equal(await files.hasPackageJson(), true);
});

test('reads and writes round-trip through the project directory', async () => {
  const { files } = await realProject();

  await files.writeFile('index.html', '<h1>hi</h1>');
  assert.equal(await files.read('index.html'), '<h1>hi</h1>');

  await files.makeDir('assets');
  assert.equal(await files.exists('assets'), true);
});

test('a project without package.json installs nothing', async () => {
  const { workspace, commands } = recordingWorkspace();
  assert.equal(await installProjectDependencies(workspace, PROJECT_DIR), false);
  assert.deepEqual(commands, []);
});

// A restored workspace already has its dependencies; installing again is waste.
test('an existing node_modules skips the install', async () => {
  const { workspace, commands } = recordingWorkspace([
    `${PROJECT_DIR}/package.json`,
    `${PROJECT_DIR}/node_modules`,
  ]);

  assert.equal(await installProjectDependencies(workspace, PROJECT_DIR), false);
  assert.deepEqual(commands, []);
});

test('a project with package.json and no node_modules installs in the project directory', async () => {
  const { workspace, commands } = recordingWorkspace([`${PROJECT_DIR}/package.json`]);
  const runs: { cwd?: string; timeout?: number }[] = [];
  workspace.commands.run = async (command, options) => {
    commands.push(command);
    runs.push(options ?? {});
    return { exitCode: 0, stdout: '', stderr: '' };
  };

  assert.equal(await installProjectDependencies(workspace, PROJECT_DIR), true);
  assert.deepEqual(commands, ['npm install --no-audit --no-fund']);
  assert.equal(runs[0]?.cwd, PROJECT_DIR);
  assert.equal(runs[0]?.timeout, 300);
});

test('project file operations need no host runtime', async () => {
  const source = await import('node:fs/promises')
    .then((fs) => fs.readFile('agents/core/_project-files.ts', 'utf8'));
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  assert.doesNotMatch(code, /context/);
  assert.doesNotMatch(code, /sandbox\./);
});
