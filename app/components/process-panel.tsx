'use client';

import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import type { TimelineCopy } from '../i18n';
import type { NormalizedStep, ProcessEvent } from '../types/workspace';
import {
  TYPEWRITER_CHARS_PER_TICK,
  TYPEWRITER_INTERVAL_MS,
  getProcessEventKey,
} from '../lib/process-timeline';
import { Spinner } from './markdown-message';

export const ProcessPanel = memo(function ProcessPanel({
  events,
  running,
  open,
  showThinking,
  onToggle,
  onToggleThinking,
  copy,
  labels,
}: {
  events: ProcessEvent[];
  running: boolean;
  open: boolean;
  showThinking: boolean;
  onToggle: () => void;
  onToggleThinking: () => void;
  copy: TimelineCopy;
  labels: {
    hide: string;
    view: string;
    steps: string;
    keepThinking: string;
  };
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const hasProcessEvents = events.length > 0;
  const visibleEvents = useMemo(
    () => showThinking
      ? events
      : events.filter((event) => event.kind !== 'thinking'),
    [events, showThinking],
  );
  const isOpen = hasProcessEvents ? open : true;

  useEffect(() => {
    if (!running || !scrollRef.current) {
      return;
    }
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [visibleEvents, running, isOpen]);

  if (!hasProcessEvents && !running) {
    return null;
  }

  return (
    <div className="min-w-0 rounded-xl border border-border bg-muted px-3 py-2 text-[12px] leading-5 text-muted-foreground">
      {hasProcessEvents && (
        <div
          role="button"
          tabIndex={0}
          aria-label={open ? `${labels.hide}${labels.steps}` : `${labels.view}${labels.steps}`}
          onClick={onToggle}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') {
              return;
            }
            event.preventDefault();
            onToggle();
          }}
          className="flex min-w-0 w-full cursor-pointer flex-wrap items-center justify-between gap-2 rounded-lg px-1 py-1 text-left transition-colors hover:bg-accent/60 focus:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
        >
          <span className="flex size-6 items-center justify-center rounded-full text-primary transition-colors hover:text-accent-foreground">
            <span
              aria-hidden="true"
              className={`block size-0 border-y-[5px] border-y-transparent border-l-[8px] border-l-current transition-transform ${
                open ? 'rotate-90' : ''
              }`}
            />
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={showThinking}
            onClick={(event) => {
              event.stopPropagation();
              onToggleThinking();
            }}
            onKeyDown={(event) => event.stopPropagation()}
            className={`flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors ${
              showThinking
                ? 'bg-accent text-accent-foreground hover:bg-accent/80'
                : 'bg-secondary text-muted-foreground hover:bg-border hover:text-foreground'
            }`}
          >
            <span
              className={`size-1.5 rounded-full ${
                showThinking ? 'bg-primary' : 'bg-muted-foreground'
              }`}
              aria-hidden="true"
            />
            {labels.keepThinking}
          </button>
        </div>
      )}
      {isOpen && (
        <div
          ref={scrollRef}
          className={`${hasProcessEvents ? 'mt-2' : ''} min-w-0 space-y-2`}
        >
          {visibleEvents.length === 0 ? (
            running ? (
              <ProcessWaitingItem copy={copy} />
            ) : null
          ) : (
            <>
              {visibleEvents.map((event, index) => (
                <ProcessEventItem
                  key={getProcessEventKey(event, index)}
                  event={event}
                  copy={copy}
                />
              ))}
              {running && visibleEvents[visibleEvents.length - 1]?.kind !== 'thinking' && (
                <ProcessWaitingItem copy={copy} />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
});

function ProcessWaitingItem({ copy }: { copy: TimelineCopy }) {
  return (
    <div className="flex min-w-0 items-center gap-2 pt-1 text-primary">
      <Spinner />
      <span className="min-w-0 flex-1 break-words text-[11px] [overflow-wrap:anywhere]">{copy.processing}</span>
    </div>
  );
}

function ProcessEventItem({
  event,
  copy,
}: {
  event: ProcessEvent;
  copy: TimelineCopy;
}) {
  if (event.kind === 'thinking') {
    return <ProcessThinkingItem content={event.content} />;
  }
  return <NormalizedStepCard step={event.step} copy={copy} />;
}

function ProcessThinkingItem({ content }: { content: string }) {
  return <SmoothThinkingText content={content} />;
}

function SmoothThinkingText({ content }: { content: string }) {
  const [segments, setSegments] = useState({ stable: '', incoming: '' });

  useEffect(() => {
    const prefersReducedMotion = typeof window !== 'undefined'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion) {
      setSegments({ stable: content, incoming: '' });
      return;
    }

    setSegments((current) => {
      const rendered = `${current.stable}${current.incoming}`;
      if (content === rendered) {
        return current;
      }
      if (content.startsWith(rendered)) {
        return {
          stable: current.stable,
          incoming: `${current.incoming}${content.slice(rendered.length)}`,
        };
      }
      if (content.startsWith(current.stable)) {
        return {
          stable: current.stable,
          incoming: content.slice(current.stable.length),
        };
      }
      return {
        stable: '',
        incoming: content,
      };
    });
  }, [content]);

  const settleIncoming = () => {
    setSegments((current) => {
      if (!current.incoming) {
        return current;
      }
      return {
        stable: `${current.stable}${current.incoming}`,
        incoming: '',
      };
    });
  };

  return (
    <div className="process-thinking-text">
      {segments.stable}
      {segments.incoming && (
        <span className="process-thinking-delta" onAnimationEnd={settleIncoming}>
          {segments.incoming}
        </span>
      )}
    </div>
  );
}

const NormalizedStepCard = memo(function NormalizedStepCard({ step, copy }: { step: NormalizedStep; copy: TimelineCopy }) {
  const isWaiting = step.status === 'waiting';
  const isRunning = step.status === 'running';
  const isError = step.status === 'error';

  return (
    <div
      className={`rounded-lg border px-3 py-2 ${
        isError
          ? 'border-destructive/30 bg-destructive/10 text-destructive'
          : isWaiting
            ? 'border-border bg-card text-muted-foreground'
            : 'border-border bg-card text-foreground'
      }`}
    >
      <div className="flex min-w-0 items-start gap-2">
        <span className="mt-1 flex size-4 shrink-0 items-center justify-center">
          {isRunning ? (
            <Spinner />
          ) : (
            <span
              className={`text-xs font-semibold ${
                isError
                  ? 'text-destructive'
                  : step.status === 'done'
                    ? 'text-[var(--ok)]'
                    : 'text-muted-foreground/60'
              }`}
            >
              {isError ? '!' : step.status === 'done' ? '✓' : '·'}
            </span>
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{step.title}</div>
          <div className="mt-0.5 min-w-0 break-words text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
            {step.summary}
          </div>
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
            isError
              ? 'bg-destructive/15 text-destructive'
              : isRunning
                ? 'bg-accent text-accent-foreground'
                : step.status === 'done'
                  ? 'bg-[color-mix(in_srgb,var(--ok)_15%,transparent)] text-[var(--ok)]'
                  : 'bg-secondary text-muted-foreground'
          }`}
        >
          {copy.statusLabels[step.status]}
        </span>
      </div>
    </div>
  );
});
