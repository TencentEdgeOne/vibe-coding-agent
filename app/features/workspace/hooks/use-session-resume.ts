'use client';

import { useEffect, useLayoutEffect, useRef, useState, type MutableRefObject } from 'react';

const useClientLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/** How soon to ask again about a turn another instance is still running. */
const ELSEWHERE_RETRY_MS = 5_000;

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });
import { dropTrailingSummaryEcho } from '../../../../shared/timeline';
import type { Locale } from '@/app/i18n';
import {
  clearCachedConversationId,
  createMessageId,
  getStoredConversationId,
} from '@/app/lib/conversation';
import type {
  AssistantStatus,
  ChatMessage,
  ChatStreamEvent,
  ResumeData,
  SessionStreamEvent,
} from '@/app/types/workspace';
import { consumeEventStream } from '../sse';
import { openSessionStream } from '../workspace-api';
import type { LiveTurnApi } from './use-live-turn';
import type { WorkspaceStateApi } from './use-workspace-state';

export function useSessionResume(options: {
  workspace: WorkspaceStateApi;
  live: LiveTurnApi;
  setConversationId: (id: string | null) => void;
  setModel: (model: string) => void;
  setLanguage: (language: Locale) => void;
  conversationIdRef: MutableRefObject<string | null>;
  workspaceEpochRef: MutableRefObject<number>;
}) {
  const {
    workspace,
    live,
    setConversationId,
    setModel,
    setLanguage,
    conversationIdRef,
    workspaceEpochRef,
  } = options;

  // False on the server and the client's first render. Reading localStorage
  // here would show the home stage on the server and hide it for a returning
  // visitor, and hydration would fail.
  const [resumeChecked, setResumeChecked] = useState(false);
  const resumeAbortControllerRef = useRef<AbortController | null>(null);

  useClientLayoutEffect(() => {
    if (!getStoredConversationId()) setResumeChecked(true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const workspaceEpoch = workspaceEpochRef.current;
    const existing = getStoredConversationId();
    if (!existing) {
      return;
    }

    setResumeChecked(false);
    setConversationId(existing);

    const applyHistory = (data: ResumeData): { restored: boolean; liveTaskId: string | null } => {
      const history = Array.isArray(data.messages) ? data.messages : [];
      const activeTask = data.activeTask;
      if (!data.hasProject && history.length === 0 && !activeTask && !data.deployment) {
        return { restored: false, liveTaskId: null };
      }
      if (data.conversation_id) {
        setConversationId(data.conversation_id);
      }
      if (data.model) {
        setModel(data.model);
      }
      if (data.language === 'zh' || data.language === 'en') {
        setLanguage(data.language);
      }
      const activityHistory = Array.isArray(data.activityHistory) ? data.activityHistory : [];
      let nextMessages: ChatMessage[] = activityHistory.length > 0
        ? activityHistory.flatMap((turn) => [
            {
              id: `${turn.id}-user`,
              role: 'user' as const,
              content: turn.user,
              status: 'done' as AssistantStatus,
            },
            {
              id: `${turn.id}-assistant`,
              role: 'assistant' as const,
              content: turn.assistant,
              activities: dropTrailingSummaryEcho(turn.activities ?? [], turn.assistant),
              status: turn.status === 'completed' ? 'done' as const : turn.status === 'failed' ? 'error' as const : 'stopped' as const,
              ...(turn.startedAt ? { startedAt: turn.startedAt } : {}),
              endedAt: turn.activities.reduce(
                (latest, activity) => Math.max(latest, activity.kind === 'tool' ? activity.endedAt || 0 : activity.kind === 'thinking' ? activity.endedAt || 0 : 0),
                turn.startedAt || turn.createdAt,
              ),
            },
          ])
        : history.map((item) => ({
            id: createMessageId(item.role),
            role: item.role,
            content: item.content,
            status: 'done' as AssistantStatus,
          }));

      if (activeTask?.id && activeTask.message) {
        const persistedTurn = activityHistory.find((turn) => turn.id === activeTask.id);
        const turnAlreadyFinished = persistedTurn
          && (persistedTurn.status === 'stopped'
            || persistedTurn.status === 'completed'
            || persistedTurn.status === 'failed');

        if (!turnAlreadyFinished) {
          const assistantId = activeTask.id;
          const userId = `${activeTask.id}-user`;
          const last = nextMessages.at(-1);
          const hasRunningAssistant = nextMessages.some(
            (item) => item.role === 'assistant' && item.id === assistantId && item.status === 'running',
          );
          const hasUserForTurn = nextMessages.some((item) => item.id === userId);

          if (!hasRunningAssistant) {
            if (last?.role === 'user' && last.content === activeTask.message) {
              nextMessages = [
                ...nextMessages.slice(0, -1),
                { ...last, id: userId },
                {
                  id: assistantId,
                  role: 'assistant',
                  content: '',
                  activities: [],
                  status: 'running',
                  ...(activeTask.preparePhase ? { preparePhase: activeTask.preparePhase } : {}),
                },
              ];
            } else if (!hasUserForTurn && !(last?.role === 'assistant' && last.id === assistantId)) {
              nextMessages = [
                ...nextMessages,
                {
                  id: userId,
                  role: 'user',
                  content: activeTask.message,
                  status: 'done',
                },
                {
                  id: assistantId,
                  role: 'assistant',
                  content: '',
                  activities: [],
                  status: 'running',
                  ...(activeTask.preparePhase ? { preparePhase: activeTask.preparePhase } : {}),
                },
              ];
            }
          }
          live.activeTurnIdRef.current = assistantId;
          live.setLoading(true);
        }
      }

      const seenIds = new Set<string>();
      nextMessages = nextMessages.filter((item) => {
        if (seenIds.has(item.id)) return false;
        seenIds.add(item.id);
        return true;
      });

      live.setMessages(nextMessages);
      if (data.gatewayNeeded) {
        workspace.setGatewayNeeded(true);
        workspace.setGatewayDeferred(false);
      } else if (data.gatewaySkipped) {
        workspace.setGatewayNeeded(false);
        workspace.setGatewayDeferred(true);
      } else {
        workspace.setGatewayNeeded(false);
      }
      workspace.setDeployment(data.deployment ?? null);
      // The download link is how the panel knows a project exists at all — the
      // deploy button reads it. Resuming a session that already has a project
      // has to restore it, or every returning visit leaves Deploy disabled.
      workspace.setDownload(data.download?.url ? data.download : null);
      // Recorded with history, before the panel can consider a lazy boot: a
      // conversation that never published a preview must not have one started
      // for it just because the Preview tab was opened.
      workspace.setHasPublishedPreview(data.hasPreview === true);
      const liveTaskId = activeTask?.id
        && nextMessages.some((item) => item.id === activeTask.id && item.status === 'running')
        ? activeTask.id
        : null;
      return { restored: true, liveTaskId };
    };

    const resumeController = new AbortController();
    resumeAbortControllerRef.current = resumeController;
    (async () => {
      const liveAttach = {
        session: null as {
          handleStreamEvent: (event: ChatStreamEvent) => void;
          finish: () => void;
        } | null,
      };
      try {
        // The server ends an attach at a time limit while the turn runs on;
        // `resume` reopens it after the last event it delivered.
        let resume: { turnId: string; afterSeq: number } | undefined;
        let again = false;
        do {
          const response = await openSessionStream(existing, resumeController.signal, resume);
          const contentType = response.headers.get('content-type') || '';
          if (!response.ok || !response.body || !contentType.includes('text/event-stream')) {
            return;
          }

          let reopen: typeof resume;
          let elsewhere = false;
          await consumeEventStream<SessionStreamEvent>(response, (event) => {
            if (cancelled || workspaceEpoch !== workspaceEpochRef.current || event.type === 'ping') return;

            if (event.type === 'reconnect') {
              if (liveAttach.session && event.data?.turnId) {
                reopen = { turnId: event.data.turnId, afterSeq: event.data.afterSeq ?? 0 };
              }
              return;
            }

            if (event.type === 'resume_history' && event.data?.ok) {
              const historyData = event.data;
              elsewhere = historyData.activeTask?.elsewhere === true;
              const { restored, liveTaskId } = applyHistory(historyData);
              if (!restored) {
                clearCachedConversationId();
                conversationIdRef.current = null;
                setConversationId(null);
                setResumeChecked(true);
              }

              if (liveTaskId) {
                const conversationForRun = historyData.conversation_id || existing;
                liveAttach.session = live.startLiveChatSessionRef.current({
                  requestConversationId: conversationForRun,
                  assistantMessageId: liveTaskId,
                  abortController: resumeController,
                });
                live.chatAbortControllerRef.current = resumeController;
              }
              return;
            }

            liveAttach.session?.handleStreamEvent(event as ChatStreamEvent);
          });
          resume = reopen;
          // The turn runs on another instance (after a redeploy, say) and its
          // events cannot come through here: ask again until it ends or moves.
          again = Boolean(reopen) || elsewhere;
          if (elsewhere && !reopen) await sleep(ELSEWHERE_RETRY_MS);
        } while (again && !cancelled && workspaceEpoch === workspaceEpochRef.current);
      } catch (error) {
        if (!(error instanceof Error && error.name === 'AbortError')) {
          // Resume is best-effort.
        }
      } finally {
        if (!cancelled) {
          setResumeChecked(true);
          if (workspaceEpoch === workspaceEpochRef.current) {
            liveAttach.session?.finish();
          }
        }
      }
    })();

    return () => {
      cancelled = true;
      resumeController.abort();
      if (resumeAbortControllerRef.current === resumeController) {
        resumeAbortControllerRef.current = null;
      }
    };
  }, []);

  return {
    resumeChecked,
    setResumeChecked,
    resumeAbortControllerRef,
  };
}

export type SessionResumeApi = ReturnType<typeof useSessionResume>;
