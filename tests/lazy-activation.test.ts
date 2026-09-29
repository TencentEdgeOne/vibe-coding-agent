import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import { activateSandbox } from '../agents/_lib/lazy/sandbox.ts';
import { ensurePreview } from '../agents/_lib/lazy/preview.ts';
import { createProjectState } from '../agents/_lib/project/state.ts';
import type { AgentContext, BlobStoreLike } from '../agents/_lib/runtime/context.ts';
import { runProjectResumePreviewPipeline } from '../agents/_lib/session/resume.ts';
import {
  createMemoryBlobStore,
  getConversationRecord,
  patchConversationRecord,
  saveProjectState,
} from '../agents/_lib/session/store.ts';
import { timeStage } from '../agents/_lib/utils/timing.ts';

function memoryContext() {
  const inner = createMemoryBlobStore();
  const stats = { gets: 0 };
  const blobStore: BlobStoreLike = {
    set: (key, value, options) => inner.set(key, value, options),
    delete: (key) => inner.delete(key),
    list: (options) => inner.list(options),
    async get(key, options) {
      stats.gets += 1;
      return inner.get(key, options);
    },
    setJSON: (key, value, options) => inner.setJSON(key, value, options),
  };
  return { blobStore, stats };
}

function sandboxContext(conversationId: string) {
  const { blobStore } = memoryContext();
  const calls = { extendTimeout: 0, makeDir: 0, restore: 0, commands: [] as string[] };
  const sandbox = {
    envdAccessToken: 'token-current',
    extendTimeout: async () => {
      calls.extendTimeout += 1;
    },
    getHost: async (port: number) => `preview-${port}.sandbox.example`,
    restore: async () => {
      calls.restore += 1;
      return { restored: true };
    },
    files: {
      makeDir: async () => {
        calls.makeDir += 1;
      },
      exists: async (target: string) => target.endsWith('/package.json'),
    },
    commands: {
      run: async (command: string) => {
        calls.commands.push(command);
        if (command.includes('npm install')) {
          return { exitCode: 1, stdout: '', stderr: 'npm failed' };
        }
        if (command.includes('curl')) {
          return { exitCode: 1, stdout: 'EXIT:1\n', stderr: '' };
        }
        if (command.includes('find')) {
          return { exitCode: 0, stdout: 'f\t1\t12\t./index.html\n', stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
  };
  const context = { conversation_id: conversationId, blobStore, sandbox } as unknown as AgentContext;
  return {
    context,
    calls,
    releaseInstall: () => {},
  };
}

test('a conversation record patch is visible to the next read on the same context', async () => {
  const { blobStore, stats } = memoryContext();
  const context = { blobStore };
  await getConversationRecord(context, 'cid-cache');
  const getsAfterFirstRead = stats.gets;
  await getConversationRecord(context, 'cid-cache');
  assert.equal(stats.gets, getsAfterFirstRead, 'the second read must reuse the per-request memo');

  await patchConversationRecord(context, 'cid-cache', { modelPreference: 'kimi-k2.6' });
  const record = await getConversationRecord(context, 'cid-cache');
  assert.equal(record.modelPreference, 'kimi-k2.6');
});

test('a conversation record patch reads through the memo then refreshes it', async () => {
  const { blobStore } = memoryContext();
  const context = { blobStore };
  const cached = await getConversationRecord(context, 'cid-cache-fresh');
  await blobStore.setJSON('conv/cid-cache-fresh/state.json', {
    projectState: cached.projectState,
    modelPreference: 'from-disk',
  });

  const stale = await getConversationRecord(context, 'cid-cache-fresh');
  assert.equal(stale.modelPreference, undefined);

  await patchConversationRecord(context, 'cid-cache-fresh', { languagePreference: 'zh' });
  const next = await getConversationRecord(context, 'cid-cache-fresh');
  assert.equal(next.modelPreference, 'from-disk');
  assert.equal(next.languagePreference, 'zh');
});

test('timeStage logs the agent instance that ran the stage', async () => {
  const lines: unknown[][] = [];
  const original = console.info;
  console.info = (...args: unknown[]) => {
    lines.push(args);
  };
  try {
    const value = await timeStage('sandbox:activate', { conversationId: 'cid' }, async () => 7);
    assert.equal(value, 7);
    const entry = lines.find((line) => line[0] === '[sandbox:activate]');
    assert.ok(entry, 'the stage must be logged');
    assert.equal(typeof (entry[1] as { instance?: string }).instance, 'string');
  } finally {
    console.info = original;
  }
});

test('a brand-new project activates once per request and does not probe or restore', async () => {
  const fixture = sandboxContext('cid-fresh');

  const first = await activateSandbox(fixture.context, 'cid-fresh');
  const second = await activateSandbox(fixture.context, 'cid-fresh');

  assert.equal(first, second, 'a repeat in the same request returns the settled handle');
  assert.equal(first.hasFiles, false);
  assert.equal(fixture.calls.extendTimeout, 1);
  assert.equal(fixture.calls.makeDir, 2);
  assert.equal(fixture.calls.restore, 0);
  assert.equal(fixture.calls.commands.length, 0);
  assert.equal(await first.dependenciesReady, true);
});

test('creating the app directory tolerates an existing projects parent', async () => {
  const fixture = sandboxContext('cid-eexist');
  const sandbox = (fixture.context as unknown as {
    sandbox: { files: { makeDir: () => Promise<void> } };
  }).sandbox;
  sandbox.files.makeDir = async () => {
    fixture.calls.makeDir += 1;
    throw new Error(
      'Sandbox directory create failed: projects/cid-eexist/app [instanceId=abc]: mkdir /home/user/projects: file exists (code=SANDBOX_UNKNOWN_ERROR, operation=file)',
    );
  };

  const handle = await activateSandbox(fixture.context, 'cid-eexist');

  assert.equal(handle.hasFiles, false);
  assert.deepEqual(
    fixture.calls.commands.filter((command) => command.startsWith('mkdir -p ')),
    ["mkdir -p 'projects/cid-eexist'", "mkdir -p 'projects/cid-eexist/app'"],
  );
});

test('npm install starts in the background and does not block activation', async () => {
  const fixture = sandboxContext('cid-npm');
  const sandbox = (fixture.context as unknown as {
    sandbox: { commands: { run: (command: string) => Promise<unknown> } };
  }).sandbox;
  sandbox.commands.run = async (command: string) => {
    fixture.calls.commands.push(command);
    if (command.includes('npm install')) {
      return new Promise((resolve) => {
        fixture.releaseInstall = () => resolve({ exitCode: 0, stdout: '', stderr: '' });
      });
    }
    if (command.includes('find')) {
      return { exitCode: 0, stdout: 'f\t1\t12\t./index.html\n', stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const state = createProjectState('cid-npm');
  state.created = true;
  await saveProjectState(fixture.context, 'cid-npm', state);

  const pending = activateSandbox(fixture.context, 'cid-npm');
  const winner = await Promise.race([
    pending.then(() => 'activated' as const),
    new Promise<'blocked'>((resolve) => {
      setTimeout(() => resolve('blocked'), 50);
    }),
  ]);
  assert.equal(winner, 'activated', 'restore must not await npm install');

  await setImmediate();
  await setImmediate();
  const installs = fixture.calls.commands.filter((command) => command.includes('npm install'));
  assert.equal(installs.length, 1, 'activation starts one install and restore does not start another');

  const handle = await pending;
  let ready = false;
  const waiting = handle.dependenciesReady.then((value) => {
    ready = value;
  });
  await setImmediate();
  assert.equal(ready, false, 'the install is still running when activation has returned');
  fixture.releaseInstall();
  await waiting;
  assert.equal(ready, true);
});

test('a sandbox install failure stays a failed install and does not kill the process', async () => {
  const fixture = sandboxContext('cid-npm-217');
  const sandbox = (fixture.context as unknown as {
    sandbox: { commands: { run: (command: string) => Promise<unknown> } };
  }).sandbox;
  sandbox.commands.run = async (command: string) => {
    fixture.calls.commands.push(command);
    if (command.includes('npm install')) {
      throw new Error(
        'Sandbox command failed [instanceId=7orydnbqxrfke42enq3cxylbye7mem3ij3sddj3h]: exit status 217 (code=SANDBOX_UNKNOWN_ERROR, operation=command)',
      );
    }
    if (command.includes('find')) {
      return { exitCode: 0, stdout: 'f\t1\t12\t./index.html\n', stderr: '' };
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const state = createProjectState('cid-npm-217');
  state.created = true;
  await saveProjectState(fixture.context, 'cid-npm-217', state);

  const rejections: unknown[] = [];
  const onRejection = (error: unknown) => {
    rejections.push(error);
  };
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  process.on('unhandledRejection', onRejection);
  try {
    const handle = await activateSandbox(fixture.context, 'cid-npm-217');
    assert.equal(await handle.dependenciesReady, false);
    await setImmediate();
    await setImmediate();
    assert.equal(rejections.length, 0, 'the install rejection must not escape activation');
    const install = fixture.calls.commands.find((command) => command.includes('npm install'));
    assert.match(install || '', /echo EXIT:\$\?/);
    assert.ok(
      warnings.some((line) => line[0] === '[sandbox]'
        && (line[1] as { stage?: string }).stage === 'dependencies-failed'),
      'the failure is logged where the file read can leave it behind',
    );
  } finally {
    process.off('unhandledRejection', onRejection);
    console.warn = originalWarn;
  }
});

test('the same sandbox skips a second probe, and a new one restores again', async () => {
  const first = sandboxContext('cid-generation');
  const present = new Set([
    'projects/cid-generation/app',
    'projects/cid-generation/app/package.json',
    'projects/cid-generation/app/node_modules',
  ]);
  const sandbox = (first.context as unknown as { sandbox: { files: { exists: (target: string) => Promise<boolean> } } }).sandbox;
  sandbox.files.exists = async (target: string) => present.has(target);
  const state = createProjectState('cid-generation');
  state.created = true;
  await saveProjectState(first.context, 'cid-generation', state);

  const restored = await activateSandbox(first.context, 'cid-generation');
  assert.equal(restored.hasFiles, true);
  assert.equal(first.calls.restore, 0, 'files already in the sandbox are not unpacked again');
  const probes = first.calls.commands.filter((command) => command.includes('find')).length;
  assert.equal(probes, 1);

  const again = {
    conversation_id: 'cid-generation',
    blobStore: (first.context as { blobStore: BlobStoreLike }).blobStore,
    sandbox,
  } as unknown as AgentContext;
  await activateSandbox(again, 'cid-generation');
  assert.equal(
    first.calls.commands.filter((command) => command.includes('find')).length,
    probes,
    'the same sandbox object does not probe again',
  );
  assert.equal(first.calls.extendTimeout, 2, 'a later request still keeps the VM alive');

  const next = sandboxContext('cid-generation');
  (next.context as { blobStore: BlobStoreLike }).blobStore = (
    first.context as { blobStore: BlobStoreLike }
  ).blobStore;
  (next.context as unknown as { sandbox: { files: { exists: () => Promise<boolean> } } }).sandbox.files.exists = async () => false;
  await activateSandbox(next.context, 'cid-generation');
  assert.equal(next.calls.restore, 1, 'a new sandbox restores the snapshot');
});

test('ensurePreview waits for dependencies before starting the dev server', async () => {
  const fixture = sandboxContext('cid-preview-deps');
  const state = createProjectState('cid-preview-deps');
  state.created = true;

  await assert.rejects(
    ensurePreview(fixture.context, 'cid-preview-deps', state),
    /Project dependencies are not available for the preview/,
  );
  assert.equal(
    fixture.calls.commands.filter((command) => command.includes('npm install')).length,
    1,
  );
  assert.equal(
    fixture.calls.commands.filter((command) => command.includes('makers dev')).length,
    0,
    'makers dev must not start when dependencies are not ready',
  );
});

test('an empty preview refresh does not boot the sandbox', async () => {
  const fixture = sandboxContext('cid-preview-empty');
  const response = await runProjectResumePreviewPipeline(fixture.context);
  const body = await response.json() as { preview?: { url?: string } };

  assert.equal(body.preview?.url, undefined);
  assert.equal(fixture.calls.extendTimeout, 0);
  assert.equal(fixture.calls.restore, 0);
  assert.equal(fixture.calls.commands.length, 0);
});

test('workspace status is announced only while a cold sandbox is being prepared', async () => {
  const phases: string[] = [];
  const send = (event: { type: string; data?: { phase?: string } }) => {
    if (event.type === 'prepare_phase' && event.data?.phase) phases.push(event.data.phase);
  };

  const fresh = sandboxContext('cid-prepare-cold');
  await activateSandbox(fresh.context, 'cid-prepare-cold', { send });
  assert.deepEqual(phases, ['workspace']);

  const present = sandboxContext('cid-prepare-present');
  const state = createProjectState('cid-prepare-present');
  state.created = true;
  await saveProjectState(present.context, 'cid-prepare-present', state);
  const sandbox = (present.context as unknown as {
    sandbox: { files: { exists: (target: string) => Promise<boolean> } };
  }).sandbox;
  const files = new Set([
    'projects/cid-prepare-present/app',
    'projects/cid-prepare-present/app/package.json',
    'projects/cid-prepare-present/app/node_modules',
  ]);
  sandbox.files.exists = async (target: string) => files.has(target);
  phases.length = 0;
  await activateSandbox(present.context, 'cid-prepare-present', { send });
  assert.deepEqual(phases, [], 'a project already on this VM is not announced as a new workspace');
  await activateSandbox(present.context, 'cid-prepare-present', { send });
  assert.deepEqual(phases, [], 'the same sandbox stays quiet');

  const missing = sandboxContext('cid-prepare-restore');
  const saved = createProjectState('cid-prepare-restore');
  saved.created = true;
  await saveProjectState(missing.context, 'cid-prepare-restore', saved);
  (missing.context as unknown as {
    sandbox: { files: { exists: (target: string) => Promise<boolean> } };
  }).sandbox.files.exists = async () => false;
  phases.length = 0;
  await activateSandbox(missing.context, 'cid-prepare-restore', { send });
  assert.deepEqual(phases, ['workspace']);
  assert.equal(missing.calls.restore, 1);
});

test('sandbox, session, and preview routes declare the lazy boundary', async () => {
  const [
    chat,
    deploy,
    sandbox,
    live,
    resume,
    snapshot,
    read,
    download,
    stop,
    preview,
    timing,
    task,
    refresh,
  ] = await Promise.all([
    readFile('agents/_lib/turn/chat.ts', 'utf8'),
    readFile('agents/_lib/turn/deploy.ts', 'utf8'),
    readFile('agents/_lib/lazy/sandbox.ts', 'utf8'),
    readFile('agents/_lib/session/live.ts', 'utf8'),
    readFile('agents/_lib/session/resume.ts', 'utf8'),
    readFile('agents/_lib/project/snapshot.ts', 'utf8'),
    readFile('agents/_lib/project/read.ts', 'utf8'),
    readFile('agents/_lib/project/download.ts', 'utf8'),
    readFile('agents/stop.ts', 'utf8'),
    readFile('agents/_lib/lazy/preview.ts', 'utf8'),
    readFile('agents/_lib/utils/timing.ts', 'utf8'),
    readFile('agents/_lib/session/task.ts', 'utf8'),
    readFile('app/features/workspace/hooks/use-preview-refresh.ts', 'utf8'),
  ]);

  assert.match(chat, /await activateSandbox\(/);
  assert.doesNotMatch(chat, /dependenciesReady/);
  assert.match(live, /export async function acquireAgentSession/);
  assert.doesNotMatch(live, /warmLiveQuery/);
  assert.match(live, /scheduleIdleClose/);
  assert.match(live, /LIVE_QUERY_IDLE_MS/);
  assert.match(live, /systemPrompt: buildPrompt\(\s*session\.getState\(\),\s*SANDBOX_MCP_SERVER_NAME,\s*\)/);

  const sessionOpen = resume.slice(resume.indexOf('export async function createProjectResumeStreamResponse'));
  assert.match(sessionOpen, /type: 'resume_history'/);
  assert.doesNotMatch(sessionOpen, /activateSandbox|ensurePreview/);
  assert.match(resume, /if \(!stored\.created && !stored\.previewUrl && !stored\.previewPublished\)/);
  assert.match(resume, /await activateSandbox\(context, conversationId\)/);

  assert.match(snapshot, /export async function loadWorkspaceSnapshot[\s\S]*?activateSandbox/);
  assert.doesNotMatch(snapshot, /runPreviewStatusPipeline/);
  assert.match(read, /activateSandbox/);
  assert.match(download, /activateSandbox/);
  // The stopped turn snapshots its own work; stop never boots a sandbox.
  assert.doesNotMatch(stop, /activateSandbox|persistProjectSnapshot/);

  const resolvePreview = preview.slice(preview.indexOf('async function resolvePreview'));
  assert.ok(
    resolvePreview.indexOf('dependenciesReady') < resolvePreview.indexOf('startPreviewServer'),
    'the dev server starts only after dependencies are ready',
  );
  assert.match(timing, /instance: instanceId\(\)/);
  assert.match(task, /orphaned task has no live runner on this instance/);
  assert.match(task, /patchConversationRecord\(context, conversationId, \{\s*chatTask: task,/);
  assert.doesNotMatch(chat, /type: 'prepare_phase', data: \{ phase: 'workspace' \}/);
  assert.doesNotMatch(deploy, /type: 'prepare_phase', data: \{ phase: 'workspace' \}/);
  assert.match(sandbox, /type: 'prepare_phase', data: \{ phase: 'workspace' \}/);
  assert.match(chat, /type: 'prepare_phase', data: \{ phase: 'agent' \}/);
  assert.match(
    refresh.slice(refresh.indexOf('const onVisibility'), refresh.indexOf('window.setInterval')),
    /previewPanelOpenRef\.current/,
  );
  assert.match(
    refresh.slice(refresh.indexOf('window.setInterval')),
    /previewPanelOpenRef\.current/,
  );
});
