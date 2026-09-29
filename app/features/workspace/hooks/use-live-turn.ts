'use client';

import { useEffect, useRef, useState, type MutableRefObject } from 'react';
import { extractApiKeyFromUserText } from '../../../../shared/gateway-secret';
import type { Locale } from '@/app/i18n';
import {
  cacheConversationId,
  createConversationId,
  createMessageId,
  getOrCreateCachedConversationId,
  markLastTurnStopped,
} from '@/app/lib/conversation';
import type { AssistantStatus, ChatMessage } from '@/app/types/workspace';
import { startPromptTurn, stopChatTask } from '../workspace-api';
import type { PreviewSurfaceApi } from './use-preview-surface';
import type { WorkspaceStateApi } from './use-workspace-state';
import type { WorkspaceSnapshotApi } from './use-workspace-snapshot';
import {
  attachChatStream as attachLiveChatStream,
  createLiveChatSession,
  type LiveChatSession,
} from './live/stream-handlers';
import { createApplyGateway } from './live/use-gateway';
import { beginStop } from './live/stop';
import { useStoppingState } from './live/use-stopping';

export function useLiveTurn(options: {
  language: Locale;
  model: string;
  t: {
    response: {
      noDisplay: string;
      processingFailed: string;
      requestFailedPrefix: string;
      unknownError: string;
      agentFlowEnded: string;
    };
    workspace: {
      deployRequest: string;
    };
  };
  workspace: WorkspaceStateApi;
  preview: PreviewSurfaceApi;
  snapshot: WorkspaceSnapshotApi;
  conversationId: string | null;
  setConversationId: (id: string | null) => void;
  conversationIdRef: MutableRefObject<string | null>;
  workspaceEpochRef: MutableRefObject<number>;
  loadingRef: MutableRefObject<boolean>;
}) {
  const {
    language,
    model,
    t,
    workspace,
    preview,
    snapshot,
    conversationId,
    setConversationId,
    conversationIdRef,
    workspaceEpochRef,
    loadingRef,
  } = options;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const stoppingState = useStoppingState();
  const { stopping, setStopping, stopInFlightRef, resetStopping } = stoppingState;
  const messagesRef = useRef<ChatMessage[]>([]);
  const modelRef = useRef(model);
  const chatAbortControllerRef = useRef<AbortController | null>(null);
  const activeTurnIdRef = useRef('');
  const stoppingRef = useRef(false);

  modelRef.current = model;

  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => () => {
    chatAbortControllerRef.current?.abort();
    chatAbortControllerRef.current = null;
  }, []);

  const startLiveChatSessionRef = useRef<(opts: {
    requestConversationId: string;
    assistantMessageId: string;
    abortController: AbortController;
  }) => Pick<LiveChatSession, 'handleStreamEvent' | 'finish'>>(() => ({
    handleStreamEvent: () => {},
    finish: () => {},
  }));

  function startLiveChatSession(sessionOptions: {
    requestConversationId: string;
    assistantMessageId: string;
    abortController: AbortController;
  }) {
    return createLiveChatSession({
      ...sessionOptions,
      workspaceEpoch: workspaceEpochRef.current,
      workspaceEpochRef,
      conversationIdRef,
      chatAbortControllerRef,
      stoppingRef,
      activeTurnIdRef,
      noDisplay: t.response.noDisplay,
      processingFailed: t.response.processingFailed,
      agentFlowEnded: t.response.agentFlowEnded,
      workspace,
      preview,
      snapshot,
      setConversationId,
      setMessages,
      setLoading,
    });
  }

  startLiveChatSessionRef.current = startLiveChatSession;

  async function sendMessage(message: string, sendOptions: {
    deploy?: boolean;
    /** Real key from the input card. The visible turn is the prompt, not the key. */
    apiKey?: string;
  } = {}) {
    const trimmed = message.trim();
    if (!trimmed || loading || stopping || stopInFlightRef.current) return;

    const providedKey = (sendOptions.apiKey || '').trim();
    const extractedKey = providedKey ? null : extractApiKeyFromUserText(trimmed);
    const inboundApiKey = providedKey || extractedKey?.apiKey;
    const displayMessage = extractedKey?.maskedText || trimmed;

    const isDeploy = sendOptions.deploy === true;
    const isStartingFromHome = !isDeploy
      && !providedKey
      && messages.length === 0
      && !preview.preview
      && !workspace.deployment
      && !workspace.build
      && !workspace.fileTree;
    const requestConversationId = isStartingFromHome
      ? createConversationId()
      : conversationId || getOrCreateCachedConversationId();
    if (isStartingFromHome) {
      cacheConversationId(requestConversationId);
      setConversationId(requestConversationId);
      preview.resetPreview();
      workspace.resetWorkspace();
    } else if (!conversationId) {
      setConversationId(requestConversationId);
    }

    const userMessageId = createMessageId('user');
    const assistantMessageId = createMessageId('assistant');
    activeTurnIdRef.current = assistantMessageId;

    const turnMessages: ChatMessage[] = [
      { id: userMessageId, role: 'user', content: displayMessage },
      {
        id: assistantMessageId,
        role: 'assistant',
        content: '',
        activities: [],
        status: 'running',
        // The opening turn still has to build a workspace, so it must not say
        // it is thinking and then correct itself. A later turn already has one.
        preparePhase: messages.length === 0 ? 'workspace' : 'accepted',
      },
    ];
    setMessages((current) => [...current, ...turnMessages]);
    if (!isDeploy && !providedKey) {
      setInput('');
    }
    if (inboundApiKey) {
      workspace.setGatewayNeeded(false);
      workspace.setGatewayDeferred(false);
      workspace.setGatewayConfigured(true);
      workspace.setGatewaySavedVisible(false);
      workspace.setGatewayBusy(false);
    }
    setLoading(true);

    try {
      const requestAbortController = new AbortController();
      chatAbortControllerRef.current = requestAbortController;
      stoppingRef.current = false;
      const response = await startPromptTurn({
        conversationId: requestConversationId,
        message: displayMessage,
        turnId: assistantMessageId,
        model: modelRef.current,
        language,
        ...(inboundApiKey ? { apiKey: inboundApiKey } : {}),
        signal: requestAbortController.signal,
      });
      await attachLiveChatStream({
        requestConversationId,
        assistantMessageId,
        response,
        abortController: requestAbortController,
        requestFailedPrefix: t.response.requestFailedPrefix,
        unknownError: t.response.unknownError,
        workspaceEpoch: workspaceEpochRef.current,
        workspaceEpochRef,
        conversationIdRef,
        chatAbortControllerRef,
        stoppingRef,
        activeTurnIdRef,
        noDisplay: t.response.noDisplay,
        processingFailed: t.response.processingFailed,
        agentFlowEnded: t.response.agentFlowEnded,
        workspace,
        preview,
        snapshot,
        setConversationId,
        setMessages,
        setLoading,
      });
    } catch (error) {
      if ((error instanceof Error && error.name === 'AbortError') || stoppingRef.current) {
        setLoading(false);
        chatAbortControllerRef.current = null;
        activeTurnIdRef.current = '';
        stoppingRef.current = false;
        return;
      }
      if (providedKey) {
        workspace.setGatewayNeeded(true);
        workspace.setGatewayConfigured(false);
        workspace.setGatewaySavedVisible(false);
        workspace.setGatewayBusy(false);
      }
      const msg = `${t.response.requestFailedPrefix}${error instanceof Error ? error.message : t.response.unknownError}`;
      setMessages((current) =>
        current.map((item) =>
          item.id === assistantMessageId
            ? {
                ...item,
                content: msg,
                status: 'error' as AssistantStatus,
              }
            : item,
        ),
      );
      setLoading(false);
      chatAbortControllerRef.current = null;
      activeTurnIdRef.current = '';
      stoppingRef.current = false;
    }
  }

  // A stop settles twice: the /stop request answers, and the turn's stream
  // delivers its stopped result. The composer stays in "stopping" until both.
  useEffect(() => {
    if (!loading && !stopInFlightRef.current) setStopping(false);
  }, [loading, setStopping, stopInFlightRef]);

  function stopCurrentTask(stopOptions: { discardProject?: boolean } = {}) {
    const cid = conversationIdRef.current || conversationId;
    if (!loadingRef.current || !cid || stoppingRef.current || stopInFlightRef.current) return null;
    stoppingRef.current = true;
    stopInFlightRef.current = true;
    setStopping(true);
    workspace.setGatewayNeeded(false);
    workspace.setGatewayBusy(false);
    workspace.setGatewaySavedVisible(false);
    const workspaceEpoch = workspaceEpochRef.current;
    const stream = chatAbortControllerRef.current;
    // The stream carries the stopped result and is the request the server-side
    // turn runs inside while it saves. Only leaving the project closes it now.
    if (stopOptions.discardProject) stream?.abort();
    return beginStop({
      conversationId: cid,
      discardProject: stopOptions.discardProject,
      requestStop: stopChatTask,
      isCurrent: () => workspaceEpochRef.current === workspaceEpoch,
      streamOpen: () => stream !== null && chatAbortControllerRef.current === stream,
      settleLocally: () => {
        setMessages((current) => markLastTurnStopped(current, '').messages);
        setLoading(false);
        stream?.abort();
      },
      onSettled: () => {
        stopInFlightRef.current = false;
        if (!loadingRef.current) setStopping(false);
      },
    });
  }

  const applyGateway = createApplyGateway({
    workspace,
    preview,
    conversationId,
    conversationIdRef,
  });

  return {
    messages,
    setMessages,
    input,
    setInput,
    loading,
    setLoading,
    stopping,
    resetStopping,
    loadingRef,
    messagesRef,
    chatAbortControllerRef,
    activeTurnIdRef,
    stoppingRef,
    startLiveChatSessionRef,
    sendMessage,
    applyGateway,
    stopCurrentTask,
  };
}

export type LiveTurnApi = ReturnType<typeof useLiveTurn>;
