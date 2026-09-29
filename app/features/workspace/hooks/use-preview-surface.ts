'use client';

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import { isMakersDeployUrl } from '../../../../shared/makers-url';
import { previewDeepLink } from '../../../../shared/preview-link';
import { previewTrackedPathFromDisplayPath } from '../../../../shared/preview-display-path';
import type { LinkInfo } from '@/app/types/workspace';
import {
  isPreviewMessageOrigin,
  isSamePreviewTarget,
} from './preview-identity';
import { usePreviewRefresh } from './use-preview-refresh';
import { usePreviewNavigation } from './use-preview-navigation';

export { isPreviewMessageOrigin, isSamePreviewTarget };

const PREVIEW_CREDENTIAL_REFRESH_MS = 8 * 60_000;
const PREVIEW_REFRESH_POLL_MS = 60_000;

export function usePreviewSurface(options: {
  conversationIdRef: MutableRefObject<string | null>;
  loadingRef: MutableRefObject<boolean>;
  previewPanelOpenRef: MutableRefObject<boolean>;
  refreshWorkspace?: (
    conversationId: string,
    options?: { includePreview?: boolean },
  ) => Promise<unknown>;
}) {
  const [preview, setPreview] = useState<LinkInfo | null>(null);
  const [previewViewport, setPreviewViewport] = useState<'desktop' | 'mobile'>('desktop');
  const [activePreviewSlot, setActivePreviewSlot] = useState<'a' | 'b'>('a');
  const [activePreviewUrl, setActivePreviewUrl] = useState('');
  const [activePreviewRevision, setActivePreviewRevision] = useState(0);
  const [activePreviewLoaded, setActivePreviewLoaded] = useState(false);
  const [previewRefreshing, setPreviewRefreshing] = useState(false);
  const [previewRefreshFailed, setPreviewRefreshFailed] = useState(false);
  const [previewRoutes, setPreviewRoutes] = useState<LinkInfo['routes']>([]);
  const [pendingPreviewUrl, setPendingPreviewUrl] = useState('');
  const pendingPreviewUrlRef = useRef('');
  const [pendingPreviewRevision, setPendingPreviewRevision] = useState(0);
  const [pendingPreviewLoaded, setPendingPreviewLoaded] = useState(false);
  const activePreviewUrlRef = useRef('');
  const activePreviewRevisionRef = useRef(0);
  const previewRevisionRef = useRef(0);
  const previewRefreshInFlightRef = useRef(false);
  const previewHiddenAtRef = useRef(0);
  const previewRefreshedAtRef = useRef(0);
  const hasLivePreviewRef = useRef(false);
  const isMakersPreviewRef = useRef(false);
  const refreshPreviewLinkRef = useRef<(options?: {
    showLoading?: boolean;
    remountIframe?: boolean;
  }) => Promise<boolean>>(async () => false);

  const shareablePreviewUrl = preview?.url || activePreviewUrl;

  /**
   * The only way the pane moves the frame. Back and Forward are modelled with
   * the parent's own stacks, so every command here is a plain navigation to a
   * route the pane already knows — the frame's own history is never consulted.
   */
  const navigatePreview = useCallback((path: string) => {
    const target = window.document.querySelector<HTMLIFrameElement>(
      'iframe[title="sandbox-preview"]',
    );
    if (!target?.contentWindow || !shareablePreviewUrl) return;
    try {
      target.contentWindow.postMessage(
        { __edgeonePreviewNavigation: 'navigate', path },
        new URL(shareablePreviewUrl).origin,
      );
    } catch {
      // An unparsable preview URL is already handled by the link builders.
    }
  }, [shareablePreviewUrl]);

  const navigation = usePreviewNavigation({
    shareablePreviewUrl,
    pendingPreviewUrl,
    isPreviewMessageOrigin,
    activePreviewUrlRef,
    navigate: navigatePreview,
  });

  useEffect(() => {
    pendingPreviewUrlRef.current = pendingPreviewUrl;
  }, [pendingPreviewUrl]);

  useEffect(() => {
    hasLivePreviewRef.current = Boolean(preview?.url);
    isMakersPreviewRef.current = preview?.kind === 'makers' || isMakersDeployUrl(preview?.url);
    setPreviewRoutes(preview?.routes || []);
  }, [preview?.url, preview?.kind, preview?.routes]);

  usePreviewRefresh({
    conversationIdRef: options.conversationIdRef,
    loadingRef: options.loadingRef,
    previewPanelOpenRef: options.previewPanelOpenRef,
    refreshWorkspace: options.refreshWorkspace,
    credentialRefreshMs: PREVIEW_CREDENTIAL_REFRESH_MS,
    refreshPollMs: PREVIEW_REFRESH_POLL_MS,
    setPreview,
    setPreviewRefreshFailed,
    setPreviewRefreshing,
    setActivePreviewUrl,
    setActivePreviewRevision,
    setActivePreviewLoaded,
    setPendingPreviewUrl,
    setPendingPreviewRevision,
    setPendingPreviewLoaded,
    activePreviewUrlRef,
    activePreviewRevisionRef,
    previewRevisionRef,
    previewRefreshedAtRef,
    hasLivePreviewRef,
    isMakersPreviewRef,
    previewRefreshInFlightRef,
    previewHiddenAtRef,
    refreshPreviewLinkRef,
  });

  const promotePendingPreview = useCallback(() => {
    if (!pendingPreviewUrl) return;
    activePreviewUrlRef.current = pendingPreviewUrl;
    activePreviewRevisionRef.current = pendingPreviewRevision;
    setActivePreviewUrl(pendingPreviewUrl);
    setActivePreviewRevision(pendingPreviewRevision);
    setActivePreviewLoaded(true);
    setActivePreviewSlot((current) => (current === 'a' ? 'b' : 'a'));
    setPendingPreviewLoaded(false);
    setPendingPreviewUrl('');
    setPendingPreviewRevision(0);
  }, [pendingPreviewRevision, pendingPreviewUrl]);

  const handlePendingPreviewLoad = useCallback(() => {
    setPendingPreviewLoaded(true);
  }, []);

  useEffect(() => {
    if (!activePreviewUrl || activePreviewLoaded || previewRefreshing) return;
    const timer = window.setTimeout(() => setActivePreviewLoaded(true), 3000);
    return () => window.clearTimeout(timer);
  }, [activePreviewUrl, activePreviewLoaded, activePreviewRevision, previewRefreshing]);

  useEffect(() => {
    if (!pendingPreviewUrl) return;
    const timer = window.setTimeout(promotePendingPreview, pendingPreviewLoaded ? 0 : 3000);
    return () => window.clearTimeout(timer);
  }, [pendingPreviewLoaded, pendingPreviewUrl, promotePendingPreview]);

  const handleActivePreviewLoad = useCallback(() => {
    if (!previewRefreshInFlightRef.current) {
      setActivePreviewLoaded(true);
    }
  }, []);

  function handleRefreshPreview() {
    if (!shareablePreviewUrl) return;
    void refreshPreviewLinkRef.current({ showLoading: true });
  }

  function handleOpenPreview() {
    if (shareablePreviewUrl) {
      window.open(
        previewDeepLink(
          shareablePreviewUrl,
          previewTrackedPathFromDisplayPath(navigation.displayPath),
        ),
        '_blank',
        'noopener,noreferrer',
      );
    }
  }

  function activatePreview(nextPreview: LinkInfo, activatedPreviewRevisions: Map<string, number>) {
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
    previewRefreshedAtRef.current = Date.now();
    let revision = activatedPreviewRevisions.get(nextPreview.url);
    if (revision === undefined || nextPreview.restarted) {
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
      setPendingPreviewLoaded(false);
      navigation.reset();
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
    setPendingPreviewLoaded(false);
  }

  function applyResumedPreview(nextPreview: LinkInfo | undefined) {
    if (nextPreview?.url) {
      setPreview(nextPreview);
      setPreviewRefreshFailed(false);
      previewRefreshedAtRef.current = Date.now();
      if (
        activePreviewUrlRef.current
        && isSamePreviewTarget(activePreviewUrlRef.current, nextPreview.url)
      ) {
        return;
      }
      const revision = previewRevisionRef.current + 1;
      previewRevisionRef.current = revision;
      if (activePreviewUrlRef.current) {
        setPendingPreviewUrl(nextPreview.url);
        setPendingPreviewRevision(revision);
        setPendingPreviewLoaded(false);
        return;
      }
      activePreviewUrlRef.current = nextPreview.url;
      activePreviewRevisionRef.current = revision;
      setActivePreviewUrl(nextPreview.url);
      setActivePreviewRevision(revision);
      setActivePreviewLoaded(false);
      navigation.reset();
      return;
    }
    setPreview(null);
    setPreviewRefreshFailed(false);
    activePreviewUrlRef.current = '';
    activePreviewRevisionRef.current = 0;
    setActivePreviewUrl('');
    setActivePreviewRevision(0);
    setActivePreviewLoaded(false);
    setPendingPreviewLoaded(false);
    navigation.reset();
  }

  const resetPreview = useCallback(() => {
    setPreview(null);
    setPreviewViewport('desktop');
    setActivePreviewSlot('a');
    activePreviewUrlRef.current = '';
    activePreviewRevisionRef.current = 0;
    previewRevisionRef.current = 0;
    setActivePreviewUrl('');
    setActivePreviewRevision(0);
    setActivePreviewLoaded(false);
    setPreviewRefreshFailed(false);
    setPendingPreviewUrl('');
    setPendingPreviewRevision(0);
    setPendingPreviewLoaded(false);
    navigation.reset();
  }, [navigation.reset]);

  return {
    preview,
    setPreview,
    previewRoutes,
    previewCanGoBack: navigation.canGoBack,
    previewCanGoForward: navigation.canGoForward,
    previewNavigating: navigation.navigating,
    previewViewport,
    setPreviewViewport,
    activePreviewSlot,
    activePreviewUrl,
    activePreviewRevision,
    activePreviewLoaded,
    previewRefreshing,
    previewRefreshFailed,
    previewPath: navigation.path,
    previewDisplayPath: navigation.displayPath,
    pendingPreviewUrl,
    pendingPreviewRevision,
    shareablePreviewUrl,
    previewRevisionRef,
    activePreviewUrlRef,
    activePreviewRevisionRef,
    previewRefreshedAtRef,
    promotePendingPreview,
    handlePendingPreviewLoad,
    handleActivePreviewLoad,
    handleRefreshPreview,
    handleOpenPreview,
    handlePreviewBack: navigation.goBack,
    handlePreviewForward: navigation.goForward,
    handlePreviewRouteSelect: navigation.selectRoute,
    activatePreview,
    applyResumedPreview,
    resetPreview,
  };
}

export type PreviewSurfaceApi = ReturnType<typeof usePreviewSurface>;
