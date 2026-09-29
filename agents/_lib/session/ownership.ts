/**
 * Which process may act for a conversation, and what a request does when it is
 * not that process.
 *
 * Session affinity keeps a conversation's requests on one instance, so the
 * process that last claimed its epoch is authoritative while the session
 * lives. A request that finds the conversation owned elsewhere either claims
 * it, fencing the old owner, or, when a turn there is still visibly making
 * progress, stays out of its way.
 */
import type { AgentContext, BlobStoreLike } from '../runtime/context.ts';
import { instanceId } from '../runtime/instance.ts';
import type { ChatTask } from '../types.ts';
import { claimEpoch, stillOwner, type OwnerClaim } from './fence.ts';
import { adoptConversationRecord, getBlobStore, getConversationRecord } from './store.ts';

/** How long a tool call may reuse an ownership check before asking Blob again. */
export const OWNER_CHECK_CACHE_MS = 2_000;

/**
 * A running turn that has not recorded progress for this long has no live
 * owner. Far above the interval a running turn writes at, far below how long a
 * platform session survives without requests.
 */
export const TURN_PROGRESS_STALE_MS = 3 * 60_000;

/**
 * How often a running turn asks whether it was replaced. Tool calls ask too;
 * this catches a model that generates for minutes without calling one.
 */
export const FENCE_WATCH_MS = 10_000;

/** A running turn records progress every this many watches (30 seconds). */
export const PROGRESS_EVERY_WATCHES = 3;

export class FencedError extends Error {
  readonly code = 'CONVERSATION_FENCED';

  constructor() {
    super('This conversation was taken over by a newer owner.');
  }
}

export class TurnRunningElsewhereError extends Error {
  readonly code = 'TURN_RUNNING_ELSEWHERE';

  constructor() {
    super('A turn of this conversation is still running on another instance. Try again shortly.');
  }
}

type OwnershipContext = Pick<AgentContext, 'blobStore' | 'epoch'>;
type Held = { epoch: number; checkedAt: number };

/** Held epochs per Blob store, so contexts with their own store do not share. */
const DEFAULT_SCOPE = {};
const heldByScope = new WeakMap<object, Map<string, Held>>();

function heldFor(context: OwnershipContext) {
  const scope: BlobStoreLike | object = context.blobStore ?? DEFAULT_SCOPE;
  let held = heldByScope.get(scope);
  if (!held) {
    held = new Map();
    heldByScope.set(scope, held);
  }
  return held;
}

const lostListeners = new Set<(conversationId: string) => void>();

/** Runs when this process learns a newer owner took the conversation. */
export function onOwnershipLost(listener: (conversationId: string) => void) {
  lostListeners.add(listener);
}

function lose(context: OwnershipContext, conversationId: string, epoch: number) {
  const held = heldFor(context);
  if (held.get(conversationId)?.epoch === epoch) {
    held.delete(conversationId);
    // Logged once per loss: how often this happens in production is what says
    // whether session affinity holds as well as the design assumes.
    console.warn('[ownership] replaced by a newer owner', {
      instance: instanceId(),
      conversationId,
      epoch,
    });
  }
  for (const listener of lostListeners) listener(conversationId);
}

function isActive(task: ChatTask | null | undefined): task is ChatTask {
  return task?.status === 'queued' || task?.status === 'running';
}

export function isTurnProgressFresh(task: ChatTask, now = Date.now()) {
  const last = task.progressAt ?? task.startedAt ?? task.createdAt;
  return now - last < TURN_PROGRESS_STALE_MS;
}

/**
 * Whether the epoch this context acts under is still the newest. A context
 * that holds none has nothing to lose and passes.
 */
export async function confirmEpoch(
  context: OwnershipContext,
  conversationId: string,
  options: { cacheMs?: number } = {},
) {
  const epoch = context.epoch;
  if (typeof epoch !== 'number') return true;
  const held = heldFor(context).get(conversationId);
  const cacheMs = options.cacheMs ?? 0;
  if (cacheMs > 0 && held?.epoch === epoch && Date.now() - held.checkedAt < cacheMs) return true;
  if (await stillOwner(getBlobStore(context), conversationId, epoch)) {
    if (held?.epoch === epoch) held.checkedAt = Date.now();
    return true;
  }
  lose(context, conversationId, epoch);
  return false;
}

