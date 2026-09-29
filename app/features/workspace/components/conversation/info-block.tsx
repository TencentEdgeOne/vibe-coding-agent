'use client';

import type { AssistantActivity } from '../../../../../shared/protocol';
import { infoLabel } from './activity-blocks';
import { ActivityRow, FollowLog } from './activity-row';
import type { ConversationCopy } from './types';

export function InfoBlock({ activity, copy }: {
  activity: Extract<AssistantActivity, { kind: 'info' }>;
  copy: ConversationCopy;
}) {
  const label = infoLabel(activity.infoType, copy);
  // The projector falls back to the info type for a title, which would then
  // read as the label twice over.
  const detail = activity.title && activity.title !== label ? activity.title : '';

  return (
    <ActivityRow
      status="completed"
      label={label}
      target={detail || undefined}
      tone="quiet"
      statusLabel={copy.completed}
    >
      {activity.content ? <FollowLog text={activity.content} className="activity-row-text" /> : undefined}
    </ActivityRow>
  );
}
