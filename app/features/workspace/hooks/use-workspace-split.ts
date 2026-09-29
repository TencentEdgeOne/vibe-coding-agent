'use client';

import { useCallback, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import {
  clampWorkspaceChatShare,
  WORKSPACE_CHAT_SHARE_DEFAULT,
  WORKSPACE_CHAT_SHARE_STEP,
  workspaceChatShareCss,
} from '../workspace-split';

function applyChatShare(shell: HTMLElement, share: number) {
  const next = clampWorkspaceChatShare(share, shell.getBoundingClientRect().width);
  shell.style.setProperty('--workspace-chat-share', workspaceChatShareCss(next));
  return next;
}

export function useWorkspaceSplit() {
  const shellRef = useRef<HTMLElement | null>(null);
  const chatShareRef = useRef(WORKSPACE_CHAT_SHARE_DEFAULT);
  const [chatShare, setChatShare] = useState(WORKSPACE_CHAT_SHARE_DEFAULT);
  const [resizing, setResizing] = useState(false);

  const moveToClientX = useCallback((clientX: number) => {
    const shell = shellRef.current;
    if (!shell) return;
    const rect = shell.getBoundingClientRect();
    chatShareRef.current = applyChatShare(shell, (clientX - rect.left) / rect.width);
  }, []);

  const onPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setResizing(true);
    moveToClientX(event.clientX);
  }, [moveToClientX]);

  const onPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    moveToClientX(event.clientX);
  }, [moveToClientX]);

  const finishResize = useCallback(() => {
    setChatShare(chatShareRef.current);
    setResizing(false);
  }, []);

  const onPointerUp = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    finishResize();
  }, [finishResize]);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const shell = shellRef.current;
    if (!shell) return;
    let next = chatShareRef.current;
    if (event.key === 'ArrowLeft') next -= WORKSPACE_CHAT_SHARE_STEP;
    else if (event.key === 'ArrowRight') next += WORKSPACE_CHAT_SHARE_STEP;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = 1;
    else return;
    event.preventDefault();
    const committed = applyChatShare(shell, next);
    chatShareRef.current = committed;
    setChatShare(committed);
  }, []);

  return {
    shellRef,
    chatShare,
    resizing,
    splitHandleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerCancel: onPointerUp,
      onLostPointerCapture: finishResize,
      onKeyDown,
    },
  };
}

export type WorkspaceSplitApi = ReturnType<typeof useWorkspaceSplit>;
