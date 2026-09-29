'use client';

import { useEffect, useState } from 'react';
import {
  hasVisibleAgentOutput,
  preparePhaseLabel,
  resolveAgentElapsed,
  resolveAgentStatusBarPhase,
} from './agent-status-bar-phase';
import type { AgentTurnStatus, ConversationCopy, ConversationMessage } from './types';

export function AgentStatusBar({ status, preparing, analyzing, stopping, sticky, copy, message }: {
  status: AgentTurnStatus;
  preparing: boolean;
  analyzing: boolean;
  stopping: boolean;
  sticky: boolean;
  copy: ConversationCopy;
  message: Pick<
    ConversationMessage,
    'status' | 'content' | 'startedAt' | 'endedAt' | 'activities' | 'preparePhase'
  >;
}) {
  const [now, setNow] = useState(() => Date.now());
  const state = resolveAgentStatusBarPhase(status, preparing, stopping, analyzing);
  const active = state === 'running' || state === 'analyzing' || state === 'stopping';
  const ticking = (status === 'running' && hasVisibleAgentOutput(message))
    || state === 'stopping';
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [ticking]);

  const label = state === 'preparing'
    ? preparePhaseLabel(message.preparePhase, copy)
    : state === 'analyzing'
      ? copy.analyzing
    : state === 'running'
      ? copy.running
      : state === 'stopping'
        ? copy.stopping
      : state === 'completed'
        ? copy.completed
        : state === 'failed'
          ? copy.failed
          : copy.stopped;
  const elapsed = resolveAgentElapsed(message, now);

  return (
    <div
      className={`agent-status-bar is-${state}${active ? ' is-active' : ''}${sticky ? ' is-sticky' : ''}`}
      role="status"
      aria-live="polite"
    >
      {active && (
        <span className="agent-status-bar-indicator" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      )}
      <span className="agent-status-bar-label">{label}</span>
      {elapsed && <span className="agent-status-bar-elapsed">{elapsed}</span>}
    </div>
  );
}
