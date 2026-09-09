import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createLocalPorts,
  createLocalWorkspacePort,
  createManualCancellationPort,
  createMemoryStorePort,
  createRecordConfigPort,
} from '../agents/core/adapters/_local.ts';
import {
  createMakersPorts,
  createMakersStorePort,
  createMakersWorkspacePort,
} from '../agents/core/adapters/_makers.ts';
import type { DomainEvent } from '../agents/core/_events.ts';
import type { TurnRequest } from '../agents/core/_engine.ts';
import type { AgentPorts } from '../agents/core/_ports.ts';
import { presentAsChatStream, toChatStreamEvent } from '../agents/core/presenters/_sse-presenter.ts';

async function workspaceDir() {
  return mkdtemp(path.join(tmpdir(), 'vca-core-'));
}

test('local workspace port reads, writes, and runs commands on real disk', async () => {
  const root = await workspaceDir();
  const workspace = createLocalWorkspacePort(root);

  assert.equal(await workspace.files.exists('app/index.html'), false);
  await workspace.files.write('app/index.html', '<h1>hi</h1>');
  assert.equal(await workspace.files.exists('app/index.html'), true);
  assert.equal(await workspace.files.read('app/index.html'), '<h1>hi</h1>');
  assert.equal(await readFile(path.join(root, 'app/index.html'), 'utf8'), '<h1>hi</h1>');

  const ok = await workspace.commands.run('echo hello');
  assert.equal(ok.exitCode, 0);
  assert.equal(ok.stdout.trim(), 'hello');

  // A failing command must resolve with a non-zero code, not throw, so the core
  // can treat verification failure as data.
  const failed = await workspace.commands.run('exit 3');
  assert.equal(failed.exitCode, 3);
});

test('local workspace port refuses paths outside its root', async () => {
  const workspace = createLocalWorkspacePort(await workspaceDir());
  await assert.rejects(() => workspace.files.write('../escape.txt', 'x'), /outside the workspace/);
  await assert.rejects(() => workspace.files.read('/etc/passwd'), /outside the workspace/);
});

test('memory store port matches the shallow-merge metadata semantics the core relies on', async () => {
  const store = createMemoryStorePort();

  await store.updateConversation({ conversationId: 'c1', metadata: { modelPreference: 'm1' } });
  await store.updateConversation({ conversationId: 'c1', metadata: { projectState: { created: true } } });

  const conversation = await store.getConversation({ conversationId: 'c1' });
  assert.equal(conversation?.metadata?.modelPreference, 'm1');
  assert.deepEqual(conversation?.metadata?.projectState, { created: true });

  await store.appendMessage({ conversationId: 'c1', role: 'user', content: 'build a todo app' });
  await store.appendMessage({ conversationId: 'c1', role: 'assistant', content: 'done' });
  const messages = await store.getMessages({ conversationId: 'c1', order: 'asc' });
  assert.deepEqual(messages, [
    { role: 'user', content: 'build a todo app' },
    { role: 'assistant', content: 'done' },
  ]);

  assert.equal(await store.getConversation({ conversationId: 'missing' }), null);
});

test('makers adapter translates an EdgeOne context into ports without leaking it', async () => {
  const calls: string[] = [];
  const fakeContext = {
    env: { AI_GATEWAY_MODEL: '  gateway-model  ' },
    store: {
      getConversation: async () => { calls.push('getConversation'); return { metadata: {} }; },
      updateConversation: async () => { calls.push('updateConversation'); return {}; },
      getMessages: async () => { calls.push('getMessages'); return []; },
      appendMessage: async () => { calls.push('appendMessage'); return {}; },
    },
    sandbox: {
      files: {
        exists: async () => { calls.push('exists'); return true; },
        read: async () => 'content',
        write: async () => {},
        makeDir: async () => {},
      },
      commands: { run: async () => ({ exitCode: 0, stdout: 'out', stderr: '' }) },
      persist: async () => { calls.push('persist'); },
      restore: async () => {},
      getHost: (port: number) => `https://preview-${port}.example.com`,
      envdAccessToken: 'token-123',
    },
  };

  const ports = createMakersPorts(fakeContext);

  assert.equal(ports.config.get('AI_GATEWAY_MODEL'), 'gateway-model');
  assert.equal(ports.config.get('NOT_SET'), '');
  assert.equal(await ports.workspace.files.exists('app'), true);
  assert.equal(await ports.workspace.getHost?.(8080), 'https://preview-8080.example.com');
  assert.equal(ports.workspace.accessToken, 'token-123');
  await ports.workspace.persist({ path: 'projects/c1/app' });
  await ports.store.getConversation({ conversationId: 'c1' });
  assert.deepEqual(calls, ['exists', 'persist', 'getConversation']);

  // `remove` is optional upstream, so the port must not fabricate it.
  assert.equal(ports.workspace.files.remove, undefined);
});

