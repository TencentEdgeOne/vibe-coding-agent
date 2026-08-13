'use client';

import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Code2,
  Copy,
  Download,
  ExternalLink,
  Eye,
  Laptop,
  MessageCircle,
  RefreshCw,
  Smartphone,
  Sparkles,
} from 'lucide-react';
import { sanitizeAssistantText } from '../agents/utils/_text';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import {
  AgentConversation,
  type AssistantActivity,
} from './components/agent-conversation';
import { FilesPanel } from './components/files-panel';
import { LanguageSwitch } from './components/language-switch';
import { useFileContentCache } from './hooks/use-file-content-cache';
import { useTypewriterPlaceholder } from './hooks/use-typewriter-placeholder';
import {
  CLAIM_DEPLOY_ENABLED,
  TENCENT_CLOUD_CONTACT_URL,
  TENCENT_CLOUD_DEPLOY_URL,
  base64ToBlob,
  cacheConversationId,
  createConversationId,
  createMessageId,
  extractProjectName,
  fetchResumeHistory,
  fetchResumePreview,
  fetchResumeWorkspace,
  getAssistantScrollSignature,
  getContactUrl,
  getDeployUrl,
  getOrCreateCachedConversationId,
  getStoredConversationId,
  sanitizeThinkingContent,
} from './lib/conversation';
import {
  PROCESS_STEP_REVEAL_DELAY_MS,
  appendOrUpdateProcessStep,
  appendOrUpdateProcessThinking,
  appendOrUpdateTimelineStep,
  appendPendingProcessSteps,
  classifyToolUse,
  countProcessSteps,
  getProcessStepForTimelineStep,
  normalizeTimelineSteps,
  relocalizeProcessEvents,
  shouldDelayProcessStepReveal,
} from './lib/process-timeline';
import { LANGUAGE_STORAGE_KEY, TRANSLATIONS, type Locale } from './i18n';
import type {
  AssistantStatus,
  BuildInfo,
  ChatMessage,
  ChatResponse,
  ChatStreamEvent,
  ChatTaskSubmission,
  FileTree,
  InitLog,
  LinkInfo,
  ProcessEvent,
  TimelineStep,
} from './types/workspace';

// Coming back to the tab does not need a fresh envdAccessToken every time: skip
// the re-mint when the last one is still recent.
const PREVIEW_REFRESH_MIN_INTERVAL_MS = 60_000;
// Below this hidden duration the loaded iframe keeps its session, so a fresh URL
// is stored for copy / open only and the frame is left untouched (no reload).
// Beyond it the token is likely dead, so reloading with a new one is the lesser evil.
const PREVIEW_STALE_AFTER_HIDDEN_MS = 10 * 60_000;

function isSamePreviewTarget(a: string, b: string) {
  try {
    const left = new URL(a);
    const right = new URL(b);
    return left.origin === right.origin && left.pathname === right.pathname;
  } catch {
    return false;
  }
}

