import type { AssistantActivity } from '../../../../../shared/protocol';
import type { ConversationCopy } from './types';

export function infoLabel(
  infoType: Extract<AssistantActivity, { kind: 'info' }>['infoType'],
  copy: ConversationCopy,
) {
  if (infoType === 'usage') return copy.usage;
  if (infoType === 'compact') return copy.compact;
  if (infoType === 'status') return copy.status;
  return copy.info;
}

export function statusLabel(status: Extract<AssistantActivity, { kind: 'tool' }>['status'], copy: ConversationCopy) {
  if (status === 'running') return copy.running;
  if (status === 'failed') return copy.failed;
  if (status === 'stopped') return copy.stopped;
  return copy.completed;
}

function formatTimestamp(value?: number) {
  if (!value) return '';
  try {
    return new Date(value).toISOString();
  } catch {
    return String(value);
  }
}

function maybeJson(value?: string) {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }
  return value;
}

export function formatToolDump(activity: Extract<AssistantActivity, { kind: 'tool' }>, copy: ConversationCopy) {
  return JSON.stringify({
    name: activity.name,
    id: activity.toolUseId,
    status: activity.status,
    statusLabel: statusLabel(activity.status, copy),
    command: activity.command || undefined,
    phaseHint: activity.phaseHint || undefined,
    fileCount: activity.fileCount,
    startedAt: formatTimestamp(activity.startedAt) || undefined,
    endedAt: formatTimestamp(activity.endedAt) || undefined,
    durationMs: activity.startedAt && activity.endedAt
      ? activity.endedAt - activity.startedAt
      : undefined,
    input: maybeJson(activity.inputSummary),
    output: maybeJson(activity.outputSummary),
  }, null, 2);
}

export function ThinkingBlock({ content, copy }: { content: string; copy: ConversationCopy }) {
  return (
    <details open className="conversation-skeleton conversation-thinking">
      <summary>{copy.thinking}</summary>
      <pre>{content}</pre>
    </details>
  );
}

export function InfoBlock({
  activity,
  copy,
}: {
  activity: Extract<AssistantActivity, { kind: 'info' }>;
  copy: ConversationCopy;
}) {
  const label = infoLabel(activity.infoType, copy);
  const title = activity.title && activity.title !== label ? `${label} · ${activity.title}` : label;
  return (
    <details open className="conversation-skeleton conversation-info">
      <summary>{title}</summary>
      {activity.content ? <pre>{activity.content}</pre> : null}
    </details>
  );
}

export function ToolBlock({
  activity,
  copy,
}: {
  activity: Extract<AssistantActivity, { kind: 'tool' }>;
  copy: ConversationCopy;
}) {
  return (
    <details open className="conversation-skeleton conversation-tool">
      <summary>{activity.name} · {statusLabel(activity.status, copy)}</summary>
      <pre>{formatToolDump(activity, copy)}</pre>
    </details>
  );
}
