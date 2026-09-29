import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import { cacheConversationId } from '@/app/lib/conversation';
import { mergeFileTreeWrites } from '@/app/lib/file-tree';
import type {
  AssistantStatus,
  ChatMessage,
  ChatResponse,
  ChatStreamEvent,
} from '@/app/types/workspace';
import { consumeEventStream } from '../../sse';
import type { PreviewSurfaceApi } from '../use-preview-surface';
import type { WorkspaceSnapshotApi } from '../use-workspace-snapshot';
import type { WorkspaceStateApi } from '../use-workspace-state';
import {
  finalizeAssistant as finalizeAssistantMessages,
  foldActivityEvent as foldActivityIntoMessages,
  patchAssistant as patchAssistantMessages,
  settleRunningAssistant,
} from './turn-messages';

export type LiveChatSession = {
  handleStreamEvent: (event: ChatStreamEvent) => void;
  finish: () => void;
  applyResponse: (data: ChatResponse) => void;
  finalizeAssistant: (finalContent: string, finalStatus: AssistantStatus) => void;
};

export type LiveChatSessionOptions = {
  requestConversationId: string;
  assistantMessageId: string;
  abortController: AbortController;
  workspaceEpoch: number;
  workspaceEpochRef: MutableRefObject<number>;
  conversationIdRef: MutableRefObject<string | null>;
  chatAbortControllerRef: MutableRefObject<AbortController | null>;
  stoppingRef: MutableRefObject<boolean>;
  activeTurnIdRef: MutableRefObject<string>;
  noDisplay: string;
  processingFailed: string;
  agentFlowEnded: string;
  workspace: WorkspaceStateApi;
  preview: PreviewSurfaceApi;
  snapshot: WorkspaceSnapshotApi;
  setConversationId: (id: string | null) => void;
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>;
  setLoading: (loading: boolean) => void;
};

