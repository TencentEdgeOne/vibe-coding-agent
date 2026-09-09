import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

/**
 * Guards on what a single chat turn is allowed to cost before the model speaks.
 *
 * Every regression these cover was invisible on turn one and got worse on every
 * turn after it, which is exactly the shape that does not show up in a smoke
 * test. `_agent.ts` uses extensionless imports that only the Makers bundler
 * resolves, so these read the source rather than importing it.
 */

/** Comments describe the contract and legitimately name what it excludes. */
function stripComments(source: string) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function sliceBetween(source: string, start: string, end: string) {
  const from = source.indexOf(start);
  const to = source.indexOf(end);
  assert.ok(from >= 0, `expected to find ${start}`);
  assert.ok(to > from, `expected ${end} to follow ${start}`);
  return source.slice(from, to);
}

// What the two prompts contain is covered behaviourally in prompt.test.ts.
// What remains source-only is the wiring: which half reaches which SDK slot.
test('the cacheable half is sent as systemPrompt and the per-turn half as the prompt', async () => {
  const agent = stripComments(await readFile('agents/_agent.ts', 'utf8'));

  assert.match(
    agent,
    /systemPrompt: buildSystemPrompt\(state, mcpServerName\)/,
    'the query must send the invariant prompt as systemPrompt',
  );
  assert.match(
    agent,
    /prompt: buildTurnPrompt\(/,
    'the per-turn prompt must travel as the query prompt, not the system prompt',
  );
});

// The platform session store writes one key per append() and reads one key at a
// time on load. 'eager' gives every transcript frame its own append, so the
// next turn pays a serial read per frame of every turn before it.
test('transcript mirroring stays batched', async () => {
  const driver = await readFile('agents/core/drivers/_claude.ts', 'utf8');

  assert.match(driver, /sessionStoreFlush: 'batched'/);
  assert.doesNotMatch(driver, /sessionStoreFlush: 'eager'/);
});

// Resolving the session must not read the transcript. Loading it to check that
// it exists was a full serial fetch on the critical path of every turn.
test('resolving the turn session never loads the transcript', async () => {
  const session = stripComments(await readFile('agents/_session.ts', 'utf8'));

  assert.doesNotMatch(
    session,
    /getSessionInfo|sessionStore\.load/,
    'the turn path must decide resume from the persisted id alone',
  );
  assert.match(
    session,
    /markSessionStarted/,
    'the id must only be persisted once the SDK confirms the session opened',
  );
});

// getConversation returns the whole metadata document, and POST /chat blocks on
// these before the browser even receives response headers.
test('starting a turn reads conversation metadata once and writes it once', async () => {
  const tasks = stripComments(await readFile('agents/_chat-tasks.ts', 'utf8'));
  const createTask = sliceBetween(tasks, 'async function createChatTask', 'function withTaskAbortSignal');

  assert.match(createTask, /getTurnStartState/);
  assert.doesNotMatch(
    createTask,
    /getChatTask|getModelPreference/,
    'the task and the model preference come from one metadata read',
  );
  assert.match(createTask, /saveTurnStart/);
  assert.doesNotMatch(
    createTask,
    /saveModelPreference|saveChatTask/,
    'the task and the model preference land in one merge',
  );
});

// The live task already carries the running status in memory, and a reconnect
// in this process is served from it, so the model must not wait for this write.
test('the running-state write does not gate the pipeline', async () => {
  const tasks = stripComments(await readFile('agents/_chat-tasks.ts', 'utf8'));
  const execute = sliceBetween(tasks, 'async function executeLiveTask', 'function ensureChatTaskStarted');
  const beforePipeline = execute.slice(0, execute.indexOf('runChatPipeline'));

  assert.doesNotMatch(
    beforePipeline,
    /await saveChatTask\(/,
    'marking the task running must not block the turn',
  );
  assert.match(beforePipeline, /void saveChatTask\(/);
});

// Three different systems, no data dependency between them. Awaiting the lease
// extension first cost a full sandbox round trip before prep could even start.
test('sandbox lease, history, and workspace prep are started together', async () => {
  const chat = stripComments(await readFile('agents/pipelines/_chat.ts', 'utf8'));

  assert.doesNotMatch(
    chat,
    /await extendExistingSandboxTimeout\(/,
    'the lease extension is best-effort and must not gate workspace prep',
  );
  assert.match(
    chat,
    /Promise\.all\(\[\s*\n\s*prepareProjectWorkspace\(/,
    'workspace prep and history must be awaited together',
  );
});
