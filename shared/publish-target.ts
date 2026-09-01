/**
 * Map the public site root domain to the Makers SDK endpoint and project area.
 * Shared by the browser (which sends `siteDomain`) and the agent runtime.
 * Region is never read from environment variables.
 */

export type MakersPublishRegion = 'china' | 'global';
export type MakersPublishArea = 'mainland' | 'overseas' | 'global';

export type MakersPublishTarget = {
  region: MakersPublishRegion;
  area: MakersPublishArea;
};

/**
 * `.dev` (international `edgeone.dev`) → global endpoint + overseas acceleration.
 * `.cool` (China `edgeone.cool`) and any non-`.dev` host → china endpoint + global area.
 */
export function resolveMakersPublishTarget(domain: string): MakersPublishTarget {
  const host = String(domain || '').trim().toLowerCase();
  if (host === 'dev' || host.endsWith('.dev')) {
    return { region: 'global', area: 'overseas' };
  }
  return { region: 'china', area: 'global' };
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
