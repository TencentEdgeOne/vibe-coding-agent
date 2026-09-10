/**
 * Map the public site root domain to the project acceleration area.
 * The API endpoint follows the token (SDK probe), not the host: a China-site
 * token can still create an overseas-accelerated project when the host is `.dev`.
 */

export type MakersPublishArea = 'mainland' | 'overseas' | 'global';

export type MakersPublishTarget = {
  area: MakersPublishArea;
};

/**
 * `.dev` (international `edgeone.dev`) → overseas acceleration.
 * `.cool` (China `edgeone.cool`) and any non-`.dev` host → global area.
 */
export function resolveMakersPublishTarget(domain: string): MakersPublishTarget {
  const host = String(domain || '').trim().toLowerCase();
  if (host === 'dev' || host.endsWith('.dev')) {
    return { area: 'overseas' };
  }
  return { area: 'global' };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const MAKERS_PAGES_URL = /https?:\/\/[^\s)\]>'"]*edgeone\.(?:cool|dev)[^\s)\]>'"]*/gi;
const MAKERS_PAGES_MARKDOWN_LINK = /\[[^\]]*\]\(https?:\/\/[^)]*edgeone\.(?:cool|dev)[^)]*\)/gi;
const PUBLISH_URL_LABEL = /[，,]?\s*(?:访问地址|线上地址|部署地址|production URL|live (?:URL|site)|site URL)\s*[：:]\s*$/i;

/**
 * The live site is rendered as a card, so any Pages URL the model repeats in
 * prose is removed before the frontend paints the bubble.
 */
export function stripReturnedPublishLinks(
  text: string,
  publishUrl?: string,
  options: { preserveEdges?: boolean } = {},
) {
  if (!text) return text;
  let next = text;
  const exact = new Set<string>();
  if (publishUrl) {
    exact.add(publishUrl);
    const origin = displayPublishOrigin(publishUrl);
    if (origin) exact.add(origin);
  }
  for (const url of exact) {
    const escaped = escapeRegExp(url);
    next = next.replace(new RegExp(`\\s*\\[[^\\]]*\\]\\(${escaped}(?:[?#][^)]*)?\\)`, 'gi'), '');
    next = next.replace(new RegExp(`\\s*${escaped}(?:[?#][^\\s)\\]>'"]*)?`, 'g'), '');
  }
  next = next.replace(MAKERS_PAGES_MARKDOWN_LINK, '');
  next = next.replace(MAKERS_PAGES_URL, '');
  next = next.replace(PUBLISH_URL_LABEL, '');
  next = next.replace(/\n{3,}/g, '\n\n');
  return options.preserveEdges ? next : next.trim();
}

/** Origin only — never include the signed query string in UI chrome. */
export function displayPublishOrigin(previewUrl: string): string {
  const raw = String(previewUrl || '').trim();
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return raw.split(/[?#]/)[0] || raw;
  }
}
