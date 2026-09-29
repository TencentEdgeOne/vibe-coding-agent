'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  previewDisplayPathFromPath,
  previewTrackedPathFromDisplayPath,
} from '../../../../shared/preview-display-path';
import {
  previewNavigationBack,
  previewNavigationForward,
  previewNavigationInit,
  previewNavigationIsBusy,
  previewNavigationReport,
  previewNavigationSelect,
  previewNavigationTarget,
  type PreviewNavigationState,
} from '../../../../shared/preview-history';

export type PreviewNavigate = (path: string) => void;

/**
 * Upper bound on how long the address bar may claim a navigation is in flight.
 *
 * The end of a navigation is a report from the frame's own tracker, which is
 * absent whenever the document that loads is not one the proxy injected into —
 * a download, a blocked frame, a response with no HTML. Without this the track
 * would sit there for the rest of the visit; with it, the bar admits it does not
 * know and stops claiming to.
 */
const PREVIEW_NAVIGATION_MAX_MS = 15_000;

/**
 * The address-bar half of the preview surface.
 *
 * The iframe is cross-origin, so its history cannot be read and `history.back()`
 * inside it is not reliably observable. The pane therefore keeps its own two
 * stacks here and drives the frame by navigation only: Back and Forward both
 * navigate to a route the pane already recorded, while a new visit truncates
 * the forward stack the way a browser does.
 */
export function usePreviewNavigation(options: {
  shareablePreviewUrl: string;
  pendingPreviewUrl: string;
  isPreviewMessageOrigin: (origin: string, previewUrls: readonly string[]) => boolean;
  activePreviewUrlRef: { current: string };
  navigate: PreviewNavigate;
}) {
  const [state, setState] = useState<PreviewNavigationState>(previewNavigationInit());
  const stateRef = useRef(state);
  const [navigating, setNavigating] = useState(false);
  const timerRef = useRef(0);

  const commit = useCallback((next: PreviewNavigationState) => {
    stateRef.current = next;
    setState(next);
    setNavigating(previewNavigationIsBusy(next));
  }, []);

  /**
   * Ends the wait, whatever ended it: a report, the safety timer, or a remount.
   * The request stops being something worth waiting for in every case.
   */
  const clearNavigation = useCallback(() => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = 0;
    commit({ ...stateRef.current, pending: null });
  }, [commit]);

  const reset = useCallback((path = '') => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = 0;
    commit(previewNavigationInit(path));
  }, [commit]);

  /**
   * Applies a transition and, when it opened a wait, arms the bound on it. The
   * state module decides whether the transition moves at all.
   */
  const transition = useCallback((
    next: PreviewNavigationState,
    navigateOptions?: { target: string | null },
  ) => {
    commit(next);
    if (navigateOptions?.target) options.navigate(navigateOptions.target);
    if (!previewNavigationIsBusy(next)) return;
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(clearNavigation, PREVIEW_NAVIGATION_MAX_MS);
  }, [clearNavigation, commit, options]);

  /**
   * Entries are stored in display form — the route as the address bar shows it,
   * `/about` rather than `/preview/about?access_token=…`. A report from the
   * tracker that answers our own navigation normalises to the entry already at
   * the top, so it is a no-op: no duplicate entry, and Forward is kept.
   */
  const apply = useCallback((path: string) => {
    const display = previewDisplayPathFromPath(path);
    const next = previewNavigationReport(stateRef.current, display);
    if (next === stateRef.current) return;
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = 0;
    commit(next);
  }, [commit]);

  useEffect(() => () => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
  }, []);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const payload = event.data;
      if (!payload || typeof payload !== 'object') return;
      const path = (payload as { __edgeonePreviewPath?: unknown }).__edgeonePreviewPath;
      if (typeof path !== 'string' || !path) return;
      if (!options.isPreviewMessageOrigin(event.origin, [
        options.activePreviewUrlRef.current,
        options.pendingPreviewUrl,
      ])) return;
      apply(path);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [apply, options.activePreviewUrlRef, options.isPreviewMessageOrigin, options.pendingPreviewUrl]);

  // A new iframe starts a new history: the old entries point at documents the
  // current frame has never served.
  useEffect(() => {
    if (options.pendingPreviewUrl) reset();
  }, [options.pendingPreviewUrl, reset]);

  const canGoBack = state.history.back.length > 0;
  const canGoForward = state.history.forward.length > 0;

  /** Runs a transition from the shared module, whatever it decided to do. */
  function run(next: PreviewNavigationState) {
    transition(next, { target: previewNavigationTarget(next) });
  }

  return {
    path: state.history.current,
    // Idempotent for an entry already in display form, and it turns the initial
    // empty string into '/' so the bar never renders blank.
    displayPath: previewDisplayPathFromPath(state.history.current),
    canGoBack,
    canGoForward,
    navigating,
    reset,
    goBack: () => run(previewNavigationBack(stateRef.current)),
    goForward: () => run(previewNavigationForward(stateRef.current)),
    selectRoute: (path: string) => run(previewNavigationSelect(stateRef.current, path)),
  };
}
