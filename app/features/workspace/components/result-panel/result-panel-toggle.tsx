'use client';

import { PanelRight, PanelRightClose } from 'lucide-react';

export function ResultPanelToggle({
  open,
  attention = false,
  showLabel,
  hideLabel,
  attentionLabel,
  onToggle,
}: {
  open: boolean;
  attention?: boolean;
  showLabel: string;
  hideLabel: string;
  attentionLabel?: string;
  onToggle: () => void;
}) {
  const label = open ? hideLabel : (attention && attentionLabel ? attentionLabel : showLabel);
  return (
    <button
      type="button"
      onClick={onToggle}
      className="workspace-icon-button"
      aria-expanded={open}
      aria-controls="workspace-result-panel"
      aria-label={label}
      data-tooltip={label}
    >
      {open ? <PanelRightClose /> : <PanelRight />}
      {attention && !open ? <span className="workspace-panel-attention" /> : null}
    </button>
  );
}
