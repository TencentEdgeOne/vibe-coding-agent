/**
 * Runtime-agnostic helpers for sandbox preview via the preinstalled Makers CLI.
 *
 * The sandbox gateway only publishes :9000/preview/, forwarding that path to
 * :3000. Makers dev serves the deploy-equivalent application at / on :8088, so
 * a small proxy on :3000 strips /preview before forwarding HTTP and WebSockets.
 */

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export const PREVIEW_PROXY_SCRIPT_PATH = '/tmp/edgeone-preview-proxy.cjs';

function normalizePreviewPrefix(value: string) {
  const normalized = `/${value}`.replace(/\/+/g, '/').replace(/\/+$/, '');
  return normalized === '/' ? '' : normalized;
}

export function rewritePreviewProxyPath(url: string | undefined, prefix = '/preview') {
  if (!url) return '/';
  const normalizedPrefix = normalizePreviewPrefix(prefix);
  if (!normalizedPrefix) return url;
  if (
    url === normalizedPrefix
    || url.startsWith(`${normalizedPrefix}/`)
    || url.startsWith(`${normalizedPrefix}?`)
  ) {
    const next = url.slice(normalizedPrefix.length);
    if (!next || next === '/') return '/';
    return next.startsWith('/') ? next : `/${next}`;
  }
  return url;
}

/**
 * Redirect target that puts the trailing slash back on the prefix root, or
 * undefined when the request is already canonical.
 *
 * Served at /preview the application looks fine, but the browser now treats
 * the host root as the base for every relative URL on the page: stylesheets,
 * scripts, and API calls all resolve one level too high and the gateway, which
 * publishes nothing outside the prefix, answers none of them. The query string
 * has to survive the redirect because it carries the sandbox access token.
 */
export function previewCanonicalRedirect(url: string | undefined, prefix = '/preview') {
  const normalizedPrefix = normalizePreviewPrefix(prefix);
  if (!normalizedPrefix || !url) return undefined;
  const queryStart = url.indexOf('?');
  const path = queryStart === -1 ? url : url.slice(0, queryStart);
  if (path !== normalizedPrefix) return undefined;
  return `${normalizedPrefix}/${queryStart === -1 ? '' : url.slice(queryStart)}`;
}

export function buildMakersDevLaunchCommand(port: number, projectName: string) {
  return `edgeone makers dev --port ${port} --skip-env-sync --name ${shellQuote(projectName)}`;
}

