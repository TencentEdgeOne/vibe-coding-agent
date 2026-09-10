import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSystemPrompt, buildTurnPrompt } from '../agents/_agent.ts';
import type { ConversationMessage, ProjectState } from '../agents/_types.ts';

/**
 * Behavioural cover for the two halves of the prompt.
 *
 * These replace source-text regex assertions: the split between a cacheable
 * system prefix and a per-turn prompt is a property of the output, and reading
 * the source for identifier names could only ever approximate it.
 */

const MCP_SERVER = 'edgeone-sandbox';

const state: ProjectState = {
  created: false,
  sessionDir: 'projects/c1',
  appDir: 'projects/c1/app',
};

const history: ConversationMessage[] = [
  { role: 'user', content: 'first request' },
  { role: 'assistant', content: 'first answer' },
];

// The system prompt is the head of the cached prefix. If it varies at all, the
// provider re-prefills a conversation that only grows.
test('the system prompt is identical no matter what the turn or project state is', () => {
  const firstTurn = buildSystemPrompt(state, MCP_SERVER);
  const laterTurn = buildSystemPrompt(
    { ...state, created: true, previewUrl: 'https://preview.example', previewPublished: true },
    MCP_SERVER,
  );

  assert.equal(firstTurn, laterTurn);
});

test('the system prompt holds no per-turn content', () => {
  const prompt = buildSystemPrompt(state, MCP_SERVER);

  assert.doesNotMatch(prompt, /Current user request/);
  assert.doesNotMatch(prompt, /Recent conversation/);
  assert.doesNotMatch(prompt, /Reply language for this turn/);
  assert.doesNotMatch(prompt, /empty and already prepared/);
});

test('the system prompt scopes the agent to the project directory and the MCP server', () => {
  const prompt = buildSystemPrompt(state, MCP_SERVER);

  assert.match(prompt, /projects\/c1\/app/);
  assert.match(prompt, new RegExp(MCP_SERVER));
  assert.match(prompt, /publish_project/);
  assert.match(prompt, /edgeone-deploy/);
  assert.match(prompt, /site card/);
  assert.match(prompt, /The project is live/);
  assert.doesNotMatch(prompt, /must include the production URL/);
});

// Localized copy in the prompt is what once made the agent answer an English
// request in Chinese.
test('the system prompt carries no localized copy and no retired tool', () => {
  const prompt = buildSystemPrompt(state, MCP_SERVER);

  assert.doesNotMatch(prompt, /[\u4e00-\u9fff]/);
  assert.doesNotMatch(prompt, /get_preview_link/);
});

test('the turn prompt carries the request and names its reply language', () => {
  const prompt = buildTurnPrompt('把按钮改成蓝色', [], state, false);

  assert.match(prompt, /Current user request: 把按钮改成蓝色/);
  assert.match(prompt, /Reply language for this turn: Chinese\./);
});

// Auto-fix prompts are machine-written English, but the answer still belongs to
// whoever asked the original question.
test('an internal prompt still answers in the original request language', () => {
  const prompt = buildTurnPrompt('Fix the build error', [], state, false, '把按钮改成蓝色');

  assert.match(prompt, /Reply language for this turn: Chinese\./);
});

// A resumed session already carries these turns in its transcript.
test('a resumed turn omits the history the transcript already holds', () => {
  const fresh = buildTurnPrompt('next', history, state, false, 'next', { sessionResumed: false });
  const resumed = buildTurnPrompt('next', history, state, false, 'next', { sessionResumed: true });

  assert.match(fresh, /Recent conversation/);
  assert.match(fresh, /first request/);
  assert.doesNotMatch(resumed, /Recent conversation/);
  assert.doesNotMatch(resumed, /first request/);
});

test('the new-project checklist appears only for an empty workspace', () => {
  const empty = buildTurnPrompt('build a timer', [], state, true);
  const existing = buildTurnPrompt('change the colour', [], state, false);

  assert.match(empty, /empty and already prepared/);
  assert.doesNotMatch(existing, /empty and already prepared/);
  assert.match(existing, /already prepared a project workspace/);
});

test('an unresumed follow-up lists the files it may edit', () => {
  const prompt = buildTurnPrompt('change the colour', [], state, false, 'change the colour', {
    sessionResumed: false,
    existingFiles: ['src/App.tsx', 'src/styles.css'],
  });

  assert.match(prompt, /Existing project files/);
  assert.match(prompt, /src\/App\.tsx/);
  assert.match(prompt, /Only files_read the files you will change/);
});
