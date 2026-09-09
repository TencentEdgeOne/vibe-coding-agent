import { appendTurn, saveActivityTurn, saveProjectState } from '../_memory.ts';
import type {
  AgentProgressEvent,
  PersistedActivity,
  ProjectState,
} from '../_types.ts';
import type { TurnResult } from '../../shared/protocol.ts';
import type { ProjectCheckpointController } from './_helpers.ts';

type TurnStatus = 'completed' | 'failed' | 'stopped';

type TurnLifecycleOptions = {
  context: any;
  conversationId: string;
  message: string;
  turnId: string;
  userMessagePersisted: boolean;
  state: ProjectState;
  checkpoint: ProjectCheckpointController;
};

type FinalizeOptions = {
  withSnapshot?: boolean;
  withState?: boolean;
  turnResult?: TurnResult;
};

/** Owns progress aggregation and the durable commit order for one chat turn. */
export function createTurnLifecycle(options: TurnLifecycleOptions) {
  const activities: PersistedActivity[] = [];
  const startedAt = Date.now();

  const recordLog = (log: {
    phase?: 'scaffold' | 'agent';
    stream?: 'status' | 'stdout' | 'stderr';
    message: string;
    startedAt?: number;
    endedAt?: number;
  }) => {
    const message = log.message.trim();
    if (!message) return;
    const now = Date.now();
    const startedAt = log.startedAt ?? now;
    activities.push({
      kind: 'log',
      phase: log.phase,
      stream: log.stream,
      message,
      startedAt,
      endedAt: log.endedAt ?? startedAt,
    });
  };

  const recordProgress = (event: AgentProgressEvent) => {
    if (event.type === 'text_segment') {
      const text = event.data.text;
      if (!text) return;
      const now = Date.now();
      const last = activities.at(-1);
      if (last?.kind === 'text') {
        if (last.content.endsWith(text) || last.content.endsWith(text.trim())) return;
        activities[activities.length - 1] = {
          ...last,
          content: `${last.content}${text}`,
          endedAt: now,
        };
      } else {
        activities.push({ kind: 'text', content: text, startedAt: now, endedAt: now });
      }
      return;
    }

    if (event.type === 'tool_output') {
      const existing = activities.find(
        (item): item is Extract<PersistedActivity, { kind: 'tool' }> =>
          item.kind === 'tool' && item.toolUseId === event.data.tool_use_id,
      );
      if (existing && event.data.outputSummary) {
        existing.outputSummary = event.data.outputSummary;
      }
      return;
    }

    if (event.type === 'tool_use') {
      const existing = activities.find(
        (item): item is Extract<PersistedActivity, { kind: 'tool' }> =>
          item.kind === 'tool' && item.toolUseId === event.data.id,
      );
      if (existing) {
        existing.name = event.data.name || existing.name;
        existing.inputSummary = event.data.inputSummary || existing.inputSummary;
        existing.command = event.data.command || existing.command;
        existing.phaseHint = event.data.phaseHint || existing.phaseHint;
        return;
      }
      activities.push({
        kind: 'tool',
        toolUseId: event.data.id,
        name: event.data.name,
        status: 'running',
        inputSummary: event.data.inputSummary,
        command: event.data.command,
        phaseHint: event.data.phaseHint,
        startedAt: event.data.startedAt || Date.now(),
      });
      return;
    }

    const existing = activities.find(
      (item): item is Extract<PersistedActivity, { kind: 'tool' }> =>
        item.kind === 'tool' && item.toolUseId === event.data.tool_use_id,
    );
    if (existing) {
      existing.status = event.data.status || (event.data.ok ? 'completed' : 'failed');
      existing.outputSummary = event.data.outputSummary || event.data.preview;
      existing.endedAt = event.data.endedAt || Date.now();
      if (event.data.command) existing.command = event.data.command;
    }
  };

  const finalize = async (
    assistant: string,
    status: TurnStatus,
    finalizeOptions?: FinalizeOptions,
  ) => {
    const endedAt = Date.now();
    for (const activity of activities) {
      if (activity.kind === 'tool' && activity.status === 'running') {
        activity.status = status === 'stopped'
          ? 'stopped'
          : status === 'failed'
            ? 'failed'
            : 'completed';
        activity.endedAt = endedAt;
      }
      if (activity.kind === 'text' && !activity.endedAt) {
        activity.endedAt = endedAt;
      }
    }

    const turnResult: TurnResult = {
      ok: status === 'completed',
      stopped: status === 'stopped',
      hasPreview: Boolean(options.state.previewUrl),
      ...finalizeOptions?.turnResult,
    };

    // Commit order matters: snapshot → project metadata → conversation.
    if (finalizeOptions?.withSnapshot === true) await options.checkpoint.flush();
    if (finalizeOptions?.withState !== false) {
      await saveProjectState(options.context, options.conversationId, options.state);
    }
    if (!options.userMessagePersisted) {
      await appendTurn(options.context, options.conversationId, 'user', options.message);
    }
    await appendTurn(options.context, options.conversationId, 'assistant', assistant);
    await saveActivityTurn(options.context, options.conversationId, {
      id: options.turnId,
      user: options.message,
      assistant,
      status,
      createdAt: startedAt,
      startedAt,
      endedAt,
      turnResult,
      activities,
    });
  };

  return { recordProgress, recordLog, finalize };
}
