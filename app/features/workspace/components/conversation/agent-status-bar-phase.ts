import { firstVisibleActivityStartedAt } from '../../../../../shared/timeline.ts';
import type { PreparePhase } from '../../../../../shared/protocol.ts';
import type { AgentTurnStatus, ConversationMessage } from './types';

export type AgentStatusBarPhase =
  | 'preparing'
  | 'analyzing'
  | 'running'
  | 'stopping'
  | 'completed'
  | 'failed'
  | 'stopped';

/** Thinking is the first visible sign that the agent is working, so it ends
 *  preparation. The bar calls that phase analysis until a real step arrives. */
export function isAgentPreparing(
  message: Pick<ConversationMessage, 'content' | 'activities'>,
) {
  return !hasVisibleAgentOutput(message);
}

export function isAgentAnalyzing(
  message: Pick<ConversationMessage, 'content' | 'activities'>,
) {
  if (message.content.length > 0) return false;
  const activities = message.activities ?? [];
  if (activities.some((activity) => activity.kind === 'tool' || activity.kind === 'text')) {
    return false;
  }
  return activities.some((activity) => activity.kind === 'thinking');
}

export function preparePhaseLabel(phase: PreparePhase | undefined, copy: {
  prepareAccepted: string;
  prepareWorkspace: string;
  prepareAgent: string;
  preparingAgent: string;
}) {
  if (phase === 'accepted') return copy.prepareAccepted;
  if (phase === 'workspace') return copy.prepareWorkspace;
  if (phase === 'agent') return copy.prepareAgent;
  return copy.preparingAgent;
}

export function hasVisibleAgentOutput(
  message: Pick<ConversationMessage, 'content' | 'activities'>,
) {
  if (message.content.length > 0) return true;
  return (message.activities ?? []).some(
    (activity) => activity.kind === 'thinking' || activity.kind === 'tool' || activity.kind === 'text',
  );
}

export function resolveAgentStatusBarPhase(
  status: AgentTurnStatus,
  preparing: boolean,
  stopping = false,
  analyzing = false,
): AgentStatusBarPhase {
  if (stopping) return 'stopping' as const;
  if (status === 'done') return 'completed' as const;
  if (status === 'error') return 'failed' as const;
  if (status === 'running' && preparing) return 'preparing' as const;
  if (status === 'running' && analyzing) return 'analyzing' as const;
  return status;
}

export function resolveAgentElapsed(
  message: Pick<ConversationMessage, 'status' | 'startedAt' | 'endedAt' | 'activities'>
    & Partial<Pick<ConversationMessage, 'content'>>,
  now = Date.now(),
) {
  const startedAt = message.startedAt
    || firstVisibleActivityStartedAt(message.activities ?? []);
  if (!startedAt) return '';
  const end = message.status === 'running' ? now : message.endedAt || now;
  if (end < startedAt) return '';
  const seconds = Math.floor((end - startedAt) / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
