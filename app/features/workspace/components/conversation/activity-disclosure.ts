import type { ActivityStatus } from '../../../../../shared/protocol';

/**
 * Running work is open because it is the only thing there is to watch.
 * Everything that has ended settles shut on its own, so a build that touched
 * thirty files reads as thirty things done rather than thirty screens of
 * output.
 */
export function autoOpenForStatus(status: ActivityStatus) {
  return status === 'running';
}

/**
 * Once the reader has opened or closed a row themselves, that choice outranks
 * the automatic one — a row must never shut while it is being read.
 */
export function resolveDisclosure(status: ActivityStatus, override: boolean | null) {
  return override ?? autoOpenForStatus(status);
}

export function formatActivityDuration(startedAt?: number, endedAt?: number) {
  if (!startedAt || !endedAt || endedAt < startedAt) return '';
  const elapsed = endedAt - startedAt;
  if (elapsed < 60_000) return `${(elapsed / 1000).toFixed(1)}s`;
  const minutes = Math.floor(elapsed / 60_000);
  const seconds = Math.round((elapsed % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}
