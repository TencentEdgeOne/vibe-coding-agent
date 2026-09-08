'use client';

import { Check, Copy, ExternalLink, RefreshCw } from 'lucide-react';
import type { UiCopy } from '@/app/i18n';

export function PreviewUrlChip({
  path,
  copied,
  copy,
  onCopy,
  onRefresh,
  onOpen,
}: {
  path: string;
  copied: boolean;
  copy: UiCopy['workspace'];
  onCopy: () => void;
  onRefresh: () => void;
  onOpen: () => void;
}) {
  return (
    <div className="workspace-url-chip" style={{ width: 240, minWidth: 240 }}>
      <button
        type="button"
        onClick={onCopy}
        className="workspace-url-chip-label"
        title={copied ? copy.previewPathCopied : copy.copyPreviewPath}
      >
        <span dir="ltr">{path}</span>
        {copied ? <Check /> : <Copy />}
      </button>
      <button
        type="button"
        onClick={onRefresh}
        className="workspace-url-chip-action"
        aria-label={copy.refreshPreview}
        data-tooltip={copy.refreshPreview}
      >
        <RefreshCw />
      </button>
      <button
        type="button"
        onClick={onOpen}
        className="workspace-url-chip-action"
        aria-label={copy.openPreview}
        data-tooltip={copy.openPreview}
      >
        <ExternalLink />
      </button>
    </div>
  );
}
