/**
 * Runtime-agnostic helpers for sandbox preview via the preinstalled Makers CLI.
 *
 * The sandbox gateway only publishes :9000/preview/, forwarding that path to
 * :3000. Makers dev serves the deploy-equivalent application at / on :8088, so
 * a small proxy on :3000 strips /preview before forwarding HTTP and WebSockets.
 */

import { createHash } from 'node:crypto';

import { shellQuote } from './shell.ts';

export const PREVIEW_PROXY_SCRIPT_PATH = '/tmp/edgeone-preview-proxy.cjs';

const PROXY_REVISION_PLACEHOLDER = '__PREVIEW_PROXY_REVISION__';

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
  return buildPreviewProxy(listenPort, targetPort, prefix).script;
}

/**
 * Content hash the running proxy reports on its health endpoint.
 *
 * A proxy that is merely alive is not necessarily the proxy this agent would
 * write: it can predate a fix and still answer every health probe, and the warm
 * path reuses it precisely because it is healthy. Comparing revisions is what
 * makes a change to the script above reach sandboxes that are already running.
 */
export function previewProxyRevision(
  listenPort: number,
  targetPort: number,
  prefix = '/preview',
) {
  return buildPreviewProxy(listenPort, targetPort, prefix).revision;
}

function buildPreviewProxy(listenPort: number, targetPort: number, prefix: string) {
  const template = buildPreviewProxyTemplate(listenPort, targetPort, prefix);
  const revision = createHash('sha256').update(template).digest('hex').slice(0, 12);
  return { script: template.replace(PROXY_REVISION_PLACEHOLDER, revision), revision };
}

