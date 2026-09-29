// Chat : panel is 4 : 6, so the conversation column owns four tenths.
export const WORKSPACE_CHAT_SHARE_DEFAULT = 4 / 10;
export const WORKSPACE_CHAT_SHARE_STEP = 0.02;
export const WORKSPACE_CHAT_MIN_PX = 280;
export const WORKSPACE_PANEL_MIN_PX = 360;

export function clampWorkspaceChatShare(share: number, shellWidth: number): number {
  if (!Number.isFinite(share)) return WORKSPACE_CHAT_SHARE_DEFAULT;
  if (!Number.isFinite(shellWidth) || shellWidth <= 0) {
    return Math.min(1, Math.max(0, share));
  }

  const minShare = WORKSPACE_CHAT_MIN_PX / shellWidth;
  const maxShare = 1 - WORKSPACE_PANEL_MIN_PX / shellWidth;
  if (minShare >= maxShare) return WORKSPACE_CHAT_SHARE_DEFAULT;
  return Math.min(maxShare, Math.max(minShare, share));
}

export function workspaceChatShareCss(share: number): string {
  return `${(share * 100).toFixed(2)}%`;
}

export function workspaceShellClassName(
  hasWorkspace: boolean,
  resultPanelOpen: boolean,
  resizing: boolean,
  resultPanelExiting = false,
) {
  const layout = hasWorkspace
    ? `workspace-shell${resultPanelOpen || resultPanelExiting ? '' : ' is-chat-only'}${resultPanelExiting ? ' is-panel-exiting' : ''}${resizing ? ' is-resizing' : ''}`
    : 'hidden';
  return `min-h-0 min-w-0 w-full flex-1 ${layout}`;
}
