/**
 * Heuristic for a Makers production URL versus a sandbox preview URL.
 * Shared by the browser (share/copy) and the agent runtime (resume / state).
 */

export function isMakersDeployUrl(url?: string | null): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.pathname === '/preview/' || parsed.pathname.startsWith('/preview/')) {
      return false;
    }
    return /(?:^|\.)edgeone\.(?:cool|ai|link)$/i.test(parsed.hostname)
      || /(?:^|\.)pages\.edgeone\./i.test(parsed.hostname)
      || /(?:^|\.)edgeone\.page$/i.test(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * The text a live address is shown as. A `.dev` deployment carries its access
 * token in the query string; the link keeps it so the site opens, and the
 * visible text drops it. Anything that is not a `.dev` URL comes back as given.
 */
export function liveUrlDisplayText(url: string): string {
  const trimmed = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return url;
  }
  if (!/^https?:$/.test(parsed.protocol) || !/\.dev$/i.test(parsed.hostname)) return url;
  if (!parsed.search) return url;
  const path = parsed.pathname === '/' ? '' : parsed.pathname;
  return `${parsed.origin}${path}${parsed.hash}`;
}