export function buildPreviewProxyScript(
  listenPort: number,
  targetPort: number,
  prefix = '/preview',
) {
  const normalizedPrefix = normalizePreviewPrefix(prefix);
  return `const http = require('node:http');
const net = require('node:net');

const LISTEN_PORT = ${listenPort};
const TARGET_PORT = ${targetPort};
const PREFIX = ${JSON.stringify(normalizedPrefix)};
const HEALTH_PATH = '/__edgeone_preview_proxy_health';

function rewritePath(url) {
  if (!url) return '/';
  if (
    PREFIX
    && (url === PREFIX || url.startsWith(PREFIX + '/') || url.startsWith(PREFIX + '?'))
  ) {
    const next = url.slice(PREFIX.length);
    if (!next || next === '/') return '/';
    return next.startsWith('/') ? next : '/' + next;
  }
  return url;
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

function rewriteSetCookie(value) {
  if (!PREFIX || typeof value !== 'string') return value;
  return value.replace(/;\\s*Path=\\//gi, '; Path=' + PREFIX + '/');
}

const server = http.createServer((req, res) => {
  if ((req.url || '').split('?')[0] === HEALTH_PATH) {
    res.writeHead(200, {
      'content-type': 'text/plain',
      'x-edgeone-preview-proxy': '1',
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

  const path = rewritePath(req.url);
  const headers = {
    ...req.headers,
    host: '127.0.0.1:' + TARGET_PORT,
    'x-forwarded-prefix': PREFIX,
  };
  const proxy = http.request({
    hostname: '127.0.0.1',
    port: TARGET_PORT,
    path,
    method: req.method,
    headers,
  }, (upstream) => {
    const responseHeaders = { ...upstream.headers };
    if (responseHeaders.location) {
      responseHeaders.location = rewriteLocation(responseHeaders.location);
    }
    if (Array.isArray(responseHeaders['set-cookie'])) {
      responseHeaders['set-cookie'] = responseHeaders['set-cookie'].map(rewriteSetCookie);
    }
    res.writeHead(upstream.statusCode || 502, responseHeaders);
    upstream.pipe(res);
  });
  proxy.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end('preview proxy error');
  });
  req.pipe(proxy);
});

server.on('upgrade', (req, socket, head) => {
  const path = rewritePath(req.url);
  const headers = {
    ...req.headers,
    host: '127.0.0.1:' + TARGET_PORT,
    'x-forwarded-prefix': PREFIX,
  };
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

export type MakersDevBackgroundOptions = {
  makersPort: number;
  previewPort: number;
  previewPath: string;
  projectName: string;
  forceRestart?: boolean;
};

export function buildMakersDevBackgroundCommand({
  makersPort,
  previewPort,
  previewPath,
  projectName,
  forceRestart = false,
}: MakersDevBackgroundOptions) {
  const prefix = normalizePreviewPrefix(previewPath);
  const readyUrl = `http://127.0.0.1:${previewPort}${prefix}/`;
  const proxyHealthUrl = `http://127.0.0.1:${previewPort}/__edgeone_preview_proxy_health`;
  const launch = buildMakersDevLaunchCommand(makersPort, projectName);
  const proxyScript = buildPreviewProxyScript(previewPort, makersPort, prefix);
  const writeProxyScript = `require('node:fs').writeFileSync(${
    JSON.stringify(PREVIEW_PROXY_SCRIPT_PATH)
  }, ${JSON.stringify(proxyScript)})`;
  return [
    'set +e',
    ...(!forceRestart ? [
      `if curl --noproxy '*' -fsS ${shellQuote(proxyHealthUrl)} >/dev/null 2>&1 \\`,
      `  && curl --noproxy '*' -fsS ${shellQuote(readyUrl)} >/dev/null 2>&1; then`,
      '  echo "MAKERS_DEV_READY=already-running"',
      '  echo "MAKERS_DEV_EXIT:0"',
      '  exit 0',
      'fi',
    ] : []),
    `if command -v fuser >/dev/null 2>&1; then fuser -k ${previewPort}/tcp ${makersPort}/tcp >/dev/null 2>&1 || true;`,
    `elif command -v lsof >/dev/null 2>&1; then { lsof -ti tcp:${previewPort}; lsof -ti tcp:${makersPort}; } | xargs -r kill -9 >/dev/null 2>&1 || true; fi`,
    'sleep 1',
    `if ! node -e ${shellQuote(writeProxyScript)}; then`,
    '  echo "Failed to write the preview proxy script." >&2',
    '  echo "MAKERS_DEV_EXIT:125"',
    '  exit 0',
    'fi',
    'rm -f /tmp/makers-dev.log /tmp/preview-proxy.log',
    `nohup ${launch} > /tmp/makers-dev.log 2>&1 &`,
    'dev_pid=$!',
    `nohup node ${shellQuote(PREVIEW_PROXY_SCRIPT_PATH)} > /tmp/preview-proxy.log 2>&1 &`,
    'proxy_pid=$!',
    'for i in $(seq 1 90); do',
    `  if curl --noproxy '*' -fsS ${shellQuote(proxyHealthUrl)} >/dev/null 2>&1 \\`,
    `    && curl --noproxy '*' -fsS ${shellQuote(readyUrl)} >/dev/null 2>&1; then`,
    '    echo "MAKERS_DEV_READY=started"',
    '    echo "MAKERS_DEV_EXIT:0"',
    '    exit 0',
    '  fi',
    '  if ! kill -0 "$dev_pid" >/dev/null 2>&1; then break; fi',
    '  if ! kill -0 "$proxy_pid" >/dev/null 2>&1; then break; fi',
    '  sleep 1',
    'done',
    `echo "edgeone makers dev did not become ready on port ${makersPort} (proxied via ${previewPort}${prefix}/)." >&2`,
    'echo "--- makers-dev log ---" >&2',
    'tail -n 160 /tmp/makers-dev.log >&2 2>/dev/null || true',
    'echo "--- preview proxy log ---" >&2',
    'tail -n 80 /tmp/preview-proxy.log >&2 2>/dev/null || true',
    'dev_status=124',
    'if ! kill -0 "$dev_pid" >/dev/null 2>&1; then',
    '  wait "$dev_pid" >/dev/null 2>&1',
    '  dev_status=$?',
    'fi',
    'if ! kill -0 "$proxy_pid" >/dev/null 2>&1; then',
    '  wait "$proxy_pid" >/dev/null 2>&1',
    '  proxy_status=$?',
    '  if [ "$dev_status" -eq 124 ]; then dev_status=$((125 + proxy_status)); fi',
    'fi',
    'kill "$proxy_pid" "$dev_pid" >/dev/null 2>&1 || true',
    'echo "MAKERS_DEV_EXIT:$dev_status"',
    // Keep the shell successful so the sandbox MCP layer returns captured
    // stdout/stderr instead of collapsing the CLI failure into UNKNOWN_ERROR.
    'exit 0',
  ].join('\n');
}

export function parseMakersDevExitCode(output: string) {
  const matches = [...output.matchAll(/(?:^|\n)MAKERS_DEV_EXIT:(\d+)(?=\s|$)/g)];
  if (matches.length === 0) return undefined;
  const value = Number(matches.at(-1)?.[1]);
  return Number.isInteger(value) ? value : undefined;
}
