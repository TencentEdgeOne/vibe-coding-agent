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

// A persisted id is only written once the SDK has opened the session, so it is
// already proof that a transcript exists. Confirming it would cost a full
// transcript load — one strong read per mirrored frame — before every turn.
test('a persisted session id resumes without loading the transcript', async () => {
  const binding = await resolveClaudeSessionBinding({
    conversationId: CONVERSATION_ID,
    storedSessionId: BOUND_SESSION_ID,
  });
  assert.deepEqual(binding, { resume: BOUND_SESSION_ID });
  assert.equal('sessionId' in binding, false);
});

test('a persisted id in conversation metadata resumes too', async () => {
  const binding = await resolveClaudeSessionBinding({
    conversationId: CONVERSATION_ID,
    store: {
      getConversation: async () => ({ metadata: { sdkSessionId: BOUND_SESSION_ID } }),
      claudeSessionBinding: async () => {
        throw new Error('a persisted id must not consult the platform binding');
      },
    },
  });
  assert.deepEqual(binding, { resume: BOUND_SESSION_ID });
});

test('a conversation with no persisted id opens the platform-bound id', async () => {
  const binding = await resolveClaudeSessionBinding({
    conversationId: CONVERSATION_ID,
    store: {
      claudeSessionBinding: async () => ({ sessionId: BOUND_SESSION_ID }),
    },
  });
  assert.deepEqual(binding, { sessionId: BOUND_SESSION_ID });
});

test('reset opens a new notebook and never resumes', async () => {
  const binding = await resolveClaudeSessionBinding({
    conversationId: CONVERSATION_ID,
    storedSessionId: BOUND_SESSION_ID,
    reset: true,
  });
  assert.equal(binding.resume, undefined);
  assert.match(binding.sessionId || '', UUID_RE);
  assert.notEqual(binding.sessionId, BOUND_SESSION_ID);
  assert.notEqual(binding.sessionId, CONVERSATION_ID);
});

test('legacy conversation ids are normalised when the binding API is missing', async () => {
  const binding = await resolveClaudeSessionBinding({
    conversationId: CONVERSATION_ID,
    store: {},
  });
  assert.deepEqual(binding, { sessionId: CONVERSATION_ID });
});

test('resolveAgentSdkSession persists the id only once the session has started', async () => {
  const metadata: Record<string, unknown> = {};
  const store = {
    claudeSessionStore: () => ({ kind: 'platform' }),
    // updateConversation shallow-merges, so the stub must too.
    updateConversation: async (input: { metadata: Record<string, unknown> }) => {
      Object.assign(metadata, input.metadata);
    },
    getConversation: async () => ({ metadata }),
  };
  const context = { store };
  const first = await resolveAgentSdkSession(context, CONVERSATION_ID);
  assert.equal(first.sessionResumed, false);
  assert.equal(first.binding.sessionId, CONVERSATION_ID);
  // Nothing is recorded until the SDK confirms the session opened, so a turn
  // that dies before its first event cannot leave a resumable id behind.
  assert.equal(metadata.sdkSessionId, undefined);
  await first.markSessionStarted();
  assert.equal(metadata.sdkSessionId, CONVERSATION_ID);

  const second = await resolveAgentSdkSession(context, CONVERSATION_ID);
  assert.equal(second.sessionResumed, true);
  assert.deepEqual(second.binding, { resume: CONVERSATION_ID });
});

test('a resumed turn does not rewrite the id it already resumed from', async () => {
  let writes = 0;
  const session = await resolveAgentSdkSession({
    store: {
      getConversation: async () => ({ metadata: { sdkSessionId: BOUND_SESSION_ID } }),
      updateConversation: async () => {
        writes += 1;
      },
    },
  }, CONVERSATION_ID);
  assert.equal(session.sessionResumed, true);
  await session.markSessionStarted();
  assert.equal(writes, 0);
});

// Reopening on the same id would land the replacement session back on the keys
// whose transcript could not be read, so the discard nominates a fresh id.
test('forgetSession retires the id and nominates a clean replacement', async () => {
  const writes: Array<Record<string, unknown>> = [];
  const session = await resolveAgentSdkSession({
    store: {
      getConversation: async () => ({ metadata: { sdkSessionId: BOUND_SESSION_ID } }),
      updateConversation: async (input: { metadata: Record<string, unknown> }) => {
        writes.push(input.metadata);
      },
    },
  }, CONVERSATION_ID);
  await session.forgetSession();

  // Both fields must land together, or a reader between two writes could see a
  // retired session with no replacement named.
  assert.equal(writes.length, 1);
  assert.equal(writes[0].sdkSessionId, '');
  const replacement = writes[0].sdkSessionNextId;
  assert.match(String(replacement), UUID_RE);
  assert.notEqual(replacement, BOUND_SESSION_ID);
  assert.notEqual(replacement, CONVERSATION_ID);
});

test('a nominated replacement opens fresh rather than resuming', async () => {
  const binding = await resolveClaudeSessionBinding({
    conversationId: CONVERSATION_ID,
    store: {
      getConversation: async () => ({
        metadata: { sdkSessionId: '', sdkSessionNextId: BOUND_SESSION_ID },
      }),
    },
  });
  assert.deepEqual(binding, { sessionId: BOUND_SESSION_ID });
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
  assert.doesNotMatch(guidance, /ensure_project_scaffold/);
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
  assert.doesNotMatch(guidance, /ensure_project_scaffold/);
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

// The prompt's resume guidance is asserted against the built prompt in
// prompt.test.ts; what stays here is how the turn is wired. The binding and the
// transcript mirror now travel to the driver as one `session` argument, which
// is what keeps the resume mechanism out of the SDK-agnostic layers.
test('the agent turn wires session resume instead of a full reread', async () => {
  const agent = await readFile('agents/_agent.ts', 'utf8');
  const chat = await readFile('agents/pipelines/_chat.ts', 'utf8');

  assert.match(agent, /resolveAgentSdkSession/);
  assert.match(agent, /\.\.\.sdkSession\.binding/);
  assert.match(agent, /store: sdkSession\.sessionStore/);
  assert.match(chat, /resetSession: shouldResetProject/);
  const autoFixCall = chat.slice(chat.indexOf('const autoFixResult'), chat.indexOf('if (autoFixResult.stopped'));
  assert.match(autoFixCall, /model: options\.model/);
  assert.doesNotMatch(autoFixCall, /resetSession/);
});
