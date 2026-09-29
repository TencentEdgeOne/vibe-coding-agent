import {
  applyStreamEvent,
  dropTrailingSummaryEcho,
  firstVisibleActivityStartedAt,
  sealOpenThinking,
} from '../../../../../shared/timeline.ts';
import type { PersistedActivityTurn } from '../../../../../shared/protocol.ts';
import type {
  AssistantStatus,
  ChatMessage,
  ChatStreamEvent,
} from '../../../../types/workspace.ts';

export function patchAssistant(
  messages: ChatMessage[],
  assistantMessageId: string,
  patch: Partial<ChatMessage>,
): ChatMessage[] {
  return messages.map((item) =>
    item.id === assistantMessageId ? { ...item, ...patch } : item,
  );
}

export function foldActivityEvent(
  messages: ChatMessage[],
  assistantMessageId: string,
  event: ChatStreamEvent,
): ChatMessage[] {
  return messages.map((item) => {
    if (item.id !== assistantMessageId) return item;
    const visibleEvent = (event.type === 'text_segment' && Boolean(event.data?.text))
      || (event.type === 'thinking_segment' && Boolean(event.data?.text))
      || (event.type === 'tool_use' && Boolean(event.data?.id));
    const previousStartedAt = item.startedAt
      || firstVisibleActivityStartedAt(item.activities ?? []);
    const folded = applyStreamEvent({
      id: item.id,
      user: '',
      assistant: item.content,
      status: 'completed',
      createdAt: 0,
      activities: item.activities ?? [],
    } satisfies PersistedActivityTurn, event);
    const startedAt = previousStartedAt
      || firstVisibleActivityStartedAt(folded.activities)
      || (visibleEvent ? Date.now() : undefined);
    return {
      ...item,
      activities: folded.activities,
      // The visible clock starts with the first thinking, tool, or text event,
      // not when the request was submitted.
      ...(startedAt ? { startedAt } : {}),
    };
  });
}

export function finalizeAssistant(
  messages: ChatMessage[],
  assistantMessageId: string,
  finalContent: string,
  finalStatus: AssistantStatus,
): ChatMessage[] {
  return messages.map((item) =>
    item.id === assistantMessageId
      ? {
          ...item,
          content: finalContent,
          activities: sealOpenThinking(dropTrailingSummaryEcho(
            item.activities ?? [],
            finalContent,
          )).map((activity) =>
            activity.kind === 'tool' && activity.status === 'running'
              ? {
                  ...activity,
                  status: finalStatus === 'stopped'
                    ? 'stopped' as const
                    : finalStatus === 'error'
                      ? 'failed' as const
                      : 'completed' as const,
                  endedAt: Date.now(),
                }
              : activity,
          ),
          status: finalStatus,
          endedAt: Date.now(),
        }
      : item,
  );
}

export function settleRunningAssistant(
  messages: ChatMessage[],
  assistantMessageId: string,
  fallbackContent: string,
): ChatMessage[] {
  return messages.map((item) =>
    item.id === assistantMessageId && item.status === 'running'
      ? {
          ...item,
          status: 'done' as const,
          content: item.content || fallbackContent,
          endedAt: Date.now(),
        }
      : item,
  );
}
