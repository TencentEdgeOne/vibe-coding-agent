import assert from 'node:assert/strict';
import test from 'node:test';

import type { DomainEvent } from '../agents/core/_events.ts';
import {
  createSdkTranslator,
  type SdkMessageLike,
  type TranslatorHelpers,
} from '../agents/core/_sdk-translator.ts';
import { classifyTool, extractCommandFromInput } from '../agents/core/_tool-kind.ts';
import { resolveNarrationEmit, sanitizeNarrationText } from '../agents/utils/_narration.ts';
import {
  isInstallCommand,
  isPreviewCommand,
  parseEchoedExitCode,
} from '../agents/utils/_tool-phase.ts';
import { detectFatalToolError } from '../agents/utils/_text.ts';

const HELPERS: TranslatorHelpers = {
  sanitizeText: sanitizeNarrationText,
  resolveNarration: (state, rawText, complete) => resolveNarrationEmit(state, rawText, complete),
  classifyTool: (name, input) => classifyTool(name, input, { isInstallCommand, isPreviewCommand }),
  extractCommand: (name, input) =>
    (name.endsWith('commands') ? extractCommandFromInput(input) : ''),
  parseEchoedExitCode,
  detectFatalError: detectFatalToolError,
};

function translate(events: SdkMessageLike[]) {
  const translator = createSdkTranslator({ runId: 'run-1', helpers: HELPERS });
  const out: DomainEvent[] = [];
  for (const event of events) {
    for (const domainEvent of translator.translate(event)) out.push(domainEvent);
    if (translator.shouldStop()) break;
  }
  return { events: out, translator };
}

function textDelta(text: string, uuid = 'block-1'): SdkMessageLike {
  return { type: 'stream_event', uuid, event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } };
}

test('streamed text deltas become assistant text events', () => {
  const { events } = translate([textDelta('Building '), textDelta('the page.')]);

  assert.deepEqual(
    events.map((event) => event.type === 'assistant.text' && event.text),
    ['Building ', 'the page.'],
  );
});

// A complete assistant snapshot repeats what already streamed; only the
// not-yet-sent suffix may be emitted or the UI shows the sentence twice.
test('a complete assistant message does not repeat already streamed text', () => {
  const { events } = translate([
    textDelta('Building the '),
    {
      type: 'assistant',
      uuid: 'block-1',
      message: { content: [{ type: 'text', text: 'Building the page.' }] },
    },
  ]);

  const texts = events
    .filter((event) => event.type === 'assistant.text')
    .map((event) => event.type === 'assistant.text' && event.text);

  assert.deepEqual(texts, ['Building the ', 'page.']);
});

// The announcement carries no arguments yet, so the refinement that follows is
// the only place a consumer learns which file is being written. Consumers key
// by toolUseId and upsert, so two events describe one step, not two.
test('a tool call is announced, then refined once its arguments arrive', () => {
  const { events } = translate([
    {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 't1', name: 'mcp__edgeone-sandbox__write_project_file' },
      },
    },
    {
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"path":"a.tsx"' } },
    },
    {
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: ',"content":"x"}' } },
    },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
  ]);

  const invoked = events.filter((event) => event.type === 'tool.invoked');
  assert.equal(invoked.length, 2);
  assert.equal(invoked[0]?.type === 'tool.invoked' && invoked[0].kind, 'file.write');
  // Same step, same id — the second one is what carries the path.
  assert.equal(invoked[1]?.type === 'tool.invoked' && invoked[1].toolUseId, 't1');
  assert.deepEqual(
    invoked[1]?.type === 'tool.invoked' ? invoked[1].raw : null,
    { path: 'a.tsx', content: 'x' },
  );
});

test('a repeat that carries nothing new is not re-announced', () => {
  const { events } = translate([
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 't1', name: 'mcp__edgeone-sandbox__files_read', input: { path: 'a.tsx' } },
        ],
      },
    },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 't1', name: 'mcp__edgeone-sandbox__files_read', input: { path: 'a.tsx' } },
        ],
      },
    },
  ]);

  assert.equal(events.filter((event) => event.type === 'tool.invoked').length, 1);
});

// Partial JSON arrives across deltas; the assembled input must be parsed.
test('tool input assembled from partial JSON reaches the event', () => {
  const translator = createSdkTranslator({ runId: 'run-1', helpers: HELPERS });
  const events: DomainEvent[] = [];
  const push = (event: SdkMessageLike) => {
    for (const domainEvent of translator.translate(event)) events.push(domainEvent);
  };

  push({
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 't1', name: 'mcp__edgeone-sandbox__commands' },
    },
  });
  push({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"npm ' } },
  });
  push({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'install"}' } },
  });
  push({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });

  const invoked = events.filter((event) => event.type === 'tool.invoked');
  // The start had no command yet, so the completed input is a real refinement.
  const last = invoked.at(-1);
  assert.equal(last?.type === 'tool.invoked' && last.command, 'npm install');
  assert.equal(last?.type === 'tool.invoked' && last.kind, 'dependency.install');
});

