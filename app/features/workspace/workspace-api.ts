import type {
  PersistedActivityTurn,
  ResumeData,
} from '../../../shared/protocol';

function conversationHeaders(conversationId: string): HeadersInit {
  return {
    'content-type': 'application/json',
    conversationId,
    'makers-conversation-id': conversationId,
  };
}

async function readJson<T>(response: Response): Promise<T | null> {
  return response.json().catch(() => null) as Promise<T | null>;
}

function fetchResumeStage(
  conversationId: string,
  stage: 'preview',
  signal?: AbortSignal,
) {
  return fetch(`/resume?stage=${stage}`, {
    method: 'POST',
    headers: conversationHeaders(conversationId),
    body: JSON.stringify({ stage }),
    signal,
  }).then((response) => readJson<ResumeData>(response));
}

export function openResumeStream(conversationId: string, signal?: AbortSignal) {
  return fetch('/resume', {
    method: 'GET',
    headers: conversationHeaders(conversationId),
    signal,
  });
}

// Cold resume can reinstall the EdgeOne CLI (420s ceiling) and project
// dependencies before makers-dev starts.
const RESUME_CLIENT_TIMEOUT_MS = 620_000;

function fetchTimedResumeStage(conversationId: string, stage: 'preview') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESUME_CLIENT_TIMEOUT_MS);
  return fetchResumeStage(conversationId, stage, controller.signal)
    .catch(() => null)
    .finally(() => clearTimeout(timer));
}

export function fetchResumePreview(conversationId: string) {
  return fetchTimedResumeStage(conversationId, 'preview');
}

export function startChatTask(options: {
  conversationId: string;
  message: string;
  turnId: string;
  resetProject: boolean;
  signal?: AbortSignal;
}) {
  return fetch('/chat', {
    method: 'POST',
    headers: conversationHeaders(options.conversationId),
    body: JSON.stringify({
      message: options.message,
      turnId: options.turnId,
      ...(options.resetProject ? { resetProject: true } : {}),
    }),
    signal: options.signal,
  });
}

export function fetchChatTaskStream(streamUrl: string, conversationId: string, signal: AbortSignal) {
  return fetch(streamUrl, {
    method: 'GET',
    headers: conversationHeaders(conversationId),
    signal,
  });
}

export async function stopChatTask(
  conversationId: string,
  turn: PersistedActivityTurn,
  options: { discardProject?: boolean } = {},
) {
  const request = (headers: HeadersInit) => fetch('/stop', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      conversation_id: conversationId,
      turn,
      ...(options.discardProject ? { discardProject: true } : {}),
    }),
  });

  const response = await request({ 'content-type': 'application/json' });
  if (response.status !== 400) return response;
  const error = await readJson<{ code?: string }>(response.clone());
  if (error?.code !== 'AGENT_CONVERSATION_ID_REQUIRED') return response;

  // Compatibility only: current runtimes require body-only /stop so sticky
  // routing cannot pin cancellation to the busy chat instance.
  return request({
    'content-type': 'application/json',
    'makers-conversation-id': conversationId,
  });
}

export function fetchProjectArchive(url: string, conversationId: string) {
  return fetch(url, {
    method: 'GET',
    headers: conversationId
      ? {
          conversationId,
          'makers-conversation-id': conversationId,
        }
      : {},
  });
}

export function fetchConversationTranscript(conversationId: string) {
  return fetch(`/transcript?conversationId=${encodeURIComponent(conversationId)}`, {
    method: 'GET',
    headers: {
      conversationId,
      'makers-conversation-id': conversationId,
    },
  });
}

export function fetchChatTaskStatus(conversationId: string) {
  return fetch(`/status?conversationId=${encodeURIComponent(conversationId)}`, {
    method: 'GET',
    headers: {
      conversationId,
      'makers-conversation-id': conversationId,
    },
  });
}
