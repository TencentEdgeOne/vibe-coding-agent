'use client';

import { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { sanitizeAssistantText } from '../../agents/utils/_text';
import {
  NARRATION_TYPEWRITER_CHARS_PER_TICK,
  NARRATION_TYPEWRITER_INTERVAL_MS,
  TYPEWRITER_CHARS_PER_TICK,
  TYPEWRITER_INTERVAL_MS,
} from '../lib/process-timeline';

export function Spinner() {
  return (
    <span
      className="inline-block size-3 animate-spin rounded-full border-2 border-primary/30 border-t-primary"
      aria-hidden="true"
    />
  );
}

export function NarrationText({ content }: { content: string }) {
  return (
    <div className="min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">
      {content}
    </div>
  );
}

export function TypewriterNarrationText({
  content,
  onDisplayChange,
}: {
  content: string;
  onDisplayChange?: (content: string) => void;
}) {
  const [displayContent, setDisplayContent] = useState('');
  const targetRef = useRef(content);

  useEffect(() => {
    onDisplayChange?.(displayContent);
  }, [displayContent, onDisplayChange]);

  useEffect(() => {
    targetRef.current = content;

    const prefersReducedMotion = typeof window !== 'undefined'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion) {
      setDisplayContent(content);
      return;
    }

    setDisplayContent((current) =>
      content.startsWith(current) ? current : '',
    );
  }, [content]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (prefersReducedMotion) {
        setDisplayContent(targetRef.current);
        return;
      }

      setDisplayContent((current) => {
        const target = targetRef.current;
        if (current === target) return current;
        return target.slice(0, current.length + NARRATION_TYPEWRITER_CHARS_PER_TICK);
      });
    }, NARRATION_TYPEWRITER_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, []);

  return (
    <>
      <NarrationText content={displayContent} />
      {displayContent.length < content.length && (
        <span
          className="ml-0.5 inline-block h-4 w-1 animate-pulse rounded-full bg-primary align-[-0.15em]"
          aria-hidden="true"
        />
      )}
    </>
  );
}

export function TypewriterMarkdownMessage({ content }: { content: string }) {
  const targetContent = sanitizeAssistantText(content);
  const [displayContent, setDisplayContent] = useState('');
  const targetRef = useRef(targetContent);

  useEffect(() => {
    targetRef.current = targetContent;

    const prefersReducedMotion = typeof window !== 'undefined'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion) {
      setDisplayContent(targetContent);
      return;
    }

    setDisplayContent((current) =>
      targetContent.startsWith(current) ? current : '',
    );
  }, [targetContent]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (prefersReducedMotion) {
        setDisplayContent(targetRef.current);
        return;
      }

      setDisplayContent((current) => {
        const target = targetRef.current;
        if (current === target) return current;
        return target.slice(0, current.length + TYPEWRITER_CHARS_PER_TICK);
      });
    }, TYPEWRITER_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, []);

  return (
    <div className="min-w-0">
      <MarkdownMessage content={displayContent} />
      {displayContent.length < targetContent.length && (
        <span
          className="ml-0.5 inline-block h-4 w-1 animate-pulse rounded-full bg-primary align-[-0.15em]"
          aria-hidden="true"
        />
      )}
    </div>
  );
}

export function MarkdownMessage({ content }: { content: string }) {
  const displayContent = sanitizeAssistantText(content);

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
        ul: ({ children }) => <ul className="mb-2 list-disc space-y-1 pl-5 last:mb-0">{children}</ul>,
        ol: ({ children }) => <ol className="mb-2 list-decimal space-y-1 pl-5 last:mb-0">{children}</ol>,
        li: ({ children }) => <li className="pl-1">{children}</li>,
        a: ({ children, href }) => (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            className="btn-brand my-1 inline-flex max-w-full items-center gap-1.5 break-all rounded-full px-3 py-1.5 text-xs font-semibold no-underline"
          >
            {children}
          </a>
        ),
        pre: ({ children }) => (
          <pre className="mb-2 max-w-full overflow-x-auto rounded-lg border border-border bg-muted p-3 text-[12px] leading-5 last:mb-0">
            {children}
          </pre>
        ),
        code: ({ children, className, ...props }) => (
          <code
            className={`rounded bg-muted px-1 py-0.5 font-mono text-[0.92em] text-foreground ${className || ''}`}
            {...props}
          >
            {children}
          </code>
        ),
      }}
    >
      {displayContent}
    </ReactMarkdown>
  );
}
