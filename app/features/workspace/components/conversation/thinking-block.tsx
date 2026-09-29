'use client';

import { ActivityRow, FollowLog } from './activity-row';
import type { ConversationCopy } from './types';

export function ThinkingBlock({ content, live, startedAt, endedAt, copy }: {
  content: string;
  /** True while this is the tail of a turn still in flight, which is the only
   *  time watching the agent think is worth the room it takes. */
  live: boolean;
  startedAt?: number;
  endedAt?: number;
  copy: ConversationCopy;
}) {
  const status = live ? 'running' : 'completed';
  return (
    <ActivityRow
      status={status}
      label={copy.thinking}
      startedAt={startedAt}
      endedAt={endedAt}
      tone="quiet"
      statusLabel={live ? copy.running : copy.completed}
    >
      <FollowLog text={content} className="activity-row-text" />
    </ActivityRow>
  );
}
