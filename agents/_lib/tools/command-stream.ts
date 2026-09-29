/**
 * Live command output.
 *
 * A `commands` call resolves exactly once, so a build that prints for two
 * minutes reaches the UI as one silent row and then all of its output at once.
 * The sandbox runtime already holds the stream — it wires E2B's onStdout and
 * onStderr whenever something installs a handler through
 * `tools.setCommandOutputHandler` — and this relays the tail of it onto the
 * tool_use row that is already on screen.
 *
 * Nothing here decides an outcome. The tool_result still carries the whole
 * output and the command's exit status; this only paints while it runs.
 */

import type { AgentContext } from '../runtime/context.ts';
import type { StreamSend } from '../types.ts';
import { summarizeToolOutput } from '../../../shared/timeline.ts';
import { redactSecret } from '../makers/cli-deploy.ts';

/** How often a running command may repaint its row. */
export const COMMAND_STREAM_THROTTLE_MS = 250;

/** Bounds what one row can accumulate, so a chatty build cannot grow it without
 *  limit. Bigger than the tail below, because the tail is cut per repaint. */
const COMMAND_STREAM_BUFFER_CHARS = 8_000;

/** What a running row shows. The settled output replaces it at the end, so this
 *  is deliberately only the end of the log — enough to watch a build move. */
const COMMAND_STREAM_TAIL_CHARS = 2_000;

type InFlightCommand = {
  toolUseId?: string;
  command: string;
  secrets: string[];
  buffer: string;
  lastEmitAt: number;
  timer?: ReturnType<typeof setTimeout>;
};

export type CommandOutputStream = {
  /** Registers one in-flight command; the returned function unregisters it. */
  begin(call: {
    toolUseId?: string;
    command: string;
    secrets?: string[];
  }): () => void;
};

/**
 * The id the agent loop gave this call.
 *
 * Claude Code passes it in the MCP request `_meta`, under the key it owns, so a
 * handler can attach progress to the call it came from. A runtime that keyed
 * its own copy is read too. Without an id there is no row to paint — the
 * browser keys activities by it — so such a call simply runs unstreamed.
 */
export function commandCallId(extra: unknown): string | undefined {
  const record = extra && typeof extra === 'object' ? extra as Record<string, unknown> : {};
  const meta = record._meta && typeof record._meta === 'object'
    ? record._meta as Record<string, unknown>
    : {};
  for (const value of [
    meta['claudecode/toolUseId'],
    record.toolUseId,
    record.tool_use_id,
    meta.toolUseId,
    meta.tool_use_id,
  ]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * The end of a log, cut at a line start.
 *
 * A plain slice can begin inside an ANSI sequence, and half an escape renders
 * as literal punctuation mid-sentence. Escapes never span a newline, so cutting
 * at one is the whole fix.
 */
function tailLines(buffer: string, limit: number) {
  if (buffer.length <= limit) return buffer;
  const window = buffer.slice(-limit);
  const newline = window.indexOf('\n');
  return newline >= 0 ? window.slice(newline + 1) : window;
}

/**
 * Installs the sandbox's live output sink for one session.
 *
 * Returns null on a runtime that does not expose one, which is the only thing
 * that makes this optional: `commands` then runs unstreamed, as it did before.
 */
export function installCommandOutputStream(options: {
  context: AgentContext;
  getSend: () => StreamSend | undefined;
  getProjectDir: () => string;
  intervalMs?: number;
  now?: () => number;
}): CommandOutputStream | null {
  let install: ((handler: (chunk: unknown) => void) => unknown) | undefined;
  try {
    const candidate = options.context.tools?.setCommandOutputHandler;
    if (typeof candidate === 'function') install = candidate as typeof install;
  } catch {
    // Reading `context.tools` throws when the toolkit was never injected.
    return null;
  }
  if (!install) return null;

  const interval = options.intervalMs ?? COMMAND_STREAM_THROTTLE_MS;
  const now = options.now ?? Date.now;
  const inFlight: InFlightCommand[] = [];

  const emit = (entry: InFlightCommand) => {
    if (!entry.toolUseId) return;
    const send = options.getSend();
    if (!send) return;
    let text = summarizeToolOutput(
      tailLines(entry.buffer, COMMAND_STREAM_TAIL_CHARS),
      options.getProjectDir(),
    );
    for (const secret of entry.secrets) text = redactSecret(text, secret);
    if (!text) return;
    entry.lastEmitAt = now();
    // Sent and not recorded. The row is already in the turn and the tool_result
    // will settle it with the whole output, so storing every repaint would add
    // hundreds of copies of a log that was already kept once.
    //
    // No `name` and no `inputSummary` either: this patches a row the agent loop
    // put on screen, and repeating either would overwrite them with this
    // module's idea of what the call is.
    send({
      type: 'tool_use',
      data: { id: entry.toolUseId, outputSummary: text },
    });
  };

  const push = (entry: InFlightCommand, data: string) => {
    entry.buffer = (entry.buffer + data).slice(-COMMAND_STREAM_BUFFER_CHARS);
    const elapsed = now() - entry.lastEmitAt;
    if (elapsed >= interval) {
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = undefined;
      }
      emit(entry);
      return;
    }
    // Coalesced: one repaint per interval, and the trailing chunk of a command
    // that finishes inside one is not dropped — the timer gets it out.
    if (!entry.timer) {
      entry.timer = setTimeout(() => {
        entry.timer = undefined;
        emit(entry);
      }, interval - elapsed);
    }
  };

  const resolve = (chunk: { toolUseId?: string; command?: string }) => {
    if (chunk.toolUseId) {
      const byId = inFlight.find((entry) => entry.toolUseId === chunk.toolUseId);
      if (byId) return byId;
    }
    if (chunk.command) {
      const byCommand = inFlight.find((entry) => entry.command === chunk.command);
      if (byCommand) return byCommand;
    }
    // An id nobody registered belongs to a call that has already ended. Only
    // when the chunk identified nothing at all is one in-flight command
    // unambiguous.
    if (chunk.toolUseId) return undefined;
    return inFlight.length === 1 ? inFlight[0] : undefined;
  };

  install((raw) => {
    const chunk = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const data = typeof chunk.data === 'string' ? chunk.data : '';
    if (!data) return;
    const entry = resolve({
      toolUseId: typeof chunk.toolUseId === 'string' ? chunk.toolUseId : undefined,
      command: typeof chunk.command === 'string' ? chunk.command : undefined,
    });
    if (entry) push(entry, data);
  });

  return {
    begin(call) {
      const entry: InFlightCommand = {
        ...(call.toolUseId ? { toolUseId: call.toolUseId } : {}),
        command: call.command,
        secrets: (call.secrets || []).filter(Boolean),
        buffer: '',
        // Backdated by one interval, so the first thing a command prints is on
        // screen at once and only the chunks after it are rate-limited. A row
        // that stayed empty for a quarter second before showing anything would
        // read as slower than one with no streaming at all.
        lastEmitAt: now() - interval,
      };
      inFlight.push(entry);
      return () => {
        const index = inFlight.indexOf(entry);
        if (index >= 0) inFlight.splice(index, 1);
        if (entry.timer) {
          clearTimeout(entry.timer);
          entry.timer = undefined;
        }
      };
    },
  };
}
