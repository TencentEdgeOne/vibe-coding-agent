'use client';

import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, CircleAlert, CircleSlash } from 'lucide-react';
import type { ActivityStatus } from '../../../../../shared/protocol';
import { formatActivityDuration, resolveDisclosure } from './activity-disclosure';

export { formatActivityDuration } from './activity-disclosure';

/** Some rows sit quieter than others; ordinary tool work uses the default. */
export type ActivityTone = 'file' | 'quiet';

function useActivityDisclosure(status: ActivityStatus) {
  const [override, setOverride] = useState<boolean | null>(null);
  const open = resolveDisclosure(status, override);
  return { open, toggle: () => setOverride(!open) };
}

function useTickingNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [active]);
  return now;
}

function StatusIcon({ status }: { status: ActivityStatus }) {
  if (status === 'running') return <span className="activity-row-spinner" aria-hidden="true" />;
  if (status === 'failed') return <CircleAlert aria-hidden="true" />;
  if (status === 'stopped') return <CircleSlash aria-hidden="true" />;
  return <Check aria-hidden="true" />;
}

/** Stick to the latest line while it is arriving, and let go the moment the
 *  reader scrolls back to something earlier — the same contract as the
 *  conversation column itself. */
export function FollowLog({ text, className }: {
  text: string;
  className?: string;
}) {
  const ref = useRef<HTMLPreElement | null>(null);
  const followRef = useRef(true);

  useEffect(() => {
    const node = ref.current;
    if (node && followRef.current) node.scrollTop = node.scrollHeight;
  }, [text]);

  return (
    <pre
      ref={ref}
      className={className}
      onScroll={(event) => {
        const node = event.currentTarget;
        followRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
      }}
    >
      {text}
    </pre>
  );
}

export function ActivityDetail({ label, content, tone }: {
  label: string;
  content: string;
  tone?: 'danger';
}) {
  return (
    <div className={`activity-detail${tone === 'danger' ? ' is-danger' : ''}`}>
      <span className="activity-detail-label">{label}</span>
      <FollowLog text={content} />
    </div>
  );
}

export function ActivityRow({
  status,
  label,
  target,
  meta,
  startedAt,
  endedAt,
  tone = 'file',
  statusLabel,
  children,
}: {
  status: ActivityStatus;
  label: string;
  target?: string;
  meta?: string;
  startedAt?: number;
  endedAt?: number;
  tone?: ActivityTone;
  /** Read out to assistive tech, which cannot see the icon carrying it. */
  statusLabel: string;
  children?: ReactNode;
}) {
  const { open, toggle } = useActivityDisclosure(status);
  const now = useTickingNow(status === 'running');
  const duration = formatActivityDuration(
    startedAt,
    status === 'running' ? now : endedAt,
  );
  const tail = [duration, meta].filter(Boolean).join(' · ');
  const expandable = Boolean(children);
  const showBody = expandable && open;

  return (
    <div className={`activity-row is-${tone} is-${status}${showBody ? ' is-open' : ''}`}>
      <button
        type="button"
        className="activity-row-summary"
        onClick={expandable ? toggle : undefined}
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
      >
        <span className="activity-row-status">
          <StatusIcon status={status} />
          <span className="sr-only">{statusLabel}</span>
        </span>
        <span className="activity-row-label">{label}</span>
        {target && <span className="activity-row-target" dir="ltr">{target}</span>}
        {/* Held together so the duration and the chevron land on the same right
            edge whether or not the row has a target to show. */}
        <span className="activity-row-tail">
          {tail && <span className="activity-row-meta">{tail}</span>}
          {expandable && <ChevronRight className="activity-row-chevron" aria-hidden="true" />}
        </span>
      </button>
      {showBody && <div className="activity-row-body">{children}</div>}
    </div>
  );
}
