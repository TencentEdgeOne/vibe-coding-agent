'use client';

import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Code2,
  Copy,
  ExternalLink,
  Eye,
  Laptop,
  RefreshCw,
  Smartphone,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AgentConversation } from '@/app/components/agent-conversation';
import { FilesPanel } from '@/app/components/files-panel';
import {
  appendNarrationChunk,
  dropTrailingSummaryEcho,
} from '@/app/lib/tool-activity';
import { useFileContentCache } from '@/app/hooks/use-file-content-cache';
import { useTypewriterPlaceholder } from '@/app/hooks/use-typewriter-placeholder';
import {
  CLAIM_DEPLOY_ENABLED,
  TENCENT_CLOUD_CONTACT_URL,
  TENCENT_CLOUD_DEPLOY_URL,
  base64ToBlob,
  cacheConversationId,
  clearCachedConversationId,
  createConversationId,
  createMessageId,
  downloadTextFile,
  extractProjectName,
  getContactUrl,
  getDeployUrl,
  getOrCreateCachedConversationId,
  getStoredConversationId,
  sanitizeThinkingContent,
} from '@/app/lib/conversation';
import { LANGUAGE_STORAGE_KEY, TRANSLATIONS, type Locale } from '@/app/i18n';
import { isMakersDeployUrl } from '../../../shared/makers-deploy';
import { conversationExportFilename } from '../../../shared/conversation-export';
import type {
  AssistantActivity,
  AssistantStatus,
  BuildInfo,
  ChatMessage,
  ChatResponse,
  ChatStreamEvent,
  DeploymentInfo,
  FileTree,
  LinkInfo,
  ResumeData,
  ResumeStreamEvent,
} from '@/app/types/workspace';
import { HomeStage } from './components/home-stage';
import { DeploymentStatus } from './components/deployment-status';
import { SiteHeader } from './components/site-header';
import { consumeEventStream } from './sse';
import {
  fetchChatTaskStream,
  fetchConversationTranscript,
  fetchProjectArchive,
  fetchResumePreview,
  openResumeStream,
  startChatTask,
  stopChatTask,
} from './workspace-api';

// Refresh before the sandbox credential is likely to expire. A gateway auth
// response is a JSON document, so it must never be allowed to replace the user
// preview inside the iframe.
const PREVIEW_CREDENTIAL_REFRESH_MS = 8 * 60_000;
const PREVIEW_REFRESH_POLL_MS = 60_000;

// Sandbox port 9000 publishes generated applications under this fixed prefix.
// The UI hides it so the address chip still represents the application route.
const PREVIEW_PATH_PREFIX = '/preview/';

// Render the mirrored pathname[+search][+hash] relative to the application root.
// Root URLs from older persisted previews remain supported.
function previewDisplayPathFromPath(path: string) {
  if (!path) return '/';
  const stripped = path.startsWith(PREVIEW_PATH_PREFIX)
    ? path.slice(PREVIEW_PATH_PREFIX.length)
    : path.replace(/^\/+/, '');
  return stripped === '' ? '/' : `/${stripped}`;
}

function isSamePreviewTarget(a: string, b: string) {
  try {
    const left = new URL(a);
    const right = new URL(b);
    return left.origin === right.origin && left.pathname === right.pathname;
  } catch {
    return false;
  }
}

