import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  buildExistingProjectGuidance,
  formatExistingFilePaths,
  normalizeClaudeSessionUuid,
  persistConversationSdkSession,
  resolveAgentSdkSession,
  resolveClaudeSessionBinding,
} from '../agents/_session.ts';

const CONVERSATION_ID = '03191d55-156a-436f-9f3f-45271b3937d0';
const BOUND_SESSION_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test('missing conversation or store degrades to an empty binding', async () => {
  assert.deepEqual(await resolveClaudeSessionBinding({}), {});
  assert.deepEqual(await resolveClaudeSessionBinding({
    conversationId: '   ',
    store: {},
  }), {});
});

test('an existing transcript resumes that session', async () => {
  const binding = await resolveClaudeSessionBinding({
    conversationId: CONVERSATION_ID,
    storedSessionId: BOUND_SESSION_ID,
    getSessionInfo: async (sessionId) => ({ sessionId }),
  });
  assert.deepEqual(binding, { resume: BOUND_SESSION_ID });
  assert.equal('sessionId' in binding, false);
});

test('a bound id with no transcript starts a new notebook on that id', async () => {
  const binding = await resolveClaudeSessionBinding({
    conversationId: CONVERSATION_ID,
    store: {
      claudeSessionBinding: async () => ({ sessionId: BOUND_SESSION_ID }),
    },
    getSessionInfo: async () => undefined,
  });
  assert.deepEqual(binding, { sessionId: BOUND_SESSION_ID });
});

test('reset opens a new notebook and never resumes', async () => {
  const binding = await resolveClaudeSessionBinding({
    conversationId: CONVERSATION_ID,
    storedSessionId: BOUND_SESSION_ID,
    reset: true,
    getSessionInfo: async () => {
      throw new Error('reset must not look up the old transcript');
    },
  });
  assert.equal(binding.resume, undefined);
  assert.match(binding.sessionId || '', UUID_RE);
  assert.notEqual(binding.sessionId, BOUND_SESSION_ID);
  assert.notEqual(binding.sessionId, CONVERSATION_ID);
});

test('a stored override wins over the platform binding', async () => {
  const binding = await resolveClaudeSessionBinding({
    conversationId: CONVERSATION_ID,
    storedSessionId: BOUND_SESSION_ID,
    store: {
      claudeSessionBinding: async () => CONVERSATION_ID,
    },
    getSessionInfo: async () => undefined,
  });
  assert.deepEqual(binding, { sessionId: BOUND_SESSION_ID });
});

test('legacy conversation ids are normalised when the binding API is missing', async () => {
  const binding = await resolveClaudeSessionBinding({
    conversationId: CONVERSATION_ID,
    store: {},
    getSessionInfo: async () => undefined,
  });
  assert.deepEqual(binding, { sessionId: CONVERSATION_ID });
});

test('a corrupt transcript starts a fresh session instead of resuming', async () => {
  const binding = await resolveClaudeSessionBinding({
    conversationId: CONVERSATION_ID,
    storedSessionId: BOUND_SESSION_ID,
    getSessionInfo: async () => {
      const error = new Error('bad jsonl');
      (error as { code?: string }).code = 'MemoryCorruptError';
      throw error;
    },
  });
  assert.equal(binding.resume, undefined);
  assert.match(binding.sessionId || '', UUID_RE);
  assert.notEqual(binding.sessionId, BOUND_SESSION_ID);
});

test('other lookup failures fall back to starting on the same id', async () => {
  const binding = await resolveClaudeSessionBinding({
    conversationId: CONVERSATION_ID,
    storedSessionId: BOUND_SESSION_ID,
    getSessionInfo: async () => {
      throw new Error('store unavailable');
    },
  });
  assert.deepEqual(binding, { sessionId: BOUND_SESSION_ID });
});

