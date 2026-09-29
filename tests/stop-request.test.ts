import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STOPPED_STREAM_GRACE_MS,
  beginStop,
  type StopRequest,
} from '../app/features/workspace/hooks/live/stop.ts';
import type { StopOutcome } from '../app/features/workspace/workspace-api.ts';

function harness(
  outcome: StopOutcome | null | Error,
  options: { closeStreamAfterPolls?: number; current?: boolean } = {},
) {
  const calls = { local: 0, settled: 0, polls: 0, requests: [] as unknown[] };
  let open = true;
  const request: StopRequest = {
    conversationId: 'conversation-1',
    requestStop: async (conversationId, stopOptions) => {
      calls.requests.push([conversationId, stopOptions]);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    isCurrent: () => options.current !== false,
    streamOpen: () => open,
    settleLocally: () => {
      calls.local += 1;
      open = false;
    },
    onSettled: () => {
      calls.settled += 1;
    },
    wait: async () => {
      calls.polls += 1;
      if (options.closeStreamAfterPolls !== undefined && calls.polls >= options.closeStreamAfterPolls) {
        open = false;
      }
    },
  };
  return { request, calls };
}

test('a confirmed stop lets the turn stream deliver the stopped result', async () => {
  const { request, calls } = harness('stopped', { closeStreamAfterPolls: 2 });

  assert.equal(await beginStop(request), 'stopped');
  assert.equal(calls.local, 0);
  assert.equal(calls.settled, 1);
});

test('a confirmed stop whose result never arrives settles the screen after a grace period', async () => {
  const { request, calls } = harness('stopped');

  await beginStop(request);
  assert.equal(calls.local, 1);
  assert.equal(calls.polls, STOPPED_STREAM_GRACE_MS / 200);
});

test('a server with no running turn, or no answer, settles the screen at once', async () => {
  for (const outcome of ['idle', null, new Error('network down')] as const) {
    const { request, calls } = harness(outcome);
    await beginStop(request);
    assert.equal(calls.local, 1, String(outcome));
    assert.equal(calls.polls, 0, String(outcome));
    assert.equal(calls.settled, 1, String(outcome));
  }
});

test('a stop from a workspace that was replaced leaves the new screen alone', async () => {
  const { request, calls } = harness('idle', { current: false });

  await beginStop(request);
  assert.equal(calls.local, 0);
  assert.equal(calls.settled, 1);
});

test('leaving the project is passed through to the server', async () => {
  const { request, calls } = harness('stopping', { closeStreamAfterPolls: 1 });

  await beginStop({ ...request, discardProject: true });
  assert.deepEqual(calls.requests, [['conversation-1', { discardProject: true }]]);
});