// Session binding hands around partial stores and adds methods later, so the
// port must forward per call instead of capturing methods at construction.
test('the store port tolerates a partial store and sees methods added later', async () => {
  const store: Record<string, unknown> = {
    updateConversation: async () => ({}),
  };
  const port = createMakersStorePort({ store });

  // Absent methods degrade instead of throwing.
  assert.equal(await port.getConversation({ conversationId: 'c1' }), null);
  assert.deepEqual(await port.getMessages({ conversationId: 'c1' }), []);

  // A method added after the port was built is still picked up.
  store.getConversation = async () => ({ metadata: { sdkSessionId: 'late' } });
  const conversation = await port.getConversation({ conversationId: 'c1' });
  assert.equal(conversation?.metadata?.sdkSessionId, 'late');
});

test('the session store is exposed only when the runtime offers one', () => {
  const without = createMakersStorePort({ store: { getConversation: async () => null } });
  assert.equal(without.claudeSessionStore, undefined);

  const withSession = createMakersStorePort({
    store: { getConversation: async () => null, claudeSessionStore: () => ({ kind: 'platform' }) },
  });
  assert.deepEqual(withSession.claudeSessionStore?.(), { kind: 'platform' });
});

/**
 * EdgeOne sandboxes initialize lazily: `envdAccessToken`, `browser`, and even
 * `files` are getters that throw until an async sandbox method has run. The
 * port is now built in front of every sandbox call, including the very first
 * one, so reading any of those at construction time breaks the whole turn with
 * "Sandbox is not initialized".
 */
function lazySandbox() {
  let initialized = false;
  const requireInit = (name: string) => {
    if (!initialized) {
      throw new Error('Sandbox is not initialized. Call an async sandbox method first, such as commands.run().');
    }
    return name;
  };
  return {
    commands: {
      run: async () => {
        initialized = true;
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      },
    },
    files: {
      exists: async () => { requireInit('files'); return true; },
      read: async () => 'x',
      write: async () => {},
      makeDir: async () => {},
    },
    persist: async () => {},
    restore: async () => {},
    getHost: () => requireInit('host'),
    get envdAccessToken() {
      return requireInit('token');
    },
    get browser() {
      throw new Error('Sandbox is not initialized. Call an async sandbox method first, such as commands.run().');
    },
  };
}

test('building the workspace port never touches an uninitialized sandbox', () => {
  // Construction alone must not throw, because the port is created before the
  // first command runs.
  assert.doesNotThrow(() => createMakersWorkspacePort({ sandbox: lazySandbox() }));
});

test('the first command through the port initializes the sandbox', async () => {
  const ports = createMakersPorts({ store: {}, sandbox: lazySandbox() });

  const result = await ports.workspace.commands.run('echo ok');
  assert.equal(result.stdout, 'ok');

  // Only after initialization do the lazy credentials become readable.
  assert.equal(ports.workspace.accessToken, 'token');
});

test('lazy sandbox credentials are read at use time, not at construction', async () => {
  const sandbox = lazySandbox();
  const workspace = createMakersWorkspacePort({ sandbox });

  // Before initialization these degrade instead of throwing.
  assert.equal(workspace.accessToken, undefined);
  assert.equal(workspace.browserLiveUrl, undefined);

  await workspace.commands.run('echo ok');

  assert.equal(workspace.accessToken, 'token');
  // `browser` throws even when initialized; that must not propagate.
  assert.equal(workspace.browserLiveUrl, undefined);
});

