/**
 * Serialize a vibe-coding conversation into JSONL (one event per line).
 * Runtime-agnostic so tests can cover the format without the browser.
 *
 * Flatten the UI's {messages, activities} dump into a readable transcript:
 *   session → user → assistant (narration) → tool → log → result → …
 */

const EXPORT_TEXT_LIMIT = 2_000;

export type ConversationExportActivity = {
  kind: 'text' | 'tool' | 'log' | string;
  content?: string;
  toolUseId?: string;
  name?: string;
  status?: string;
  inputSummary?: string;
  outputSummary?: string;
  command?: string;
  phaseHint?: string;
  phase?: string;
  stream?: string;
  message?: string;
  startedAt?: number;
  endedAt?: number;
};

export type ConversationExportTurnResult = {
  ok?: boolean;
  stopped?: boolean;
  buildStatus?: string;
  hasPreview?: boolean;
};

export type ConversationExportMessage = {
  id?: string;
  role: 'user' | 'assistant';
  content: string;
  status?: string;
  startedAt?: number;
  endedAt?: number;
  turnResult?: ConversationExportTurnResult;
  activities?: ConversationExportActivity[];
};

export type ConversationExportPreview = {
  has_url?: boolean;
  error?: string;
  restarted?: boolean;
};

export type ConversationExportDownload = {
  has_url?: boolean;
  error?: string;
};

export type ConversationExportBuild = {
  status?: string;
  auto_fix_attempts?: number;
  auto_fix_applied?: boolean;
  stdout?: string;
  stderr?: string;
};

export type ConversationExportFiles = {
  root?: string;
  count?: number;
  paths?: string[];
};

export type ConversationExportPublish = {
  has_url?: boolean;
  project_id?: string;
  deployment_id?: string;
};

export type ConversationExportInput = {
  conversationId?: string | null;
  exportedAt?: string;
  model?: string;
  language?: string;
  preview?: ConversationExportPreview;
  download?: ConversationExportDownload;
  build?: ConversationExportBuild;
  files?: ConversationExportFiles;
  publish?: ConversationExportPublish;
  messages: ConversationExportMessage[];
};

