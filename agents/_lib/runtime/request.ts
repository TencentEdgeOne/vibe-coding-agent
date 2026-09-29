import type { AgentContext, RequestCapable } from './context.ts';

export function getRequestHeader(context: RequestCapable, name: string): string {
  const headers = context?.request?.headers;
  if (!headers) return '';

  const maybeHeaders = headers as Headers | Record<string, string>;
  if (typeof (maybeHeaders as Headers).get === 'function') {
    return String((maybeHeaders as Headers).get(name) || '');
  }

  const record = maybeHeaders as Record<string, string>;
  const lowerName = name.toLowerCase();
  const directValue = record[name] ?? record[lowerName];
  const value = directValue
    ?? Object.entries(record).find(([key]) => key.toLowerCase() === lowerName)?.[1];
  return typeof value === 'string' ? value : String(value || '');
}

function queryValueToString(value: unknown): string {
  if (Array.isArray(value)) {
    return queryValueToString(value[0]);
  }
  if (value === undefined || value === null) {
    return '';
  }
  return typeof value === 'string' ? value : String(value);
}

function getSearchParamFromString(rawValue: unknown, name: string): string {
  if (typeof rawValue !== 'string' || !rawValue.trim()) {
    return '';
  }

  const raw = rawValue.trim();
  try {
    if (raw.startsWith('?')) {
      return new URLSearchParams(raw.slice(1)).get(name) || '';
    }
    if (raw.includes('?') || raw.startsWith('/') || /^https?:\/\//i.test(raw)) {
      return new URL(raw, 'http://local').searchParams.get(name) || '';
    }
    if (raw.includes('=')) {
      return new URLSearchParams(raw).get(name) || '';
    }
  } catch {
    return '';
  }

  return '';
}

export function getRequestQueryParam(context: AgentContext & {
  query?: unknown;
  params?: unknown;
}, name: string): {
  value: string;
  source: string;
} {
  const request = context?.request || {};
  const stringFields = [
    'url',
    'path',
    'pathname',
    'search',
    'queryString',
    'rawUrl',
    'originalUrl',
  ];
  for (const field of stringFields) {
    const value = getSearchParamFromString(request[field], name);
    if (value) {
      return { value, source: `request.${field}` };
    }
  }

  const queryObjects = [
    { source: 'request.query', value: request.query },
    { source: 'request.params', value: request.params },
    { source: 'request.searchParams', value: request.searchParams },
    { source: 'context.query', value: context?.query },
    { source: 'context.params', value: context?.params },
  ];
  for (const query of queryObjects) {
    const bag = query.value as { get?: (key: string) => unknown } | Record<string, unknown> | undefined;
    if (bag && typeof (bag as { get?: unknown }).get === 'function') {
      const value = (bag as { get: (key: string) => unknown }).get(name);
      if (value) {
        return { value: queryValueToString(value), source: query.source };
      }
      continue;
    }
    if (!bag || typeof bag !== 'object') continue;
    const value = (bag as Record<string, unknown>)[name];
    const normalized = queryValueToString(value);
    if (normalized) {
      return { value: normalized, source: query.source };
    }
  }

  return { value: '', source: 'none' };
}

export function getRequestBody(context: RequestCapable): Record<string, unknown> {
  const body = context.request?.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return {};
  }
  return body as Record<string, unknown>;
}

export function resolveConversationId(
  context: AgentContext,
  options?: { allowQuery?: boolean },
): { conversationId: string; source: string } {
  const contextConversationId = String(context?.conversation_id || '');
  if (contextConversationId) {
    return { conversationId: contextConversationId, source: 'context.conversation_id' };
  }

  const pagesHeaderConversationId = getRequestHeader(context, 'makers-conversation-id');
  if (pagesHeaderConversationId) {
    return { conversationId: pagesHeaderConversationId, source: 'makers-conversation-id' };
  }

  const headerConversationId = getRequestHeader(context, 'conversationId');
  if (headerConversationId) {
    return { conversationId: headerConversationId, source: 'conversationId' };
  }

  if (options?.allowQuery) {
    const cid = getRequestQueryParam(context, 'cid');
    if (cid.value) {
      return { conversationId: cid.value, source: cid.source };
    }
    const conversationIdQuery = getRequestQueryParam(context, 'conversationId');
    if (conversationIdQuery.value) {
      return { conversationId: conversationIdQuery.value, source: conversationIdQuery.source };
    }
  }

  return { conversationId: '', source: 'none' };
}

/**
 * Public site root from the incoming request, used to pick Makers acceleration
 * area. Mirrors the browser hostname split: `foo.edgeone.dev` → `edgeone.dev`.
 *
 * `eo-pages-host` is the only header carrying the public hostname on the edge,
 * and it has to be read first: the edge rewrites `host` to the container's own
 * address (`localhost:9000`), so a lookup that starts at `host` finds a name that
 * is not a domain and resolves the area to the `global` default — which is how a
 * `.dev` site ends up publishing to `.edgeone.cool`. `x-forwarded-host` is set
 * by the local dev proxy only, and `host` is a last resort for a plain local run.
 */
const PUBLIC_HOST_HEADERS = ['eo-pages-host', 'x-forwarded-host', 'host'] as const;

/** A name that cannot carry a public site root, whichever header offered it. */
function isInternalHostname(hostname: string) {
  return !hostname
    || hostname === 'localhost'
    || hostname === 'undefined'
    || hostname === 'null'
    || /^\d+\.\d+\.\d+\.\d+$/.test(hostname);
}

export function resolveRequestSiteDomain(context: RequestCapable): string {
  for (const header of PUBLIC_HOST_HEADERS) {
    const host = getRequestHeader(context, header).split(',')[0].trim();
    const hostname = host.split(':')[0].toLowerCase();
    if (isInternalHostname(hostname)) continue;
    const parts = hostname.split('.');
    // A single-label name is not a site root: it is a container hostname the
    // edge did not rewrite, and reading it as a domain is the same mistake as
    // reading `localhost` — the area then follows the wrong answer.
    if (parts.length < 2) continue;
    return parts.slice(1).join('.');
  }
  return '';
}
