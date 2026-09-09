/**
 * Preview URL construction.
 *
 * Pure string and URL work, extracted from agents/project/_preview.ts where it
 * was interleaved with sandbox side effects and therefore only reachable with a
 * live `context`. Nothing here starts a server or touches a filesystem: given a
 * host and a token, it decides what the public URL looks like.
 *
 * The preview path prefix is a parameter rather than an import so a host that
 * proxies previews differently is not forced to adopt EdgeOne's layout.
 */

export const DEFAULT_PREVIEW_PATH_PREFIX = '/preview/';

/** Accepts a bare host and upgrades it to https, or passes a full URL through. */
export function normalizePublicUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function publicUrlOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

/**
 * Whether two preview URLs point at the same served location.
 *
 * Query and hash are ignored on purpose: the access token rotates, and a
 * rotated token still addresses the same preview.
 */
export function previewTargetsMatch(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    return left.protocol === right.protocol
      && left.hostname === right.hostname
      && left.port === right.port
      && left.pathname === right.pathname;
  } catch {
    return false;
  }
}

/** Adds the token only when absent, so an existing one is never clobbered. */
export function appendAccessToken(url: string, token: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has('access_token')) {
      parsed.searchParams.set('access_token', token);
    }
    return parsed.toString();
  } catch {
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}access_token=${encodeURIComponent(token)}`;
  }
}

export function buildPublicPreviewUrl(
  baseUrl: string,
  token: string,
  pathPrefix = DEFAULT_PREVIEW_PATH_PREFIX,
): string {
  try {
    const parsed = new URL(baseUrl);
    parsed.pathname = pathPrefix;
    parsed.search = '';
    parsed.hash = '';
    return appendAccessToken(parsed.toString(), token);
  } catch {
    const trimmedBase = baseUrl.replace(/\/+$/, '');
    return appendAccessToken(`${trimmedBase}${pathPrefix}`, token);
  }
}

/**
 * Rotate the token on an already-published URL.
 *
 * Unlike appendAccessToken this overwrites, because the point is replacing an
 * expired token on a URL that already has one.
 */
export function rewritePreviewAccessToken(
  existingUrl: string,
  token: string,
): string | undefined {
  try {
    const parsed = new URL(existingUrl);
    parsed.searchParams.set('access_token', token);
    return parsed.toString();
  } catch {
    return undefined;
  }
}

/** Hostname a dev server must allow for the preview proxy to reach it. */
export function resolvePreviewAllowedHost(host: unknown): string {
  const previewUrl = normalizePublicUrl(host);
  if (!previewUrl) return '';
  try {
    return new URL(previewUrl).hostname;
  } catch {
    return '';
  }
}

/**
 * The public preview URL, or undefined when the host cannot serve one yet.
 *
 * `browserLiveUrl` wins when present: some sandboxes expose previews through a
 * browser-session origin that differs from the raw port host.
 */
export function resolvePreviewUrl(input: {
  previewHost?: unknown;
  accessToken?: string;
  browserLiveUrl?: unknown;
  pathPrefix?: string;
}): string | undefined {
  const browserLiveUrl = normalizePublicUrl(input.browserLiveUrl);
  const previewBaseUrl = publicUrlOrigin(browserLiveUrl)
    || normalizePublicUrl(input.previewHost);

  if (!previewBaseUrl || !input.accessToken) return undefined;
  return buildPublicPreviewUrl(
    previewBaseUrl,
    input.accessToken,
    input.pathPrefix ?? DEFAULT_PREVIEW_PATH_PREFIX,
  );
}
