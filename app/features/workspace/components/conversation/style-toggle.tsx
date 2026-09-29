'use client';

import type { ActivityStyle } from '../../hooks/use-activity-style';
import type { ConversationCopy } from './types';

const OPTIONS: readonly ActivityStyle[] = ['refined', 'classic'];

export function StyleToggle({ style, copy, onStyleChange }: {
  style: ActivityStyle;
  copy: ConversationCopy;
  onStyleChange: (style: ActivityStyle) => void;
}) {
  return (
    <div className="conversation-style-toggle" role="group" aria-label={copy.styleLabel}>
      {OPTIONS.map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onStyleChange(option)}
          aria-pressed={style === option}
        >
          {option === 'refined' ? copy.styleRefined : copy.styleClassic}
        </button>
      ))}
    </div>
  );
}