export function WorkspaceScreen() {
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
  const [deployment, setDeployment] = useState<DeploymentInfo | null>(null);
  const [deploymentCopied, setDeploymentCopied] = useState(false);
  const [download, setDownload] = useState<LinkInfo | null>(null);
  const [downloadBusy, setDownloadBusy] = useState(false);
  const [build, setBuild] = useState<BuildInfo | null>(null);
  const [loading, setLoading] = useState(false);
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
  // When credential renewal fails, keep the iframe detached and show our own
  // retry state instead of restoring an expired URL that can render the sandbox
  // gateway's AUTHENTICATION_FAILED JSON.
  const [previewRefreshFailed, setPreviewRefreshFailed] = useState(false);
  const [previewCopied, setPreviewCopied] = useState(false);
  // Mirror of the preview iframe's current route (pathname + search + hash),
  // posted back by an injected script. Empty until the first message arrives.
  const [previewPath, setPreviewPath] = useState('');
  const previewPathRef = useRef('');
  const [pendingPreviewUrl, setPendingPreviewUrl] = useState('');
  const [pendingPreviewRevision, setPendingPreviewRevision] = useState(0);
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
  const isMakersPreviewRef = useRef(false);
  const chatAbortControllerRef = useRef<AbortController | null>(null);
  const activeTurnIdRef = useRef('');
  const stoppingRef = useRef(false);
  // Invalidates callbacks from an aborted workspace after "Stop and start new"
  // has already painted the fresh home screen.
  const workspaceEpochRef = useRef(0);
  // Resume-on-load reconnects to an in-flight run after history paints. The
  // effect closes over this ref so it always calls the latest stream attacher.
  const attachChatStreamRef = useRef<(options: {
    requestConversationId: string;
    assistantMessageId: string;
    streamUrl?: string;
    response?: Response;
    abortController?: AbortController;
  }) => Promise<void>>(async () => {});
  // Visibility / toolbar preview refresh — kept on a ref so the listener effect
  // can stay mount-only while still calling the latest implementation.
  const refreshPreviewLinkRef = useRef<(options?: {
    showLoading?: boolean;
    remountIframe?: boolean;
  }) => Promise<boolean>>(async () => false);

  const t = TRANSLATIONS[language];
  const canSend = input.trim().length > 0 && !loading;
  // Do not leave a streaming /chat socket attached to makers-dev after this
  // workspace unmounts (navigation, HMR, or closing the app shell).
  useEffect(() => () => {
    chatAbortControllerRef.current?.abort();
    chatAbortControllerRef.current = null;
  }, []);
  // `preview.url` always carries the freshest access_token, while `activePreviewUrl`
  // is only what the iframe happens to be showing (deliberately left stale so a
  // token rotation does not reload the running app).
  const shareablePreviewUrl = preview?.url || activePreviewUrl;
  const hasWorkspace = messages.length > 0
    || Boolean(preview)
    || Boolean(deployment)
    || Boolean(build)
    || workspaceRestoring;
  // Address bar shows the preview's current route once the injected tracker
  // reports it; before that it falls back to a bare root path so the sandbox
  // host is never shown.
  const previewDisplayPath = previewDisplayPathFromPath(previewPath);
  // Cycling typewriter placeholder for the landing prompt. Reuses the localized
  // example prompts; pauses while the field has text.
  const placeholderPhrases = useMemo(() => t.home.examples.map((example) => `${example}…`), [t]);
  const typedPlaceholder = useTypewriterPlaceholder(
    placeholderPhrases,
    !hasWorkspace && input.length === 0,
  );
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
    isMakersPreviewRef.current = preview?.kind === 'makers' || isMakersDeployUrl(preview?.url);
  }, [preview?.url, preview?.kind]);

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
      return;
    }

    setResumeChecked(false);
    setConversationId(existing);

    const applyHistory = (data: ResumeData) => {
      const history = Array.isArray(data.messages) ? data.messages : [];
      const activeTask = data.activeTask;
      if (!data.hasProject && history.length === 0 && !activeTask && !data.deployment) {
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
              activities: dropTrailingSummaryEcho(turn.activities ?? [], turn.assistant),
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
                  activities: [],
                  status: 'running',
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
                },
              ];
            }
          }
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
      if (data.deployment) {
        setDeployment(data.deployment);
        setResultPanelOpen(true);
      }
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

    const applyWorkspace = (data: ResumeData) => {
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
      if (data.deployment) {
        setDeployment(data.deployment);
        setResultPanelOpen(true);
      }
      if (data.preview?.url) {
        setPreview(data.preview);
        setPreviewRefreshFailed(false);
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
        setPreviewRefreshFailed(false);
        activePreviewUrlRef.current = '';
        activePreviewRevisionRef.current = 0;
        setActivePreviewUrl('');
        setActivePreviewRevision(0);
        setActivePreviewLoaded(false);
        previewPathRef.current = '';
        setPreviewPath('');
        if (hasFiles) {
          setSandboxTab('files');
        }
      }
    };

    const resumeController = new AbortController();
    (async () => {
      let handedOffToActiveStream = false;
      try {
        const response = await openResumeStream(existing, resumeController.signal);
        const contentType = response.headers.get('content-type') || '';
        if (!response.ok || !response.body || !contentType.includes('text/event-stream')) {
          return;
        }

        await consumeEventStream<ResumeStreamEvent>(response, (event) => {
          if (cancelled || event.type === 'ping') return;

          if (event.type === 'resume_history' && event.data?.ok) {
            const historyData = event.data;
            const restored = applyHistory(historyData);
            if (!restored) {
              // A cached ID alone does not mean a conversation exists. Remove
              // stale/empty IDs so later refreshes stay on the home screen.
              clearCachedConversationId();
              conversationIdRef.current = null;
              setConversationId(null);
            }
            // History arrives first, so the UI paints while workspace restore
            // continues over this same HTTP connection.
            setResumeChecked(true);

            const activeTask = historyData.activeTask;
            const conversationForRun = historyData.conversation_id || existing;
            if (activeTask?.id) {
              handedOffToActiveStream = true;
              setFilesRefreshing(true);
              void attachChatStreamRef.current({
                requestConversationId: conversationForRun,
                assistantMessageId: activeTask.id,
                streamUrl: activeTask.streamUrl
                  || `/chat?runId=${encodeURIComponent(activeTask.id)}`,
              });
            }
            return;
          }

          if (event.type === 'resume_workspace' && event.data?.ok) {
            applyWorkspace(event.data);
            return;
          }

          if (event.type === 'resume_file_content' && event.data?.path && typeof event.data.content === 'string') {
            fileCache.write(event.data.path, {
              content: event.data.content,
              size: typeof event.data.size === 'number'
                ? event.data.size
                : new TextEncoder().encode(event.data.content).byteLength,
              truncated: Boolean(event.data.truncated),
              mtime: event.data.mtime,
            });
          }
        });
      } catch (error) {
        if (!(error instanceof Error && error.name === 'AbortError')) {
          // Resume is best-effort; on failure the user sees the restored history
          // if that phase already arrived, otherwise the home screen.
        }
      } finally {
        if (!cancelled) {
          setResumeChecked(true);
          setWorkspaceRestoring(false);
          if (!handedOffToActiveStream) setFilesRefreshing(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      resumeController.abort();
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
      setPreviewRefreshFailed(false);
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
      remountIframe?: boolean;
    }) => {
      const id = conversationIdRef.current;
      if (
        !id
        || !hasLivePreviewRef.current
        || isMakersPreviewRef.current
        || loadingRef.current
        || workspaceRestoringRef.current
        || previewRefreshInFlightRef.current
      ) {
        return false;
      }

      previewRefreshInFlightRef.current = true;

      const willRemount = options?.remountIframe !== false;
      const previousActiveUrl = activePreviewUrlRef.current;

      if (options?.showLoading) {
        setPreviewRefreshing(true);
        setPreviewRefreshFailed(false);
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
          applyFreshPreviewUrl(data.preview.url, data.preview.sandboxDebugUrl, {
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
        // The preview stage already escalates to full workspace restore on the
        // backend, so a second frontend fallback request would only duplicate work.
        // Never restore `previousActiveUrl` here: it may contain the expired token
        // that caused the refresh, and displaying it leaks the gateway JSON into
        // the product UI.
        if (options?.showLoading) {
          setPreviewRefreshFailed(true);
        }
        return false;
      } finally {
        previewRefreshInFlightRef.current = false;
        if (options?.showLoading) {
          setPreviewRefreshing(false);
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
      const credentialAge = Date.now() - previewRefreshedAtRef.current;
      const wentStale = hiddenFor >= PREVIEW_CREDENTIAL_REFRESH_MS
        || credentialAge >= PREVIEW_CREDENTIAL_REFRESH_MS;
      // Short tab switches keep the current iframe and token. Refresh only after
      // a genuinely stale interval or an explicit toolbar action.
      // Makers deploy URLs do not use sandbox envdAccessToken — skip remint.
      if (!wentStale || isMakersPreviewRef.current) return;

      void refreshPreviewLink({
        remountIframe: true,
        showLoading: true,
      });
    };

    const refreshTimer = window.setInterval(() => {
      if (
        document.visibilityState === 'visible'
        && hasLivePreviewRef.current
        && !isMakersPreviewRef.current
        && Date.now() - previewRefreshedAtRef.current >= PREVIEW_CREDENTIAL_REFRESH_MS
      ) {
        void refreshPreviewLink({
          remountIframe: true,
          showLoading: true,
        });
      }
    }, PREVIEW_REFRESH_POLL_MS);

    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(refreshTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      refreshPreviewLinkRef.current = async () => false;
    };
  }, []);

  useEffect(() => {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  }, [language]);

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

  // Track the preview iframe's current route. The sandbox app injects a small
  // script (Vite transformIndexHtml) that posts `location.pathname + search +
  // hash` back to the parent so the address bar can mirror it instead of the
  // raw sandbox host. The listener is mount-only; previewPathRef keeps the
  // latest value without re-subscribing on every path change.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const payload = event.data;
      if (!payload || typeof payload !== 'object') return;
      const path = (payload as { __edgeonePreviewPath?: unknown }).__edgeonePreviewPath;
      if (typeof path !== 'string' || !path) return;
      if (path === previewPathRef.current) return;
      previewPathRef.current = path;
      setPreviewPath(path);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  async function attachChatStream(options: {
    requestConversationId: string;
    assistantMessageId: string;
    streamUrl?: string;
    response?: Response;
    abortController?: AbortController;
  }) {
    const {
      requestConversationId,
      assistantMessageId,
      streamUrl,
    } = options;
    const workspaceEpoch = workspaceEpochRef.current;
    const requestAbortController = options.abortController || new AbortController();
    const activatedPreviewRevisions = new Map<string, number>();
    let sawProjectActivity = false;
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
          return {
            ...item,
            activities: appendNarrationChunk(item.activities ?? [], nextText),
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
      setMessages((current) =>
        current.map((item) =>
          item.id === assistantMessageId
            ? {
                ...item,
                content: finalContent,
                activities: dropTrailingSummaryEcho(
                  item.activities ?? [],
                  finalContent,
                ).map((activity) =>
                  activity.kind === 'tool' && activity.status === 'running'
                    ? {
                        ...activity,
                        status: finalStatus === 'stopped'
                          ? 'stopped' as const
                          : finalStatus === 'error'
                            ? 'failed' as const
                            : 'completed' as const,
                        endedAt: Date.now(),
                      }
                    : activity,
                ),
                status: finalStatus,
              }
            : item,
        ),
      );
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
      setPreviewRefreshFailed(false);
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
      if (data.deployment) {
        setDeployment(data.deployment);
        setResultPanelOpen(true);
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
      if (workspaceEpoch !== workspaceEpochRef.current) {
        return;
      }
      if (event.type === 'task_started') {
        if (event.data?.conversation_id) {
          cacheConversationId(event.data.conversation_id);
          setConversationId(event.data.conversation_id);
        }
        return;
      }
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
        const toolUseId = event.data.id || '';
        const toolName = event.data.name || '<unknown>';
        upsertToolActivity(toolUseId, {
          name: toolName,
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
      if (event.type === 'deployment_status' && event.data) {
        sawProjectActivity = true;
        setDeployment(event.data);
        setDeploymentCopied(false);
        setResultPanelOpen(true);
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
      chatAbortControllerRef.current = requestAbortController;
      stoppingRef.current = false;

      const response = options.response || await fetchChatTaskStream(
        streamUrl || `/chat?runId=${encodeURIComponent(assistantMessageId)}`,
        requestConversationId,
        requestAbortController.signal,
      );

      const contentType = response.headers.get('content-type') || '';
      if (!response.body || !contentType.includes('text/event-stream')) {
        applyResponse((await response.json().catch(() => ({
          ok: false,
          error: `${response.status}`,
        }))) as ChatResponse);
        return;
      }

      await consumeEventStream<ChatStreamEvent>(response, handleStreamEvent);
    } catch (error) {
      if (
        workspaceEpoch !== workspaceEpochRef.current
        || (error instanceof Error && error.name === 'AbortError')
        || stoppingRef.current
      ) {
        return;
      }
      const msg = `${t.response.requestFailedPrefix}${error instanceof Error ? error.message : t.response.unknownError}`;
      finalizeAssistant(msg, 'error');
    } finally {
      const ownsActiveWorkspace = workspaceEpoch === workspaceEpochRef.current
        && chatAbortControllerRef.current === requestAbortController;
      // An old aborted stream may unwind after the user has already submitted the
      // first prompt in a new project. Never let that stale finally block clear the
      // new request's loading state, controller, or turn id.
      if (ownsActiveWorkspace) {
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
                  }
                : item,
            ),
          );
        }
        setLoading(false);
        setFilesRefreshing(false);
        chatAbortControllerRef.current = null;
        if (!stoppingRef.current) {
          activeTurnIdRef.current = '';
        }
        stoppingRef.current = false;
      }
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
      setDeployment(null);
      setDeploymentCopied(false);
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
      setPreviewRefreshFailed(false);
      setPendingPreviewUrl('');
      setPendingPreviewRevision(0);
      previewPathRef.current = '';
      setPreviewPath('');
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
        activities: [],
        status: 'running',
      },
    ]);
    setFilesRefreshing(true);
    setInput('');
    setLoading(true);

    try {
      const requestAbortController = new AbortController();
      chatAbortControllerRef.current = requestAbortController;
      stoppingRef.current = false;
      // POST /chat both creates the durable task and returns its SSE stream.
      // Reconnects still use GET /chat?runId=..., but the normal path is one request.
      const response = await startChatTask({
        conversationId: requestConversationId,
        message: trimmed,
        turnId: assistantMessageId,
        resetProject: isStartingFromHome,
        signal: requestAbortController.signal,
      });
      await attachChatStream({
        requestConversationId,
        assistantMessageId,
        response,
        abortController: requestAbortController,
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

  function stopCurrentTask(options: { discardProject?: boolean } = {}) {
    const cid = conversationIdRef.current || conversationId;
    if (!loadingRef.current || !cid || stoppingRef.current) return null;
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
      status: 'stopped' as const,
      createdAt: Date.now(),
      activities: stoppedActivities,
    };

    const stopRequest = stopChatTask(cid, stoppedTurn, options).catch(() => null);
    chatAbortControllerRef.current?.abort();
    return stopRequest;
  }

  async function handleStop() {
    await stopCurrentTask();
  }

  async function handleExportTranscript() {
    if (process.env.NODE_ENV !== 'development' || !conversationId) {
      return;
    }
    try {
      const response = await fetchConversationTranscript(conversationId);
      if (!response.ok) {
        return;
      }
      const jsonl = await response.text();
      downloadTextFile(conversationExportFilename(conversationId), jsonl);
    } catch {
      // Dev-only export; a failed fetch should not interrupt the workspace.
    }
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
      const cid = conversationId || getOrCreateCachedConversationId();
      const resp = await fetchProjectArchive(download.url, cid);
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
    if (!shareablePreviewUrl) {
      return;
    }
    // A failed remint deliberately leaves the iframe detached. Reloading the
    // existing URL as a fallback would expose the sandbox gateway's raw auth
    // response to the user.
    void refreshPreviewLinkRef.current({
      showLoading: true,
    });
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
    // Build the URL to copy from the freshest shareable URL, rewriting its
    // path to the preview iframe's current route so the link deep-links the
    // page the user is actually looking at.
    const urlToCopy = (() => {
      try {
        const parsed = new URL(shareablePreviewUrl);
        if (previewPath) {
          parsed.pathname = previewPath;
        }
        return parsed.toString();
      } catch {
        return shareablePreviewUrl;
      }
    })();
    try {
      await navigator.clipboard.writeText(urlToCopy);
      setPreviewCopied(true);
      window.setTimeout(() => setPreviewCopied(false), 1600);
    } catch {
      setPreviewCopied(false);
    }
  }

  async function handleCopyDeploymentUrl() {
    if (deployment?.status !== 'success' || !deployment.url || !navigator.clipboard) {
      return;
    }
    try {
      await navigator.clipboard.writeText(deployment.url);
      setDeploymentCopied(true);
      window.setTimeout(() => setDeploymentCopied(false), 1600);
    } catch {
      setDeploymentCopied(false);
    }
  }

  // Return to an uncommitted home state. A conversation ID is created and cached
  // only when the user sends the first message, so refreshing an untouched home
  // screen does not trigger an empty /resume request.
  function startNewProject() {
    workspaceEpochRef.current += 1;
    chatAbortControllerRef.current = null;
    activeTurnIdRef.current = '';
    stoppingRef.current = false;
    loadingRef.current = false;
    conversationIdRef.current = null;
    clearCachedConversationId();
    setConversationId(null);
    setMessages([]);
    setLoading(false);
    setPreview(null);
    setDeployment(null);
    setDeploymentCopied(false);
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
    setPreviewRefreshFailed(false);
    setPendingPreviewUrl('');
    setPendingPreviewRevision(0);
    setPreviewCopied(false);
    previewPathRef.current = '';
    setPreviewPath('');
    setInput('');
  }

  function handleNewProject() {
    if (loadingRef.current) {
      setNewProjectConfirmOpen(true);
      return;
    }
    startNewProject();
  }

  function confirmNewProject() {
    setNewProjectConfirmOpen(false);
    if (loadingRef.current) {
      // Fire cancellation against the old conversation, but do not make the new
      // workspace wait for snapshot persistence or the /stop response.
      void stopCurrentTask({ discardProject: true });
    }
    startNewProject();
  }

  // Hold the first paint until the resume check resolves, so a returning user does
  // not see the home screen flash before their project is restored.
  if (!resumeChecked) {
    return (
      <main className="app-shell flex flex-col items-center justify-center gap-4 text-foreground">
        <span
          className="size-8 animate-spin rounded-full border-2 border-primary/30 border-t-primary"
          aria-hidden="true"
        />
        <p className="text-sm text-muted-foreground">{t.workspace.resuming}</p>
      </main>
    );
  }

  return (
    <main className="app-shell flex flex-col text-foreground">
      <SiteHeader
        copy={t}
        language={language}
        hasWorkspace={hasWorkspace}
        canDownload={Boolean(download?.url)}
        downloadBusy={downloadBusy}
        contactUrl={contactUrl}
        showDeploy={CLAIM_DEPLOY_ENABLED}
        showExportTranscript={process.env.NODE_ENV === 'development'}
        canExportTranscript={Boolean(conversationId) && messages.length > 0}
        onLanguageChange={setLanguage}
        onDownload={() => void handleDownload()}
        onNewProject={handleNewProject}
        onDeploy={handleClaimDeploy}
        onExportTranscript={handleExportTranscript}
      />
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
            <Button onClick={confirmNewProject}>
              {t.workspace.newProjectConfirmContinue}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {!hasWorkspace && (
        <HomeStage
          copy={t}
          locale={language}
          input={input}
          placeholder={typedPlaceholder}
          canSend={canSend}
          loading={loading}
          onInputChange={setInput}
          onSubmit={handleSubmit}
          onSend={() => void sendMessage(input)}
        />
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
            running: t.workspace.activityRunning,
            completed: t.workspace.activityCompleted,
            failed: t.workspace.activityFailed,
            stopped: t.workspace.activityStopped,
            input: t.workspace.activityInput,
            output: t.workspace.activityOutput,
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
              {sandboxTab === 'preview' && shareablePreviewUrl && !previewRefreshing && !previewRefreshFailed && (
                <button
                  type="button"
                  onClick={handleCopyPreviewUrl}
                  className="workspace-url-chip"
                  title={previewCopied ? t.workspace.previewPathCopied : t.workspace.copyPreviewPath}
                >
                  <span dir="ltr">{previewDisplayPath}</span>
                  {previewCopied ? <Check /> : <Copy />}
                </button>
              )}
            </div>

            <div className="workspace-topbar-actions">
              {sandboxTab === 'preview' && shareablePreviewUrl && !previewRefreshing && !previewRefreshFailed && (
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

          {deployment && (
            <DeploymentStatus
              deployment={deployment}
              copy={t.workspace.deployment}
              copied={deploymentCopied}
              onCopy={() => void handleCopyDeploymentUrl()}
            />
          )}

          <div className="workspace-panel-content">
            {/* The preview pane stays mounted and is only hidden behind the Code tab:
                unmounting the iframe would reload the sandbox app (and lose its route,
                scroll position and form state) on every tab switch. */}
            <div className={`workspace-panel-pane ${sandboxTab === 'preview' ? '' : 'is-hidden'}`}>
              {preview?.url ? (
                <div className={`workspace-preview-shell is-${previewViewport}`}>
                  <div className="workspace-preview-stage">
                  <div className="workspace-preview-frame">
                    {(!activePreviewLoaded || previewRefreshing || previewRefreshFailed) && (
                      <div className={`workspace-preview-loading${previewRefreshFailed ? ' is-actionable' : ''}`}>
                        <span>
                          {previewRefreshFailed
                            ? t.workspace.previewUnavailable
                            : t.workspace.loadingPreview}
                        </span>
                        {previewRefreshFailed && (
                          <Button size="sm" variant="outline" onClick={handleRefreshPreview}>
                            {t.workspace.retryPreview}
                          </Button>
                        )}
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
