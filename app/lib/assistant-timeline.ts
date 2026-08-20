import type { AssistantActivity } from '../../shared/protocol';

export type AssistantTimelineTextBlock = {
  kind: 'text';
  index: number;
  content: string;
};

export type AssistantTimelineToolItem = {
  index: number;
  activity: Extract<AssistantActivity, { kind: 'tool' }>;
};

export type AssistantTimelineToolBlock = {
  kind: 'tools';
  items: AssistantTimelineToolItem[];
};

export type AssistantTimelineBlock = AssistantTimelineTextBlock | AssistantTimelineToolBlock;

export function normalizeTimelineText(value: string) {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Collapse consecutive tool calls into one chain-log block so the stream is
 * text → tools → text → tools, matching the persisted activity order.
 */
export function buildAssistantTimeline(activities: AssistantActivity[]): AssistantTimelineBlock[] {
  const blocks: AssistantTimelineBlock[] = [];
  for (let index = 0; index < activities.length; index += 1) {
    const activity = activities[index];
    if (activity.kind === 'text') {
      if (!activity.content.trim()) continue;
      blocks.push({ kind: 'text', index, content: activity.content });
      continue;
    }
    const last = blocks.at(-1);
    if (last?.kind === 'tools') {
      last.items.push({ index, activity });
    } else {
      blocks.push({ kind: 'tools', items: [{ index, activity }] });
    }
  }
  return blocks;
}

export function lastTimelineText(blocks: AssistantTimelineBlock[]) {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block.kind === 'text') return block;
  }
  return undefined;
}

/**
 * Text that still needs to render after the activity timeline. If the finalized
 * reply only extends the last streamed narration, keep the narration in place
 * and return just the leftover so it stays after later tool calls.
 */
export function trailingTimelineContent(
  lastText: string | undefined,
  finalContent: string,
  status?: 'running' | 'done' | 'error' | 'stopped',
) {
  const trailing = finalContent.trim();
  if (!trailing || status === 'running') return '';
  if (status === 'error' || !lastText?.trim()) return trailing;

  const left = normalizeTimelineText(lastText);
  const right = normalizeTimelineText(trailing);
  if (left === right) return '';
  if (right.startsWith(left)) return right.slice(left.length).trimStart();
  return trailing;
}
