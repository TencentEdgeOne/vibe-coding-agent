'use client';

import {
  groupTimelineBlocks,
  visibleRefinedBlocks,
  type AssistantTimelineBlock,
} from '@/app/lib/assistant-timeline';
import type { ActivityStyle } from '../../hooks/use-activity-style';
import {
  InfoBlock as ClassicInfoBlock,
  ThinkingBlock as ClassicThinkingBlock,
  ToolBlock as ClassicToolBlock,
} from './activity-blocks';
import { ActivityGroup } from './activity-group';
import { InfoBlock } from './info-block';
import { Markdown } from './markdown';
import { ThinkingBlock } from './thinking-block';
import { ToolBlock } from './tool-block';
import type { ConversationCopy } from './types';

function ClassicStream({ blocks, copy }: {
  blocks: AssistantTimelineBlock[];
  copy: ConversationCopy;
}) {
  return (
    <>
      {blocks.map((block) => {
        if (block.kind === 'text') {
          return <Markdown key={`text-${block.index}`} content={block.content} copy={copy} />;
        }
        if (block.kind === 'thinking') {
          return <ClassicThinkingBlock key={`thinking-${block.index}`} content={block.content} copy={copy} />;
        }
        if (block.kind === 'info') {
          return <ClassicInfoBlock key={`info-${block.index}`} activity={block.activity} copy={copy} />;
        }
        return (
          <ClassicToolBlock
            key={block.activity.toolUseId || `tool-${block.index}`}
            activity={block.activity}
            copy={copy}
          />
        );
      })}
    </>
  );
}

function RefinedStream({ blocks, liveIndex, copy }: {
  blocks: AssistantTimelineBlock[];
  liveIndex?: number;
  copy: ConversationCopy;
}) {
  return (
    <>
      {groupTimelineBlocks(visibleRefinedBlocks(blocks)).map((block) => {
        if (block.kind === 'text') {
          return <Markdown key={`text-${block.index}`} content={block.content} copy={copy} />;
        }
        if (block.kind === 'thinking') {
          return (
            <ThinkingBlock
              key={`thinking-${block.index}`}
              content={block.content}
              live={block.index === liveIndex}
              startedAt={block.startedAt}
              endedAt={block.endedAt}
              copy={copy}
            />
          );
        }
        if (block.kind === 'info') {
          return <InfoBlock key={`info-${block.index}`} activity={block.activity} copy={copy} />;
        }
        if (block.kind === 'group') {
          return <ActivityGroup key={`group-${block.index}`} block={block} copy={copy} />;
        }
        return (
          <ToolBlock
            key={block.activity.toolUseId || `tool-${block.index}`}
            activity={block.activity}
            copy={copy}
          />
        );
      })}
    </>
  );
}

export function ActivityStream({ blocks, style, liveIndex, copy }: {
  blocks: AssistantTimelineBlock[];
  style: ActivityStyle;
  /** Index of the block the turn is still writing into, so a thinking row knows
   *  whether it is being watched or merely kept. */
  liveIndex?: number;
  copy: ConversationCopy;
}) {
  if (style === 'classic') return <ClassicStream blocks={blocks} copy={copy} />;
  return <RefinedStream blocks={blocks} liveIndex={liveIndex} copy={copy} />;
}
