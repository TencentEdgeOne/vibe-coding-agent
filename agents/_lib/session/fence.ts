/**
 * Epochs: which generation of owner may act for a conversation.
 *
 * Session affinity normally keeps a conversation on one instance, but a
 * redeploy, a crash that was not quite one, or a re-created session can leave
 * an old executor running while a new one takes over the same sandbox. Each
 * takeover creates `owner/{n+1}` with `onlyIfNew`, so exactly one claimant wins,
 * and the holder of epoch n stays valid only while `owner/{n+1}` is absent.
 * The keys are never rewritten, so "have I been replaced?" is one GET.
 */
import type { BlobStoreLike } from '../runtime/context.ts';
import { isPreconditionFailed } from './store.ts';

export type OwnerClaim = {
  instance: string;
  at: number;
  /** The request that claimed: a turn start, a stop, or a takeover on read. */
  intent: 'read' | 'write' | 'stop';
};

const MAX_CLAIM_ATTEMPTS = 5;

export function ownerKey(conversationId: string, epoch: number) {
  return `conv/${conversationId}/owner/${epoch}.json`;
}

/** The newest claimed epoch, probing forward from a hint that may lag. */
export async function latestEpoch(store: BlobStoreLike, conversationId: string, hint = 0) {
  let epoch = Math.max(0, Math.floor(hint));
  while (await store.get(ownerKey(conversationId, epoch + 1), { type: 'json' })) epoch += 1;
  return epoch;
}

export async function claimEpoch(
  store: BlobStoreLike,
  conversationId: string,
  hint: number,
  claim: OwnerClaim,
) {
  let from = hint;
  for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
    const next = (await latestEpoch(store, conversationId, from)) + 1;
    try {
      await store.setJSON(ownerKey(conversationId, next), claim, { onlyIfNew: true });
      return next;
    } catch (error) {
      if (!isPreconditionFailed(error)) throw error;
      from = next;
    }
  }
  throw new Error('Could not claim the conversation: another instance keeps claiming it.');
}

export async function stillOwner(store: BlobStoreLike, conversationId: string, epoch: number) {
  return !(await store.get(ownerKey(conversationId, epoch + 1), { type: 'json' }));
}
