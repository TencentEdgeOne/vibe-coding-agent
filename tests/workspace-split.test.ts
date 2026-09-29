import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clampWorkspaceChatShare,
  WORKSPACE_CHAT_MIN_PX,
  WORKSPACE_CHAT_SHARE_DEFAULT,
  WORKSPACE_PANEL_MIN_PX,
  workspaceChatShareCss,
  workspaceShellClassName,
} from '../app/features/workspace/workspace-split.ts';

test('the default chat share is four tenths, so the split is 4:6', () => {
  assert.equal(WORKSPACE_CHAT_SHARE_DEFAULT, 4 / 10);
  assert.equal(workspaceChatShareCss(WORKSPACE_CHAT_SHARE_DEFAULT), '40.00%');
});

test('dragging the split keeps both columns above their minimum widths', () => {
  const width = 1000;
  assert.equal(clampWorkspaceChatShare(0.4, width), 0.4);
  assert.equal(clampWorkspaceChatShare(0, width), WORKSPACE_CHAT_MIN_PX / width);
  assert.equal(clampWorkspaceChatShare(1, width), 1 - WORKSPACE_PANEL_MIN_PX / width);
});

test('an unusable shell width falls back to the default 4:6 split', () => {
  assert.equal(clampWorkspaceChatShare(0.8, 200), WORKSPACE_CHAT_SHARE_DEFAULT);
  assert.equal(clampWorkspaceChatShare(Number.NaN, 1000), WORKSPACE_CHAT_SHARE_DEFAULT);
});

test('the shell class tracks open, collapsed, and drag states', () => {
  assert.match(workspaceShellClassName(true, true, false), /workspace-shell/);
  assert.match(workspaceShellClassName(true, false, false), /is-chat-only/);
  assert.match(workspaceShellClassName(true, true, true), /is-resizing/);
  assert.match(workspaceShellClassName(true, false, false, true), /is-panel-exiting/);
  assert.doesNotMatch(workspaceShellClassName(true, false, false, true), /is-chat-only/);
  assert.match(workspaceShellClassName(false, true, false), /\bhidden\b/);
});