/**
 * The epoch this process last claimed for the conversation, without asking
 * Blob whether it still holds. For reads that may use the owner's copy.
 */
export function heldEpoch(context: OwnershipContext, conversationId: string) {
  return heldFor(context).get(conversationId)?.epoch;
}

export type ConversationEntry =
  | { role: 'owner'; epoch: number; tookOver: boolean }
  | { role: 'observer' };

const entering = new WeakMap<object, Map<string, Promise<unknown>>>();

/**
 * Requests of one conversation enter one at a time: a page load sends several
 * at once, and two concurrent claims would have the second fence the first.
 */
async function oneEntryAtATime<T>(context: OwnershipContext, conversationId: string, run: () => Promise<T>) {
  const scope: BlobStoreLike | object = context.blobStore ?? DEFAULT_SCOPE;
  let queue = entering.get(scope);
  if (!queue) {
    queue = new Map();
    entering.set(scope, queue);
  }
  const previous = queue.get(conversationId) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(run);
  queue.set(conversationId, current);
  try {
    return await current;
  } finally {
    if (queue.get(conversationId) === current) queue.delete(conversationId);
  }
}

/**
 * Establish what this request may do. A process that owns the conversation
 * keeps it. Otherwise the request claims a new epoch and settles the turn the
 * old owner left running, unless that turn is still making progress: then a
 * write is refused and a read goes ahead without writing. A stop always claims.
 */
export function enterConversation(
  context: OwnershipContext,
  conversationId: string,
  intent: OwnerClaim['intent'],
): Promise<ConversationEntry> {
  return oneEntryAtATime(context, conversationId, () => enter(context, conversationId, intent));
}

async function enter(
  context: OwnershipContext,
  conversationId: string,
  intent: OwnerClaim['intent'],
): Promise<ConversationEntry> {
  const held = heldFor(context).get(conversationId);
  if (held) {
    // Uncached: one GET per request, and a request must not start from a copy
    // a newer owner has already replaced.
    context.epoch = held.epoch;
    if (await confirmEpoch(context, conversationId)) {
      return { role: 'owner', epoch: held.epoch, tookOver: false };
    }
    context.epoch = undefined;
  }

  const record = await getConversationRecord(context, conversationId, { refresh: true });
  const task = record.chatTask;
  if (intent !== 'stop' && isActive(task) && isTurnProgressFresh(task)) {
    if (intent === 'write') throw new TurnRunningElsewhereError();
    return { role: 'observer' };
  }

  const epoch = await claimEpoch(getBlobStore(context), conversationId, record.epoch ?? 0, {
    instance: instanceId(),
    at: Date.now(),
    intent,
  });
  heldFor(context).set(conversationId, { epoch, checkedAt: Date.now() });
  context.epoch = epoch;
  if (epoch > 1 || isActive(task)) {
    console.warn('[ownership] took over the conversation', {
      instance: instanceId(),
      conversationId,
      epoch,
      intent,
      ...(isActive(task) ? { settledTask: task.id, lastProgressAt: task.progressAt } : {}),
    });
  }
  const chatTask = isActive(task)
    ? {
        ...task,
        status: intent === 'stop' ? 'stopped' as const : 'failed' as const,
        finishedAt: Date.now(),
        ...(intent === 'stop' ? {} : { error: 'The previous generation stopped before it finished.' }),
      }
    : task;
  await adoptConversationRecord(context, conversationId, { ...record, epoch, chatTask });
  return { role: 'owner', epoch, tookOver: true };
}

/**
 * The guard in front of every durable write for a conversation. A context
 * that holds an epoch must still hold it; one that never entered enters now as
 * a read, which claims only when no turn elsewhere is making progress.
 */
export async function assertCanWrite(context: OwnershipContext, conversationId: string) {
  if (typeof context.epoch !== 'number') {
    const entry = await enterConversation(context, conversationId, 'read');
    if (entry.role === 'observer') throw new TurnRunningElsewhereError();
    return;
  }
  if (!(await confirmEpoch(context, conversationId))) throw new FencedError();
}
