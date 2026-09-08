'use client';

import {
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
} from 'react';

export const DEFAULT_CHAT_WIDTH = 400;
const MIN_CHAT_WIDTH = 280;
const MIN_RESULT_WIDTH = 320;
const CHAT_WIDTH_STORAGE_KEY = 'web-dev-agent-chat-width';
const KEYBOARD_STEP = 16;
const KEYBOARD_STEP_LARGE = 48;

function clampChatWidth(width: number, shellWidth: number) {
  const maxWidth = Math.max(MIN_CHAT_WIDTH, shellWidth - MIN_RESULT_WIDTH);
  return Math.round(Math.min(maxWidth, Math.max(MIN_CHAT_WIDTH, width)));
}

function readStoredChatWidth() {
  if (typeof window === 'undefined') return DEFAULT_CHAT_WIDTH;
  const parsed = Number(window.localStorage.getItem(CHAT_WIDTH_STORAGE_KEY));
  return Number.isFinite(parsed) ? parsed : DEFAULT_CHAT_WIDTH;
}

function persistChatWidth(width: number) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(CHAT_WIDTH_STORAGE_KEY, String(width));
}

function applyShellChatWidth(shell: HTMLElement, width: number) {
  const next = clampChatWidth(width, shell.clientWidth);
  shell.style.setProperty('--workspace-chat-width', `${next}px`);
  return next;
}

export function useWorkspaceSplitShell() {
  const shellRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;

    applyShellChatWidth(shell, readStoredChatWidth());

    const onResize = () => {
      applyShellChatWidth(shell, readStoredChatWidth());
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return shellRef;
}

export function WorkspaceSplitHandle({
  shellRef,
  label,
}: {
  shellRef: RefObject<HTMLElement | null>;
  label: string;
}) {
  const handleRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);

  const syncAria = useCallback((width: number) => {
    const handle = handleRef.current;
    const shell = shellRef.current;
    if (!handle || !shell) return;
    handle.setAttribute('aria-valuenow', String(width));
    handle.setAttribute(
      'aria-valuemax',
      String(Math.max(MIN_CHAT_WIDTH, shell.clientWidth - MIN_RESULT_WIDTH)),
    );
  }, [shellRef]);

  const applyWidth = useCallback((width: number) => {
    const shell = shellRef.current;
    if (!shell) return DEFAULT_CHAT_WIDTH;
    const next = applyShellChatWidth(shell, width);
    syncAria(next);
    return next;
  }, [shellRef, syncAria]);

  useEffect(() => {
    applyWidth(readStoredChatWidth());
    return () => {
      document.body.classList.remove('is-workspace-resizing');
      shellRef.current?.classList.remove('is-resizing');
    };
  }, [applyWidth, shellRef]);

  const conversationWidth = useCallback(() => {
    const conversation = shellRef.current?.querySelector<HTMLElement>(':scope > .agent-conversation');
    return conversation?.getBoundingClientRect().width ?? readStoredChatWidth();
  }, [shellRef]);

  const stopDrag = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    shellRef.current?.classList.remove('is-resizing');
    document.body.classList.remove('is-workspace-resizing');
    persistChatWidth(applyWidth(conversationWidth()));
  }, [applyWidth, conversationWidth, shellRef]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: conversationWidth(),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    shellRef.current?.classList.add('is-resizing');
    document.body.classList.add('is-workspace-resizing');
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    applyWidth(drag.startWidth + (event.clientX - drag.startX));
  };

  const onDoubleClick = () => {
    persistChatWidth(applyWidth(DEFAULT_CHAT_WIDTH));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? KEYBOARD_STEP_LARGE : KEYBOARD_STEP;
    let next: number | null = null;
    if (event.key === 'ArrowLeft') next = conversationWidth() - step;
    if (event.key === 'ArrowRight') next = conversationWidth() + step;
    if (event.key === 'Home') next = MIN_CHAT_WIDTH;
    if (event.key === 'End') {
      const shellWidth = shellRef.current?.clientWidth ?? MIN_CHAT_WIDTH + MIN_RESULT_WIDTH;
      next = shellWidth - MIN_RESULT_WIDTH;
    }
    if (next == null) return;
    event.preventDefault();
    persistChatWidth(applyWidth(next));
  };

  return (
    <div
      ref={handleRef}
      className="workspace-split-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title={label}
      aria-valuemin={MIN_CHAT_WIDTH}
      aria-valuenow={DEFAULT_CHAT_WIDTH}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stopDrag}
      onPointerCancel={stopDrag}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
    >
      <span className="workspace-split-handle-grip" aria-hidden="true" />
    </div>
  );
}
