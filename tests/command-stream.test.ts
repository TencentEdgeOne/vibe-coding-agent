import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COMMAND_STREAM_THROTTLE_MS,
  commandCallId,
  installCommandOutputStream,
} from '../agents/_lib/tools/command-stream.ts';
import type { AgentContext } from '../agents/_lib/runtime/context.ts';
import type { ChatStreamEvent } from '../shared/protocol.ts';

/**
 * A context whose toolkit records the handler it was given, the way the sandbox
 * runtime does — the sink only exists once something installs one.
 */
function streamingContext() {
  const state: { handler?: (chunk: unknown) => void } = {};
  const context = {
    tools: {
      toClaudeMcpServer: () => ({ tools: [], allowedTools: [] }),
      setCommandOutputHandler: (handler: (chunk: unknown) => void) => {
        state.handler = handler;
        return () => {
          if (state.handler === handler) state.handler = undefined;
        };
      },
    },
  } as unknown as AgentContext;
  return { context, emit: (chunk: unknown) => state.handler?.(chunk) };
}

type ToolPatch = Extract<ChatStreamEvent, { type: 'tool_use' }>['data'];

function collector() {
  const events: ChatStreamEvent[] = [];
  return {
    events,
    send: (event: ChatStreamEvent) => events.push(event),
    /** The output patches, which are the only thing this module emits. */
    patches: () => events
      .filter((event): event is Extract<ChatStreamEvent, { type: 'tool_use' }> => event.type === 'tool_use')
      .map((event) => event.data as ToolPatch),
  };
}

/** The installed stream, for a context that always has a sink. */
function install(overrides: {
  context: AgentContext;
  getSend: () => (event: ChatStreamEvent) => void;
  getProjectDir?: () => string;
  intervalMs?: number;
  now?: () => number;
}) {
  const stream = installCommandOutputStream({
    getProjectDir: () => '/app',
    ...overrides,
  });
  assert.ok(stream, 'the sink must install for a context that exposes one');
  return stream;
}

test('a runtime without an output sink installs nothing and still runs', () => {
  const context = {
    tools: { toClaudeMcpServer: () => ({ tools: [], allowedTools: [] }) },
  } as unknown as AgentContext;
  assert.equal(installCommandOutputStream({
    context,
    getSend: () => undefined,
    getProjectDir: () => '/app',
  }), null);
});

test('streamed output patches the running row while the command is still printing', () => {
  const { context, emit } = streamingContext();
  const sink = collector();
  const stream = install({ context, getSend: () => sink.send, intervalMs: 0 });

  const end = stream.begin({ toolUseId: 'toolu_1', command: 'npm run build' });
  emit({ stream: 'stdout', data: 'Compiling…\n', command: 'npm run build', toolUseId: 'toolu_1' });
  emit({ stream: 'stderr', data: 'warning: chunk is large\n', command: 'npm run build', toolUseId: 'toolu_1' });

  const patches = sink.patches();
  assert.ok(patches.length >= 1);
  const last = patches.at(-1);
  assert.equal(last?.id, 'toolu_1');
  assert.match(String(last?.outputSummary), /Compiling/);
  assert.match(String(last?.outputSummary), /chunk is large/);
  // The row already knows its name and input. A patch that repeated them would
  // only risk replacing them with this module's idea of the call.
  assert.equal(last?.name, undefined);
  assert.equal(last?.inputSummary, undefined);

  end();
});

test('nothing is painted once the command has ended', () => {
  const { context, emit } = streamingContext();
  const sink = collector();
  const stream = install({ context, getSend: () => sink.send, intervalMs: 0 });

  const end = stream.begin({ toolUseId: 'toolu_1', command: 'npm run build' });
  emit({ data: 'before\n', command: 'npm run build', toolUseId: 'toolu_1' });
  const before = sink.events.length;
  end();
  // A late chunk from a process that has already exited has no row to patch.
  emit({ data: 'after\n', command: 'npm run build', toolUseId: 'toolu_1' });
  assert.equal(sink.events.length, before);
});

test('a chunk with no tool-use id is dropped rather than guessed at', () => {
  const { context, emit } = streamingContext();
  const sink = collector();
  const stream = install({ context, getSend: () => sink.send, intervalMs: 0 });
  const end = stream.begin({ command: 'npm run build' });
  emit({ data: 'Compiling…\n', command: 'npm run build' });
  assert.equal(sink.events.length, 0);
  end();
});

test('the tail is what is shown, cut at a line boundary', () => {
  const { context, emit } = streamingContext();
  const sink = collector();
  const stream = install({ context, getSend: () => sink.send, intervalMs: 0 });
  const end = stream.begin({ toolUseId: 'toolu_1', command: 'npm run build' });

  // Past the tail window, so the leading lines go and no escape is left half
  // written at the front of what remains.
  const noise = Array.from({ length: 2_000 }, (_, index) => `line ${index}`).join('\n');
  emit({ data: `${noise}\n\x1b[32mDone in 12s\x1b[0m\n`, command: 'npm run build', toolUseId: 'toolu_1' });

  const summary = String(sink.patches().at(-1)?.outputSummary);
  assert.match(summary, /Done in 12s/);
  assert.doesNotMatch(summary, /line 0\n/);
  end();
});

test('the token and the gateway key never reach a live patch', () => {
  const { context, emit } = streamingContext();
  const sink = collector();
  const stream = install({ context, getSend: () => sink.send, intervalMs: 0 });
  const end = stream.begin({
    toolUseId: 'toolu_1',
    command: 'edgeone makers deploy',
    secrets: ['sandbox-token-value', 'gateway-key-value'],
  });
  emit({
    data: 'token=sandbox-token-value key=gateway-key-value\n',
    command: 'edgeone makers deploy',
    toolUseId: 'toolu_1',
  });

  const summary = String(sink.patches().at(-1)?.outputSummary);
  assert.doesNotMatch(summary, /sandbox-token-value|gateway-key-value/);
  end();
});

test('a repaint is throttled, and the last chunk still lands', async () => {
  const { context, emit } = streamingContext();
  const sink = collector();
  const stream = install({
    context,
    getSend: () => sink.send,
    intervalMs: COMMAND_STREAM_THROTTLE_MS,
    now: () => 0,
  });
  const end = stream.begin({ toolUseId: 'toolu_1', command: 'npm run build' });

  emit({ data: 'first\n', command: 'npm run build', toolUseId: 'toolu_1' });
  emit({ data: 'second\n', command: 'npm run build', toolUseId: 'toolu_1' });
  assert.equal(sink.events.length, 1, 'the second chunk coalesces into the first repaint');

  await new Promise((resolve) => setTimeout(resolve, COMMAND_STREAM_THROTTLE_MS + 50));
  // The coalesced trailing chunk is not lost to the throttle.
  assert.equal(sink.events.length, 2);
  assert.match(String(sink.patches().at(-1)?.outputSummary), /second/);
  end();
});

test('the tool use id comes from the key the CLI actually sets', () => {
  assert.equal(commandCallId({ _meta: { 'claudecode/toolUseId': 'toolu_1' } }), 'toolu_1');
  assert.equal(commandCallId({ toolUseId: 'toolu_2' }), 'toolu_2');
  assert.equal(commandCallId({ tool_use_id: 'toolu_3' }), 'toolu_3');
  assert.equal(commandCallId({}), undefined);
  assert.equal(commandCallId(null), undefined);
  assert.equal(commandCallId({ _meta: { 'claudecode/toolUseId': '   ' } }), undefined);
});