test('malformed tool input JSON falls back instead of throwing', () => {
  const { events } = translate([
    {
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 't1', name: 'files_read', input: { path: 'a.ts' } },
      },
    },
    {
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{not json' } },
    },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
  ]);

  const invoked = events.filter((event) => event.type === 'tool.invoked');
  assert.equal(invoked.length, 1);
  assert.equal(invoked[0]?.type === 'tool.invoked' && invoked[0].kind, 'file.read');
});

// Tool results reference a tool by id only, so the invocation must be remembered.
test('a tool result is matched back to its invocation', () => {
  const { events, translator } = translate([
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__edgeone-sandbox__commands', input: { command: 'npm run build' } }] },
    },
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'compiled ok' }] },
    },
  ]);

  const settled = events.find((event) => event.type === 'tool.settled');
  assert.equal(settled?.type === 'tool.settled' && settled.toolUseId, 't1');
  assert.equal(settled?.type === 'tool.settled' && settled.ok, true);
  assert.equal(settled?.type === 'tool.settled' && settled.output, 'compiled ok');
  assert.equal(translator.toolContext('t1')?.command, 'npm run build');
});

// An echoed non-zero exit means failure even when the SDK reports success,
// because the host drops output on a non-zero shell exit.
test('an echoed non-zero exit code marks the tool as failed', () => {
  const { events } = translate([
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'error TS2339\nEXIT:2' }] },
    },
  ]);

  const settled = events.find((event) => event.type === 'tool.settled');
  assert.equal(settled?.type === 'tool.settled' && settled.ok, false);
  assert.equal(settled?.type === 'tool.settled' && settled.exitCode, 2);
});

test('an echoed zero exit stays successful', () => {
  const { events } = translate([
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done\nEXIT:0' }] } },
  ]);

  const settled = events.find((event) => event.type === 'tool.settled');
  assert.equal(settled?.type === 'tool.settled' && settled.ok, true);
  assert.equal(settled?.type === 'tool.settled' && settled.exitCode, 0);
});

test('tool output is passed through untruncated for the host to trim', () => {
  const long = 'x'.repeat(5_000);
  const { events } = translate([
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: long }] } },
  ]);

  const settled = events.find((event) => event.type === 'tool.settled');
  assert.equal(settled?.type === 'tool.settled' && settled.output?.length, 5_000);
});

// Infrastructure failure must stop the run; retrying only burns turns.
test('a fatal sandbox error stops the loop', () => {
  const { events, translator } = translate([
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 't1', name: 'files_read' }] },
    },
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'Not Found' }] },
    },
    textDelta('this must never be translated'),
  ]);

  assert.equal(translator.shouldStop(), true);
  assert.match(translator.outcome().fatalError ?? '', /Not Found/);
  assert.match(translator.outcome().fatalError ?? '', /tool=files_read/);
  // The loop broke before the trailing narration.
  assert.equal(events.some((event) => event.type === 'assistant.text'), false);
});

// The strict match exists so a literal "not found" in user output is not
// mistaken for an infrastructure failure.
test('ordinary output mentioning not found is not fatal', () => {
  const { translator } = translate([
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'grep: pattern not found in file' }] },
    },
  ]);

  assert.equal(translator.outcome().fatalError, undefined);
  assert.equal(translator.shouldStop(), false);
});

test('a failed tool without is_error is not treated as infrastructure failure', () => {
  const { translator } = translate([
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Not Found' }] },
    },
  ]);

  assert.equal(translator.outcome().fatalError, undefined);
});

test('the result message finishes the run', () => {
  const { translator } = translate([
    textDelta('working'),
    { type: 'result', subtype: 'success' },
  ]);

  assert.equal(translator.shouldStop(), true);
  assert.equal(translator.outcome().finished, true);
  assert.equal(translator.outcome().fatalError, undefined);
});

test('a project write marks the turn as having touched the project', () => {
  const { translator } = translate([
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 't1', name: 'mcp__edgeone-sandbox__write_project_file', input: { path: 'a.tsx' } }] },
    },
  ]);

  assert.equal(translator.outcome().projectTouched, true);
});

test('a read-only turn does not claim to have touched the project', () => {
  const { translator } = translate([
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'files_read' }] } },
  ]);

  assert.equal(translator.outcome().projectTouched, false);
});

test('unknown and irrelevant SDK messages translate to nothing', () => {
  const { events } = translate([
    { type: 'system', subtype: 'init' },
    { type: 'assistant', message: { content: 'not an array' as never } },
    { type: 'user', message: {} },
    { type: 'stream_event', event: { type: 'something_else' } },
  ]);

  assert.deepEqual(events, []);
});

test('translation carries no host runtime dependency', async () => {
  const source = await import('node:fs/promises')
    .then((fs) => fs.readFile('agents/core/_sdk-translator.ts', 'utf8'));
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  assert.doesNotMatch(code, /context/);
  assert.doesNotMatch(code, /sandbox\./);
  assert.doesNotMatch(code, /onProgress/);
});
