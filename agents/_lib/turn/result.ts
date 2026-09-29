import type { ChatResponse, WorkspaceSnapshot } from '../../../shared/protocol.ts';
import type { StreamSend } from '../types.ts';

export function sendTurnResult(
  send: StreamSend,
  data: ChatResponse,
  snapshot?: WorkspaceSnapshot,
) {
  if (snapshot) {
    send({ type: 'workspace', data: snapshot });
  }
  send({ type: 'result', data });
}