test('resolveAgentSdkSession persists the id so the next call can resume', async () => {
  let stored = '';
  const store: {
    claudeSessionStore: () => { kind: string };
    updateConversation: (input: { metadata: { sdkSessionId: string } }) => Promise<void>;
    getConversation?: () => Promise<{ metadata: { sdkSessionId: string } }>;
  } = {
    claudeSessionStore: () => ({ kind: 'platform' }),
    updateConversation: async ({ metadata }) => {
      stored = metadata.sdkSessionId;
    },
  };
  const context = { store };
  const first = await resolveAgentSdkSession(context, CONVERSATION_ID, {
    getSessionInfo: async () => undefined,
  });
  assert.equal(first.sessionResumed, false);
  assert.equal(first.binding.sessionId, CONVERSATION_ID);
  assert.equal(stored, CONVERSATION_ID);

  store.getConversation = async () => ({ metadata: { sdkSessionId: stored } });
  const second = await resolveAgentSdkSession(context, CONVERSATION_ID, {
    getSessionInfo: async (sessionId) => ({ sessionId }),
  });
  assert.equal(second.sessionResumed, true);
  assert.deepEqual(second.binding, { resume: CONVERSATION_ID });
});

test('persistConversationSdkSession swallows a missing conversation', async () => {
  await persistConversationSdkSession({
    store: {
      updateConversation: async () => {
        const error = new Error('missing');
        (error as { code?: string }).code = 'MemoryNotFoundError';
        throw error;
      },
    },
  }, CONVERSATION_ID, BOUND_SESSION_ID);
});

test('normalizeClaudeSessionUuid reuses a UUID and pads arbitrary ids', () => {
  assert.equal(normalizeClaudeSessionUuid(CONVERSATION_ID), CONVERSATION_ID);
  assert.equal(
    normalizeClaudeSessionUuid('conv-hello'),
    'ce000000-0000-0000-0000-000000000000',
  );
  assert.equal(normalizeClaudeSessionUuid(''), null);
});

test('formatExistingFilePaths lists files only and caps the list', () => {
  assert.deepEqual(formatExistingFilePaths([
    { path: 'src', type: 'directory' },
    { path: 'src/App.tsx', type: 'file' },
    { path: 'package.json', type: 'file' },
  ]), ['src/App.tsx', 'package.json']);
  assert.equal(
    formatExistingFilePaths(
      Array.from({ length: 90 }, (_, index) => ({ path: `f${index}.ts`, type: 'file' as const })),
    ).length,
    80,
  );
});

test('resumed guidance forbids a full-project reread', () => {
  const guidance = buildExistingProjectGuidance({
    isNewProject: false,
    sessionResumed: true,
  });
  assert.doesNotMatch(guidance, /inspect the existing code first/);
  assert.match(guidance, /Do not call files_list/);
  assert.match(guidance, /do not files_read files you already wrote or read/);
});

test('unresumed follow-up guidance includes the file list and read-only-what-you-change', () => {
  const guidance = buildExistingProjectGuidance({
    isNewProject: false,
    sessionResumed: false,
    existingFiles: ['src/App.tsx', 'src/styles.css'],
  });
  assert.doesNotMatch(guidance, /inspect the existing code first/);
  assert.match(guidance, /Existing project files/);
  assert.match(guidance, /src\/App\.tsx/);
  assert.match(guidance, /Only files_read the files you will change/);
});

test('a new project does not add follow-up reread guidance', () => {
  assert.equal(buildExistingProjectGuidance({
    isNewProject: true,
    sessionResumed: false,
    existingFiles: ['src/App.tsx'],
  }), '');
});

test('the agent prompt and query wire session resume instead of a full reread', async () => {
  const agent = await readFile('agents/_agent.ts', 'utf8');
  const promptBody = agent.slice(
    agent.indexOf('export function buildPrompt'),
    agent.indexOf('export async function runCodingAgent'),
  );
  const chat = await readFile('agents/pipelines/_chat.ts', 'utf8');

  assert.match(promptBody, /buildExistingProjectGuidance/);
  assert.doesNotMatch(promptBody, /inspect the existing code first/);
  assert.match(agent, /resolveAgentSdkSession/);
  assert.match(agent, /sessionStore: sdkSession\.sessionStore/);
  assert.match(agent, /\.\.\.sdkSession\.binding/);
  assert.match(chat, /resetSession: shouldResetProject/);
  assert.match(
    chat.slice(chat.indexOf('const autoFixResult'), chat.indexOf('if (autoFixResult.stopped')),
    /\{ model: options\.model \}/,
  );
});