// _state.ts branches on `typeof files.remove === 'function'` and falls back to
// `rm -rf`. Making the probe lazy must not make the port claim a capability the
// host lacks, or that fallback becomes unreachable.
test('optional capabilities report absence honestly', () => {
  const without = createMakersWorkspacePort({
    sandbox: { files: { exists: async () => true }, commands: { run: async () => ({}) } },
  });
  assert.equal(without.files.remove, undefined);
  assert.equal(without.extendTimeout, undefined);

  const removed: string[] = [];
  const extended: number[] = [];
  const withCapabilities = createMakersWorkspacePort({
    sandbox: {
      files: { exists: async () => true, remove: async (path: string) => { removed.push(path); } },
      commands: { run: async () => ({}) },
      extendTimeout: async (seconds: number) => { extended.push(seconds); },
    },
  });
  assert.equal(typeof withCapabilities.files.remove, 'function');
  assert.equal(typeof withCapabilities.extendTimeout, 'function');
});

test('optional capabilities are absent rather than throwing on a cold sandbox', () => {
  const workspace = createMakersWorkspacePort({ sandbox: lazySandbox() });
  // A cold sandbox cannot be probed, so the caller takes its fallback path
  // instead of crashing.
  assert.doesNotThrow(() => workspace.files.remove);
  assert.equal(workspace.files.remove, undefined);
});

/**
 * The strongest form of the guard: rather than listing the properties known to
 * be lazy, record every property the adapter touches while building the port.
 * Construction must read nothing at all, so any future eager access — not just
 * the `envdAccessToken` and `browser` reads that caused the outage — fails here
 * instead of in production on the first turn.
 */
test('constructing the workspace port reads no sandbox property', () => {
  const touched: string[] = [];
  const sandbox = new Proxy({} as Record<string, unknown>, {
    get(_target, property) {
      touched.push(String(property));
      throw new Error('Sandbox is not initialized. Call an async sandbox method first, such as commands.run().');
    },
    has: () => true,
  });

  assert.doesNotThrow(() => createMakersWorkspacePort({ sandbox }));
  assert.deepEqual(touched, [], `construction touched: ${touched.join(', ')}`);
});

test('makers adapter fails loudly when the context lacks a capability', () => {
  assert.throws(() => createMakersPorts({ sandbox: {} }), /missing `store`/);
  assert.throws(() => createMakersPorts({ store: {} }), /missing `sandbox`/);
});

test('cancellation port lets stop work without an HTTP abort signal', () => {
  const cancellation = createManualCancellationPort();
  let notified = 0;

  assert.equal(cancellation.aborted, false);
  cancellation.onAbort(() => { notified += 1; });
  cancellation.abort();

  assert.equal(cancellation.aborted, true);
  assert.equal(notified, 1);

  // Late subscribers still fire, and abort is idempotent.
  cancellation.onAbort(() => { notified += 1; });
  cancellation.abort();
  assert.equal(notified, 2);
});

// A stand-in core: proves a turn runner can be written against ports alone,
// with no context, Request, or Response anywhere in its signature.
async function* fakeRunTurn(
  ports: AgentPorts,
  request: TurnRequest,
): AsyncGenerator<DomainEvent> {
  const runId = request.runId ?? 'run-1';
  const at = 1_700_000_000_000;

  yield { type: 'turn.started', runId, conversationId: request.conversationId, at };

  await ports.store.appendMessage({
    conversationId: request.conversationId,
    role: 'user',
    content: request.message,
  });

  yield { type: 'assistant.text', runId, blockId: 'b1', text: 'Writing the page.', at };

  await ports.workspace.files.write('app/index.html', '<h1>todo</h1>');
  yield {
    type: 'tool.invoked',
    runId,
    toolUseId: 't1',
    name: 'write_project_file',
    kind: 'file.write',
    at,
  };
  yield { type: 'tool.settled', runId, toolUseId: 't1', ok: true, at };
  yield { type: 'workspace.changed', runId, paths: ['app/index.html'], at };

  const build = await ports.workspace.commands.run('echo built');
  yield {
    type: 'verification.finished',
    runId,
    status: build.exitCode === 0 ? 'success' : 'failed',
    stdout: build.stdout,
    at,
  };

  const host = await ports.workspace.getHost?.(8080);
  if (host) {
    yield { type: 'preview.ready', runId, url: host, serverGeneration: 1, at };
  }

  yield { type: 'turn.finished', runId, outcome: 'completed', summary: 'Built the page.', at };
}

