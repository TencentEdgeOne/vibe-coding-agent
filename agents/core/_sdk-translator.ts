/**
 * Translate Claude Agent SDK messages into domain events.
 *
 * This is the heart of the agent loop, and it was the least testable part of
 * the template: ~200 lines of stream bookkeeping welded to `onProgress?.()`
 * callbacks inside an 800-line function, reachable only by running a real
 * model against a real sandbox.
 *
 * It is really a pure translation with state, so it is modelled as one. Feed it
 * SDK messages, get domain events back. No context, no callbacks, no HTTP.
 *
 * The three pieces of bookkeeping that look incidental but are not:
 *
 *   1. Tool inputs stream in as partial JSON across deltas, so a tool call is
 *      announced on `content_block_start` and refined on `content_block_stop`.
 *      Emitting a duplicate would make the UI show the same step twice, hence
 *      the signature dedupe.
 *   2. Tool results arrive on `user` messages and reference a tool by id alone,
 *      so the name and command must be remembered from the invocation.
 *   3. A tool call ends the current narration block. Without clearing the
 *      dedupe window, the next sentence can be swallowed by the previous one.
 */

import type { DomainEvent, ToolKind } from './_events.ts';

/** The SDK message shape this translator actually reads. */
export type SdkMessageLike = {
  type: string;
  uuid?: string;
  subtype?: string;
  event?: any;
  message?: { content?: unknown };
};

export type TranslatorHelpers = {
  sanitizeText: (value: string) => string;
  /** Incremental narration dedupe; returns only the not-yet-emitted suffix. */
  resolveNarration: (
    state: NarrationWindow,
    rawText: string,
    complete: boolean,
  ) => { state: NarrationWindow; text: string | null };
  classifyTool: (name: string, input: unknown) => ToolKind;
  extractCommand: (name: string, input: unknown) => string;
  parseEchoedExitCode: (output: string) => number | undefined;
  detectFatalError: (text: string) => string | null;
};

export type NarrationWindow = {
  currentTextBlock: string;
  emittedNarration: string;
};

type PendingToolBlock = {
  id: string;
  name: string;
  inputJson: string;
  input?: unknown;
};

export type TranslatorOutcome = {
  /** Set when the run hit an unrecoverable host failure and must stop now. */
  fatalError?: string;
  /** Set when the SDK produced its terminal result message. */
  finished?: boolean;
  /** Whether any tool wrote to the project. */
  projectTouched: boolean;
};

function isToolUseBlock(block: unknown): block is {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
} {
  const record = block && typeof block === 'object' ? block as Record<string, unknown> : {};
  return record.type === 'tool_use' || record.type === 'mcp_tool_use';
}

/**
 * Whether the SDK has handed over the tool's assembled arguments yet.
 *
 * Cheaper than comparing the arguments themselves, which for a file write is
 * the entire file, and enough to tell the announcement apart from the
 * refinement that follows it.
 */
function hasToolInput(input: unknown) {
  return Boolean(
    input
    && typeof input === 'object'
    && Object.keys(input as Record<string, unknown>).length > 0,
  );
}

function textFromBlock(block: unknown) {
  const record = block && typeof block === 'object' ? block as Record<string, unknown> : {};
  return record.type === 'text' && typeof record.text === 'string' ? record.text : '';
}

function parseToolInputJson(rawJson: string, fallback: unknown) {
  if (!rawJson.trim()) return fallback ?? {};
  try {
    return JSON.parse(rawJson);
  } catch {
    return fallback ?? {};
  }
}

function toolResultText(block: any) {
  if (Array.isArray(block?.content)) {
    return block.content
      .map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
      .join(' ');
  }
  return typeof block?.content === 'string' ? block.content : '';
}

/**
 * A translator instance for one turn.
 *
 * Stateful by necessity — partial tool JSON and narration dedupe both span
 * messages — but the state is owned here rather than scattered through a
 * long function's local variables.
 */
