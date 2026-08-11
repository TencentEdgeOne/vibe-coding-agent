import type { ChatMessage, ResumeData } from '../types/workspace';

export const CONVERSATION_STORAGE_KEY = 'web-dev-agent-conversation-id';

function resumeHeaders(conversationId: string): HeadersInit {
  return {
    'content-type': 'application/json',
    conversationId,
    'makers-conversation-id': conversationId,
  };
}

// Fast store-only resume: chat history without touching the sandbox.
export function fetchResumeHistory(conversationId: string) {
  return fetch('/resume?stage=history', {
    method: 'POST',
    headers: resumeHeaders(conversationId),
    body: JSON.stringify({ stage: 'history' }),
  }).then((response) => response.json().catch(() => null) as Promise<ResumeData | null>);
}

// Slow resume: restore snapshot into the sandbox, return the file tree, and
// restart live preview when the project was previously publishable.
const RESUME_WORKSPACE_CLIENT_TIMEOUT_MS = 130_000;

export function fetchResumeWorkspace(conversationId: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESUME_WORKSPACE_CLIENT_TIMEOUT_MS);
  return fetch('/resume?stage=workspace', {
    method: 'POST',
    headers: resumeHeaders(conversationId),
    body: JSON.stringify({ stage: 'workspace' }),
    signal: controller.signal,
  })
    .then((response) => response.json().catch(() => null) as Promise<ResumeData | null>)
    .catch(() => null)
    .finally(() => clearTimeout(timer));
}

// Light resume: re-mint the public preview URL with a fresh sandbox
// envdAccessToken. May escalate to full workspace restore when the sandbox
// has gone cold, so use the same client ceiling as fetchResumeWorkspace.
const RESUME_PREVIEW_CLIENT_TIMEOUT_MS = 130_000;

export function fetchResumePreview(conversationId: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RESUME_PREVIEW_CLIENT_TIMEOUT_MS);
  return fetch('/resume?stage=preview', {
    method: 'POST',
    headers: resumeHeaders(conversationId),
    body: JSON.stringify({ stage: 'preview' }),
    signal: controller.signal,
  })
    .then((response) => response.json().catch(() => null) as Promise<ResumeData | null>)
    .catch(() => null)
    .finally(() => clearTimeout(timer));
}

/** @deprecated Prefer fetchResumeHistory + fetchResumeWorkspace. */
export function fetchResume(conversationId: string) {
  return fetchResumeHistory(conversationId);
}

export function createConversationId() {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `conversation-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function getOrCreateCachedConversationId() {
  if (typeof window === 'undefined') {
    return createConversationId();
  }

  const stored = window.localStorage.getItem(CONVERSATION_STORAGE_KEY)?.trim();
  if (stored) {
    return stored;
  }

  const next = createConversationId();
  window.localStorage.setItem(CONVERSATION_STORAGE_KEY, next);
  return next;
}

// Read the cached conversationId without minting a new one. Returns null on a
// first visit — used to decide whether there is anything to resume at all, so a
// brand-new visitor skips the "restoring…" screen entirely.
export function getStoredConversationId() {
  if (typeof window === 'undefined') {
    return null;
  }
  return window.localStorage.getItem(CONVERSATION_STORAGE_KEY)?.trim() || null;
}

export function cacheConversationId(value: string) {
  const trimmed = value.trim();
  if (!trimmed || typeof window === 'undefined') {
    return;
  }
  window.localStorage.setItem(CONVERSATION_STORAGE_KEY, trimmed);
}

export function createMessageId(role: ChatMessage['role']) {
  return `${role}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function createWorkspaceTitle(messages: ChatMessage[], fallback: string) {
  const firstRequest = messages.find((message) => message.role === 'user')?.content
    .replace(/\s+/g, ' ')
    .trim();
  if (!firstRequest) return fallback;
  return firstRequest.length > 48 ? `${firstRequest.slice(0, 48).trimEnd()}…` : firstRequest;
}

export function sanitizeThinkingContent(value: string) {
  return value
    .replace(/\x1b\[[0-9;?]*[~A-Za-z]/g, '')
    .replace(/\[20[01]~/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')
    .replace(/<think\b[^>]*>/gi, '')
    .replace(/<\/think>/gi, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .replace(/<t(?:h(?:i(?:n(?:k(?:\b[^>]*)?)?)?)?)?$/i, '');
}

export function getAssistantScrollSignature(message: ChatMessage) {
  const events = message.processEvents ?? [];
  const processSignature = events.map((event) =>
    event.kind === 'thinking'
      ? `thinking:${event.content}`
      : `step:${event.phase}:${event.step.status}:${event.step.summary}`,
  ).join('\u001e');
  return [
    message.status || '',
    message.content,
    events.length,
    processSignature,
  ].join('\u001f');
}

export function extractProjectName() {
  if (typeof window === 'undefined') {
    return {
      projectName: '',
      domain: '',
    };
  }

  var fullUrl = window.location.href;
  var urlObject = new URL(fullUrl);
  var hostname = urlObject.hostname;
  var parts = hostname.split('.');
  return {
    projectName: parts[0].replace('-zh', ''),
    domain: parts.slice(1).join('.'),
  };
}

export const EDGEONE_AI_DEPLOY_URL = 'https://edgeone.ai/makers/new?template=vibe-coding-agent&from=within&fromAgent=1&agentLang=typescript';
export const TENCENT_CLOUD_DEPLOY_URL = 'https://console.cloud.tencent.com/edgeone/makers/new?template=vibe-coding-agent&from=within&fromAgent=1&agentLang=typescript';
export const EDGEONE_AI_CONTACT_URL = 'https://pages.edgeone.ai/contact?source=pages-home';
export const TENCENT_CLOUD_CONTACT_URL = 'https://cloud.tencent.com/online-service?from=connect-us';
// 认领部署（EdgeOne）功能暂不上线，先隐藏入口。上线时改回 true 即可。
export const CLAIM_DEPLOY_ENABLED = false;

export function getDeployUrl(domain: string) {
  return domain === 'edgeone.dev' ? EDGEONE_AI_DEPLOY_URL : TENCENT_CLOUD_DEPLOY_URL;
}

export function getContactUrl(domain: string) {
  return domain === 'edgeone.dev' ? EDGEONE_AI_CONTACT_URL : TENCENT_CLOUD_CONTACT_URL;
}

// Decode a base64 string into a Blob. The source archive arrives base64-encoded
// inside a JSON envelope (the agent proxy only transports text reliably).
export function base64ToBlob(base64: string, contentType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: contentType });
}
