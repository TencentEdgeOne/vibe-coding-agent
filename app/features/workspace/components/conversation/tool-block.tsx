'use client';

import { presentToolActivity } from '@/app/lib/tool-activity';
import type { AssistantActivity } from '../../../../../shared/protocol';
import { statusLabel } from './activity-blocks';
import { ActivityDetail, ActivityRow } from './activity-row';
import type { ConversationCopy } from './types';

type ToolActivity = Extract<AssistantActivity, { kind: 'tool' }>;

/**
 * The words a user recognises for what the agent just did. `presentToolActivity`
 * already knows the action; this only picks the translation and, for a reference
 * the agent went to read, says which subject it was after — the tool is handed
 * a skill name, and a skill name tells the reader nothing.
 */
export function toolRowLabel(activity: { name: string; inputSummary?: string }, copy: ConversationCopy) {
  const presentation = presentToolActivity(activity);
  const action = copy.toolActions[presentation.action] ?? presentation.action;
  if (presentation.action !== 'Load skill') return action;

  const topic = presentation.topic ? copy.referenceTopics[presentation.topic] : '';
  const named = topic ? `${action} · ${topic}` : action;
  return presentation.detailed ? `${named} · ${copy.referenceDetail}` : named;
}

export function ToolBlock({ activity, copy }: {
  activity: ToolActivity;
  copy: ConversationCopy;
}) {
  const presentation = presentToolActivity(activity);
  const failed = activity.status === 'failed';
  const hasDetail = Boolean(activity.inputSummary || activity.outputSummary);

  return (
    <ActivityRow
      status={activity.status}
      label={toolRowLabel(activity, copy)}
      target={presentation.target}
      startedAt={activity.startedAt}
      endedAt={activity.endedAt}
      statusLabel={statusLabel(activity.status, copy)}
    >
      {hasDetail && (
        <>
          {activity.inputSummary && (
            <ActivityDetail label={copy.input} content={activity.inputSummary} />
          )}
          {activity.outputSummary && (
            <ActivityDetail
              label={copy.output}
              content={activity.outputSummary}
              tone={failed ? 'danger' : undefined}
            />
          )}
        </>
      )}
    </ActivityRow>
  );
}
