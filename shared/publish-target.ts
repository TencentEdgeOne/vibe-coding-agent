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
