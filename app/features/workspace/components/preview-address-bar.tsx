'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ExternalLink,
  Laptop,
  RefreshCw,
  Smartphone,
} from 'lucide-react';
import type { PreviewRoute } from '../../../../shared/protocol';
import type { PreviewViewport } from './preview-frame';

export type PreviewAddressCopy = {
  back: string;
  forward: string;
  routeList: string;
  routeEmpty: string;
  /** Action labels for the single size toggle, named for where they lead. */
  viewportToDesktop: string;
  viewportToMobile: string;
  open: string;
  refresh: string;
  /** Shown on refresh and open while a publish has the dev server stopped. */
  pausedForDeploy: string;
  /** Progress track's accessible name while a route change is in flight. */
  loading: string;
};

type PreviewAddressBarProps = {
  displayPath: string;
  routes: PreviewRoute[] | undefined;
  viewport: PreviewViewport;
  /** A publish stops the dev server, so both links lead nowhere until it ends. */
  publishing: boolean;
  /** A route change was requested and the frame has not reported back yet. */
  navigating: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  copy: PreviewAddressCopy;
  onSelectRoute: (path: string) => void;
  onBack: () => void;
  onForward: () => void;
  onToggleViewport: () => void;
  onOpen: () => void;
  onRefresh: () => void;
};

/**
 * The address bar for a cross-origin preview.
 *
 * The route is read-only on purpose: the iframe cannot be trusted to serve a
 * path the pane does not know, and a hand-typed route would turn a client-side
 * navigation into a full document load. Selecting from the project's route list
 * is the only way to move, which keeps every address the bar can show one the
 * scan found and the preview can actually serve.
 */
export function PreviewAddressBar({
  displayPath,
  routes,
  viewport,
  publishing,
  navigating,
  canGoBack,
  canGoForward,
  copy,
  onSelectRoute,
  onBack,
  onForward,
  onToggleViewport,
  onOpen,
  onRefresh,
}: PreviewAddressBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const hasRoutes = Boolean(routes?.length);
  // Both of these lead to the stopped server while a publish runs. Reconnecting
  // is the worse of the two: it fails, and then reports an expired connection,
  // which is the one explanation that is not true here.
  const linkHint = publishing ? copy.pausedForDeploy : '';
  const viewportHint = viewport === 'desktop' ? copy.viewportToMobile : copy.viewportToDesktop;

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  const menuOpenable = hasRoutes || Boolean(displayPath);

  return (
    <div className="workspace-preview-address" ref={rootRef}>
      {/* A route change is a document load inside a cross-origin frame, so there
          is no load event the parent can watch and the bar otherwise sits still
          for about a second. The track reports that wait; the tracker's own
          report is what ends it. */}
      {navigating && (
        <span
          className="workspace-address-progress"
          role="progressbar"
          aria-label={copy.loading}
        />
      )}
      <div className="workspace-preview-nav">
        <button
          type="button"
          onClick={onBack}
          disabled={!canGoBack}
          aria-label={copy.back}
          data-tooltip={copy.back}
          className="workspace-address-button"
        >
          <ArrowLeft />
        </button>
        <button
          type="button"
          onClick={onForward}
          disabled={!canGoForward}
          aria-label={copy.forward}
          data-tooltip={copy.forward}
          className="workspace-address-button"
        >
          <ArrowRight />
        </button>
        {/* One button, not a pair: the pane only ever holds two widths, and the
            icon shows the one on screen while the label names where a click
            leads. */}
        <button
          type="button"
          onClick={onToggleViewport}
          aria-label={viewportHint}
          data-tooltip={viewportHint}
          className="workspace-address-button"
        >
          {viewport === 'desktop' ? <Laptop /> : <Smartphone />}
        </button>
      </div>
      <button
        type="button"
        onClick={() => {
          setMenuOpen((current) => !current);
        }}
        disabled={!menuOpenable}
        aria-haspopup="listbox"
        aria-expanded={menuOpen}
        aria-label={copy.routeList}
        data-tooltip={copy.routeList}
        className="workspace-address-route"
      >
        <span dir="ltr">{displayPath}</span>
        <ChevronDown />
      </button>
      <button
        type="button"
        onClick={onOpen}
        disabled={publishing}
        aria-label={linkHint || copy.open}
        data-tooltip={linkHint || copy.open}
        className="workspace-address-button"
      >
        <ExternalLink />
      </button>
      <button
        type="button"
        onClick={onRefresh}
        disabled={publishing}
        aria-label={linkHint || copy.refresh}
        data-tooltip={linkHint || copy.refresh}
        className="workspace-address-button"
      >
        <RefreshCw />
      </button>
      {menuOpen && (
        hasRoutes ? (
          <div className="workspace-route-menu" role="listbox" aria-label={copy.routeList}>
            {routes?.map((route) => (
              <button
                key={route.path}
                type="button"
                role="option"
                aria-selected={route.path === displayPath}
                onClick={() => {
                  setMenuOpen(false);
                  onSelectRoute(route.path);
                }}
              >
                <span dir="ltr">{route.path}</span>
              </button>
            ))}
          </div>
        ) : (
          <div className="workspace-route-menu">
            <p className="workspace-route-empty">{copy.routeEmpty}</p>
          </div>
        )
      )}
    </div>
  );
}