export function createSdkTranslator(options: {
  runId: string;
  helpers: TranslatorHelpers;
}) {
  const { runId, helpers } = options;

  const toolsById = new Map<string, { name: string; command?: string }>();
  const toolStartedAt = new Map<string, number>();
  const pendingBlocks = new Map<number, PendingToolBlock>();
  const emittedSignatures = new Map<string, string>();

  let narration: NarrationWindow = { currentTextBlock: '', emittedNarration: '' };
  let fatalError: string | undefined;
  let projectTouched = false;
  let finished = false;

  function* emitNarration(rawText: string, blockId: string, complete: boolean) {
    if (!rawText) return;
    const resolved = helpers.resolveNarration(narration, rawText, complete);
    narration = resolved.state;
    if (!resolved.text) return;
    yield {
      type: 'assistant.text',
      runId,
      blockId,
      text: resolved.text,
      at: Date.now(),
    } satisfies DomainEvent;
  }

  function* emitToolInvoked(toolUse: { id?: string; name?: string; input?: unknown }) {
    const name = typeof toolUse.name === 'string' ? toolUse.name : '<unknown>';
    const toolUseId = typeof toolUse.id === 'string' ? toolUse.id : '';
    const command = helpers.extractCommand(name, toolUse.input);
    const kind = helpers.classifyTool(name, toolUse.input);

    // A tool is announced at content_block_start before its arguments have
    // streamed, then again at content_block_stop with them assembled. Consumers
    // key by toolUseId and upsert, so that refinement has to reach them — it is
    // how a caller learns which path a file write is writing. What must not
    // reach them is a repeat that carries nothing new.
    const signature = JSON.stringify({
      name,
      command,
      kind,
      refined: hasToolInput(toolUse.input),
    });
    if (toolUseId) {
      if (emittedSignatures.get(toolUseId) === signature) return;
      emittedSignatures.set(toolUseId, signature);
    }

    // A tool call ends the current narration block.
    narration = { ...narration, currentTextBlock: '' };

    if (toolUseId) {
      toolsById.set(toolUseId, { name, ...(command ? { command } : {}) });
    }
    const startedAt = (toolUseId && toolStartedAt.get(toolUseId)) || Date.now();
    if (toolUseId) toolStartedAt.set(toolUseId, startedAt);

    if (kind === 'file.write' || kind === 'dir.create') projectTouched = true;

    yield {
      type: 'tool.invoked',
      runId,
      toolUseId,
      name,
      kind,
      ...(command ? { command } : {}),
      raw: toolUse.input,
      at: startedAt,
    } satisfies DomainEvent;
  }

  function* handleStreamEvent(event: SdkMessageLike) {
    const stream = event.event;
    const blockId = typeof event.uuid === 'string' ? event.uuid : '';

    if (stream?.type === 'content_block_delta') {
      const delta = stream.delta;
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        yield* emitNarration(helpers.sanitizeText(delta.text), blockId, false);
      }
      // Tool inputs stream as partial JSON; accumulate until the block stops.
      const pending = typeof stream.index === 'number'
        ? pendingBlocks.get(stream.index)
        : undefined;
      if (pending && delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
        pending.inputJson += delta.partial_json;
      }
      return;
    }

    if (stream?.type === 'content_block_start') {
      const block = stream.content_block;
      // A fresh text block starts a fresh dedupe window, so an earlier sentence
      // cannot suppress a later one that shares a suffix.
      if (block?.type === 'text') {
        narration = { ...narration, currentTextBlock: '' };
      }
      if (isToolUseBlock(block) && typeof stream.index === 'number') {
        pendingBlocks.set(stream.index, {
          id: typeof block.id === 'string' ? block.id : '',
          name: typeof block.name === 'string' ? block.name : '',
          inputJson: '',
          input: block.input,
        });
        yield* emitToolInvoked({ id: block.id, name: block.name, input: block.input });
      }
      return;
    }

    if (stream?.type === 'content_block_stop') {
      const pending = typeof stream.index === 'number'
        ? pendingBlocks.get(stream.index)
        : undefined;
      if (pending) {
        pendingBlocks.delete(stream.index);
        yield* emitToolInvoked({
          id: pending.id,
          name: pending.name,
          input: parseToolInputJson(pending.inputJson, pending.input),
        });
      }
    }
  }

  function* handleToolResults(event: SdkMessageLike) {
    const blocks = (event.message as any)?.content;
    if (!Array.isArray(blocks)) return;

    for (const block of blocks) {
      if (block?.type !== 'tool_result') continue;

      const text = toolResultText(block);
      const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
      const known = toolsById.get(toolUseId);
      const echoedExit = helpers.parseEchoedExitCode(text);
      const commandFailed = typeof echoedExit === 'number' && echoedExit !== 0;
      const failed = block.is_error === true || commandFailed;

      yield {
        type: 'tool.settled',
        runId,
        toolUseId,
        ok: !failed,
        ...(typeof echoedExit === 'number' ? { exitCode: echoedExit } : {}),
        // Untruncated: trimming for display is a host decision.
        output: text,
        at: Date.now(),
      } satisfies DomainEvent;

      // Only trust is_error for infrastructure detection; ordinary output
      // containing "Not Found" must not abort the run.
      if (block.is_error === true && !fatalError) {
        const fatal = helpers.detectFatalError(text);
        if (fatal) {
          fatalError = `${fatal} (tool=${known?.name || '<unknown>'})`;
        }
      }
    }
  }

  return {
    /** Translate one SDK message into zero or more domain events. */
    *translate(event: SdkMessageLike): Generator<DomainEvent> {
      if (event.type === 'stream_event') {
        yield* handleStreamEvent(event);
        return;
      }

      if (event.type === 'assistant') {
        const blocks = (event.message as any)?.content;
        if (!Array.isArray(blocks)) return;
        const blockId = typeof event.uuid === 'string' ? event.uuid : '';
        for (const block of blocks) {
          const text = textFromBlock(block);
          if (text) {
            yield* emitNarration(helpers.sanitizeText(text), blockId, true);
          }
          if (isToolUseBlock(block)) {
            yield* emitToolInvoked({ id: block.id, name: block.name, input: block.input });
          }
        }
        return;
      }

      if (event.type === 'user') {
        yield* handleToolResults(event);
        return;
      }

      if (event.type === 'result') {
        finished = true;
      }
    },

    /** Whether the loop should stop before consuming more messages. */
    shouldStop() {
      return finished || Boolean(fatalError);
    },

    outcome(): TranslatorOutcome {
      return {
        ...(fatalError ? { fatalError } : {}),
        ...(finished ? { finished } : {}),
        projectTouched,
      };
    },

    /** Tool metadata by id, for callers that still need the legacy shape. */
    toolContext(toolUseId: string) {
      return toolsById.get(toolUseId);
    },
  };
}
