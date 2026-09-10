'use client';

import { memo } from 'react';
import { ExternalLink, Laptop, RefreshCw, Smartphone } from 'lucide-react';

export type PreviewControlsCopy = {
  viewportGroup: string;
  desktop: string;
  mobile: string;
  refresh: string;
  open: string;
};

type PreviewControlsProps = {
  viewport: 'desktop' | 'mobile';
  copy: PreviewControlsCopy;
  onViewportChange: (viewport: 'desktop' | 'mobile') => void;
  onRefresh: () => void;
  onOpen: () => void;
};

export const PreviewControls = memo(function PreviewControls({
  viewport,
  copy,
  onViewportChange,
  onRefresh,
  onOpen,
}: PreviewControlsProps) {
  return (
    <div className="workspace-topbar-group">
      <div className="workspace-viewport-switch" role="group" aria-label={copy.viewportGroup}>
        <button
          type="button"
          aria-pressed={viewport === 'desktop'}
          aria-label={copy.desktop}
          onClick={() => onViewportChange('desktop')}
          title={copy.desktop}
        >
          <Laptop />
        </button>
        <button
          type="button"
          aria-pressed={viewport === 'mobile'}
          aria-label={copy.mobile}
          onClick={() => onViewportChange('mobile')}
          title={copy.mobile}
        >
          <Smartphone />
        </button>
      </div>
      <button
        type="button"
        onClick={onRefresh}
        className="workspace-icon-button"
        aria-label={copy.refresh}
        data-tooltip={copy.refresh}
      >
        <RefreshCw className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={onOpen}
        className="workspace-icon-button"
        aria-label={copy.open}
        data-tooltip={copy.open}
      >
        <ExternalLink className="size-3.5" />
      </button>
    </div>
  );
});
