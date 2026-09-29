'use client';

import { ReactNode, useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { withoutPlatformName } from '../../../../../shared/platform-name';
import type { ConversationCopy } from './types';

function plainText(node: ReactNode): string {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(plainText).join('');
  return '';
}

function ConversationLink({ href, copy, children }: {
  href?: string;
  copy: ConversationCopy;
  children?: ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  const url = href || '';
  // An address spelled out in full is something the user takes elsewhere. A link
  // behind words is meant to be followed, and a button beside it would only
  // crowd the sentence it sits in.
  const isAddress = Boolean(url) && plainText(children).trim() === url;

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const anchor = (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      dir={isAddress ? 'ltr' : undefined}
    >
      {children}
    </a>
  );

  if (!isAddress) {
    return anchor;
  }

  const label = copied ? copy.linkCopied : copy.copyLink;
  const handleCopy = async () => {
    if (!navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <span className="conversation-link">
      {anchor}
      <button
        type="button"
        onClick={() => void handleCopy()}
        className="conversation-link-copy"
        aria-label={label}
        title={label}
      >
        {copied ? <Check /> : <Copy />}
      </button>
    </span>
  );
}

export function Markdown({ content, copy }: { content: string; copy: ConversationCopy }) {
  return (
    <div className="agent-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <ConversationLink href={href} copy={copy}>{children}</ConversationLink>
          ),
        }}
      >
        {withoutPlatformName(content)}
      </ReactMarkdown>
    </div>
  );
}
