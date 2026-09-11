/**
 * Domain events -> the existing ChatStreamEvent wire format.
 *
 * This presenter is what makes the migration incremental. The current browser
 * client keeps speaking shared/protocol.ts while the core underneath speaks
 * domain events, so the core can be extracted without a synchronized frontend
 * rewrite. It is also where the UI-shaped concerns that used to live in the
 * runtime now sit, by design:
 *
 *   - `phaseHint` is derived here from `ToolKind`, not decided by the engine.
 *   - Tool output is truncated here, because "how much text fits" is a display
 *     question.
 *
 * When the client eventually consumes domain events directly, deleting this
 * file is the whole cleanup.
 */

import { formatCommandOutput, looksLikeCommandLog } from '../../../shared/command-output.ts';
import type { ChatStreamEvent, ProgressPhase } from '../../../shared/protocol.ts';
import type { DomainEvent, ToolKind } from '../_events.ts';

const OUTPUT_DISPLAY_LIMIT = 2_000;

const PHASE_BY_TOOL_KIND: Record<ToolKind, ProgressPhase | undefined> = {
  'file.write': 'code',
  'file.read': undefined,
  'file.remove': 'code',
  'dir.create': 'code',
  'command.run': undefined,
  'dependency.install': 'install',
  'preview.publish': 'preview',
  'project.deploy': 'link',
  scaffold: 'scaffold',
  other: undefined,
};

function truncateForDisplay(value: string) {
  if (looksLikeCommandLog(value)) {
    return formatCommandOutput(value);
  }
  return value.length > OUTPUT_DISPLAY_LIMIT ? value.slice(0, OUTPUT_DISPLAY_LIMIT) : value;
}

/**
 * Translate one domain event. Returns `null` for events this wire format has no
 * slot for, which is itself informative: those are facts the browser never
 * needed and a CLI might.
 */
export function toChatStreamEvent(event: DomainEvent): ChatStreamEvent | null {
  switch (event.type) {
    case 'turn.started':
      return {
        type: 'task_started',
        data: {
          runId: event.runId,
          conversation_id: event.conversationId,
          status: 'running',
        },
      };

    case 'assistant.text':
      return {
        type: 'text_segment',
        data: { uuid: event.blockId, text: event.text },
      };

    case 'tool.invoked':
      return {
        type: 'tool_use',
        data: {
          id: event.toolUseId,
          name: event.name,
          command: event.command,
          phaseHint: PHASE_BY_TOOL_KIND[event.kind],
          startedAt: event.at,
        },
      };

    case 'tool.settled':
      return {
        type: 'tool_result',
        data: {
          tool_use_id: event.toolUseId,
          ok: event.ok,
          outputSummary: event.output ? truncateForDisplay(event.output) : undefined,
          status: event.ok ? 'completed' : 'failed',
          endedAt: event.at,
        },
      };

    case 'preview.ready':
      return {
        type: 'preview_ready',
        data: { preview: { url: event.url } },
      };

    case 'preview.failed':
      return {
        type: 'preview_ready',
        data: { preview: { error: event.reason } },
      };

    case 'verification.finished':
      return {
        type: 'result',
        data: {
          ok: event.status !== 'failed',
          build: {
            status: event.status,
            stdout: event.stdout,
            stderr: event.stderr,
          },
        },
      };

    case 'turn.finished':
      return {
        type: 'result',
        data: {
          ok: event.outcome === 'completed',
          stopped: event.outcome === 'stopped',
          reply: event.summary,
          // A reason code reaches the client as-is; localized copy is the
          // client's job now, not the runtime's.
          error: event.outcome === 'completed' ? undefined : event.reason,
        },
      };

    // `workspace.changed` carries paths; the browser wants a rebuilt tree, which
    // the host assembles from its own file-tree read.
    case 'workspace.changed':
      return null;

    default:
      return null;
  }
}

/** Adapt a domain event stream to the wire format the current client expects. */
export async function* presentAsChatStream(
  events: AsyncIterable<DomainEvent>,
): AsyncGenerator<ChatStreamEvent> {
  for await (const event of events) {
    const wireEvent = toChatStreamEvent(event);
    if (wireEvent) yield wireEvent;
  }
}
