'use client';

import { memo } from 'react';
import { Button } from '@/app/components/ui/button';

export type PreviewViewport = 'desktop' | 'mobile';

export type PreviewFrameCopy = {
  unavailable: string;
  loading: string;
  retry: string;
};

type PreviewFrameProps = {
  activeSlot: 'a' | 'b';
  activeUrl: string;
  activeRevision: number;
  /** The next preview, preloaded in the other stable iframe slot. */
  pendingUrl: string;
  pendingRevision: number;
  viewport: PreviewViewport;
  loaded: boolean;
  refreshFailed: boolean;
  copy: PreviewFrameCopy;
  onActiveLoad: () => void;
  onPendingLoad: () => void;
  onRetry: () => void;
};

// Memoized deliberately: this subtree owns two live iframes, and re-rendering it
// on every streamed chat token was enough to make the preview stutter while the
// agent talked. Every prop here is a primitive or a stable callback so the
// comparison actually holds.
export const PreviewFrame = memo(function PreviewFrame({
  activeSlot,
  activeUrl,
  activeRevision,
  pendingUrl,
  pendingRevision,
  viewport,
  loaded,
  refreshFailed,
  copy,
  onActiveLoad,
  onPendingLoad,
  onRetry,
}: PreviewFrameProps) {
  const slotAIsActive = activeSlot === 'a';
  const slotAUrl = slotAIsActive ? activeUrl : pendingUrl;
  const slotARevision = slotAIsActive ? activeRevision : pendingRevision;
  const slotBUrl = slotAIsActive ? pendingUrl : activeUrl;
  const slotBRevision = slotAIsActive ? pendingRevision : activeRevision;

  const renderFrame = (
    slot: 'a' | 'b',
    url: string,
    revision: number,
    isActive: boolean,
  ) => {
    if (!url) return null;
    return (
      <iframe
        key={`preview-slot-${slot}:${url}:${revision}`}
        title={isActive ? 'sandbox-preview' : 'sandbox-preview-pending'}
        src={url}
        onLoad={isActive ? onActiveLoad : onPendingLoad}
        aria-hidden={!isActive}
        className={`absolute inset-0 h-full w-full border-0${isActive ? '' : ' invisible pointer-events-none'}`}
        data-preview-revision={revision}
      />
    );
  };

  return (
    <div className={`workspace-preview-shell is-${viewport}`}>
      <div className="workspace-preview-stage">
        <div className="workspace-preview-frame">
          {(!loaded || refreshFailed) && (
            <div className={`workspace-preview-loading${refreshFailed ? ' is-actionable' : ''}`}>
              {/* Stacked only when there is an action: a lone sentence in a
                  column is the same box, and a button beside it is not. */}
              <div className={`workspace-preview-status${refreshFailed ? ' is-stacked' : ''}`}>
                <span>{refreshFailed ? copy.unavailable : copy.loading}</span>
                {refreshFailed && (
                  <Button size="sm" variant="outline" onClick={onRetry}>
                    {copy.retry}
                  </Button>
                )}
              </div>
            </div>
          )}
          {renderFrame('a', slotAUrl, slotARevision, slotAIsActive)}
          {renderFrame('b', slotBUrl, slotBRevision, !slotAIsActive)}
        </div>
      </div>
    </div>
  );
});
