'use client';

import { memo, useEffect, useState } from 'react';
import type { SessionCopy } from '@/app/i18n';
import { consumeEventStream } from '../sse';
import { openTranscriptStream } from '../workspace-api';
import type { TranscriptData, TranscriptStreamEvent } from '../../../../shared/protocol';
import { Spinner } from '@/app/components/spinner';

type SessionState =
  | { status: 'loading' }
  | { status: 'empty' }
  | {
      status: 'ready';
      jsonl: string;
      sessionId: string;
      transcriptPath: string;
    }
  | { status: 'error'; error: string };

export const SessionPanel = memo(function SessionPanel({
  conversationId,
  live,
  copy,
}: {
  conversationId: string | null;
  live: boolean;
  copy: SessionCopy;
}) {
  const [state, setState] = useState<SessionState>({ status: 'loading' });

  useEffect(() => {
    if (!conversationId) {
      setState({ status: 'empty' });
      return;
    }

    const controller = new AbortController();
    let cancelled = false;

    const apply = (data: TranscriptData) => {
      if (data.ok === false) {
        setState({ status: 'error', error: data.error || copy.failed });
        return;
      }
      const jsonl = typeof data.jsonl === 'string' ? data.jsonl : '';
      if (!jsonl) {
        setState({ status: 'empty' });
        return;
      }
      const sessionId = data.sessionId || '';
      const transcriptPath = data.transcriptPath || '';
      setState((current) => (
        current.status === 'ready'
          && current.jsonl === jsonl
          && current.sessionId === sessionId
          && current.transcriptPath === transcriptPath
          ? current
          : { status: 'ready', jsonl, sessionId, transcriptPath }
      ));
    };

    (async () => {
      // The server sends the file once, then only what is appended, and ends
      // the stream at a time limit; `resume` reopens it where it stopped.
      let jsonl = '';
      let resume: { cursor: number; sessionId: string } | undefined;
      try {
        do {
          const response = await openTranscriptStream(conversationId, controller.signal, resume);
          const contentType = response.headers.get('content-type') || '';
          if (cancelled) return;
          if (!response.ok || !response.body || !contentType.includes('text/event-stream')) {
            setState({ status: 'error', error: copy.failed });
            return;
          }
          let reopen: typeof resume;
          await consumeEventStream<TranscriptStreamEvent>(response, (event) => {
            if (cancelled || event.type === 'ping') return;
            if (event.type === 'error') {
              setState({ status: 'error', error: event.error || copy.failed });
              return;
            }
            if (event.type === 'reconnect') {
              reopen = { cursor: event.data?.cursor ?? 0, sessionId: event.data?.sessionId || '' };
              return;
            }
            if (event.type === 'transcript' && event.data) {
              jsonl = event.data.append ? jsonl + (event.data.jsonl || '') : event.data.jsonl || '';
              apply({ ...event.data, jsonl });
            }
          });
          resume = reopen;
        } while (resume && !cancelled);
      } catch (error) {
        if (cancelled || (error instanceof DOMException && error.name === 'AbortError')) return;
        if (error instanceof Error && error.name === 'AbortError') return;
        setState({ status: 'error', error: copy.failed });
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [conversationId, copy.failed, live]);

  if (state.status === 'loading') {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-[var(--code-paper)] px-6 text-center text-muted-foreground">
        <Spinner />
        <p>{copy.loading}</p>
      </div>
    );
  }

  if (state.status === 'empty') {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-[var(--code-paper)] px-6 text-center text-muted-foreground">
        {live ? (
          <>
            <Spinner />
            <p>{copy.writing}</p>
          </>
        ) : (
          <p>{copy.empty}</p>
        )}
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-[var(--code-paper)] px-6 text-center text-destructive">
        <p>{state.error}</p>
      </div>
    );
  }

  const lines = state.jsonl.split('\n');
  const lineCount = state.jsonl.endsWith('\n') ? lines.length - 1 : lines.length;
  const sourceLabel = state.transcriptPath || copy.source;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-[var(--code-paper)] text-[var(--code-ink)]">
      <div className="flex min-h-10 flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] bg-[var(--code-rail)] px-4 py-2">
        <p className="min-w-0 truncate font-mono text-[11px] font-medium text-[var(--n-800)]">
          {sourceLabel}
        </p>
        <div className="flex shrink-0 items-center gap-2 font-mono text-[11px] text-muted-foreground">
          {state.sessionId ? <span>{state.sessionId}</span> : null}
          <span>{copy.lines(lineCount)}</span>
        </div>
      </div>
      <pre className="min-h-0 flex-1 overflow-auto bg-[var(--code-paper)] px-4 py-3 font-mono text-[12px] leading-5 text-[var(--code-ink)] whitespace-pre">
        {state.jsonl}
      </pre>
    </div>
  );
});
