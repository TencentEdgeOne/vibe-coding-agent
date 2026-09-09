import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  formatCommandError,
  formatCommandExit,
  runCommand,
  runCommandCapturingExit,
} from '../agents/core/_commands.ts';
import { createLocalWorkspacePort } from '../agents/core/adapters/_local.ts';
import {
  parseEchoedExitCode,
  stripEchoedExit,
  withExitCodeEcho,
} from '../agents/utils/_tool-phase.ts';
import type { CommandResult, WorkspacePort } from '../agents/core/_ports.ts';

const ECHO_HELPERS = { withExitCodeEcho, parseEchoedExitCode, stripEchoedExit };

/** A workspace whose command runner is scripted, for the paths a shell cannot produce. */
function scriptedWorkspace(run: (command: string) => Promise<CommandResult>): WorkspacePort {
  return {
    files: {
      exists: async () => false,
      read: async () => '',
      write: async () => {},
      makeDir: async () => {},
    },
    commands: { run: (command) => run(command) },
    persist: async () => {},
    restore: async () => {},
  };
}

async function realWorkspace() {
  return createLocalWorkspacePort(await mkdtemp(path.join(tmpdir(), 'vca-cmd-')));
}

test('a successful command returns its output against a real shell', async () => {
  const result = await runCommand(await realWorkspace(), 'echo hello');
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trim(), 'hello');
});

// A failing build is an outcome the agent reasons about, not an exception.
test('a non-zero exit is returned as data, not thrown', async () => {
  const result = await runCommand(await realWorkspace(), 'echo oops >&2; exit 3');
  assert.equal(result.exitCode, 3);
  assert.equal(result.stderr.trim(), 'oops');
});

// Some sandbox failures surface as a bare exit code with no diagnostics at all.
test('a silent failure gets a synthesized description instead of two empty strings', async () => {
  const workspace = scriptedWorkspace(async () => ({ exitCode: 137, stdout: '', stderr: '' }));
  const result = await runCommand(workspace, 'npm run build', { cwd: 'app', timeout: 30 });

  assert.equal(result.exitCode, 137);
  assert.match(result.stderr, /exited with code 137/);
  assert.match(result.stderr, /npm run build/);
  assert.match(result.stderr, /cwd: app/);
  assert.match(result.stderr, /timeout: 30s/);
});

test('real output is never replaced by the synthesized description', async () => {
  const workspace = scriptedWorkspace(async () => ({
    exitCode: 1,
    stdout: '',
    stderr: 'TS2339: Property does not exist',
  }));
  const result = await runCommand(workspace, 'tsc');

  assert.equal(result.stderr, 'TS2339: Property does not exist');
  assert.doesNotMatch(result.stderr, /exited with code/);
});

test('a transport failure throws with the invocation attached', async () => {
  const workspace = scriptedWorkspace(async () => {
    throw Object.assign(new Error('sandbox unreachable'), { stderr: 'route not found' });
  });

  await assert.rejects(
    () => runCommand(workspace, 'npm install', { cwd: 'app', timeout: 120 }),
    (error: Error) => {
      assert.match(error.message, /failed while running: npm install/);
      assert.match(error.message, /cwd: app/);
      assert.match(error.message, /timeout: 120s/);
      assert.match(error.message, /error: sandbox unreachable/);
      assert.match(error.message, /stderr: route not found/);
      return true;
    },
  );
});

test('long output in an error message is truncated', () => {
  const message = formatCommandError(
    Object.assign(new Error('boom'), { stdout: 'x'.repeat(5_000) }),
    'npm run build',
    {},
  );

  assert.ok(message.includes('...'));
  assert.ok(message.length < 3_000);
});

test('the exit description omits fields that were not supplied', () => {
  const bare = formatCommandExit('ls', {}, 1);
  assert.equal(bare, 'Sandbox command exited with code 1 while running: ls');
  assert.doesNotMatch(bare, /cwd:/);
  assert.doesNotMatch(bare, /timeout:/);
});

// Some hosts discard output when the shell exits non-zero, which is exactly the
// output a failing verification needs to show.
test('the echoed exit code wins over the shell exit code', async () => {
  const workspace = await realWorkspace();
  const result = await runCommandCapturingExit(
    workspace,
    'echo compiling; exit 2',
    {},
    ECHO_HELPERS,
  );

  assert.equal(result.exitCode, 2);
  assert.match(result.stdout, /compiling/);
  // The marker itself is stripped so the model does not see the plumbing.
  assert.doesNotMatch(result.stdout, /EXIT:/);
});

test('a successful verification reports exit 0 with the marker stripped', async () => {
  const result = await runCommandCapturingExit(
    await realWorkspace(),
    'echo build ok',
    {},
    ECHO_HELPERS,
  );

  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /build ok/);
  assert.doesNotMatch(result.stdout, /EXIT:/);
});

test('without an echoed marker the original result passes through unchanged', async () => {
  const workspace = scriptedWorkspace(async () => ({
    exitCode: 0,
    stdout: 'no marker here',
    stderr: '',
  }));
  const result = await runCommandCapturingExit(workspace, 'echo hi', {}, ECHO_HELPERS);

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'no marker here');
});

test('command execution needs no host runtime', async () => {
  const source = await import('node:fs/promises')
    .then((fs) => fs.readFile('agents/core/_commands.ts', 'utf8'));
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  assert.doesNotMatch(code, /context/);
  assert.doesNotMatch(code, /sandbox\./);
});