export function redactExportText(value: string): string {
  return value
    .replace(/\x1b\[[0-9;?]*[~A-Za-z]/g, '')
    .replace(/(-t|--token)\s+(['"]?)[^\s'"]+\2/gi, '$1 $2[REDACTED]$2')
    .replace(/(eo_token=)[^&\s"']+/gi, '$1[REDACTED]')
    .replace(/(authorization\s*:\s*)(?:bearer\s+)?[^"'\s]+(?:\s+[^"'\s]+)?/gi, '$1[REDACTED]')
    .replace(
      /((?:authorization|cookie|password|passwd|secret|token|api[_-]?key|private[_-]?key)\s*[:=]\s*)([^\s,;"']+)/gi,
      '$1[REDACTED]',
    )
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9]{16,}/g, '[REDACTED]')
    .replace(/\bTOKEN=[^\s;]+/g, 'TOKEN=[REDACTED]');
}

export function conversationToJsonl(input: ConversationExportInput): string {
  const exportedAt = input.exportedAt || new Date().toISOString();
  const conversationId = input.conversationId?.trim() || null;
  const events: Record<string, unknown>[] = [];

  for (const message of input.messages) {
    if (message.role === 'user') {
      events.push(compact({
        type: 'user',
        id: message.id,
        status: exportStatus(message.status),
        content: redactExportText(message.content),
        ...timingFields(message.startedAt, message.endedAt ?? message.startedAt),
      }));
      continue;
    }

    const activities = message.activities ?? [];
    let lastAssistantText = '';

    for (const activity of activities) {
      if (activity.kind === 'text' && activity.content?.trim()) {
        lastAssistantText = activity.content;
        events.push(compact({
          type: 'assistant',
          id: message.id,
          content: redactExportText(activity.content),
          ...timingFields(
            activity.startedAt ?? message.startedAt,
            activity.endedAt ?? message.endedAt ?? activity.startedAt ?? message.startedAt,
          ),
        }));
        continue;
      }

      if (activity.kind === 'tool') {
        events.push(compact({
          type: 'tool',
          id: activity.toolUseId,
          name: shortenToolName(activity.name || 'tool'),
          status: activity.status,
          input: maybeJson(activity.inputSummary),
          output: maybeJson(activity.outputSummary),
          command: activity.command ? redactExportText(activity.command) : undefined,
          phase: activity.phaseHint,
          ...timingFields(activity.startedAt, activity.endedAt),
        }));
        continue;
      }

      if (activity.kind === 'log' && activity.message?.trim()) {
        const startedAt = activity.startedAt ?? activity.endedAt;
        events.push(compact({
          type: 'log',
          phase: activity.phase,
          stream: activity.stream,
          message: truncateExportText(redactExportText(activity.message)),
          ...timingFields(startedAt, activity.endedAt ?? startedAt),
        }));
      }
    }

    const finalContent = message.content?.trim();
    const alreadyEmitted = finalContent && lastAssistantText
      && normalizeText(finalContent) === normalizeText(lastAssistantText);
    if (finalContent && !alreadyEmitted) {
      events.push(compact({
        type: 'assistant',
        id: message.id,
        content: redactExportText(finalContent),
        status: exportStatus(message.status),
        ...timingFields(message.startedAt, message.endedAt ?? message.startedAt),
      }));
    }

    if (message.turnResult) {
      events.push(compact({
        type: 'result',
        ok: message.turnResult.ok,
        stopped: message.turnResult.stopped,
        build_status: message.turnResult.buildStatus,
        has_preview: message.turnResult.hasPreview,
        ...timingFields(message.startedAt, message.endedAt ?? message.startedAt),
      }));
    }
  }

  const lines = [
    JSON.stringify(compact({
      type: 'session',
      conversation_id: conversationId,
      exported_at: exportedAt,
      event_count: events.length,
      model: input.model?.trim() || undefined,
      language: input.language?.trim() || undefined,
      preview: input.preview,
      download: input.download,
      build: input.build
        ? compact({
            status: input.build.status,
            auto_fix_attempts: input.build.auto_fix_attempts,
            auto_fix_applied: input.build.auto_fix_applied,
            stdout: input.build.stdout
              ? truncateExportText(redactExportText(input.build.stdout))
              : undefined,
            stderr: input.build.stderr
              ? truncateExportText(redactExportText(input.build.stderr))
              : undefined,
          })
        : undefined,
      files: input.files,
      publish: input.publish,
    })),
    ...events.map((event) => JSON.stringify(event)),
  ];

  return `${lines.join('\n')}\n`;
}

export function conversationExportFilename(conversationId?: string | null, now = new Date()) {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const shortId = conversationId?.trim().slice(0, 8) || 'session';
  return `vibe-coding-conversation-${shortId}-${stamp}.jsonl`;
}

function exportStatus(status?: string) {
  if (!status || status === 'done') return undefined;
  return status;
}

function timingFields(startedAt?: number, endedAt?: number) {
  const started_at = isoFromMs(startedAt);
  const ended_at = isoFromMs(endedAt);
  if (!started_at && !ended_at) {
    return {};
  }
  const duration_ms = Number.isFinite(startedAt) && Number.isFinite(endedAt)
    ? Math.max(0, (endedAt as number) - (startedAt as number))
    : undefined;
  return { started_at, ended_at, duration_ms };
}

function truncateExportText(value: string, limit = EXPORT_TEXT_LIMIT) {
  return value.length > limit ? `${value.slice(0, limit)}\n... truncated` : value;
}

function shortenToolName(name: string) {
  const parts = name.split('__');
  return parts[parts.length - 1] || name;
}

function maybeJson(value?: string): unknown {
  if (!value?.trim()) return undefined;
  const redacted = redactExportText(value);
  const trimmed = redacted.trim();
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}'))
    || (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return redacted;
    }
  }
  return redacted;
}

function isoFromMs(ms?: number) {
  if (ms === undefined || !Number.isFinite(ms)) return undefined;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function normalizeText(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

function compact(record: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined && value !== null && value !== ''),
  );
}
