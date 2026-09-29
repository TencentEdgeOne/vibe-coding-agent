'use client';

import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import type { ConversationCopy } from './types';

export function UserTurn({ content, copy }: {
  content: string;
  copy: ConversationCopy;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const label = copied ? copy.messageCopied : copy.copyMessage;
  const handleCopy = async () => {
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section className="conversation-turn conversation-user-turn">
      <button
        type="button"
        onClick={() => void handleCopy()}
        className="conversation-user-copy"
        aria-label={label}
        title={label}
      >
        {copied ? <Check /> : <Copy />}
      </button>
      <div className="conversation-body whitespace-pre-wrap">{content}</div>
    </section>
  );
}