test('a turn runs end to end against local ports and yields domain events', async () => {
  const root = await workspaceDir();
  const ports = createLocalPorts({ rootDir: root, config: { AI_GATEWAY_MODEL: 'local' } });

  const events: DomainEvent[] = [];
  for await (const event of fakeRunTurn(ports, { conversationId: 'c1', message: 'make a todo app' })) {
    events.push(event);
  }

  assert.deepEqual(events.map((event) => event.type), [
    'turn.started',
    'assistant.text',
    'tool.invoked',
    'tool.settled',
    'workspace.changed',
    'verification.finished',
    'preview.ready',
    'turn.finished',
  ]);

  // The side effects really happened through the ports.
  assert.equal(await readFile(path.join(root, 'app/index.html'), 'utf8'), '<h1>todo</h1>');
  const messages = await ports.store.getMessages({ conversationId: 'c1' });
  assert.deepEqual(messages, [{ role: 'user', content: 'make a todo app' }]);

  // No event carries a UI concern: no stage, no needsWorkspace, no iframe flag.
  const serialized = JSON.stringify(events);
  for (const uiField of ['stage', 'needsWorkspace', 'restarted', 'inputSummary', 'outputSummary']) {
    assert.doesNotMatch(serialized, new RegExp(uiField), `domain events must not carry ${uiField}`);
  }
});

test('the same turn drives the existing SSE wire format through the presenter', async () => {
  const root = await workspaceDir();
  const ports = createLocalPorts({ rootDir: root });

  const wireEvents = [];
  for await (const event of presentAsChatStream(
    fakeRunTurn(ports, { conversationId: 'c1', message: 'make a todo app' }),
  )) {
    wireEvents.push(event);
  }

  // workspace.changed has no slot in the current protocol, so it drops out.
  assert.deepEqual(wireEvents.map((event) => event.type), [
    'task_started',
    'text_segment',
    'tool_use',
    'tool_result',
    'result',
    'preview_ready',
    'result',
  ]);

  const toolUse = wireEvents.find((event) => event.type === 'tool_use');
  // phaseHint is derived by the presenter from ToolKind, not sent by the core.
  assert.equal(toolUse?.type, 'tool_use');
  assert.equal(toolUse?.type === 'tool_use' ? toolUse.data?.phaseHint : undefined, 'code');

  const final = wireEvents.at(-1);
  assert.equal(final?.type, 'result');
  assert.equal(final?.type === 'result' ? final.data?.ok : undefined, true);
  assert.equal(final?.type === 'result' ? final.data?.reply : undefined, 'Built the page.');
});

test('presenter maps a failed turn to a reason code instead of localized prose', () => {
  const wireEvent = toChatStreamEvent({
    type: 'turn.finished',
    runId: 'run-1',
    outcome: 'failed',
    reason: 'model_returned_no_output',
    at: 1,
  });

  assert.equal(wireEvent?.type, 'result');
  assert.equal(wireEvent?.data?.ok, false);
  assert.equal(wireEvent?.data?.error, 'model_returned_no_output');
  // The runtime must not ship Chinese or English copy the way
  // buildRequirementConclusionFallback does today.
  assert.doesNotMatch(JSON.stringify(wireEvent), /[\u4e00-\u9fff]/);
  assert.doesNotMatch(JSON.stringify(wireEvent), /preview panel/i);
});

test('config port is the only channel for deployment settings', () => {
  const config = createRecordConfigPort({ ANTHROPIC_MODEL: 'm', EMPTY: '   ' });
  assert.equal(config.get('ANTHROPIC_MODEL'), 'm');
  assert.equal(config.get('EMPTY'), '');
  assert.equal(config.get('MISSING'), '');
});