export function createLiveChatSession(sessionOptions: LiveChatSessionOptions): LiveChatSession {
  const { assistantMessageId } = sessionOptions;
  const workspaceEpoch = sessionOptions.workspaceEpoch;
  const requestAbortController = sessionOptions.abortController;
  const {
    workspace,
    preview,
    snapshot,
    setConversationId,
    setMessages,
    setLoading,
    workspaceEpochRef,
    conversationIdRef,
    chatAbortControllerRef,
    stoppingRef,
    activeTurnIdRef,
  } = sessionOptions;
  const activatedPreviewRevisions = new Map<string, number>();
  let sawProjectActivity = false;
  let openedFirstFile = false;
  let pendingFirstFilePath: string | null = null;
  let gatewayKeyApplied = false;

  const revealFirstFile = (path: string) => {
    if (openedFirstFile || !path) return;
    openedFirstFile = true;
    pendingFirstFilePath = null;
    workspace.setFilesFocusPath(path);
  };

  const patchAssistant = (patch: Partial<ChatMessage>) => {
    setMessages((current) => patchAssistantMessages(current, assistantMessageId, patch));
  };

  const foldActivityEvent = (event: ChatStreamEvent) => {
    setMessages((current) => foldActivityIntoMessages(current, assistantMessageId, event));
  };

  const finalizeAssistant = (
    finalContent: string,
    finalStatus: AssistantStatus,
  ) => {
    workspace.setGatewayBusy(false);
    setMessages((current) =>
      finalizeAssistantMessages(current, assistantMessageId, finalContent, finalStatus),
    );
  };

  const applyResponse = (data: ChatResponse) => {
    if (data.conversation_id) {
      cacheConversationId(data.conversation_id);
      setConversationId(data.conversation_id);
    }
    const finalText = data.reply || data.error || sessionOptions.noDisplay;
    const finalStatus: AssistantStatus = data.stopped ? 'stopped' : data.ok === false ? 'error' : 'done';
    finalizeAssistant(finalText, finalStatus);
  };

  const handleStreamEvent = (event: ChatStreamEvent) => {
    if (workspaceEpoch !== workspaceEpochRef.current) return;
    if (event.type === 'task_started') {
      if (event.data?.conversation_id) {
        cacheConversationId(event.data.conversation_id);
        setConversationId(event.data.conversation_id);
      }
      if (event.data?.preparePhase) {
        patchAssistant({ preparePhase: event.data.preparePhase });
      }
      return;
    }
    if (event.type === 'prepare_phase') {
      if (event.data?.phase) {
        patchAssistant({ preparePhase: event.data.phase });
      }
      return;
    }
    if (event.type === 'ping') return;
    if (event.type === 'gateway_credentials') {
      if (event.data?.status === 'needed') {
        if (gatewayKeyApplied) return;
        workspace.setGatewayNeeded(true);
        workspace.setGatewayDeferred(false);
        workspace.setGatewayBusy(false);
      }
      if (event.data?.status === 'resolved') {
        workspace.setGatewayNeeded(false);
        workspace.setGatewayBusy(false);
        if (event.data.skipped) {
          workspace.setGatewayDeferred(true);
          workspace.setGatewayConfigured(false);
          workspace.setGatewaySavedVisible(false);
        } else {
          gatewayKeyApplied = true;
          workspace.setGatewayDeferred(false);
          workspace.setGatewayConfigured(true);
          workspace.setGatewaySavedVisible(false);
          workspace.setGatewayPromptVariant('default');
        }
      }
      return;
    }
    if (event.type === 'workspace' && event.data) {
      snapshot.applySnapshot(event.data);
      return;
    }
    if (event.type === 'result' && event.data) {
      applyResponse(event.data);
      setLoading(false);
      return;
    }
    if (event.type === 'agent' && event.data) {
      const agentData = event.data;
      const text = agentData.reply || agentData.error || sessionOptions.noDisplay;
      if (!sawProjectActivity) {
        finalizeAssistant(text, agentData.ok === false ? 'error' : 'done');
        return;
      }
      patchAssistant({ content: text });
      return;
    }
    if (event.type === 'text_segment' || event.type === 'thinking_segment' || event.type === 'system_info' || event.type === 'tool_use' || event.type === 'tool_result') {
      if (event.type === 'tool_use' || event.type === 'tool_result') sawProjectActivity = true;
      foldActivityEvent(event);
      return;
    }
    if (event.type === 'file_changed' && event.data?.paths?.length) {
      sawProjectActivity = true;
      const paths = event.data.paths.filter(Boolean);
      const cid = conversationIdRef.current || sessionOptions.requestConversationId;
      if (cid && paths.length > 0) {
        const merge = (sizes = new Map<string, number | undefined>()) => {
          workspace.setFileTree((current) => mergeFileTreeWrites(
            current,
            paths.map((path) => {
              const size = sizes.get(path);
              return { path, ...(typeof size === 'number' ? { size } : {}) };
            }),
          ));
        };
        void snapshot.pullFiles(cid, paths).then((files) => {
          merge(new Map(files.map((file) => [file.path, file.size])));
        }, () => {
          merge();
        }).finally(() => {
          if (!openedFirstFile && paths[0]) revealFirstFile(paths[0]);
        });
      } else if (!openedFirstFile && paths[0]) {
        pendingFirstFilePath = paths[0];
      }
      return;
    }
    if (event.type === 'file_tree' && event.data) {
      sawProjectActivity = true;
      workspace.setFileTree(event.data);
      if (pendingFirstFilePath) {
        revealFirstFile(pendingFirstFilePath);
      }
      return;
    }
    if (event.type === 'deployment_status' && event.data) {
      sawProjectActivity = true;
      workspace.setDeployment(event.data);
      return;
    }
    if (event.type === 'preview_ready' && event.data) {
      sawProjectActivity = true;
      if (gatewayKeyApplied) {
        workspace.setGatewaySavedVisible(false);
      }
      if (event.data.preview) {
        // Proof for the rest of this visit: the tab may be reopened, and the
        // lazy boot must treat this conversation as one that has a preview.
        workspace.setHasPublishedPreview(true);
        preview.activatePreview(event.data.preview, activatedPreviewRevisions);
        if (!workspace.resultPanelOpen) {
          workspace.setSandboxTab('preview');
          workspace.setUnseenPanel(false);
          workspace.setResultPanelOpen(true);
        }
      }
      if (event.data.download) {
        workspace.setDownload(event.data.download);
      }
      return;
    }
    if (event.type === 'error') {
      finalizeAssistant(event.error || sessionOptions.processingFailed, 'error');
      setLoading(false);
    }
  };

  const finish = () => {
    const ownsActiveWorkspace = workspaceEpoch === workspaceEpochRef.current
      && chatAbortControllerRef.current === requestAbortController;
    if (ownsActiveWorkspace) {
      if (!stoppingRef.current) {
        setMessages((current) =>
          settleRunningAssistant(current, assistantMessageId, sessionOptions.agentFlowEnded),
        );
      }
      setLoading(false);
      chatAbortControllerRef.current = null;
      if (!stoppingRef.current) {
        activeTurnIdRef.current = '';
      }
      stoppingRef.current = false;
    }
  };

  return { handleStreamEvent, finish, applyResponse, finalizeAssistant };
}

export async function attachChatStream(options: {
  requestConversationId: string;
  assistantMessageId: string;
  response: Response;
  abortController: AbortController;
  requestFailedPrefix: string;
  unknownError: string;
} & Omit<LiveChatSessionOptions, 'requestConversationId' | 'assistantMessageId' | 'abortController'>) {
  const session = createLiveChatSession(options);
  try {
    options.chatAbortControllerRef.current = options.abortController;
    options.stoppingRef.current = false;

    const contentType = options.response.headers.get('content-type') || '';
    if (!options.response.body || !contentType.includes('text/event-stream')) {
      session.applyResponse((await options.response.json().catch(() => ({
        ok: false,
        error: `${options.response.status}`,
      }))) as ChatResponse);
      return;
    }

    await consumeEventStream<ChatStreamEvent>(options.response, session.handleStreamEvent);
  } catch (error) {
    if ((error instanceof Error && error.name === 'AbortError') || options.stoppingRef.current) {
      return;
    }
    const msg = `${options.requestFailedPrefix}${error instanceof Error ? error.message : options.unknownError}`;
    session.finalizeAssistant(msg, 'error');
  } finally {
    session.finish();
  }
}
