import type { ProjectState, StreamSend } from '../types.ts';

type LiveWorkspaceBinding = {
  state: ProjectState;
  send?: StreamSend;
};

const bindings = new Map<string, LiveWorkspaceBinding>();

export function bindLiveWorkspace(
  conversationId: string,
  state: ProjectState,
  send?: StreamSend,
) {
  const id = conversationId.trim();
  if (!id) return;
  bindings.set(id, { state, send });
}

export function unbindLiveWorkspace(conversationId: string) {
  const id = conversationId.trim();
  if (!id) return;
  bindings.delete(id);
}

export function getLiveWorkspace(conversationId: string): LiveWorkspaceBinding | undefined {
  const id = conversationId.trim();
  return id ? bindings.get(id) : undefined;
}
