'use client';

import { useState, type MutableRefObject } from 'react';
import { clearCachedConversationId } from '@/app/lib/conversation';
import type { LiveTurnApi } from './use-live-turn';
import type { PreviewSurfaceApi } from './use-preview-surface';
import type { WorkspaceStateApi } from './use-workspace-state';

export function useNewProject(options: {
  live: LiveTurnApi;
  resume: {
    resumeAbortControllerRef: MutableRefObject<AbortController | null>;
  };
  workspace: WorkspaceStateApi;
  preview: PreviewSurfaceApi;
  setConversationId: (id: string | null) => void;
  conversationIdRef: MutableRefObject<string | null>;
  workspaceEpochRef: MutableRefObject<number>;
  loadingRef: MutableRefObject<boolean>;
}) {
  const {
    live,
    resume,
    workspace,
    preview,
    setConversationId,
    conversationIdRef,
    workspaceEpochRef,
    loadingRef,
  } = options;
  const [newProjectConfirmOpen, setNewProjectConfirmOpen] = useState(false);

  function startNewProject() {
    workspaceEpochRef.current += 1;
    live.chatAbortControllerRef.current = null;
    resume.resumeAbortControllerRef.current?.abort();
    resume.resumeAbortControllerRef.current = null;
    live.activeTurnIdRef.current = '';
    live.stoppingRef.current = false;
    live.resetStopping();
    loadingRef.current = false;
    conversationIdRef.current = null;
    clearCachedConversationId();
    setConversationId(null);
    live.setMessages([]);
    live.setLoading(false);
    live.setInput('');
    workspace.resetWorkspace();
    preview.resetPreview();
  }

  function handleNewProject() {
    if (live.loadingRef.current || live.stopping) {
      setNewProjectConfirmOpen(true);
      return;
    }
    startNewProject();
  }

  function confirmNewProject() {
    setNewProjectConfirmOpen(false);
    if (live.loadingRef.current) {
      void live.stopCurrentTask({ discardProject: true });
    }
    startNewProject();
  }

  return {
    newProjectConfirmOpen,
    setNewProjectConfirmOpen,
    startNewProject,
    handleNewProject,
    confirmNewProject,
  };
}
