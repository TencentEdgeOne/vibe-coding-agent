/** Generated Node proxy source. Keep in sync with the TS helpers in cli-dev.ts. */

export const PROXY_REVISION_PLACEHOLDER = '__PREVIEW_PROXY_REVISION__';

function normalizePreviewPrefix(value: string) {
  const normalized = `/${value}`.replace(/\/+/g, '/').replace(/\/+$/, '');
  return normalized === '/' ? '' : normalized;
}

export function buildPreviewProxyTemplate(
  listenPort: number,
  targetPort: number,
  prefix: string,
) {
  const normalizedPrefix = normalizePreviewPrefix(prefix);
  return `const http = require('node:http');
const net = require('node:net');

const LISTEN_PORT = ${listenPort};
const TARGET_PORT = ${targetPort};
const PREFIX = ${JSON.stringify(normalizedPrefix)};
const HEALTH_PATH = '/__edgeone_preview_proxy_health';

// Set once the upstream asks to be addressed with the prefix — see
// previewUpstreamClaimsPrefix in shared/makers-dev.ts. Until then the prefix is
// stripped, which is what makers dev and every framework with an asset-only
// prefix knob expect.
//
// A framework that owns the prefix does not own everything under it. makers dev
// mounts the platform's own routes — agents and cloud functions — at the root
// whatever base the framework was given, so /preview/chat is a path the
// framework answers and the platform does not, until the prefix comes off. The
// answer is what tells the two apart: see misroutedPlatformPath below.
let prefixAware = false;

// The 404-shaped form of the same claim. Subpaths are tried once per proxy —
// see previewPrefixProbe — because a page that is simply missing answers 404
// too, and re-asking on every one of those would double the requests to
// re-learn what the first probe already established. The homepage is asked
// every time: the readiness poll hits it while the framework is still
// compiling, and latching that pair of 404s is how an Astro preview never
// comes up.
let prefixProbed = false;

// How large a request body may be and still be replayed once.
//
// The strip-and-retry below needs the body twice, so a replayable request is
// read into memory before it is sent. The bound keeps an upload from being held
// there for a retry it would not get anyway.
const REPLAY_LIMIT = 2 * 1024 * 1024;

function rewritePath(url) {
  if (!url) return '/';
  if (prefixAware) return url;
  const stripped = stripPrefixPath(url);
  if (stripped) return stripped;
  return url;
}

// The same strip, exposed so a request that already carries the prefix can be
// re-sent without it. Returns null when there is nothing to strip.
function stripPrefixPath(url) {
  if (!PREFIX || !url) return null;
  if (!(url === PREFIX || url.startsWith(PREFIX + '/') || url.startsWith(PREFIX + '?'))) {
    return null;
  }
  const next = url.slice(PREFIX.length);
  if (!next || next === '/') return '/';
  return next.startsWith('/') ? next : '/' + next;
}

// Whether this request can be sent a second time from a copy of its body.
//
// GET and HEAD carry nothing, so they always can. Anything else needs a length
// this proxy can trust: a chunked upload is streamed once and never replayed.
function canReplay(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return true;
  const length = Number(req.headers['content-length']);
  return Number.isFinite(length) && length >= 0 && length <= REPLAY_LIMIT;
}

function readBody(req, done) {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => done(Buffer.concat(chunks)));
  req.on('error', () => done(Buffer.alloc(0)));
}

// Whether this answer is the framework answering a path that belonged to the
// platform.
//
// Two shapes, and they are the two ways a real route gets mistaken for a
// missing page. A 404 is the plain one. The other is a page: a request that did
// not ask for HTML — fetch(), curl, an XHR — being handed a document is the
// framework's fallback rather than anything the caller can use.
//
// The page shape is only read this way for a method that is not a navigation.
// A GET that accepts anything may be a client router asking for a route it will
// render from that document, and that request belongs to the framework.
function misroutedPlatformPath(req, upstream) {
  const status = upstream.statusCode || 0;
  if (status === 404) return true;
  if (req.method === 'GET' || req.method === 'HEAD') return false;
  const accept = req.headers.accept;
  if (typeof accept === 'string' && accept.indexOf('text/html') !== -1) return false;
  const type = upstream.headers['content-type'];
  return typeof type === 'string' && type.toLowerCase().indexOf('text/html') !== -1;
}

// Mirrors previewCanonicalRedirect in shared/makers-dev.ts.
function canonicalRedirect(url) {
  if (!PREFIX || !url) return null;
  const queryStart = url.indexOf('?');
  const path = queryStart === -1 ? url : url.slice(0, queryStart);
  if (path !== PREFIX) return null;
  return PREFIX + '/' + (queryStart === -1 ? '' : url.slice(queryStart));
}

function rewriteLocation(value) {
  if (!PREFIX || typeof value !== 'string' || !value.startsWith('/')) return value;
  if (value === PREFIX || value.startsWith(PREFIX + '/')) return value;
  return PREFIX + value;
}

// Mirrors previewUpstreamClaimsPrefix in shared/makers-dev.ts.
function claimsPrefix(statusCode, location) {
  if (!PREFIX) return false;
  if (!statusCode || statusCode < 300 || statusCode >= 400) return false;
  if (typeof location !== 'string' || !location) return false;
  let path = location;
  const schemeEnd = location.indexOf('://');
  if (schemeEnd !== -1) {
    const afterHost = location.indexOf('/', schemeEnd + 3);
    path = afterHost === -1 ? '/' : location.slice(afterHost);
  } else if (location.charAt(0) !== '/') {
    return false;
  }
  path = path.split('?')[0];
  return path === PREFIX || path.indexOf(PREFIX + '/') === 0;
}

// Mirrors previewPrefixProbe in shared/makers-dev.ts.
function prefixProbe(requestUrl, forwardedPath, statusCode) {
  if (!PREFIX || !requestUrl || !forwardedPath) return null;
  if (statusCode !== 404) return null;
  if (forwardedPath === requestUrl) return null;
  const probePath = requestUrl.split('?')[0];
  if (probePath !== PREFIX && probePath.indexOf(PREFIX + '/') !== 0) return null;
  return requestUrl;
}

// Mirrors previewPrefixProbeIsHome in shared/makers-dev.ts.
function prefixProbeIsHome(forwardedPath) {
  if (!forwardedPath) return false;
  const path = forwardedPath.split('?')[0];
  return path === '/' || path === '';
}

// Mirrors previewTrailingSlashFollow in shared/makers-dev.ts.
function trailingSlashFollow(forwardedPath, statusCode, location) {
  if (!forwardedPath) return null;
  if (!statusCode || statusCode < 300 || statusCode >= 400) return null;
  if (typeof location !== 'string' || location.charAt(0) !== '/') return null;
  const from = forwardedPath.split('?')[0];
  const to = location.split('?')[0];
  if (from === to) return null;
  return withoutTrailingSlash(from) === withoutTrailingSlash(to) ? location : null;
}

function withoutTrailingSlash(value) {
  return value.length > 1 && value.charAt(value.length - 1) === '/'
    ? value.slice(0, -1)
    : value;
}

function rewriteSetCookie(value) {
  if (!PREFIX || typeof value !== 'string') return value;
  return value.replace(/;\\s*Path=\\//gi, '; Path=' + PREFIX + '/');
}

// makers dev reaches its function runtime through http-proxy with xfwd
// enabled, and xfwd APPENDS to x-forwarded-proto rather than replacing it. A
// value from the sandbox gateway therefore arrives at the runtime as
// "http,http", which it concatenates into a request URL and hands to new
// Request(): ERR_INVALID_URL. The failure is then swallowed by an error
// handler that throws on its own, so nothing ever writes a response and the
// browser spins until the user gives up. Dropping the header here leaves xfwd
// setting the single value it would have set anyway, which is also what makes
// a direct curl to the CLI work today.
// The parent workspace frames this preview cross-origin, so it cannot read the
// iframe's location to fill its address bar. Nothing else can report the route
// either: makers dev serves the application, and a proxy is the only layer left
// that sees every document. This posts the real path — prefix included, which is
// what the parent strips for display and reuses when deep-linking a copied URL.
// It also owns the other direction: a route the pane selects arrives as a
// message. The pane keeps its own back/forward stacks, so every command here is
// a navigation to a route it already recorded — the frame's own history is
// never read back, which is the only thing that works cross-origin.
const TRACKER = '<script data-edgeone-preview-tracker>'
  + '(function(){'
  + 'if(window.parent===window)return;'
  + 'var last="";'
  + 'function serialize(){return location.pathname+location.search+location.hash;}'
  + 'function report(){'
  + 'var path=serialize();'
  + 'if(path===last)return;'
  + 'last=path;'
  + 'try{window.parent.postMessage({__edgeonePreviewPath:path},"*");}catch(e){}'
  + '}'
  + 'addEventListener("message",function(event){'
  + 'if(event.source!==window.parent)return;'
  + 'var data=event.data;'
  + 'if(!data||typeof data!=="object")return;'
  + 'if(data.__edgeonePreviewNavigation==="navigate"){'
  + 'if(typeof window.__edgeonePreviewNavigate==="function"){'
  + 'window.__edgeonePreviewNavigate(data.path);'
  + '}else{try{location.assign(data.path);}catch(e){}}'
  + '}'
  + '},false);'
  // Client-side routing changes the URL without any event of its own.
  + 'function wrap(name){'
  + 'var original=history[name];'
  + 'if(typeof original!=="function")return;'
  + 'history[name]=function(){var r=original.apply(this,arguments);report();return r;};'
  + '}'
  + 'wrap("pushState");wrap("replaceState");'
  + 'addEventListener("popstate",report);'
  + 'addEventListener("hashchange",report);'
  + 'report();'
  + '})();'
  // Everything below restores what the prefix takes away, so the generated
  // project can be written the way the deployed site needs it. Mirrors
  // previewRestoredUrl in shared/makers-dev.ts; the tests pin both.
  + '(function(){'
  + 'var PREFIX=' + JSON.stringify(PREFIX) + ';'
  + 'if(!PREFIX)return;'
  + 'var KEY="__edgeone_preview_token";'
  + 'function token(){'
  + 'try{'
  + 'var found=new URLSearchParams(location.search).get("access_token");'
  + 'if(found){sessionStorage.setItem(KEY,found);return found;}'
  + 'return sessionStorage.getItem(KEY)||"";'
  + '}catch(e){return "";}'
  + '}'
  + 'function restore(raw){'
  + 'try{'
  + 'var page=new URL(location.href);'
  + 'var target=new URL(raw,location.href);'
  + 'if(target.origin!==page.origin)return null;'
  + 'if(!/^https?:$/.test(target.protocol))return null;'
  + 'var inside=target.pathname===PREFIX||target.pathname.indexOf(PREFIX+"/")===0;'
  + 'var t=token();'
  + 'var needsToken=!!t&&!target.searchParams.has("access_token");'
  + 'if(inside&&!needsToken)return null;'
  + 'if(!inside)target.pathname=PREFIX+target.pathname;'
  + 'if(needsToken)target.searchParams.set("access_token",t);'
  + 'return target.toString();'
  + '}catch(e){return null;}'
  + '}'
  // Selected routes need a real document request, not pushState: a client router
  // does not re-render on a pushState it did not make, and a server route
  // would never be fetched at all. The restore helper puts the preview prefix
  // and token back, and the resulting load joins the iframe's own history.
  + 'window.__edgeonePreviewNavigate=function(raw){'
  + 'try{var fixed=restore(raw);location.assign(fixed||raw);}catch(e){}'
  + '};'
  // Bubble, not capture, and only if nothing has claimed the event. A client
  // router calls preventDefault on its own links, and hijacking those would
  // turn every in-app navigation into a full document load — which for a SPA
  // with no server-side routes is a 404 where the router had been working.
  // So this only rescues links the page left to the browser.
  + 'addEventListener("click",function(event){'
  + 'if(event.defaultPrevented||event.button!==0)return;'
  + 'if(event.metaKey||event.ctrlKey||event.shiftKey||event.altKey)return;'
  + 'var anchor=event.target&&event.target.closest&&event.target.closest("a[href]");'
  + 'if(!anchor||anchor.target&&anchor.target!=="_self"||anchor.hasAttribute("download"))return;'
  + 'var fixed=restore(anchor.getAttribute("href"));'
  + 'if(!fixed)return;'
  + 'event.preventDefault();'
  + 'location.assign(fixed);'
  + '},false);'
  + 'addEventListener("submit",function(event){'
  + 'if(event.defaultPrevented)return;'
  + 'var form=event.target;'
  + 'if(!form||!form.getAttribute)return;'
  + 'var fixed=restore(form.getAttribute("action")||location.href);'
  + 'if(fixed)form.setAttribute("action",fixed);'
  + '},false);'
  // The other half of a client router: it pushes the path it believes it is on,
  // which is root-absolute and therefore outside the prefix. The app keeps
  // rendering from its own state, so nothing looks wrong until the reload that
  // asks the sandbox host for a path it does not publish.
  + 'function keepInside(name){'
  + 'var original=history[name];'
  + 'if(typeof original!=="function")return;'
  + 'history[name]=function(state,title,url){'
  + 'var args=[].slice.call(arguments);'
  + 'if(typeof url==="string"){'
  + 'var fixed=restore(url);'
  + 'if(fixed)args[2]=fixed;'
  + '}'
  + 'return original.apply(this,args);'
  + '};'
  + '}'
  + 'keepInside("pushState");keepInside("replaceState");'
  // Wrapped in <head> so this runs before app code can hold its own reference.
  + 'var nativeFetch=window.fetch;'
  + 'if(typeof nativeFetch==="function"){'
  + 'window.fetch=function(input,init){'
  + 'try{'
  + 'if(typeof input==="string"){'
  + 'var fixed=restore(input);'
  + 'if(fixed)input=fixed;'
  + '}else if(input&&typeof input.url==="string"){'
  + 'var fixedRequest=restore(input.url);'
  + 'if(fixedRequest)input=new Request(fixedRequest,input);'
  + '}'
  + '}catch(e){}'
  + 'return nativeFetch.call(this,input,init);'
  + '};'
  + '}'
  + 'var open=window.XMLHttpRequest&&window.XMLHttpRequest.prototype.open;'
  + 'if(typeof open==="function"){'
  + 'window.XMLHttpRequest.prototype.open=function(method,url){'
  + 'var args=[].slice.call(arguments);'
  + 'try{var fixed=restore(url);if(fixed)args[1]=fixed;}catch(e){}'
  + 'return open.apply(this,args);'
  + '};'
  + '}'
  + '})();'
  + '</script>';

// Scanned as latin1 so one character is one byte and the match offset can index
// the buffer directly.
//
// <head> is only the preferred landing place. A hand-written index.html may not
// have one, and the script above is now what makes in-app navigation work, so
// skipping those pages would leave exactly the simplest generated sites broken.
// The fallbacks stay below the doctype: above it the page drops into quirks
// mode, which changes how the whole document lays out.
function headInsertionPoint(buffer) {
  const text = buffer.toString('latin1');
  for (const pattern of [/<head[^>]*>/i, /<html[^>]*>/i, /<!doctype[^>]*>/i]) {
    const match = pattern.exec(text);
    if (match) return match.index + match[0].length;
  }
  return -1;
}

function acceptsHtml(req) {
  const accept = req.headers.accept;
  return typeof accept === 'string' && accept.includes('text/html');
}

function isHtmlResponse(headers) {
  const type = headers['content-type'];
  return typeof type === 'string' && type.toLowerCase().includes('text/html');
}

function forwardHeaders(req) {
  const headers = {
    ...req.headers,
    host: '127.0.0.1:' + TARGET_PORT,
    'x-forwarded-prefix': PREFIX,
  };
  delete headers['x-forwarded-proto'];
  // TRACKER can only be spliced into an unencoded body. Asking for identity on
  // navigations alone costs nothing on a loopback hop and leaves compression in
  // place for the assets, which are what the encoding is actually worth.
  if (acceptsHtml(req)) headers['accept-encoding'] = 'identity';
  return headers;
}

// Buffer only up to the opening <head>, then release and stream the rest
// untouched: a page that streams its body from a Suspense boundary has to keep
// arriving in pieces, and the shell carrying <head> is already in the first one.
function injectTracker(upstream, res) {
  const SCAN_LIMIT = 65536;
  let pending = [];
  let scanned = 0;
  let injected = false;

  function splice(buffer) {
    const at = headInsertionPoint(buffer);
    // No <head> to splice after. Prepending would land the script above the
    // doctype and drop the page into quirks mode, so leave the body alone and
    // let the address bar stay where it is.
    if (at === -1) {
      res.write(buffer);
      return;
    }
    res.write(buffer.subarray(0, at));
    res.write(TRACKER);
    res.write(buffer.subarray(at));
  }

  upstream.on('data', (chunk) => {
    if (injected) {
      res.write(chunk);
      return;
    }
    pending.push(chunk);
    scanned += chunk.length;
    const buffer = Buffer.concat(pending);
    if (headInsertionPoint(buffer) === -1 && scanned <= SCAN_LIMIT) return;
    injected = true;
    pending = [];
    splice(buffer);
  });
  upstream.on('end', () => {
    if (!injected && pending.length) splice(Buffer.concat(pending));
    res.end();
  });
  upstream.on('error', () => res.end());
}

const server = http.createServer((req, res) => {
  if ((req.url || '').split('?')[0] === HEALTH_PATH) {
    res.writeHead(200, {
      'content-type': 'text/plain',
      'x-edgeone-preview-proxy': '${PROXY_REVISION_PLACEHOLDER}',
    });
    res.end('ok');
    return;
  }

  const canonical = canonicalRedirect(req.url);
  if (canonical) {
    res.writeHead(308, { location: canonical });
    res.end();
    return;
  }

  // A request the browser addressed to the prefix may belong to the framework
  // (which would keep the prefix) or to the platform (which mounts at the
  // root). Only the answer can tell the two apart, so a replayable one is
  // buffered up front and the verdict costs a single retry.
  const startedPrefixed = Boolean(stripPrefixPath(req.url));
  if (prefixAware && startedPrefixed && canReplay(req)) {
    readBody(req, (body) => forward(req, res, rewritePath(req.url), true, true, false, body));
    return;
  }
  forward(req, res, rewritePath(req.url), true, true, false, null);
});

function forward(req, res, path, mayRetry, mayFollow, probing, replayBody) {
  const headers = forwardHeaders(req);
  if (replayBody) {
    headers['content-length'] = String(replayBody.length);
    delete headers['transfer-encoding'];
  }
  const proxy = http.request({
    hostname: '127.0.0.1',
    port: TARGET_PORT,
    path,
    method: req.method,
    headers,
  }, (upstream) => {
    // The prefix was kept because the framework asked for it, but this answer
    // says the request was the platform's: the route lives at the root, and the
    // framework only saw it because the prefix was still on. Send it again
    // without the prefix, from the body held for exactly this.
    if (mayRetry && prefixAware && replayBody && misroutedPlatformPath(req, upstream)) {
      upstream.resume();
      const stripped = stripPrefixPath(req.url);
      if (stripped) {
        forward(req, res, stripped, false, true, false, replayBody);
        return;
      }
    }
    // The probe's answer, which is the half of previewPrefixProbe that decides.
    // Anything but a second 404 means the prefixed path is a route the upstream
    // knows, so it keeps the prefix from here on. Read before the branches
    // below so a probe answered with a redirect still counts as knowing it.
    if (probing && upstream.statusCode !== 404) prefixAware = true;
    // The one response that means the prefix should not have been stripped.
    // Retried rather than passed on, because handing the browser a redirect to
    // a path this proxy still strips is the same request again: it would bounce
    // between the two until the browser gave up.
    if (
      mayRetry
      && !prefixAware
      && (req.method === 'GET' || req.method === 'HEAD')
      && claimsPrefix(upstream.statusCode, upstream.headers.location)
    ) {
      prefixAware = true;
      upstream.resume();
      forward(req, res, req.url || '/', false, true, false);
      return;
    }
    // The same claim made as a 404, which is how Astro states it. Asked rather
    // than concluded: the retry's status is what tells a base-mounted app apart
    // from a page that is simply not there. The homepage is re-asked on every
    // miss so a compile-time 404 cannot latch; other paths stay once.
    const probeTarget = prefixProbe(req.url, path, upstream.statusCode);
    const homeProbe = Boolean(probeTarget) && prefixProbeIsHome(path);
    if (
      mayRetry
      && !prefixAware
      && (homeProbe || !prefixProbed)
      && (req.method === 'GET' || req.method === 'HEAD')
      && probeTarget
    ) {
      if (!homeProbe) prefixProbed = true;
      upstream.resume();
      forward(req, res, req.url, false, true, true);
      return;
    }
    // A redirect that only normalizes a trailing slash, settled here for the
    // same reason — see previewTrailingSlashFollow. Once, and never from a
    // follow of its own: an upstream that keeps normalizing is a loop this
    // proxy would be holding open instead of the browser.
    if (mayFollow && (req.method === 'GET' || req.method === 'HEAD')) {
      const follow = trailingSlashFollow(
        path,
        upstream.statusCode,
        upstream.headers.location,
      );
      if (follow) {
        upstream.resume();
        forward(req, res, follow, false, false, false);
        return;
      }
    }
    const responseHeaders = { ...upstream.headers };
    if (responseHeaders.location) {
      responseHeaders.location = rewriteLocation(responseHeaders.location);
    }
    if (Array.isArray(responseHeaders['set-cookie'])) {
      responseHeaders['set-cookie'] = responseHeaders['set-cookie'].map(rewriteSetCookie);
    }
    const injectable = isHtmlResponse(responseHeaders)
      && !responseHeaders['content-encoding'];
    // The body grows by TRACKER, so the declared length no longer holds.
    // Dropping it hands the response to chunked encoding.
    if (injectable) delete responseHeaders['content-length'];
    res.writeHead(upstream.statusCode || 502, responseHeaders);
    if (injectable) injectTracker(upstream, res);
    else upstream.pipe(res);
  });
  proxy.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end('preview proxy error');
  });
  // Three ways to send the body, and never two of them. A buffered request is
  // written from the copy taken before the first attempt, because the stream it
  // came from is drained. A plain request streams straight through. A retry
  // that reaches here has no body left to send: those are only ever made for a
  // GET or a HEAD.
  if (replayBody) proxy.end(replayBody);
  else if (mayRetry) req.pipe(proxy);
  else proxy.end();
}

server.on('upgrade', (req, socket, head) => {
  const path = rewritePath(req.url);
  const headers = forwardHeaders(req);
  const target = net.connect(TARGET_PORT, '127.0.0.1', () => {
    const headerLines = Object.entries(headers).flatMap(([key, value]) => {
      if (value == null) return [];
      return [key + ': ' + (Array.isArray(value) ? value.join(', ') : value)];
    });
    target.write([
      (req.method || 'GET') + ' ' + path + ' HTTP/1.1',
      ...headerLines,
      '',
      '',
    ].join('\\r\\n'));
    if (head && head.length) target.write(head);
    target.pipe(socket);
    socket.pipe(target);
  });
  target.on('error', () => socket.destroy());
  socket.on('error', () => target.destroy());
});

server.listen(LISTEN_PORT, '0.0.0.0');
`;
}
