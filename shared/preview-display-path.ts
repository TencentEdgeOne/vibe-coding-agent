// Mirror of the sandbox preview base path. Kept here so the address chip can
// hide the gateway prefix without the frontend importing agents/_lib/constants.
export const PREVIEW_PATH_PREFIX = '/preview/';

// Render a mirrored preview route (pathname[+search][+hash]) as the address-bar
// display value: the /preview/ base (and any other leading slashes) is stripped
// so only the route relative to the app root is shown, with a leading '/'.
// The sandbox access_token stays on the real preview URL; it is never shown.
export function previewDisplayPathFromPath(path: string) {
  if (!path) return '/';
  const hashIndex = path.indexOf('#');
  const hash = hashIndex >= 0 ? path.slice(hashIndex) : '';
  const beforeHash = hashIndex >= 0 ? path.slice(0, hashIndex) : path;
  const queryIndex = beforeHash.indexOf('?');
  const rawPath = queryIndex >= 0 ? beforeHash.slice(0, queryIndex) : beforeHash;
  const search = queryIndex >= 0 ? beforeHash.slice(queryIndex + 1) : '';
  const stripped = rawPath.startsWith(PREVIEW_PATH_PREFIX)
    ? rawPath.slice(PREVIEW_PATH_PREFIX.length)
    : rawPath.replace(/^\/+/, '');
  const pathname = stripped === '' ? '/' : `/${stripped}`;
  if (!search) return `${pathname}${hash}`;
  const params = new URLSearchParams(search);
  params.delete('access_token');
  const nextSearch = params.toString();
  return `${pathname}${nextSearch ? `?${nextSearch}` : ''}${hash}`;
}

/**
 * The inverse, for opening or copying the route the pane is showing.
 *
 * `previewDeepLink` resolves its argument against the preview base, so it needs
 * the tracked form — prefix included. The address bar and the route list are in
 * display form, so this puts the gateway prefix back and leaves the base to
 * carry the access token.
 */
export function previewTrackedPathFromDisplayPath(displayPath: string) {
  if (!displayPath) return '';
  if (displayPath.startsWith(PREVIEW_PATH_PREFIX)) return displayPath;
  const withoutLeadingSlash = displayPath.replace(/^\/+/, '');
  return `${PREVIEW_PATH_PREFIX}${withoutLeadingSlash}`;
}
