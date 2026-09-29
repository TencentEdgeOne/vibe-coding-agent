'use client';

import { summarizeToolGroup, type AssistantTimelineGroupBlock } from '@/app/lib/assistant-timeline';
import { statusLabel } from './activity-blocks';
import { ActivityRow } from './activity-row';
import { ToolBlock } from './tool-block';
import type { ConversationCopy } from './types';

export function ActivityGroup({ block, copy }: {
  block: AssistantTimelineGroupBlock;
  copy: ConversationCopy;
}) {
  const summary = summarizeToolGroup(block.blocks);

  return (
    <ActivityRow
      status={summary.status}
      label={copy.toolActions[summary.action] ?? summary.action}
      target={summary.target}
      meta={copy.steps.replace('{count}', String(summary.count))}
      startedAt={block.blocks[0]?.activity.startedAt}
      endedAt={summary.status === 'running'
        ? undefined
        : block.blocks.reduce((latest, child) => Math.max(latest, child.activity.endedAt || 0), 0) || undefined}
      tone="file"
      statusLabel={statusLabel(summary.status, copy)}
    >
      <div className="activity-group-children">
        {block.blocks.map((child) => (
          <ToolBlock
            key={child.activity.toolUseId || `tool-${child.index}`}
            activity={child.activity}
            copy={copy}
          />
        ))}
      </div>
    </ActivityRow>
  );
}
