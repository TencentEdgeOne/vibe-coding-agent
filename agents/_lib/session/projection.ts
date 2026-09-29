import type { AssistantActivity, PersistedActivityTurn } from '../../../shared/protocol.ts';
import {
  appendNarrationChunk,
  appendThinkingChunk,
  sanitizeAssistantText,
  sanitizeThinkingContent,
  sealOpenThinking,
  summarizeToolInput,
  summarizeToolOutput,
} from '../../../shared/timeline.ts';

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === 'object' ? value as JsonRecord : {};
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return sanitizeAssistantText(content);
  if (!Array.isArray(content)) return '';
  return sanitizeAssistantText(
    content
      .map((block) => {
        const record = asRecord(block);
        return typeof record.text === 'string' ? record.text : '';
      })
      .join(''),
  );
}

function commandFromInput(input: unknown) {
  const record = asRecord(input);
  const command = typeof record.command === 'string'
    ? record.command
    : typeof record.cmd === 'string'
      ? record.cmd
      : '';
  return command.trim();
}

function toolBlocks(content: unknown): JsonRecord[] {
  if (!Array.isArray(content)) return [];
  return content.filter((block) => {
    const record = asRecord(block);
    return record.type === 'tool_use' || record.type === 'mcp_tool_use' || record.type === 'tool_result';
  }).map(asRecord);
}

/**
 * Project a Claude Code JSONL transcript into the turns the workspace UI renders.
 * The file is the source of truth; this is a derived view.
 */
export function projectTranscript(jsonl: string, projectDir = ''): PersistedActivityTurn[] {
  const turns: PersistedActivityTurn[] = [];
  const active: { turn: PersistedActivityTurn | null } = { turn: null };

  const openTurn = (user: string, createdAt: number) => {
    const turn: PersistedActivityTurn = {
      id: `turn-${createdAt}-${turns.length}`,
      user,
      assistant: '',
      status: 'completed',
      createdAt,
      activities: [],
    };
    active.turn = turn;
    turns.push(turn);
    return turn;
  };

  for (const rawLine of jsonl.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let entry: JsonRecord;
    try {
      entry = JSON.parse(line) as JsonRecord;
    } catch {
      continue;
    }
    const createdAt = Date.parse(String(entry.timestamp || '')) || Date.now();
    const message = asRecord(entry.message);
    const content = message.content;

    if (entry.type === 'user') {
      const tools = toolBlocks(content);
      const text = textFromContent(content);
      if (tools.some((block) => block.type === 'tool_result')) {
        const turn = active.turn;
        if (!turn) continue;
        for (const block of tools) {
          if (block.type !== 'tool_result') continue;
          const id = typeof block.tool_use_id === 'string' ? block.tool_use_id : '';
          const existing = turn.activities.find(
            (activity): activity is Extract<AssistantActivity, { kind: 'tool' }> =>
              activity.kind === 'tool' && activity.toolUseId === id,
          );
          const output = typeof block.content === 'string'
            ? block.content
            : textFromContent(block.content);
          if (existing) {
            existing.status = block.is_error === true ? 'failed' : 'completed';
            existing.outputSummary = summarizeToolOutput(output, projectDir, existing.name);
            existing.endedAt = createdAt;
          }
        }
        continue;
      }
      if (text) openTurn(text, createdAt);
      continue;
    }

    if (entry.type === 'system' && entry.subtype === 'compact_boundary' && active.turn) {
      const compact = asRecord(entry.compact_metadata);
      active.turn.activities.push({
        kind: 'info',
        infoType: 'compact',
        title: 'Compact',
        content: [
          compact.trigger ? `trigger=${compact.trigger}` : '',
          compact.pre_tokens != null ? `pre_tokens=${compact.pre_tokens}` : '',
          compact.post_tokens != null ? `post_tokens=${compact.post_tokens}` : '',
        ].filter(Boolean).join('\n'),
      });
      continue;
    }

    if (entry.type === 'assistant' && active.turn) {
      const turn = active.turn;
      const text = textFromContent(content);
      const hasVisibleOutput = Boolean(text)
        || (Array.isArray(content) && content.some((block) => {
          const record = asRecord(block);
          return record.type === 'thinking'
            || record.type === 'redacted_thinking'
            || record.type === 'text'
            || record.type === 'tool_use'
            || record.type === 'mcp_tool_use';
        }));
      if (hasVisibleOutput && !turn.startedAt) {
        turn.startedAt = createdAt;
      }
      if (text) turn.assistant = text;
      if (Array.isArray(content)) {
        for (const block of content) {
          const record = asRecord(block);
          if (record.type === 'thinking') {
            const thinking = typeof record.thinking === 'string'
              ? record.thinking
              : typeof record.text === 'string' ? record.text : '';
            if (thinking) {
              if (!turn.startedAt) turn.startedAt = createdAt;
              turn.activities = appendThinkingChunk(
                turn.activities,
                sanitizeThinkingContent(thinking),
                createdAt,
              );
            }
            continue;
          }
          if (record.type === 'redacted_thinking') {
            if (!turn.startedAt) turn.startedAt = createdAt;
            turn.activities = appendThinkingChunk(turn.activities, '(redacted)', createdAt);
            continue;
          }
          if (record.type === 'text' && typeof record.text === 'string') {
            const narration = sanitizeAssistantText(record.text);
            if (narration) {
              turn.activities = appendNarrationChunk(
                sealOpenThinking(turn.activities, createdAt),
                narration,
              );
            }
            continue;
          }
          if (record.type !== 'tool_use' && record.type !== 'mcp_tool_use') continue;
          const id = typeof record.id === 'string' ? record.id : '';
          const name = typeof record.name === 'string' ? record.name : 'tool';
          const command = commandFromInput(record.input);
          turn.activities = sealOpenThinking(turn.activities, createdAt);
          turn.activities.push({
            kind: 'tool',
            toolUseId: id,
            name,
            status: 'completed',
            ...(command ? { command } : {}),
            inputSummary: summarizeToolInput(name, record.input, projectDir),
            startedAt: createdAt,
          });
        }
      } else if (text) {
        turn.activities = appendNarrationChunk(sealOpenThinking(turn.activities, createdAt), text);
      }
    }
  }

  return turns;
}

export function turnsToMessages(turns: PersistedActivityTurn[]) {
  return turns.flatMap((turn) => [
    { role: 'user' as const, content: turn.user },
    { role: 'assistant' as const, content: turn.assistant },
  ]);
}
