import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import type { SessionStore, SessionStoreEntry } from '@anthropic-ai/claude-agent-sdk';
import {
  claudeSessionExportFilename,
  sessionEntriesToJsonl,
} from '../shared/claude-session-export.ts';
import {
  encodeClaudeProjectKey,
  loadClaudeSessionEntries,
} from '../agents/utils/_sdk-transcript.ts';
import { readBoundSdkSessionId } from '../agents/_session.ts';

const SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function memoryStore(byKey: Record<string, SessionStoreEntry[]>): SessionStore {
  return {
    append: async () => undefined,
    load: async (key) => byKey[`${key.projectKey}:${key.sessionId}`] ?? null,
  };
}

test('sessionEntriesToJsonl writes one JSON object per line', () => {
  const jsonl = sessionEntriesToJsonl([
    { type: 'user', uuid: 'u1', message: { content: 'hi' } },
    { type: 'assistant', uuid: 'a1' },
  ]);
  const lines = jsonl.trimEnd().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).type, 'user');
  assert.equal(JSON.parse(lines[1]).uuid, 'a1');
  assert.match(jsonl, /\n$/);
});

test('sessionEntriesToJsonl is empty when there are no entries', () => {
  assert.equal(sessionEntriesToJsonl([]), '');
});

test('claudeSessionExportFilename includes a short session id and timestamp', () => {
  const filename = claudeSessionExportFilename(
    'abcdefghijklmnop',
    new Date('2026-08-17T12:34:56.789Z'),
  );
  assert.equal(filename, 'claude-session-abcdefgh-2026-08-17T12-34-56-789Z.jsonl');
});

test('encodeClaudeProjectKey sanitizes cwd and hashes long paths', () => {
  assert.equal(encodeClaudeProjectKey('/tmp/app'), '-tmp-app');
  const long = `/${'a'.repeat(250)}`;
  const key = encodeClaudeProjectKey(long);
  assert.ok(key.length <= 200);
  assert.match(key, /-[0-9a-f]+$/);
});

test('loadClaudeSessionEntries captures the getSessionInfo store load', async () => {
  const entries: SessionStoreEntry[] = [{ type: 'user', uuid: 'u1' }];
  const found = await loadClaudeSessionEntries({
    sessionStore: memoryStore({ [`captured:${SESSION_ID}`]: entries }),
    sessionId: SESSION_ID,
    extraProjectKeys: ['should-not-be-used'],
    getSessionInfo: async (_id, options) => {
      await options.sessionStore?.load({
        projectKey: 'captured',
        sessionId: SESSION_ID,
      });
      return { sessionId: SESSION_ID };
    },
  });
  assert.deepEqual(found, entries);
});

test('loadClaudeSessionEntries falls back to extra project keys', async () => {
  const entries: SessionStoreEntry[] = [{ type: 'file-history-snapshot' }];
  const loaded = await loadClaudeSessionEntries({
    sessionStore: memoryStore({
      [`conv-1:${SESSION_ID}`]: entries,
    }),
    sessionId: SESSION_ID,
    cwd: '/tmp/app',
    extraProjectKeys: ['conv-1'],
    getSessionInfo: async () => ({ sessionId: SESSION_ID }),
  });
  assert.deepEqual(loaded, entries);
});

test('readBoundSdkSessionId uses persisted conversation metadata', async () => {
  const sessionId = await readBoundSdkSessionId({
    store: {
      getConversation: async () => ({ metadata: { sdkSessionId: SESSION_ID } }),
    },
  }, '03191d55-156a-436f-9f3f-45271b3937d0');
  assert.equal(sessionId, SESSION_ID);
});

test('dev-only session export is wired next to the conversation log button', async () => {
  const workspace = await readFile('app/features/workspace/workspace-screen.tsx', 'utf8');
  const header = await readFile('app/features/workspace/components/site-header.tsx', 'utf8');
  const client = await readFile('app/features/workspace/workspace-api.ts', 'utf8');
  const route = await readFile('agents/sdk-session.ts', 'utf8');
  const i18n = await readFile('app/i18n.ts', 'utf8');

  assert.match(workspace, /onExportSession=\{\(\) => void handleExportSdkSession\(\)\}/);
  assert.match(workspace, /fetchSdkSessionTranscript/);
  assert.match(header, /copy\.workspace\.exportSession/);
  assert.match(header, /exportSessionBusy/);
  assert.match(client, /fetch\('\/sdk-session'/);
  assert.match(route, /onRequestGet/);
  assert.match(route, /loadClaudeSessionEntries/);
  assert.match(route, /application\/x-ndjson/);
  assert.match(i18n, /exportSession: '导出 Session'/);
  assert.match(i18n, /exportSession: 'Export session'/);
});
