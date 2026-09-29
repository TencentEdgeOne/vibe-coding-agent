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
