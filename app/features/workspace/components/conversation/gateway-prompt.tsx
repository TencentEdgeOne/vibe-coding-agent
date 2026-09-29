'use client';

import { memo, useEffect, useRef, useState } from 'react';
import { usePresence } from '@/app/hooks/use-presence';
import type { GatewayPromptCopy } from './types';

export const GatewayPrompt = memo(function GatewayPrompt({
  gatewayPrompt,
  gatewayChip,
  gatewaySaved,
  gatewayBusy,
  onGatewaySubmit,
  onGatewaySkip,
  onGatewayReopen,
}: {
  gatewayPrompt?: GatewayPromptCopy | null;
  gatewayChip?: string | null;
  gatewaySaved?: string | null;
  gatewayBusy?: boolean;
  onGatewaySubmit?: (values: { apiKey: string }) => void;
  onGatewaySkip?: () => void;
  onGatewayReopen?: () => void;
}) {
  const [gatewayApiKey, setGatewayApiKey] = useState('');
  const gatewayInputRef = useRef<HTMLInputElement | null>(null);
  const focusOnOpenRef = useRef(false);
  const lastPromptRef = useRef<GatewayPromptCopy | null>(gatewayPrompt ?? null);
  if (gatewayPrompt) lastPromptRef.current = gatewayPrompt;

  const lastChipRef = useRef<string | null>(gatewayChip ?? null);
  if (gatewayChip) lastChipRef.current = gatewayChip;

  const lastSavedRef = useRef<string | null>(gatewaySaved ?? null);
  if (gatewaySaved) lastSavedRef.current = gatewaySaved;

  const lastCollapsedRef = useRef(false);
  if (gatewayPrompt) lastCollapsedRef.current = false;
  else if (gatewayChip || gatewaySaved) lastCollapsedRef.current = true;

  const cardVisible = Boolean(gatewayPrompt || gatewayChip || gatewaySaved);
  const cardPresence = usePresence(cardVisible ? true : null);
  const collapsed = Boolean(gatewayChip || gatewaySaved)
    || (cardPresence.exiting && lastCollapsedRef.current);
  const savedStatus = Boolean(gatewaySaved);
  const cardLabel = gatewayChip || lastChipRef.current || lastPromptRef.current?.title || '';
  const cardCopy: GatewayPromptCopy = lastPromptRef.current ?? {
    title: cardLabel,
    docs: '',
    docsUrl: '',
    apiKey: '',
    continue: '',
    skip: '',
  };
  const cardInDom = cardVisible || cardPresence.mounted;
  const gatewaySlot = cardInDom;

  useEffect(() => {
    if (!gatewayPrompt) {
      setGatewayApiKey('');
      return;
    }
    const node = gatewayInputRef.current;
    if (!focusOnOpenRef.current) return;
    focusOnOpenRef.current = false;
    if (!node || node.disabled) return;
    node.focus();
  }, [gatewayPrompt]);

  if (!gatewaySlot) return null;

  return (
    <div className="gateway-prompt-slot">
      {cardInDom ? (
        <form
          className={`gateway-prompt${collapsed ? ' is-collapsed' : ''}${savedStatus ? ' is-status' : ''}`}
          data-presence={cardPresence.exiting ? 'exiting' : 'entering'}
          onSubmit={(event) => {
            event.preventDefault();
            if (gatewayBusy || cardPresence.exiting || collapsed) return;
            onGatewaySubmit?.({
              apiKey: gatewayApiKey.trim(),
            });
          }}
          onAnimationEnd={cardPresence.finishExit}
        >
          <div
            className="gateway-prompt-state gateway-prompt-expanded"
            aria-hidden={collapsed}
          >
            <div className="gateway-prompt-state-inner gateway-prompt-expanded-inner">
              <div className="gateway-prompt-copy">
                <p className="gateway-prompt-title">
                  {cardCopy.title}
                  {cardCopy.description && (
                    <span className="gateway-prompt-description">
                      {cardCopy.description}
                    </span>
                  )}
                </p>
                {cardCopy.docsUrl && (
                  <a
                    className="gateway-prompt-docs"
                    href={cardCopy.docsUrl}
                    target="_blank"
                    rel="noreferrer"
                    tabIndex={collapsed ? -1 : undefined}
                  >
                    {cardCopy.docs}
                  </a>
                )}
              </div>
              <label className="gateway-prompt-field">
                <input
                  ref={gatewayInputRef}
                  type="password"
                  aria-label={cardCopy.apiKey}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={cardCopy.apiKey}
                  value={gatewayApiKey}
                  disabled={gatewayBusy || cardPresence.exiting || collapsed}
                  onChange={(event) => setGatewayApiKey(event.target.value)}
                />
              </label>
              <button
                type="button"
                className="deploy-offer-dismiss"
                disabled={gatewayBusy || cardPresence.exiting || collapsed}
                tabIndex={collapsed ? -1 : undefined}
                onClick={onGatewaySkip}
              >
                {cardCopy.skip}
              </button>
              <button
                type="submit"
                className="deploy-offer-accept"
                disabled={
                  gatewayBusy
                  || cardPresence.exiting
                  || collapsed
                  || !gatewayApiKey.trim()
                }
                tabIndex={collapsed ? -1 : undefined}
              >
                {cardCopy.continue}
              </button>
            </div>
          </div>
          <div
            className="gateway-prompt-state gateway-prompt-collapsed"
            aria-hidden={!collapsed}
          >
            <div className="gateway-prompt-state-inner">
              <button
                type="button"
                className="gateway-prompt-expand"
                disabled={gatewayBusy || cardPresence.exiting || !collapsed || savedStatus}
                tabIndex={collapsed ? undefined : -1}
                onClick={() => {
                  focusOnOpenRef.current = true;
                  onGatewayReopen?.();
                }}
              >
                {savedStatus ? (
                  <span className="gateway-prompt-status" role="status">
                    {gatewaySaved}
                  </span>
                ) : cardLabel}
              </button>
            </div>
          </div>
        </form>
      ) : lastSavedRef.current ? (
        <p className="gateway-prompt-saved" role="status">{lastSavedRef.current}</p>
      ) : null}
    </div>
  );
});
