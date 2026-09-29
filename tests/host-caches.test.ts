import assert from 'node:assert/strict';
import test from 'node:test';
import { activateSandbox } from '../agents/_lib/lazy/sandbox.ts';
import { startPreviewServer } from '../agents/_lib/project/preview.ts';
import { createProjectState } from '../agents/_lib/project/state.ts';
import type { AgentContext } from '../agents/_lib/runtime/context.ts';
import { createMemoryBlobStore, patchConversationRecord } from '../agents/_lib/session/store.ts';

const FILE_TREE_SIGNATURE = "-printf '%y";

/** A sandbox proxy for one request. The runtime builds a new one every time. */
function requestSandbox(instanceId: string, calls: { fileTrees: number; restores: number }) {
  return {
    getInfo: () => ({ instanceId }),
    extendTimeout: async () => {},
    restore: async () => {
      calls.restores += 1;
      return { restored: true };
    },
    files: {
      exists: async () => true,
      makeDir: async () => {},
    },
    commands: {
      run: async (command: string) => {
        if (command.includes(FILE_TREE_SIGNATURE)) calls.fileTrees += 1;
        return { exitCode: 0, stdout: 'f\t1\t12\t./index.html\n', stderr: '' };
      },
    },
  };
}

// Session affinity keeps a conversation's requests in this process, which is
// only worth something if what one request learned about the VM carries over.
test('a later request on the same VM skips the probe; a replaced VM is probed again', async () => {
  const blobStore = createMemoryBlobStore();
  const id = 'vm-identity';
  await patchConversationRecord({ blobStore }, id, {
    projectState: { ...createProjectState(id), created: true },
  });
  const calls = { fileTrees: 0, restores: 0 };
  const request = (instanceId: string) => ({
    blobStore,
    sandbox: requestSandbox(instanceId, calls),
  }) as unknown as AgentContext;

  const first = await activateSandbox(request('vm-1'), id);
  assert.equal(first.hasFiles, true);
  const probesAfterFirst = calls.fileTrees;
  assert.ok(probesAfterFirst > 0, 'the first request probes the VM');

  const second = await activateSandbox(request('vm-1'), id);
  assert.equal(second.hasFiles, true);
  assert.equal(calls.fileTrees, probesAfterFirst, 'same VM behind a new proxy: no probe');

  await activateSandbox(request('vm-2'), id);
  assert.ok(calls.fileTrees > probesAfterFirst, 'a replaced VM is probed again');
});

/** A cold sandbox whose project lint fails, so every launch stops at step one. */
function failingLintContext(counter: { commands: number }) {
  return {
    blobStore: createMemoryBlobStore(),
    sandbox: {
      files: {
        exists: async () => false,
        makeDir: async () => {},
        write: async () => {},
        read: async () => '',
      },
      commands: {
        run: async () => {
          counter.commands += 1;
          return { exitCode: 1, stdout: 'lint failed', stderr: '' };
        },
      },
    },
  } as unknown as AgentContext;
}

// The preview panel, start_preview, and the agent's own `edgeone makers dev`
// all start the dev server, often at the same moment and from different requests.
test('preview starts from different requests at once share one launch', async () => {
  const alone = { commands: 0 };
  const aloneState = createProjectState('preview-alone');
  await assert.rejects(startPreviewServer(failingLintContext(alone), aloneState));

  const together = { commands: 0 };
  const state = createProjectState('preview-together');
  const outcomes = await Promise.allSettled(
    [1, 2, 3, 4].map(() => startPreviewServer(failingLintContext(together), state)),
  );

  const reasons = outcomes.map((outcome) => (outcome.status === 'rejected' ? outcome.reason : null));
  assert.ok(reasons.every(Boolean), 'every caller sees the launch fail');
  assert.equal(new Set(reasons).size, 1, 'all four callers share one launch');
  assert.equal(together.commands, alone.commands, 'the sandbox runs one launch worth of commands');
});
