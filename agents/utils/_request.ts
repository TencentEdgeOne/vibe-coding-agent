// Request helpers for the agents/github/* endpoints. Self-contained (no dependency
// on _pipelines) so the OAuth endpoints stay lightweight. Mirrors the query/header
// resolution the rest of the app relies on for the EdgeOne request shape.

export function getHeader(context: any, name: string): string {
  const headers = context?.request?.headers;
  if (!headers) return '';
  if (typeof headers.get === 'function') {
    return String(headers.get(name) || '');
  }
  const lower = name.toLowerCase();
  const value = headers[name] ?? headers[lower];
  return typeof value === 'string' ? value : String(value || '');
}

function fromString(rawValue: unknown, name: string): string {
  if (typeof rawValue !== 'string' || !rawValue.trim()) return '';
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

export function getQueryParam(context: any, name: string): string {
  const request = context?.request || {};
  for (const field of ['url', 'path', 'pathname', 'search', 'queryString', 'rawUrl', 'originalUrl']) {
    const value = fromString(request[field], name);
    if (value) return value;
  }
  const queryObjects = [request.query, request.params, request.searchParams, context?.query, context?.params];
  for (const query of queryObjects) {
    if (query && typeof query.get === 'function') {
      const value = query.get(name);
      if (value) return Array.isArray(value) ? String(value[0]) : String(value);
      continue;
    }
    if (query && typeof query === 'object') {
      const value = (query as Record<string, unknown>)[name];
      if (Array.isArray(value) && value.length) return String(value[0]);
      if (value !== undefined && value !== null && value !== '') return String(value);
    }
  }
  return '';
}

// Best-effort public origin (scheme + host). On EdgeOne the public Pages domain is
// carried by the `eo-pages-host` header; the plain `host` / `x-forwarded-host`
// headers hold the INTERNAL SCF backend host (e.g. *.pages-scf-*.qcloudteo.com),
// which is not publicly reachable — using it sends OAuth redirects to the wrong URL.
// Prefer an explicitly configured redirect URI over this when one is set.
export function getOrigin(context: any): string {
  const pagesHost = getHeader(context, 'eo-pages-host');
  if (pagesHost) {
    return /^https?:\/\//i.test(pagesHost)
      ? pagesHost.replace(/\/+$/, '')
      : `https://${pagesHost}`;
  }
  const host = getHeader(context, 'x-forwarded-host') || getHeader(context, 'host');
  if (!host) return '';
  const proto = getHeader(context, 'x-forwarded-proto') || 'https';
  return `${proto}://${host}`;
}

export function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

// OAuth is run inside a popup window opened by the app, so the main page never
// reloads. This returns a tiny HTML page that hands the result back to the opener via
// postMessage and closes itself. If there is no opener (popup blocked → the flow ran
// as a full-page navigation), it falls back to the old behavior: navigate this tab to
// the app with the same `?github=...` query. `query` is already URL-encoded by callers.
export function oauthPopupResult(origin: string, query: string): Response {
  const data = JSON.stringify({ origin, query }).replace(/</g, '\\u003c');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>GitHub</title>`
    + `<style>html,body{height:100%;margin:0}body{display:flex;align-items:center;justify-content:center;`
    + `font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#5b6472;background:#f6f8ff}</style></head>`
    + `<body><p>处理完成，正在返回…</p><script>(function(){var d=${data};try{`
    + `var p=new URLSearchParams(d.query);`
    + `var msg={source:"github-oauth",github:p.get("github"),repo:p.get("repo")||"",reason:p.get("reason")||""};`
    + `if(window.opener&&!window.opener.closed){window.opener.postMessage(msg,d.origin);window.close();return;}`
    + `}catch(e){}location.replace(d.origin+"/?"+d.query);})();</script></body></html>`;
  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

// Branded popup shell: a centered brand-blue spinner + label, plus an inline script.
// Shared by the OAuth loading pages so the popup never shows a blank white screen.
function popupShell(label: string, script: string): Response {
  const safeLabel = label.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c] as string));
  const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1"><title>GitHub</title><style>`
    + `:root{color-scheme:light}html,body{height:100%;margin:0}`
    + `body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;`
    + `font-family:system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;`
    + `background:#f6f8ff;color:#5b6472}`
    + `.spinner{width:44px;height:44px;border-radius:50%;border:3px solid rgba(47,107,255,.18);`
    + `border-top-color:#2f6bff;animation:spin .8s linear infinite}`
    + `.label{font-size:14px;letter-spacing:.01em;margin:0}`
    + `@keyframes spin{to{transform:rotate(360deg)}}`
    + `</style></head><body><div class="spinner"></div><p class="label">${safeLabel}</p>`
    + `<script>${script}</script></body></html>`;
  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

// Popup page that shows a spinner while it JS-redirects to `url` (e.g. GitHub's
// authorize page). Replaces a bare 302 so the popup isn't blank during the hop.
export function oauthRedirectPage(url: string, label: string): Response {
  const u = JSON.stringify(url).replace(/</g, '\\u003c');
  return popupShell(label, `location.replace(${u});`);
}

// Popup page shown at the OAuth callback: keeps a spinner on screen while it POSTs the
// code/state to /github/finalize (the slow token-exchange + repo-push work), then hands
// the result back to the opener via postMessage and closes — or, with no opener, falls
// back to navigating this tab to the app with ?github=...
export function oauthFinalizePage(origin: string, code: string, state: string, label: string): Response {
  const d = JSON.stringify({ origin, code, state }).replace(/</g, '\\u003c');
  const script = `(async function(){var d=${d};`
    + `function done(q){try{if(window.opener&&!window.opener.closed){var p=new URLSearchParams(q);`
    + `window.opener.postMessage({source:"github-oauth",github:p.get("github"),repo:p.get("repo")||"",`
    + `reason:p.get("reason")||""},d.origin);window.close();return;}}catch(e){}location.replace(d.origin+"/?"+q);}`
    + `try{var r=await fetch(d.origin+"/github/finalize",{method:"POST",headers:{"content-type":"application/json"},`
    + `body:JSON.stringify({code:d.code,state:d.state})});var j=await r.json();`
    + `if(j&&j.ok){done("github=success&repo="+encodeURIComponent(j.repo||""));}`
    + `else{done("github=error&reason="+encodeURIComponent((j&&j.reason)||"push_failed"));}}`
    + `catch(e){done("github=error&reason=push_failed");}})();`;
  return popupShell(label, script);
}
