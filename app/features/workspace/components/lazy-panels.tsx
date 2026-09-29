'use client';

import dynamic from 'next/dynamic';

function PanelLoading() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center">
      <span
        className="size-8 animate-spin rounded-full border-2 border-primary/30 border-t-primary"
        aria-hidden="true"
      />
    </div>
  );
}

export const importAgentConversation = () =>
  import('./conversation').then((mod) => mod.AgentConversation);
export const AgentConversation = dynamic(importAgentConversation, {
  ssr: false,
  loading: PanelLoading,
});
// FilesPanel stays a static import in files-pane.tsx. Wrapping it with
// next/dynamic makes Turbopack wait on the prism-react-renderer chunk
// before mount, which is what crashed the files tab.
export const SessionPanel = dynamic(
  () => import('./session-panel').then((mod) => mod.SessionPanel),
  { ssr: false, loading: PanelLoading },
);
