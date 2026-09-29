import type { StopOutcome } from '../../workspace-api';

/** How long a stop the server confirmed may take to arrive on the turn's own stream. */
export const STOPPED_STREAM_GRACE_MS = 3_000;

/** How long a stop the server is still saving may take before the screen stops waiting. */
export const STOPPING_STREAM_GRACE_MS = 20_000;

const STREAM_POLL_MS = 200;

export type StopRequest = {
  conversationId: string;
  discardProject?: boolean;
  requestStop: (conversationId: string, options: { discardProject?: boolean }) => Promise<StopOutcome | null>;
  /** The workspace that asked is still the one on screen. */
  isCurrent: () => boolean;
  /** The turn's stream has not delivered its result yet. */
  streamOpen: () => boolean;
  /** Mark the turn stopped on screen without the server's result. */
  settleLocally: () => void;
  onSettled: () => void;
  wait?: (ms: number) => Promise<void>;
};

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

/**
 * Ask the server to stop the turn, then let the turn's own stream deliver the
 * stopped result: that stream is the request keeping the turn alive while it
 * saves its work. The screen settles on its own only when the server has no
 * running turn, could not be reached, or the result never arrives.
 */
export async function beginStop(request: StopRequest): Promise<StopOutcome | null> {
  const wait = request.wait ?? sleep;
  let outcome: StopOutcome | null = null;
  try {
    outcome = await request.requestStop(request.conversationId, {
      ...(request.discardProject ? { discardProject: true } : {}),
    }).catch(() => null);
    if (!request.isCurrent()) return outcome;
    if (outcome === 'stopped' || outcome === 'stopping') {
      const grace = outcome === 'stopped' ? STOPPED_STREAM_GRACE_MS : STOPPING_STREAM_GRACE_MS;
      for (let waited = 0; waited < grace && request.streamOpen(); waited += STREAM_POLL_MS) {
        await wait(STREAM_POLL_MS);
      }
    }
    if (request.isCurrent() && request.streamOpen()) request.settleLocally();
    return outcome;
  } finally {
    request.onSettled();
  }
}