export default function Home() {
  const [language, setLanguage] = useState<Locale>('zh');
  const [deployUrl, setDeployUrl] = useState(TENCENT_CLOUD_DEPLOY_URL);
  const [contactUrl, setContactUrl] = useState(TENCENT_CLOUD_CONTACT_URL);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [conversationId, setConversationId] = useState<string | null>(null);
  // Resume-on-load: rehydrate the last conversation's workspace after a refresh.
  // `resumeChecked` gates the first render. It MUST init to a constant (not from
  // localStorage): SSR has no localStorage, so deriving it there would mismatch the
  // client's first paint and trigger a hydration error. Start `true` (render home),
  // matching SSR — a first-time visitor then stays on home and never flashes the
  // "restoring…" screen. A returning visitor is switched to `false` inside the
  // client-only effect below (after hydration), which shows the restore screen
  // while /resume runs.
  const [resumeChecked, setResumeChecked] = useState(true);
  const [preview, setPreview] = useState<LinkInfo | null>(null);
  const [download, setDownload] = useState<LinkInfo | null>(null);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [build, setBuild] = useState<BuildInfo | null>(null);
  const [loading, setLoading] = useState(false);
  // Per-assistant-message progress expansion state. The running message is
  // expanded while active, then collapsed by default.
  const [openSteps, setOpenSteps] = useState<Record<string, boolean>>({});
  const [showProcessThinking, setShowProcessThinking] = useState(true);
  const [sandboxTab, setSandboxTab] = useState<'preview' | 'files'>('preview');
  const [previewViewport, setPreviewViewport] = useState<'desktop' | 'mobile'>('desktop');
  const [fileTree, setFileTree] = useState<FileTree | null>(null);
  const [filesRefreshing, setFilesRefreshing] = useState(false);
  // Path the Files panel should open (first generated file). Cleared on new project.
  const [filesFocusPath, setFilesFocusPath] = useState<string | null>(null);
  // Right preview/code panel stays closed until the first real file arrives (or resume).
  const [resultPanelOpen, setResultPanelOpen] = useState(false);
  // Slow resume stage: snapshot restore + npm install + preview restart.
  const [workspaceRestoring, setWorkspaceRestoring] = useState(false);
  const [newProjectConfirmOpen, setNewProjectConfirmOpen] = useState(false);
  const fileCache = useFileContentCache();
  const [activePreviewUrl, setActivePreviewUrl] = useState('');
  const [activePreviewRevision, setActivePreviewRevision] = useState(0);
  const [activePreviewLoaded, setActivePreviewLoaded] = useState(false);
  // Covers the remint window before the iframe remounts. Independent of
  // activePreviewLoaded so the 3s onLoad fallback cannot uncover an expired
  // token's AUTHENTICATION_FAILED response mid-refresh.
  const [previewRefreshing, setPreviewRefreshing] = useState(false);
  const [previewCopied, setPreviewCopied] = useState(false);
  const [pendingPreviewUrl, setPendingPreviewUrl] = useState('');
  const [pendingPreviewRevision, setPendingPreviewRevision] = useState(0);
  const conversationScrollRef = useRef<HTMLDivElement | null>(null);
  const activePreviewUrlRef = useRef('');
  const activePreviewRevisionRef = useRef(0);
  const previewRevisionRef = useRef(0);
  const previewRefreshInFlightRef = useRef(false);
  const previewHiddenAtRef = useRef(0);
  const previewRefreshedAtRef = useRef(0);
  const conversationIdRef = useRef<string | null>(null);
  const loadingRef = useRef(false);
  const workspaceRestoringRef = useRef(false);
  const hasLivePreviewRef = useRef(false);
  const processStepRevealTimersRef = useRef<Record<string, number>>({});
  const showProcessThinkingRef = useRef(true);
  const chatAbortControllerRef = useRef<AbortController | null>(null);
  const activeTurnIdRef = useRef('');
  const stoppingRef = useRef(false);
  // Resume-on-load reconnects to an in-flight run after history paints. The
  // effect closes over this ref so it always calls the latest stream attacher.
  const attachChatStreamRef = useRef<(options: {
    requestConversationId: string;
    assistantMessageId: string;
    isStartingFromHome: boolean;
    streamUrl: string;
  }) => Promise<void>>(async () => {});
  // Visibility / toolbar preview refresh — kept on a ref so the listener effect
  // can stay mount-only while still calling the latest implementation.
  const refreshPreviewLinkRef = useRef<(options?: {
    showLoading?: boolean;
    allowWorkspaceFallback?: boolean;
    remountIframe?: boolean;
  }) => Promise<boolean>>(async () => false);

  const t = TRANSLATIONS[language];
  const canSend = input.trim().length > 0 && !loading;
  // `preview.url` always carries the freshest access_token, while `activePreviewUrl`
  // is only what the iframe happens to be showing (deliberately left stale so a
  // token rotation does not reload the running app).
  const shareablePreviewUrl = preview?.url || activePreviewUrl;
  const hasWorkspace = messages.length > 0 || Boolean(preview) || Boolean(build) || workspaceRestoring;
  // Cycling typewriter placeholder for the landing prompt (see plan/design-mockup.html).
  // Reuses the localized example prompts; pauses while the field has text.
  const placeholderPhrases = useMemo(() => t.home.examples.map((example) => `${example}…`), [t]);
  const typedPlaceholder = useTypewriterPlaceholder(
    placeholderPhrases,
    !hasWorkspace && input.length === 0,
  );
  const latestAssistantMessage = messages.findLast((message) => message.role === 'assistant');
  const latestAssistantScrollSignature = latestAssistantMessage
    ? getAssistantScrollSignature(latestAssistantMessage)
    : '';
  const clearFileCache = fileCache.clear;
  useEffect(() => {
    clearFileCache();
  }, [clearFileCache, conversationId]);

  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);

  useEffect(() => {
    loadingRef.current = loading;
  }, [loading]);

  useEffect(() => {
    workspaceRestoringRef.current = workspaceRestoring;
  }, [workspaceRestoring]);

  useEffect(() => {
    hasLivePreviewRef.current = Boolean(preview?.url);
  }, [preview?.url]);

  // Every new file listing is the authoritative view of what is on disk, so use it
  // to stamp or drop cached file contents. Covers all three sources of a tree
  // (streamed file_tree, the final result, and /resume). Deliberately keyed on the
  // tree alone: reconciling on a cache write would stamp freshly streamed content
  // with the previous listing's mtime.
  const reconcileFileCache = fileCache.reconcile;
  useEffect(() => {
    reconcileFileCache(fileTree);
  }, [fileTree, reconcileFileCache]);

  useEffect(() => {
    const { domain } = extractProjectName();
    setDeployUrl(getDeployUrl(domain));
    setContactUrl(getContactUrl(domain));
  }, []);

  useEffect(() => {
    const stored = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (stored === 'zh' || stored === 'en') {
      setLanguage(stored);
    }
  }, []);

  useEffect(() => {
    // Progressive resume: paint chat history as soon as store data returns, then
    // bootstrap the sandbox (restore + npm install + preview) in the background.
    let cancelled = false;
    const existing = getStoredConversationId();
    if (!existing) {
      setConversationId(createConversationId());
      return;
    }

    setResumeChecked(false);
    setConversationId(existing);

    const applyHistory = (data: NonNullable<Awaited<ReturnType<typeof fetchResumeHistory>>>) => {
      const history = Array.isArray(data.messages) ? data.messages : [];
      const activeTask = data.activeTask;
      if (!data.hasProject && history.length === 0 && !activeTask) {
        return false;
      }
      if (data.conversation_id) {
        setConversationId(data.conversation_id);
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
              activities: turn.activities,
              status: turn.status === 'completed' ? 'done' as const : turn.status === 'failed' ? 'error' as const : 'stopped' as const,
            },
          ])
        : history.map((item) => ({
            id: createMessageId(item.role),
            role: item.role,
            content: item.content,
            status: 'done' as AssistantStatus,
          }));

      // In-flight turn is not in activityHistory yet. Merge it so refresh keeps
      // the user prompt visible and a running assistant slot ready for SSE replay.
      // Exception: /stop may already have persisted the turn while the chat task is
      // still marked running during unwind — merging again duplicates `${turnId}-user`.
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
                  thinkingContent: '',
                  processEvents: [],
                  activities: [],
                  status: 'running',
                  steps: [],
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
                  thinkingContent: '',
                  processEvents: [],
                  activities: [],
                  status: 'running',
                  steps: [],
                },
              ];
            }
          }
          setOpenSteps((current) => ({ ...current, [assistantId]: true }));
          activeTurnIdRef.current = assistantId;
          setLoading(true);
          setFilesRefreshing(true);
        }
      }

      // Last line of defense against duplicate React keys after stop/resume races.
      const seenIds = new Set<string>();
      nextMessages = nextMessages.filter((item) => {
        if (seenIds.has(item.id)) return false;
        seenIds.add(item.id);
        return true;
      });

      setMessages(nextMessages);
      if (data.hasProject || data.needsWorkspace || activeTask) {
        if (data.hasProject || data.needsWorkspace) {
          // If a preview was published before, stay on the preview pane and show
          // the restoring spinner while workspace resume restarts the server.
          // Otherwise show source first (interrupted / never-published projects).
          setSandboxTab(data.hasPreview ? 'preview' : 'files');
          setWorkspaceRestoring(true);
          setFilesRefreshing(true);
          setResultPanelOpen(true);
        }
      }
      return true;
    };

    const applyWorkspace = (data: NonNullable<Awaited<ReturnType<typeof fetchResumeWorkspace>>>) => {
      const hasFiles = Boolean(data.files?.items.some((item) => item.type === 'file'));
      if (data.files) {
        setFileTree(data.files);
      }
      if (hasFiles || data.preview?.url) {
        setResultPanelOpen(true);
      }
      if (data.download?.url) {
        setDownload(data.download);
      }
      if (data.preview?.url) {
        setPreview(data.preview);
        setSandboxTab('preview');
        previewRefreshedAtRef.current = Date.now();
        const revision = previewRevisionRef.current + 1;
        previewRevisionRef.current = revision;
        activePreviewUrlRef.current = data.preview.url;
        activePreviewRevisionRef.current = revision;
        setActivePreviewUrl(data.preview.url);
        setActivePreviewRevision(revision);
        setActivePreviewLoaded(false);
      } else {
        // No live preview on this resume — clear stale iframe state. Only then
        // fall back to the Files tab (do not steal the tab when preview is ready).
        setPreview(null);
        activePreviewUrlRef.current = '';
        activePreviewRevisionRef.current = 0;
        setActivePreviewUrl('');
        setActivePreviewRevision(0);
        setActivePreviewLoaded(false);
        if (hasFiles) {
          setSandboxTab('files');
        }
      }
    };

    (async () => {
      let handedOffToActiveStream = false;
      try {
        const historyData = await fetchResumeHistory(existing);
        if (cancelled) return;
        if (!historyData?.ok) {
          return;
        }
        applyHistory(historyData);
        // Unblock the UI as soon as chat history is available.
        setResumeChecked(true);

        const activeTask = historyData.activeTask;
        const conversationForRun = historyData.conversation_id || existing;

        // Reattach to the live SSE run before (or while) the slow workspace
        // restore runs. Generation keeps going after a refresh; this only
        // resubscribes the UI to buffered + live events.
        if (activeTask?.id && !cancelled) {
          handedOffToActiveStream = true;
          setFilesRefreshing(true);
          void attachChatStreamRef.current({
            requestConversationId: conversationForRun,
            assistantMessageId: activeTask.id,
            isStartingFromHome: false,
            streamUrl: activeTask.streamUrl
              || `/chat/stream?runId=${encodeURIComponent(activeTask.id)}`,
          });
        }

        if (!historyData.needsWorkspace && !historyData.hasProject) {
          return;
        }

        const workspaceData = await fetchResumeWorkspace(conversationForRun);
        if (cancelled) return;
        if (workspaceData?.ok) {
          applyWorkspace(workspaceData);
        }
      } catch {
        // Resume is best-effort; on failure the user just sees the home screen.
      } finally {
        if (!cancelled) {
          setResumeChecked(true);
          setWorkspaceRestoring(false);
          // Active stream owns the files spinner after handoff; otherwise clear it.
          if (!handedOffToActiveStream) {
            setFilesRefreshing(false);
          }
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Re-mint the iframe access_token when the tab becomes visible again, or when
  // the user hits refresh. The SPA keeps the old preview URL in memory; the
  // sandbox gateway rejects expired envdAccessToken with AUTHENTICATION_FAILED.
  useEffect(() => {
    const applyFreshPreviewUrl = (
      url: string,
      sandboxDebugUrl?: string,
      options?: { remountIframe?: boolean },
    ): boolean => {
      setPreview({ url, sandboxDebugUrl });
      previewRefreshedAtRef.current = Date.now();

      // Same host and path means only the token rotated. Reloading would throw
      // away the running app (route, scroll, form state), so keep the frame and
      // let copy / open / the next reload pick up the fresh URL from `preview`.
      if (
        options?.remountIframe === false
        && activePreviewUrlRef.current
        && isSamePreviewTarget(activePreviewUrlRef.current, url)
      ) {
        return false;
      }

      const revision = previewRevisionRef.current + 1;
      previewRevisionRef.current = revision;
      activePreviewUrlRef.current = url;
      activePreviewRevisionRef.current = revision;
      setActivePreviewUrl(url);
      setActivePreviewRevision(revision);
      setActivePreviewLoaded(false);
      setPendingPreviewUrl('');
      setPendingPreviewRevision(0);
      return true;
    };

    const refreshPreviewLink = async (options?: {
      showLoading?: boolean;
      allowWorkspaceFallback?: boolean;
      remountIframe?: boolean;
    }) => {
      const id = conversationIdRef.current;
      if (
        !id
        || !hasLivePreviewRef.current
        || loadingRef.current
        || workspaceRestoringRef.current
        || previewRefreshInFlightRef.current
      ) {
        return false;
      }

      previewRefreshInFlightRef.current = true;
      // Stamp the attempt, not just the success, so a dead sandbox is not probed
      // again on every tab switch.
      previewRefreshedAtRef.current = Date.now();

      const willRemount = options?.remountIframe !== false;
      const previousActiveUrl = activePreviewUrlRef.current;
      let remounted = false;

      if (options?.showLoading) {
        setPreviewRefreshing(true);
        setActivePreviewLoaded(false);
        // Drop the live frame immediately so an expired envdAccessToken cannot
        // paint AUTHENTICATION_FAILED under (or ahead of) the loading overlay
        // while /resume?stage=preview is in flight.
        if (willRemount && previousActiveUrl) {
          activePreviewUrlRef.current = '';
          setActivePreviewUrl('');
          setPendingPreviewUrl('');
          setPendingPreviewRevision(0);
        }
      }

      try {
        // Backend stage=preview remints the token on the existing host, and
        // escalates to full workspace restore when the sandbox has gone cold.
        const data = await fetchResumePreview(id);
        if (data?.ok && data.preview?.url) {
          remounted = applyFreshPreviewUrl(data.preview.url, data.preview.sandboxDebugUrl, {
            // A restarted dev server invalidates whatever the frame is showing,
            // so that case always reloads even when the caller asked not to.
            remountIframe: willRemount || data.preview.restarted === true,
          });
          if (data.files?.items?.length) {
            setFileTree(data.files);
          }
          if (data.download?.url) {
            setDownload(data.download);
          }
          return true;
        }
        if (options?.allowWorkspaceFallback) {
          const workspaceData = await fetchResumeWorkspace(id);
          if (workspaceData?.ok && workspaceData.preview?.url) {
            remounted = applyFreshPreviewUrl(
              workspaceData.preview.url,
              workspaceData.preview.sandboxDebugUrl,
            );
            if (workspaceData.files?.items?.length) {
              setFileTree(workspaceData.files);
            }
            if (workspaceData.download?.url) {
              setDownload(workspaceData.download);
            }
            return true;
          }
        }
        return false;
      } finally {
        previewRefreshInFlightRef.current = false;
        if (options?.showLoading) {
          setPreviewRefreshing(false);
          // Remint failed (or token-only update): put the previous frame back so
          // the panel is not left blank after the overlay drops.
          if (!remounted && previousActiveUrl && !activePreviewUrlRef.current) {
            activePreviewUrlRef.current = previousActiveUrl;
            setActivePreviewUrl(previousActiveUrl);
            setActivePreviewLoaded(true);
          } else if (!remounted) {
            setActivePreviewLoaded(true);
          }
        }
      }
    };

    refreshPreviewLinkRef.current = refreshPreviewLink;

    const onVisibility = () => {
      if (document.visibilityState !== 'visible') {
        previewHiddenAtRef.current = Date.now();
        return;
      }

      const hiddenFor = previewHiddenAtRef.current
        ? Date.now() - previewHiddenAtRef.current
        : 0;
      previewHiddenAtRef.current = 0;
      const wentStale = hiddenFor >= PREVIEW_STALE_AFTER_HIDDEN_MS;
      const sinceLastRefresh = Date.now() - previewRefreshedAtRef.current;
      if (!wentStale && sinceLastRefresh < PREVIEW_REFRESH_MIN_INTERVAL_MS) {
        return;
      }
      // Long-hidden tabs almost always have an expired access token. Cover the
      // frame and remount once the remint returns so users never stare at
      // AUTHENTICATION_FAILED for the duration of /resume.
      void refreshPreviewLink({
        remountIframe: wentStale,
        showLoading: wentStale,
      });
    };

    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      refreshPreviewLinkRef.current = async () => false;
    };
  }, []);

  useEffect(() => {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
    // 语言切换后，用每条消息保留的原始 steps 重刷已渲染的过程卡片文案。
    const copy = TRANSLATIONS[language].timeline;
    setMessages((current) =>
      current.map((item) =>
        item.steps && item.steps.length > 0
          ? {
              ...item,
              processEvents: relocalizeProcessEvents(item.processEvents ?? [], item.steps, copy),
            }
          : item,
      ),
    );
  }, [language]);

  useEffect(() => {
    showProcessThinkingRef.current = showProcessThinking;
  }, [showProcessThinking]);

  useEffect(() => {
    const container = conversationScrollRef.current;
    if (!container) {
      return;
    }
    container.scrollTop = container.scrollHeight;
  }, [messages.length, latestAssistantScrollSignature]);

  const promotePendingPreview = () => {
    if (!pendingPreviewUrl) {
      return;
    }
    activePreviewUrlRef.current = pendingPreviewUrl;
    activePreviewRevisionRef.current = pendingPreviewRevision;
    setActivePreviewUrl(pendingPreviewUrl);
    setActivePreviewRevision(pendingPreviewRevision);
    setActivePreviewLoaded(true);
    setPendingPreviewUrl('');
    setPendingPreviewRevision(0);
  };

  // Cross-origin iframe onLoad may not fire in some environments. Hide the
  // overlay after 3 seconds as a fallback to avoid a permanently blank preview.
  // Skip while a token remint is in flight — uncovering early would flash
  // AUTHENTICATION_FAILED from the expired frame.
  useEffect(() => {
    if (!activePreviewUrl || activePreviewLoaded || previewRefreshing) {
      return;
    }
    const timer = window.setTimeout(() => setActivePreviewLoaded(true), 3000);
    return () => window.clearTimeout(timer);
  }, [activePreviewUrl, activePreviewLoaded, activePreviewRevision, previewRefreshing]);

  // Keep the same fallback for the background iframe so the old preview is not
  // kept forever when onLoad does not fire.
  useEffect(() => {
    if (!pendingPreviewUrl) {
      return;
    }
    const timer = window.setTimeout(() => {
      activePreviewUrlRef.current = pendingPreviewUrl;
      activePreviewRevisionRef.current = pendingPreviewRevision;
      setActivePreviewUrl(pendingPreviewUrl);
      setActivePreviewRevision(pendingPreviewRevision);
      setActivePreviewLoaded(true);
      setPendingPreviewUrl('');
      setPendingPreviewRevision(0);
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [pendingPreviewUrl, pendingPreviewRevision]);

  async function attachChatStream(options: {
    requestConversationId: string;
    assistantMessageId: string;
    isStartingFromHome: boolean;
    streamUrl: string;
  }) {
    const {
      requestConversationId,
      assistantMessageId,
      isStartingFromHome,
      streamUrl,
    } = options;
    const activatedPreviewRevisions = new Map<string, number>();
    let sawProjectActivity = false;
    let insertedModifyMarker = false;
    // Expand the right panel and open a file only after the first real file arrives.
    // file_content seeds the path; the following file_tree mounts the panel so the
    // Files list is not empty. Do not open on tool_use — that fires before any bytes.
    let openedFirstFile = false;
    let pendingFirstFilePath: string | null = null;

    const revealFirstFile = (path: string) => {
      if (openedFirstFile || !path) return;
      openedFirstFile = true;
      pendingFirstFilePath = null;
      setFilesFocusPath(path);
      setSandboxTab('files');
      setResultPanelOpen(true);
    };

    const patchAssistant = (patch: Partial<ChatMessage>) => {
      setMessages((current) =>
        current.map((item) =>
          item.id === assistantMessageId ? { ...item, ...patch } : item,
        ),
      );
    };

    const clearProcessStepRevealTimer = () => {
      const timer = processStepRevealTimersRef.current[assistantMessageId];
      if (timer) {
        window.clearTimeout(timer);
        delete processStepRevealTimersRef.current[assistantMessageId];
      }
    };

    const scheduleProcessStepReveal = () => {
      clearProcessStepRevealTimer();
      processStepRevealTimersRef.current[assistantMessageId] = window.setTimeout(() => {
        delete processStepRevealTimersRef.current[assistantMessageId];
        setMessages((current) =>
          current.map((item) =>
            item.id === assistantMessageId
              ? {
                  ...item,
                  thinkingContent: '',
                  processEvents: appendPendingProcessSteps(
                    item.processEvents ?? [],
                    item.steps ?? [],
                    t.timeline,
                  ),
                }
              : item,
          ),
        );
      }, PROCESS_STEP_REVEAL_DELAY_MS);
    };

    const appendStep = (step: TimelineStep) => {
      setMessages((current) =>
        current.map((item) =>
          item.id === assistantMessageId
            ? (() => {
                const nextSteps = appendOrUpdateTimelineStep(item.steps ?? [], step);
                const previousProcessEvents = item.processEvents ?? [];
                const nextProcessEvents = appendOrUpdateProcessStep(
                  previousProcessEvents,
                  nextSteps,
                  step,
                  t.timeline,
                );
                const didAppendProcessStep = countProcessSteps(nextProcessEvents) > countProcessSteps(previousProcessEvents);
                if (showProcessThinkingRef.current && shouldDelayProcessStepReveal(previousProcessEvents, nextProcessEvents)) {
                  scheduleProcessStepReveal();
                  return {
                    ...item,
                    steps: nextSteps,
                  };
                }
                return {
                  ...item,
                  steps: nextSteps,
                  thinkingContent: didAppendProcessStep && !showProcessThinkingRef.current ? '' : item.thinkingContent,
                  processEvents: nextProcessEvents,
                };
              })()
            : item,
        ),
      );
    };

    const appendTextActivity = (text: string) => {
      setMessages((current) =>
        current.map((item) => {
          if (item.id !== assistantMessageId) {
            return item;
          }
          const nextText = sanitizeThinkingContent(text);
          if (!nextText) {
            return item;
          }
          const activities = [...(item.activities ?? [])];
          const last = activities.at(-1);
          if (last?.kind === 'text') {
            const trimmed = nextText.trim();
            // Immutable append + skip replayed/overlapping chunks so concurrent
            // setState updaters cannot double-paste the same suffix.
            if (
              last.content.endsWith(nextText)
              || (trimmed.length > 0 && last.content.endsWith(trimmed))
              || (trimmed.length > 24 && last.content.includes(trimmed))
            ) {
              return item;
            }
            activities[activities.length - 1] = {
              ...last,
              content: `${last.content}${nextText}`,
            };
          } else {
            activities.push({ kind: 'text', content: nextText });
          }
          return {
            ...item,
            activities,
          };
        }),
      );
    };

    const upsertToolActivity = (
      toolUseId: string,
      patch: Partial<Extract<AssistantActivity, { kind: 'tool' }>>,
    ) => {
      setMessages((current) => current.map((item) => {
        if (item.id !== assistantMessageId) return item;
        const activities = [...(item.activities ?? [])];
        const index = activities.findIndex(
          (activity) => activity.kind === 'tool' && activity.toolUseId === toolUseId,
        );
        if (index >= 0) {
          activities[index] = { ...activities[index], ...patch } as AssistantActivity;
        } else {
          activities.push({
            kind: 'tool',
            toolUseId,
            name: patch.name || '<unknown>',
            status: patch.status || 'running',
            inputSummary: patch.inputSummary,
            outputSummary: patch.outputSummary,
            startedAt: patch.startedAt || Date.now(),
            endedAt: patch.endedAt,
          });
        }
        return { ...item, activities };
      }));
    };

    const finalizeAssistant = (
      finalContent: string,
      finalStatus: AssistantStatus,
    ) => {
      clearProcessStepRevealTimer();
      setMessages((current) =>
        current.map((item) =>
          item.id === assistantMessageId
              ? {
                  ...item,
                  content: finalContent,
                  activities: (item.activities ?? []).map((activity) =>
                    activity.kind === 'tool' && activity.status === 'running'
                      ? {
                          ...activity,
                          status: finalStatus === 'stopped' ? 'stopped' as const : finalStatus === 'error' ? 'failed' as const : 'completed' as const,
                          endedAt: Date.now(),
                        }
                      : activity,
                  ),
                  thinkingContent: '',
                processEvents: appendPendingProcessSteps(item.processEvents ?? [], item.steps ?? [], t.timeline),
                status: finalStatus,
              }
            : item,
        ),
      );
      // Collapse progress by default when the stream ends. The running-phase
      // forced expansion is temporary.
      setOpenSteps((current) => ({ ...current, [assistantMessageId]: false }));
    };

    const activatePreview = (nextPreview: LinkInfo) => {
      if (!nextPreview.url) {
        if (nextPreview.error) {
          setPreview((current) =>
            current?.url
              ? {
                  ...nextPreview,
                  url: current.url,
                  sandboxDebugUrl: nextPreview.sandboxDebugUrl ?? current.sandboxDebugUrl,
                }
              : nextPreview,
          );
        }
        return;
      }

      setPreview(nextPreview);
      setSandboxTab('preview');
      setResultPanelOpen(true);
      previewRefreshedAtRef.current = Date.now();
      let revision = activatedPreviewRevisions.get(nextPreview.url);
      if (revision === undefined) {
        revision = previewRevisionRef.current + 1;
        previewRevisionRef.current = revision;
        activatedPreviewRevisions.set(nextPreview.url, revision);
      }

      if (!activePreviewUrlRef.current) {
        activePreviewUrlRef.current = nextPreview.url;
        activePreviewRevisionRef.current = revision;
        setActivePreviewUrl(nextPreview.url);
        setActivePreviewRevision(revision);
        setActivePreviewLoaded(false);
        setPendingPreviewUrl('');
        setPendingPreviewRevision(0);
        return;
      }

      if (
        activePreviewUrlRef.current === nextPreview.url
        && activePreviewRevisionRef.current === revision
      ) {
        return;
      }

      setPendingPreviewUrl(nextPreview.url);
      setPendingPreviewRevision(revision);
    };

    const applyResponse = (data: ChatResponse) => {
      if (data.conversation_id) {
        cacheConversationId(data.conversation_id);
        setConversationId(data.conversation_id);
      }
      if (data.preview) {
        activatePreview(data.preview);
      }
      if (data.download) {
        setDownload(data.download);
      }
      if (data.build) {
        setBuild(data.build);
      }
      if (data.files) {
        setFileTree(data.files);
        if (data.files.items.some((item) => item.type === 'file')) {
          setResultPanelOpen(true);
        }
      }
      setFilesRefreshing(false);

      const finalText = data.reply || data.error || t.response.noDisplay;
      const finalStatus: AssistantStatus = data.stopped ? 'stopped' : data.ok === false ? 'error' : 'done';
      finalizeAssistant(finalText, finalStatus);
    };

    const handleStreamEvent = (event: ChatStreamEvent) => {
      if (event.type === 'status' && event.message) {
        return;
      }
      if (event.type === 'ping') return;
      if (event.type === 'result' && event.data) {
        applyResponse(event.data);
        return;
      }
      if (event.type === 'agent' && event.data) {
        const agentData = event.data;
        const text = agentData.reply || agentData.error || t.response.noDisplay;
        // agent events can arrive before the final aggregate result with build
        // and preview data. For plain Q&A without project tool activity, the
        // agent event is already complete and can finish the frontend wait state.
        // If project tools ran, keep the message running until result finalizes it.
        if (!sawProjectActivity) {
          finalizeAssistant(text, agentData.ok === false ? 'error' : 'done');
          return;
        }
        patchAssistant({ content: text });
        return;
      }
      if (event.type === 'text_segment' && event.data?.text) {
        appendTextActivity(event.data.text);
        return;
      }
      if (event.type === 'tool_use' && event.data) {
        sawProjectActivity = true;
        const toolUseStep: TimelineStep = {
          kind: 'tool_use',
          id: event.data.id || '',
          name: event.data.name || '<unknown>',
          command: event.data.command,
          phaseHint: event.data.phaseHint,
          fileCount: event.data.fileCount,
        };
        const classification = classifyToolUse(toolUseStep, t.timeline);
        if (!isStartingFromHome && !insertedModifyMarker && classification?.phase === 'code') {
          appendStep({ kind: 'modify_marker' });
          insertedModifyMarker = true;
        }
        upsertToolActivity(toolUseStep.id, {
          name: toolUseStep.name,
          status: 'running',
          inputSummary: event.data.inputSummary || event.data.command,
          startedAt: event.data.startedAt,
        });
        return;
      }
      if (event.type === 'tool_result' && event.data) {
        sawProjectActivity = true;
        upsertToolActivity(event.data.tool_use_id || '', {
          name: event.data.toolName || '<unknown>',
          status: event.data.status || (event.data.ok === false ? 'failed' : 'completed'),
          outputSummary: event.data.outputSummary || event.data.preview,
          endedAt: event.data.endedAt || Date.now(),
        });
        return;
      }
      if (event.type === 'file_content' && event.data?.path) {
        // The agent just wrote this file and handed us the text, so seed the cache
        // now; the file_tree event that follows stamps it with the sandbox mtime
        // and is what actually expands the right panel.
        const content = event.data.content || '';
        fileCache.write(event.data.path, {
          content,
          size: typeof event.data.size === 'number' ? event.data.size : content.length,
          truncated: false,
        });
        if (!openedFirstFile) {
          pendingFirstFilePath = event.data.path;
        }
        return;
      }
      if (event.type === 'file_tree' && event.data) {
        sawProjectActivity = true;
        setFileTree(event.data);
        setFilesRefreshing(false);
        if (pendingFirstFilePath) {
          revealFirstFile(pendingFirstFilePath);
        }
        return;
      }
      if (event.type === 'preview_ready' && event.data) {
        sawProjectActivity = true;
        if (event.data.preview) {
          activatePreview(event.data.preview);
        }
        if (event.data.download) {
          setDownload(event.data.download);
        }
        return;
      }
      if (event.type === 'error') {
        finalizeAssistant(event.error || t.response.processingFailed, 'error');
        return;
      }
      if (event.type === 'log' && event.message) {
        sawProjectActivity = true;
      }
    };

    try {
      const requestAbortController = new AbortController();
      chatAbortControllerRef.current = requestAbortController;
      stoppingRef.current = false;

      const response = await fetch(streamUrl, {
        method: 'GET',
        headers: {
          conversationId: requestConversationId,
          'makers-conversation-id': requestConversationId,
        },
        signal: requestAbortController.signal,
      });

      const contentType = response.headers.get('content-type') || '';
      if (!response.body || !contentType.includes('text/event-stream')) {
        applyResponse((await response.json().catch(() => ({
          ok: false,
          error: `${response.status}`,
        }))) as ChatResponse);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let streamDone = false;

      while (!streamDone) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() || '';

        for (const frame of frames) {
          const data = frame
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (!data) {
            continue;
          }
          if (data === '[DONE]') {
            streamDone = true;
            break;
          }
          handleStreamEvent(JSON.parse(data) as ChatStreamEvent);
        }
      }

      buffer += decoder.decode();
      if (buffer.trim()) {
        const data = buffer
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data && data !== '[DONE]') {
          handleStreamEvent(JSON.parse(data) as ChatStreamEvent);
        }
      }
    } catch (error) {
      if ((error instanceof Error && error.name === 'AbortError') || stoppingRef.current) {
        return;
      }
      const msg = `${t.response.requestFailedPrefix}${error instanceof Error ? error.message : t.response.unknownError}`;
      appendStep({ kind: 'error', text: msg });
      finalizeAssistant(msg, 'error');
    } finally {
      clearProcessStepRevealTimer();
      // Fallback only when the stream died unexpectedly. Stop/abort already set a
      // terminal status; overwriting it would hide an in-flight reconnect.
      if (!stoppingRef.current) {
        setMessages((current) =>
          current.map((item) =>
            item.id === assistantMessageId && item.status === 'running'
              ? {
                  ...item,
                  status: 'done',
                  content: item.content || t.response.agentFlowEnded,
                  thinkingContent: '',
                  processEvents: appendPendingProcessSteps(item.processEvents ?? [], item.steps ?? [], t.timeline),
                }
              : item,
          ),
        );
      }
      setOpenSteps((current) => {
        if (current[assistantMessageId] === false) return current;
        return { ...current, [assistantMessageId]: false };
      });
      setLoading(false);
      setFilesRefreshing(false);
      chatAbortControllerRef.current = null;
      if (!stoppingRef.current) {
        activeTurnIdRef.current = '';
      }
      stoppingRef.current = false;
    }
  }


  attachChatStreamRef.current = attachChatStream;

  async function sendMessage(message: string) {
    const trimmed = message.trim();
    if (!trimmed || loading) {
      return;
    }

    const isStartingFromHome = !hasWorkspace;
    const requestConversationId = isStartingFromHome
      ? createConversationId()
      : conversationId || getOrCreateCachedConversationId();
    if (isStartingFromHome) {
      cacheConversationId(requestConversationId);
      setConversationId(requestConversationId);
      setPreview(null);
      setDownload(null);
      setBuild(null);
      setFileTree(null);
      setFilesRefreshing(false);
      setFilesFocusPath(null);
      setResultPanelOpen(false);
      setWorkspaceRestoring(false);
      setSandboxTab('preview');
      activePreviewUrlRef.current = '';
      activePreviewRevisionRef.current = 0;
      previewRevisionRef.current = 0;
      setActivePreviewUrl('');
      setActivePreviewRevision(0);
      setActivePreviewLoaded(false);
      setPendingPreviewUrl('');
      setPendingPreviewRevision(0);
    } else if (!conversationId) {
      setConversationId(requestConversationId);
    }

    const userMessageId = createMessageId('user');
    const assistantMessageId = createMessageId('assistant');
    activeTurnIdRef.current = assistantMessageId;

    setMessages((current) => [
      ...current,
      { id: userMessageId, role: 'user', content: trimmed },
      {
        id: assistantMessageId,
        role: 'assistant',
        content: '',
        thinkingContent: '',
        processEvents: [],
        activities: [],
        status: 'running',
        steps: [],
      },
    ]);
    // Expand the running message by default while preserving older turn states.
    setOpenSteps((current) => ({ ...current, [assistantMessageId]: true }));
    setFilesRefreshing(true);
    setInput('');
    setLoading(true);

    try {
      const requestAbortController = new AbortController();
      chatAbortControllerRef.current = requestAbortController;
      stoppingRef.current = false;
      const submitResponse = await fetch('/chat', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          conversationId: requestConversationId,
          'makers-conversation-id': requestConversationId,
        },
        body: JSON.stringify({
          message: trimmed,
          turnId: assistantMessageId,
          ...(isStartingFromHome ? { resetProject: true } : {}),
        }),
        signal: requestAbortController.signal,
      });

      const submission = await submitResponse.json().catch(() => null) as ChatTaskSubmission | null;
      if (!submitResponse.ok || !submission?.ok || !submission.runId) {
        const errorText = submission?.error || `${submitResponse.status}`;
        setMessages((current) =>
          current.map((item) =>
            item.id === assistantMessageId
              ? {
                  ...item,
                  content: errorText,
                  status: 'error' as AssistantStatus,
                }
              : item,
          ),
        );
        setLoading(false);
        setFilesRefreshing(false);
        chatAbortControllerRef.current = null;
        activeTurnIdRef.current = '';
        return;
      }

      if (submission.conversation_id) {
        cacheConversationId(submission.conversation_id);
        setConversationId(submission.conversation_id);
      }

      const streamUrl = submission.streamUrl
        || `/chat/stream?runId=${encodeURIComponent(submission.runId)}`;
      await attachChatStream({
        requestConversationId: submission.conversation_id || requestConversationId,
        assistantMessageId,
        isStartingFromHome,
        streamUrl,
      });
    } catch (error) {
      if ((error instanceof Error && error.name === 'AbortError') || stoppingRef.current) {
        setLoading(false);
        setFilesRefreshing(false);
        chatAbortControllerRef.current = null;
        activeTurnIdRef.current = '';
        stoppingRef.current = false;
        return;
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
      setFilesRefreshing(false);
      chatAbortControllerRef.current = null;
      activeTurnIdRef.current = '';
      stoppingRef.current = false;
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await sendMessage(input);
  }

  async function handleStop() {
    const cid = conversationId;
    if (!loading || !cid || stoppingRef.current) return;
    stoppingRef.current = true;
    const stoppedText = language === 'zh'
      ? '已停止本次生成，你可以继续描述下一步修改。'
      : 'Generation stopped. You can continue with another change.';
    setMessages((current) => current.map((item, index) => {
      if (index !== current.length - 1 || item.role !== 'assistant' || item.status !== 'running') return item;
      return {
        ...item,
        content: stoppedText,
        status: 'stopped',
        activities: (item.activities ?? []).map((activity) =>
          activity.kind === 'tool' && activity.status === 'running'
            ? { ...activity, status: 'stopped' as const, endedAt: Date.now() }
            : activity,
        ),
      };
    }));
    setLoading(false);
    setFilesRefreshing(false);

    const currentAssistant = [...messages].reverse().find((item) => item.role === 'assistant' && item.status === 'running');
    const currentUser = [...messages].reverse().find((item) => item.role === 'user');
    const stoppedActivities = (currentAssistant?.activities ?? []).map((activity) =>
      activity.kind === 'tool' && activity.status === 'running'
        ? { ...activity, status: 'stopped' as const, endedAt: Date.now() }
        : activity,
    );
    const stoppedTurn = {
      id: activeTurnIdRef.current,
      user: currentUser?.content || '',
      assistant: stoppedText,
      status: 'stopped',
      createdAt: Date.now(),
      activities: stoppedActivities,
    };

    const stopRequest = (async () => {
      const request = (headers: HeadersInit) => fetch('/stop', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          conversation_id: cid,
          turn: stoppedTurn,
        }),
      });
      const response = await request({ 'content-type': 'application/json' });
      if (response.status !== 400) return response;
      const error = await response.clone().json().catch(() => null) as { code?: string } | null;
      if (error?.code !== 'AGENT_CONVERSATION_ID_REQUIRED') return response;
      // Older local Makers runtimes validate every agent route before reading the
      // stop body. Retry with the header there; current production runtimes use
      // the body-only request above so cancellation is not sticky-routed.
      return request({
        'content-type': 'application/json',
        'makers-conversation-id': cid,
      });
    })().catch(() => null);
    chatAbortControllerRef.current?.abort();
    await stopRequest;
  }

  async function handleDownload() {
    if (!download?.url || downloadBusy) {
      return;
    }
    setDownloadBusy(true);
    setDownload((current) => (current ? { ...current, error: undefined } : current));
    try {
      // /download must hit the same sandbox the project lives in; sticky routing
      // keys off the conversation id header, so send it like /file and /chat do
      // (a plain <a download> could not set this header).
      const headers: HeadersInit = {};
      const cid = conversationId || getOrCreateCachedConversationId();
      if (cid) {
        headers['makers-conversation-id'] = cid;
        headers['conversationId'] = cid;
      }
      const resp = await fetch(download.url, { method: 'GET', headers });
      const data = (await resp.json().catch(() => null)) as
        | { ok?: boolean; base64?: string; filename?: string; contentType?: string; error?: string }
        | null;
      if (!resp.ok || !data?.ok || !data.base64) {
        const message = data?.error || `${resp.status}`;
        setDownload((current) => (current ? { ...current, error: message } : current));
        return;
      }
      const blob = base64ToBlob(data.base64, data.contentType || 'application/zip');
      const filename = data.filename || download.filename || 'source.zip';
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch (error) {
      const message = error instanceof Error ? error.message : t.workspace.downloadFailed;
      setDownload((current) => (current ? { ...current, error: message } : current));
    } finally {
      setDownloadBusy(false);
    }
  }

  // Placeholder for "claim deployment" (plan §3.1). Until the platform drop/claim API
  // is ready, this opens the EdgeOne console (plan's option A: finish the claim there).
  function handleClaimDeploy() {
    window.open(deployUrl, '_blank', 'noreferrer');
  }

  function handleRefreshPreview() {
    if (!activePreviewUrlRef.current) {
      return;
    }
    void (async () => {
      const refreshed = await refreshPreviewLinkRef.current({
        showLoading: true,
        allowWorkspaceFallback: true,
      });
      if (refreshed) {
        return;
      }
      // Last resort: reload the current iframe src (same token). Prefer the
      // resume paths above — they mint a fresh envdAccessToken.
      const revision = previewRevisionRef.current + 1;
      previewRevisionRef.current = revision;
      activePreviewRevisionRef.current = revision;
      setActivePreviewRevision(revision);
      setActivePreviewLoaded(false);
    })();
  }

  function handleOpenPreview() {
    if (shareablePreviewUrl) {
      window.open(shareablePreviewUrl, '_blank', 'noopener,noreferrer');
    }
  }

  async function handleCopyPreviewUrl() {
    if (!shareablePreviewUrl || !navigator.clipboard) {
      return;
    }
    try {
      await navigator.clipboard.writeText(shareablePreviewUrl);
      setPreviewCopied(true);
      window.setTimeout(() => setPreviewCopied(false), 1600);
    } catch {
      setPreviewCopied(false);
    }
  }

  // Start a fresh project. Needed because resume-on-load means a refresh no longer
  // clears the workspace, so this is the explicit way back to an empty home screen
  // with a brand-new conversation.
  function startNewProject() {
    const next = createConversationId();
    cacheConversationId(next);
    setConversationId(next);
    setMessages([]);
    setPreview(null);
    setDownload(null);
    setBuild(null);
    setFileTree(null);
    setFilesRefreshing(false);
    setFilesFocusPath(null);
    setResultPanelOpen(false);
    setWorkspaceRestoring(false);
    setSandboxTab('preview');
    setPreviewViewport('desktop');
    activePreviewUrlRef.current = '';
    activePreviewRevisionRef.current = 0;
    previewRevisionRef.current = 0;
    setActivePreviewUrl('');
    setActivePreviewRevision(0);
    setActivePreviewLoaded(false);
    setPendingPreviewUrl('');
    setPendingPreviewRevision(0);
    setPreviewCopied(false);
    setInput('');
  }

  function handleNewProject() {
    if (loadingRef.current) {
      setNewProjectConfirmOpen(true);
      return;
    }
    startNewProject();
  }

  async function confirmNewProject() {
    setNewProjectConfirmOpen(false);
    if (loadingRef.current) {
      await handleStop();
    }
    startNewProject();
  }

  // Hold the first paint until the resume check resolves, so a returning user does
  // not see the home screen flash before their project is restored.
  if (!resumeChecked) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-4 text-foreground">
        <span
          className="size-8 animate-spin rounded-full border-2 border-primary/30 border-t-primary"
          aria-hidden="true"
        />
        <p className="text-sm text-muted-foreground">{t.workspace.resuming}</p>
      </main>
    );
  }

  return (
    <main
      className={`flex flex-col text-foreground ${
        hasWorkspace ? 'h-screen overflow-hidden' : 'min-h-screen'
      }`}
    >
      <header className="site-topbar">
        <div className="site-brand" aria-label="MAKERS VIBE CODING">MAKERS VIBE CODING</div>
        <div className="site-topbar-actions">
          {!hasWorkspace && (
            <LanguageSwitch
              language={language}
              onChange={setLanguage}
              ariaLabel={t.languageToggleAria}
              className="site-language"
            />
          )}
          {hasWorkspace && download?.url && (
            <button
              type="button"
              onClick={handleDownload}
              disabled={downloadBusy}
              className="site-icon-button"
              aria-label={downloadBusy ? t.workspace.downloading : t.workspace.downloadSource}
              title={downloadBusy ? t.workspace.downloading : t.workspace.downloadSource}
            >
              {downloadBusy ? <span className="size-4 animate-spin rounded-full border-2 border-transparent border-t-current" /> : <Download />}
            </button>
          )}
          {hasWorkspace && (
            <button type="button" onClick={handleNewProject} className="site-secondary-button">
              {t.workspace.newProject}
            </button>
          )}
          {hasWorkspace && CLAIM_DEPLOY_ENABLED && (
            <button type="button" onClick={handleClaimDeploy} className="site-secondary-button">
              {t.deployLabel}
            </button>
          )}
          <Dialog>
            <DialogTrigger asChild>
              <Button size="sm" className="h-7 px-3 text-xs">
                {language === 'zh' ? '联系我们' : 'Contact'}
              </Button>
            </DialogTrigger>
            <DialogContent
              className="contact-dialog"
              overlayClassName="contact-dialog-overlay"
              showCloseButton={false}
            >
              <DialogHeader>
                <div className="contact-dialog-icon" aria-hidden="true">
                  <MessageCircle />
                </div>
                <DialogTitle>{language === 'zh' ? '集成平台化部署能力' : 'Integrate deployment capabilities'}</DialogTitle>
                <DialogDescription>
                  {language === 'zh'
                    ? '希望把代码生成、实时预览与全球加速部署能力集成到你自己的产品中？我们提供开放 API 与专属技术支持，可根据你的业务场景定制接入方案。欢迎与我们联系，一起聊聊具体需求。'
                    : "Want to bring code generation, live preview, and globally accelerated deployment into your own product? We provide open APIs and dedicated technical support tailored to your business needs. Get in touch and let's talk."}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter className="contact-dialog-footer">
                <DialogClose asChild>
                  <Button variant="outline">{language === 'zh' ? '取消' : 'Cancel'}</Button>
                </DialogClose>
                <Button asChild>
                  <a href={contactUrl} target="_blank" rel="noreferrer">
                    {language === 'zh' ? '联系我们' : 'Contact us'}
                  </a>
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </header>
      <Dialog open={newProjectConfirmOpen} onOpenChange={setNewProjectConfirmOpen}>
        <DialogContent
          className="contact-dialog"
          overlayClassName="contact-dialog-overlay"
          showCloseButton={false}
        >
          <DialogHeader>
            <DialogTitle>{t.workspace.newProjectConfirmTitle}</DialogTitle>
            <DialogDescription>{t.workspace.newProjectConfirmDescription}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="contact-dialog-footer">
            <DialogClose asChild>
              <Button variant="outline">{t.workspace.newProjectConfirmCancel}</Button>
            </DialogClose>
            <Button onClick={() => void confirmNewProject()}>
              {t.workspace.newProjectConfirmContinue}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {!hasWorkspace && (
        <section className="home-stage flex flex-1 flex-col items-center justify-center px-6 py-12 text-center">
          <div className="w-full max-w-[820px]">
            <h1 className="text-[clamp(2rem,4vw,2.75rem)] font-bold leading-[1.18]">
              {t.home.titleBefore}
              {language === 'en' ? ' ' : ''}
              <span className="text-primary">{t.home.titleAccent}</span>
              {language === 'en' ? ' ' : ''}
              {t.home.titleAfter}
            </h1>
            <p className="mt-3 text-[15px] text-muted-foreground">
              {t.home.subtitle}
            </p>

            <Card className="mt-8 gap-0 rounded-[10px] border-border p-4 text-left shadow-none transition-[border-color,box-shadow] focus-within:border-primary focus-within:shadow-[0_0_0_3px_rgba(47,107,255,0.12)]">
              <form onSubmit={handleSubmit}>
                <Textarea
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => {
                    // 输入法合成中（如中文选词）按回车只用于选中候选词，不应提交。
                    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      void sendMessage(input);
                    }
                  }}
                  placeholder={typedPlaceholder || t.home.placeholder}
                  rows={3}
                  className="min-h-[104px] resize-none border-0 bg-transparent px-1 py-1 text-[14px] leading-relaxed shadow-none focus-visible:ring-0"
                />
                <div className="mt-3 flex items-center gap-2.5">
                  <button
                    type="submit"
                    disabled={!canSend}
                    aria-label={t.home.fastBuild}
                    className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-4 text-xs font-semibold text-primary-foreground transition-colors hover:bg-[var(--brand-deep)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {loading ? (
                      <span className="size-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                    ) : (
                      <Sparkles className="size-4" />
                    )}
                    {t.home.fastBuild}
                  </button>
                </div>
              </form>
            </Card>

            <div className="mt-5 flex flex-wrap justify-center gap-2.5">
              {t.home.examples.map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => setInput(example)}
                  className="rounded-lg border border-border bg-card px-3.5 py-1.5 text-[12px] text-secondary-foreground transition-colors hover:border-primary/45 hover:bg-accent hover:text-accent-foreground"
                >
                  {example}
                </button>
              ))}
            </div>
          </div>
        </section>
      )}

      <section
        className={`min-h-0 min-w-0 w-full flex-1 ${
          hasWorkspace
            ? `workspace-shell${resultPanelOpen ? '' : ' is-chat-only'}`
            : 'hidden'
        }`}
      >
        <AgentConversation
          messages={messages}
          input={input}
          loading={loading}
          canSend={canSend}
          compact
          copy={{
            agentName: t.workspace.agentName,
            you: t.workspace.you,
            running: t.workspace.activityRunning,
            completed: t.workspace.activityCompleted,
            failed: t.workspace.activityFailed,
            stopped: t.workspace.activityStopped,
            input: t.workspace.activityInput,
            output: t.workspace.activityOutput,
            workedFor: t.workspace.workedFor,
            placeholder: t.workspace.changePlaceholder,
            send: t.workspace.send,
            stop: t.workspace.stop,
            toolActions: t.workspace.toolActions,
          }}
          onInputChange={setInput}
          onSubmit={() => void sendMessage(input)}
          onStop={() => void handleStop()}
        />

        {/* ===== RIGHT: preview / files — mounts after the first written file ===== */}
        {resultPanelOpen && <div className="workspace-result-panel">
          <div className="workspace-topbar">
            <Tabs
              value={sandboxTab}
              onValueChange={(value) => setSandboxTab(value as 'preview' | 'files')}
              className="workspace-topbar-tabs"
            >
              <TabsList className="workspace-tabs">
                <TabsTrigger value="preview" className="workspace-tab">
                  <Eye />
                  {t.workspace.preview}
                </TabsTrigger>
                <TabsTrigger value="files" className="workspace-tab">
                  <Code2 />
                  {t.workspace.code}
                  {filesRefreshing && <span className="workspace-tab-refreshing">{t.files.refreshing}</span>}
                </TabsTrigger>
              </TabsList>
            </Tabs>

            <div className="workspace-topbar-center">
              {sandboxTab === 'preview' && shareablePreviewUrl && (
                <button
                  type="button"
                  onClick={handleCopyPreviewUrl}
                  className={`workspace-url-chip ${activePreviewLoaded && !previewRefreshing ? 'is-ready' : ''}`}
                  title={previewCopied ? t.workspace.previewUrlCopied : t.workspace.copyPreviewUrl}
                >
                  <span className="workspace-panel-status-dot" aria-hidden="true" />
                  <span>{shareablePreviewUrl.replace(/^https?:\/\//, '')}</span>
                  {previewCopied ? <Check /> : <Copy />}
                </button>
              )}
            </div>

            <div className="workspace-topbar-actions">
              {sandboxTab === 'preview' && shareablePreviewUrl && (
                <>
                  <div className="workspace-viewport-switch" role="group" aria-label="Viewport">
                    <button
                      type="button"
                      aria-pressed={previewViewport === 'desktop'}
                      onClick={() => setPreviewViewport('desktop')}
                      title="Desktop"
                    >
                      <Laptop />
                    </button>
                    <button
                      type="button"
                      aria-pressed={previewViewport === 'mobile'}
                      onClick={() => setPreviewViewport('mobile')}
                      title="Mobile"
                    >
                      <Smartphone />
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={handleRefreshPreview}
                    className="workspace-icon-button"
                    aria-label={t.workspace.refreshPreview}
                    data-tooltip={t.workspace.refreshPreview}
                  >
                    <RefreshCw className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={handleOpenPreview}
                    className="workspace-icon-button"
                    aria-label={t.workspace.openPreview}
                    data-tooltip={t.workspace.openPreview}
                  >
                    <ExternalLink className="size-3.5" />
                  </button>
                </>
              )}
            </div>
          </div>

          <div className="workspace-panel-content">
            {/* The preview pane stays mounted and is only hidden behind the Code tab:
                unmounting the iframe would reload the sandbox app (and lose its route,
                scroll position and form state) on every tab switch. */}
            <div className={`workspace-panel-pane ${sandboxTab === 'preview' ? '' : 'is-hidden'}`}>
              {preview?.url ? (
                <div className={`workspace-preview-shell is-${previewViewport}`}>
                  <div className="workspace-preview-stage">
                  <div className="workspace-preview-frame">
                    {(!activePreviewLoaded || previewRefreshing) && (
                      <div className="workspace-preview-loading">
                        {t.workspace.loadingPreview}
                      </div>
                    )}
                    {activePreviewUrl && (
                      <iframe
                        key={`${activePreviewUrl}:${activePreviewRevision}`}
                        title="sandbox-preview"
                        src={activePreviewUrl}
                        onLoad={() => {
                          if (!previewRefreshInFlightRef.current) {
                            setActivePreviewLoaded(true);
                          }
                        }}
                        className="h-full w-full border-0"
                      />
                    )}
                    {pendingPreviewUrl && (
                      <iframe
                        key={`pending:${pendingPreviewUrl}:${pendingPreviewRevision}`}
                        title="sandbox-preview-pending"
                        src={pendingPreviewUrl}
                        onLoad={promotePendingPreview}
                        className="invisible pointer-events-none absolute inset-0 h-full w-full border-0"
                      />
                    )}
                  </div>
                  </div>
                </div>
              ) : (
                <div className="workspace-empty-state">
                  {workspaceRestoring ? (
                    <>
                      <span
                        className="size-8 animate-spin rounded-full border-2 border-primary/30 border-t-primary"
                        aria-hidden="true"
                      />
                      <p>{t.workspace.restoringWorkspace}</p>
                      <p className="max-w-xl text-xs leading-5 text-muted-foreground">
                        {t.workspace.previewStarting}
                      </p>
                    </>
                  ) : (
                    <>
                      <p>{t.workspace.previewEmpty}</p>
                      <p className="workspace-empty-disclaimer">
                        {t.workspace.constructionDisclaimer}
                      </p>
                    </>
                  )}
                </div>
              )}
            </div>

            {sandboxTab === 'files' && (
              <div className="workspace-panel-pane">
                <FilesPanel
                  tree={fileTree}
                  refreshing={filesRefreshing || workspaceRestoring}
                  conversationId={conversationId}
                  copy={t.files}
                  cache={fileCache}
                  focusPath={filesFocusPath}
                />
              </div>
            )}
          </div>

          {(build?.status === 'failed' || download?.error || preview?.error) && (
            <div className="workspace-error-bar">
              {build?.status === 'failed' && (
                <p className="text-destructive">
                  {build.autoFixApplied && build.autoFixAttempts
                    ? t.workspace.buildFailedAfter(build.autoFixAttempts)
                    : t.workspace.buildFailedMessage}
                </p>
              )}
              {preview?.error && (
                <p>
                  {t.workspace.previewError}
                  {preview.error}
                </p>
              )}
              {download?.error && (
                <p>
                  {t.workspace.downloadError}
                  {download.error}
                </p>
              )}
            </div>
          )}
        </div>}
      </section>
    </main>
  );
}
