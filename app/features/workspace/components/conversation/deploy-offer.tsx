'use client';

import { memo } from 'react';
import { usePresence } from '@/app/hooks/use-presence';
import type { DeployOfferCopy } from './types';

export const DeployOffer = memo(function DeployOffer({
  deployOffer,
  onDeployOffer,
  onDismissDeployOffer,
}: {
  deployOffer: DeployOfferCopy | null;
  onDeployOffer?: () => void;
  onDismissDeployOffer?: () => void;
}) {
  const presence = usePresence(deployOffer);
  if (!presence.value) return null;

  return (
    <div
      className="deploy-offer"
      data-presence={presence.exiting ? 'exiting' : 'entering'}
      role="status"
      onAnimationEnd={presence.finishExit}
    >
      <span className="deploy-offer-copy">{presence.value.prompt}</span>
      <div className="deploy-offer-actions">
        <button
          type="button"
          className="deploy-offer-dismiss"
          disabled={presence.exiting}
          onClick={onDismissDeployOffer}
        >
          {presence.value.dismiss}
        </button>
        <button
          type="button"
          className="deploy-offer-accept"
          disabled={presence.exiting}
          onClick={onDeployOffer}
        >
          {presence.value.deploy}
        </button>
      </div>
    </div>
  );
});