function buildPreviewProxyTemplate(
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

// makers dev reaches its function runtime through http-proxy with xfwd
// enabled, and xfwd APPENDS to x-forwarded-proto rather than replacing it. A
// value from the sandbox gateway therefore arrives at the runtime as
// "http,http", which it concatenates into a request URL and hands to new
// Request(): ERR_INVALID_URL. The failure is then swallowed by an error
// handler that throws on its own, so nothing ever writes a response and the
// browser spins until the user gives up. Dropping the header here leaves xfwd
// setting the single value it would have set anyway, which is also what makes
// a direct curl to the CLI work today.
function forwardHeaders(req) {
  const headers = {
    ...req.headers,
    host: '127.0.0.1:' + TARGET_PORT,
    'x-forwarded-prefix': PREFIX,
  };
  delete headers['x-forwarded-proto'];
  return headers;
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

  const path = rewritePath(req.url);
  const headers = forwardHeaders(req);
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
  const proxyRevision = previewProxyRevision(previewPort, makersPort, prefix);
  const writeProxyScript = `require('node:fs').writeFileSync(${
    JSON.stringify(PREVIEW_PROXY_SCRIPT_PATH)
  }, ${JSON.stringify(proxyScript)})`;
  return [
    'set +e',
    ...(!forceRestart ? [
      'rm -f /tmp/preview-proxy-health',
      `if curl --noproxy '*' -fsS -o /dev/null -D /tmp/preview-proxy-health \\`,
      `    ${shellQuote(proxyHealthUrl)} >/dev/null 2>&1 \\`,
      // Reuse only a proxy this agent would have written itself. An older one
      // answers every probe here while still mangling requests downstream.
      `  && grep -qi ${shellQuote(`x-edgeone-preview-proxy: ${proxyRevision}`)} \\`,
      '    /tmp/preview-proxy-health \\',
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

/**
 * How a smoke script names who is at fault, shared by every probe so one caller
 * can classify them all.
 *
 * `transport` means nothing answered: the dev server may be stale, and a restart
 * is worth trying. `application` means something answered and the answer was
 * wrong, which proves the proxy chain and the dev server both work — restarting
 * only delays the news that the generated code is broken.
 */
export const SMOKE_EXIT = {
  transport: 20,
  application: 30,
} as const;

/**
 * Budget for the generated /chat smoke test.
 *
 * makers dev rebuilds the agent worker on save, and requests that land in that
 * window come back as 502 or a refused connection. Retrying costs a couple of
 * seconds; reporting it as a failure costs a dev-server restart plus another
 * probe, and every probe is a real model call against the generated agent.
 */
export const GENERATED_CHAT_SMOKE = {
  attempts: 3,
  retrySleepSeconds: 2,
  firstAttemptTimeoutSeconds: 40,
  retryTimeoutSeconds: 20,
  // Worst case is one long attempt plus two short ones and their sleeps.
  commandTimeoutSeconds: 95,
  // Suffixed with the shell's pid: two probes can overlap (a resume racing a
  // turn), and on one shared path each would overwrite the other's verdict.
  tmpPathPrefix: '/tmp/agent-chat-smoke',
} as const;

export function buildGeneratedChatSmokeScript({
  endpoint,
  payload,
  conversationId,
  // The pause between attempts is a cadence, not part of the decision this script
  // makes, so tests set it to zero and still exercise every branch.
  retrySleepSeconds = GENERATED_CHAT_SMOKE.retrySleepSeconds,
}: {
  endpoint: string;
  payload: string;
  conversationId: string;
  retrySleepSeconds?: number;
}) {
  const {
    attempts,
    firstAttemptTimeoutSeconds,
    retryTimeoutSeconds,
    tmpPathPrefix,
  } = GENERATED_CHAT_SMOKE;
  const { transport: transportExit, application: applicationExit } = SMOKE_EXIT;

  return [
    `body=${tmpPathPrefix}-$$-body`,
    `headers=${tmpPathPrefix}-$$-headers`,
    // The failing body is echoed to stderr below, so nothing is lost by cleaning
    // up: leaving one file per probe behind would just fill /tmp.
    "trap 'rm -f \"$body\" \"$headers\"' EXIT",
    'attempt=0',
    'while :; do',
    '  attempt=$((attempt + 1))',
    `  if [ "$attempt" -eq 1 ]; then maxtime=${firstAttemptTimeoutSeconds}; else maxtime=${retryTimeoutSeconds}; fi`,
    '  rm -f "$body" "$headers"',
    [
      '  curl -sS -N --max-time "$maxtime"',
      "--noproxy '*'",
      '-D "$headers"',
      '-o "$body"',
      `-X POST ${shellQuote(endpoint)}`,
      `-H ${shellQuote('Content-Type: application/json')}`,
      `-H ${shellQuote(`makers-conversation-id: ${conversationId}`)}`,
      `--data ${shellQuote(payload)}`,
    ].join(' '),
    '  status=$?',
    '  http=$(awk \'NR==1 {print $2}\' "$headers" 2>/dev/null)',
    '  if [ "$status" -eq 0 ] && [ "$http" = "200" ]; then break; fi',
    `  if [ "$attempt" -lt ${attempts} ]; then sleep ${retrySleepSeconds}; continue; fi`,
    `  echo "Generated /chat endpoint did not return HTTP 200 after ${attempts} attempts." >&2`,
    '  cat "$body" >&2 2>/dev/null || true',
    `  exit ${transportExit}`,
    'done',
    'if ! grep -q \'data:\' "$body" || ! grep -q \'\\[DONE\\]\' "$body"; then',
    '  echo "Generated /chat endpoint did not return a complete SSE stream." >&2',
    '  cat "$body" >&2 2>/dev/null || true',
    `  exit ${applicationExit}`,
    'fi',
    'if grep -Eq \'"(event|type)"[[:space:]]*:[[:space:]]*"(error|error_message)"\' "$body"; then',
    '  echo "Generated /chat endpoint returned an SSE error event." >&2',
    '  cat "$body" >&2 2>/dev/null || true',
    `  exit ${applicationExit}`,
    'fi',
  ].join('\n');
}

/**
 * Budget for the generated API route probe.
 *
 * Deliberately narrow: a generated route may legitimately answer 401, 403, 404 or
 * 405 to an unauthenticated GET, so only a 5xx or a request that never completes
 * counts as broken. That is exactly the shape of the failures worth catching —
 * a function that throws, one that cannot exchange storage credentials, or one
 * that hangs forever.
 */
export const GENERATED_API_SMOKE = {
  attempts: 3,
  retrySleepSeconds: 2,
  timeoutSeconds: 15,
  // Enough to cover a generated project's handful of endpoints without turning
  // preview publication into a test suite.
  maxRoutes: 4,
  commandTimeoutSeconds: 90,
  tmpPathPrefix: '/tmp/agent-api-smoke',
} as const;

export function buildGeneratedApiSmokeScript({
  baseUrl,
  routes,
  retrySleepSeconds = GENERATED_API_SMOKE.retrySleepSeconds,
}: {
  baseUrl: string;
  routes: string[];
  retrySleepSeconds?: number;
}) {
  const {
    attempts,
    timeoutSeconds,
    maxRoutes,
    tmpPathPrefix,
  } = GENERATED_API_SMOKE;
  const { transport: transportExit, application: applicationExit } = SMOKE_EXIT;
  const probed = routes.slice(0, maxRoutes);

  return [
    `body=${tmpPathPrefix}-$$-body`,
    "trap 'rm -f \"$body\"' EXIT",
    `base=${shellQuote(baseUrl.replace(/\/$/, ''))}`,
    `for route in ${probed.map((route) => shellQuote(route)).join(' ')}; do`,
    '  attempt=0',
    '  while :; do',
    '    attempt=$((attempt + 1))',
    '    rm -f "$body"',
    [
      '    http=$(curl -sS --noproxy \'*\'',
      `--max-time ${timeoutSeconds}`,
      // The sandbox gateway sets this, so send it too: probing without it would
      // miss anything that only breaks on a forwarded request.
      "-H 'x-forwarded-proto: http'",
      '-o "$body" -w \'%{http_code}\' "$base$route" 2>/dev/null)',
    ].join(' '),
    '    status=$?',
    '    if [ "$status" -eq 0 ]; then',
    '      case "$http" in',
    // Anything that is not a server error is a real answer, whatever it says.
    '        5??) ;;',
    '        *) break ;;',
    '      esac',
    '    fi',
    `    if [ "$attempt" -lt ${attempts} ]; then sleep ${retrySleepSeconds}; continue; fi`,
    '    echo "Generated route $route is not serving: http=$http curl=$status" >&2',
    '    cat "$body" >&2 2>/dev/null || true',
    // curl 6/7 mean nothing was listening, so the server itself is suspect. A
    // timeout means it accepted the request and never answered, which is the
    // function hanging rather than the server being down.
    '    case "$status" in',
    `      6|7) exit ${transportExit} ;;`,
    `      0|28) exit ${applicationExit} ;;`,
    `      *) exit ${transportExit} ;;`,
    '    esac',
    '  done',
    'done',
  ].join('\n');
}

export function parseMakersDevExitCode(output: string) {
  const matches = [...output.matchAll(/(?:^|\n)MAKERS_DEV_EXIT:(\d+)(?=\s|$)/g)];
  if (matches.length === 0) return undefined;
  const value = Number(matches.at(-1)?.[1]);
  return Number.isInteger(value) ? value : undefined;
}
