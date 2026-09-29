/**
 * Runtime-agnostic helpers for sandbox preview via the preinstalled Makers CLI.
 *
 * The sandbox gateway only publishes :9000/preview/, forwarding that path to
 * :3000. Makers dev serves the deploy-equivalent application at / on :8088, so
 * a small proxy on :3000 strips /preview before forwarding HTTP and WebSockets.
 */

import { createHash } from 'node:crypto';

import { buildNpmWarmupWaitScript } from './npm-install.ts';
import { buildPreviewProxyTemplate, PROXY_REVISION_PLACEHOLDER } from './preview-proxy-source.ts';
import { shellQuote } from '../utils/shell.ts';

export const PREVIEW_PROXY_SCRIPT_PATH = '/tmp/edgeone-preview-proxy.cjs';

/** Where the launcher records the dev server, so a later build can stop it. */
export const MAKERS_DEV_PID_PATH = '/tmp/makers-dev.pid';

/**
 * Where the dev server's own output goes.
 *
 * The launcher tails this only when the server fails to come up, which leaves
 * nothing for the failure that comes later: a server that starts fine and then
 * cannot mount a route writes its reason here and nowhere else. The route gate
 * reads it at the moment that reason is the whole answer.
 */
export const MAKERS_DEV_LOG_PATH = '/tmp/makers-dev.log';

/**
 * The CLI came up on a port other than the one it was asked for.
 *
 * Chosen well clear of 124 (the readiness timeout) and the 125..129 band the
 * proxy's own exit folds into, so the caller can tell a drifted port from a
 * server that simply never answered. The two need different advice: this one
 * is recoverable by launching again, now that the launcher clears the port.
 */
export const MAKERS_DEV_PORT_DRIFT_EXIT = 60;

/**
 * The dev server is up and throws the same error on every request.
 *
 * Distinct from 124 because the two mean opposite things to the caller: 124 is
 * "nothing answered yet, maybe it needs longer", this one is "it answered, and
 * it will answer the same way for every second of the poll that is left". Only
 * the project's own code can clear it, so a relaunch is the wrong move.
 */
export const MAKERS_DEV_APP_ERROR_EXIT = 61;

/**
 * The CLI is up, and the frontend process it proxies to has already exited.
 *
 * Distinct from 124: that one is "still starting, keep waiting", and a relaunch
 * can be the right next step. This one is "the dev command already ended", so
 * launching again runs the same command and fails the same way. The caller has
 * to fix what the log names.
 */
export const MAKERS_DEV_FRONTEND_EXIT = 62;

/**
 * What the CLI prints once a second while its frontend port is closed.
 *
 * The readiness poll is what generates these, and a tail of the log is then
 * nothing but them. The frontend's own output — the line that says the dev
 * command exited, the missing module — sits above that and never gets read.
 * `}` closes the Node stack `console.error` writes after `proxy error`.
 */
const FRONTEND_PROXY_NOISE_AWK = [
  '/^proxy error / { skip=1; next }',
  'skip && /^}[[:space:]]*$/ { skip=0; next }',
  'skip { next }',
  '{ print }',
].join('\n');

const FRONTEND_REFUSAL_SUMMARY = 'The CLI is up and proxying to its frontend dev server, which refused the connection';

const FRONTEND_REFUSAL_DETAIL = 'The port in that error is the frontend (6699 unless the CLI moved it), not the agent runtime.';

/**
 * The dev log with the poll's proxy stacks removed, plus one line naming them.
 *
 * `logPath` is already shell-quoted, or `"$1"` inside the launcher's function.
 * A missing file prints nothing: the boot has not written a log yet, which is
 * not a failure of the read.
 */
export function makersDevLogExcerptScript(logPath: string, lines = 80) {
  const kept = Number.isInteger(lines) && lines > 0 ? lines : 80;
  return [
    `proxy_refusals=$(grep -c '^proxy error ' ${logPath} 2>/dev/null || true)`,
    'if [ "${proxy_refusals:-0}" -gt 0 ]; then',
    `  echo "${FRONTEND_REFUSAL_SUMMARY} \${proxy_refusals} time(s). ${FRONTEND_REFUSAL_DETAIL}"`,
    'fi',
    `awk ${shellQuote(FRONTEND_PROXY_NOISE_AWK)} ${logPath} 2>/dev/null | tail -n ${kept}`,
  ].join('\n');
}

/**
 * Lines that mean a request reached the app and the app threw.
 *
 * Deliberately narrow. Anything matched here ends the poll early, so a pattern
 * that also matches startup chatter would turn a slow boot into a failure. The
 * two shapes below are what a request-time throw looks like on the Vite-based
 * templates and on the frameworks that log a bare `Error:` with a stack; a
 * server whose error is worded differently just falls through to the ordinary
 * timeout, which is what happens today.
 */
const MAKERS_DEV_APP_ERROR_PATTERN = 'Internal server error|^Error: ';

/**
 * How many such lines end the poll.
 *
 * Each iteration makes one request through the proxy, so a throw on every
 * request writes roughly one line per second and this is a five-second floor.
 * It is a floor and not a trigger on the first line because Vite can throw once
 * while it optimizes deps and recover — and a server that recovers passes the
 * readiness check at the top of the loop before this is ever consulted.
 */
const MAKERS_DEV_APP_ERROR_THRESHOLD = 5;

/**
 * How long the launcher waits for the proxy and the dev server to both answer.
 *
 * Ninety seconds, which this used to be, covers every launch that reuses an
 * already-linked project, and falls short of what the first one needs. A first
 * launch
 * creates the project remotely, links it, pulls environment variables and KV
 * bindings, writes .env, boots the framework, boots the agent-node worker, and
 * only then does the CLI run its own `Installing observability dependencies`.
 * That install starts after this poll is already counting, so no amount of
 * waiting for the host's warmup beforehand covers it — a real session spent 98
 * seconds here and was killed mid-install, then came up in 8 seconds on the
 * retry that found all of it done.
 *
 * Affordable because the poll does not spend this budget on a project that is
 * actually broken: a dead dev process, a drifted port and a route that throws on
 * every request each break out of the loop within seconds of being detectable.
 * What is left to spend it on is a launch that is merely slow, which is the case
 * this number exists for.
 */
export const MAKERS_DEV_READY_POLL_SECONDS = 200;

/**
 * Host-side budget for one makers-dev launch.
 *
 * Derived rather than written down, because the two drifted once already: the
 * outer number was raised to four minutes while the poll inside it still gave
 * up at ninety seconds, so the launch that motivated the raise went on failing
 * at the same moment it always had. The headroom is for what happens after the
 * poll gives up — tailing the log and signalling the processes — not for more
 * waiting.
 */
export const MAKERS_DEV_LAUNCH_TIMEOUT_SECONDS = MAKERS_DEV_READY_POLL_SECONDS + 40;

/**
 * Stop the framework dev server, for a command that is about to build in the
 * same directory.
 *
 * `next build` and `next dev` share .next, and the build loses that race: it
 * writes a manifest, the dev server rewrites the directory underneath it, and
 * the build then fails copying a file that no longer exists. Nothing about the
 * failure points at the dev server — it surfaces as a bare ENOENT on whichever
 * file happened to lose — so this runs unconditionally rather than in response
 * to anything.
 *
 * Two ways of finding it, because neither is reliable alone: the recorded PID
 * misses a framework server that outlived the CLI which spawned it, and the
 * port misses nothing but depends on tools the image may not ship. Only the
 * first works on an image with neither fuser nor lsof, which is why the pid is
 * recorded on every launch rather than only before a deploy.
 *
 * `announce` is printed when a recorded server was actually signalled, for
 * callers whose own output is all the model will read.
 */
export function buildMakersDevStopScript(makersPort: number, announce = '') {
  return [
    `stop_announce=${shellQuote(announce)}`,
    'stop_makers_dev() {',
    `  if [ -f ${shellQuote(MAKERS_DEV_PID_PATH)} ]; then`,
    `    stop_pid=$(cat ${shellQuote(MAKERS_DEV_PID_PATH)} 2>/dev/null)`,
    '    if [ -n "$stop_pid" ]; then',
    '      if command -v pkill >/dev/null 2>&1; then',
    '        pkill -TERM -P "$stop_pid" >/dev/null 2>&1 || true',
    '      fi',
    '      kill -TERM "$stop_pid" >/dev/null 2>&1 || true',
    // Said out loud because the caller is usually a build or an install the
    // model issued, and a preview that stopped without a word is a preview it
    // goes on describing as running.
    '      if [ -n "$stop_announce" ]; then echo "$stop_announce" >&2; fi',
    '    fi',
    `    rm -f ${shellQuote(MAKERS_DEV_PID_PATH)}`,
    '  fi',
    '  if command -v fuser >/dev/null 2>&1; then',
    `    fuser -k ${makersPort}/tcp >/dev/null 2>&1 || true`,
    '  elif command -v lsof >/dev/null 2>&1; then',
    `    lsof -ti tcp:${makersPort} | xargs kill -TERM >/dev/null 2>&1 || true`,
    '  fi',
    // A dev server that has stopped answering can still be flushing into .next,
    // and starting the build in that window loses the race it just avoided.
    '  for _ in 1 2 3 4 5; do',
    `    curl --noproxy '*' -fsS -o /dev/null http://127.0.0.1:${makersPort}/ >/dev/null 2>&1 || break`,
    '    sleep 1',
    '  done',
    '  sleep 1',
    '}',
    'stop_makers_dev',
  ].join('\n');
}

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
 * Whether the upstream just said it serves the application under the prefix.
 *
 * Some frameworks have no asset-only prefix knob. Vite's `base` is the whole of
 * what it offers, and it moves the served paths along with the asset URLs — set
 * it and a request for the stripped path is answered with a redirect back into
 * the base, while every asset exists only under it. Leave it unset and the
 * assets are emitted root-absolute, which the gateway does not publish, so a
 * stylesheet 404s while the document still answers 200.
 *
 * That redirect is the signal. An upstream that sends one is asking to be
 * addressed with the prefix, so the proxy stops stripping for the rest of its
 * life and both halves line up: the framework emits prefixed URLs and receives
 * prefixed requests.
 */
export function previewUpstreamClaimsPrefix(
  statusCode: number | undefined,
  location: unknown,
  prefix = '/preview',
) {
  const normalizedPrefix = normalizePreviewPrefix(prefix);
  if (!normalizedPrefix) return false;
  if (!statusCode || statusCode < 300 || statusCode >= 400) return false;
  if (typeof location !== 'string' || !location) return false;
  // The header may be absolute or relative, and only its path matters here.
  let path = location;
  const schemeEnd = location.indexOf('://');
  if (schemeEnd !== -1) {
    const afterHost = location.indexOf('/', schemeEnd + 3);
    path = afterHost === -1 ? '/' : location.slice(afterHost);
  } else if (!location.startsWith('/')) {
    return false;
  }
  path = path.split('?')[0];
  return path === normalizedPrefix || path.startsWith(`${normalizedPrefix}/`);
}

/**
 * The same claim as above, from a framework that states it with a 404.
 *
 * `previewUpstreamClaimsPrefix` reads a redirect, which is what Vite sends. It
 * is not what every framework sends: Astro with `base` set treats a request
 * outside the base as a route it does not have and answers 404, so nothing in
 * the response points at the base at all. The two behaviours are identical in
 * intent and only the status separates them.
 *
 * That gap is not hypothetical. The runtime writes `base` into astro.config.mjs
 * for the preview prefix, so it is self-inflicted and it lands on every Astro
 * project: the readiness poll asks for the prefix, the proxy strips it, Astro
 * 404s on the root, and the launch spends its whole budget polling a server
 * that is up and answering — reported as a preview that never came up.
 *
 * A 404 is weaker evidence than a redirect, though, because it is also what a
 * genuinely missing page returns. So this only proposes the retry; what settles
 * it is the retry's own status. Anything but a second 404 means the prefixed
 * path is a route the upstream knows and the stripped one was not, and the
 * proxy stops stripping. Two 404s mean the page is simply absent, the second
 * answer is served, and nothing is remembered — except on the homepage, where
 * the same pair of 404s is also what a server still compiling looks like. The
 * readiness poll asks for `/` every second, so a once-per-process latch there
 * would spend the whole launch budget on a server that later answers 200.
 *
 * Returns the path to re-request, or undefined when this is not that case —
 * including when nothing was stripped, where the retry would be the same
 * request a second time.
 */
export function previewPrefixProbe(
  requestUrl: string | undefined,
  forwardedPath: string | undefined,
  statusCode: number | undefined,
  prefix = '/preview',
) {
  const normalizedPrefix = normalizePreviewPrefix(prefix);
  if (!normalizedPrefix || !requestUrl || !forwardedPath) return undefined;
  if (statusCode !== 404) return undefined;
  if (forwardedPath === requestUrl) return undefined;
  const path = requestUrl.split('?')[0];
  if (path !== normalizedPrefix && !path.startsWith(`${normalizedPrefix}/`)) return undefined;
  return requestUrl;
}

/**
 * Whether a 404 probe is for the readiness document itself.
 *
 * Subpath 404s stay latched after one miss so a missing page is not asked
 * twice. The homepage cannot be: the first pair of 404s is often "not compiled
 * yet", and locking that answer is how an Astro preview never comes up.
 */
export function previewPrefixProbeIsHome(forwardedPath: string | undefined) {
  if (!forwardedPath) return false;
  const path = forwardedPath.split('?')[0];
  return path === '/' || path === '';
}

/**
 * The path to re-request when the upstream's redirect only adds or removes a
 * trailing slash, or undefined when the redirect says anything else.
 *
 * Next normalizes a trailing slash away before it matches a route, so it
 * answers /articles/ with a 308 to /articles whether or not that route exists.
 * The gateway in front of this proxy does the opposite to an extension-less
 * path, reading it as a directory and sending it to the slash form. Passed on,
 * the two undo each other: the browser bounces between /preview/articles and
 * /preview/articles/ until the gateway gives up and serves its own loop page,
 * and the project never renders at all.
 *
 * Neither side is wrong on its own, so the proxy settles it instead of picking
 * a winner — it follows the normalization itself and answers with the result,
 * which takes the redirect off the wire and leaves the browser on the URL it
 * asked for. Same reasoning as the prefix retry: a redirect whose target this
 * proxy will only send back is not one the browser can make progress on.
 *
 * Everything else is left alone, so a project's own redirects() and an auth
 * bounce still reach the browser as redirects.
 */
export function previewTrailingSlashFollow(
  forwardedPath: string | undefined,
  statusCode: number | undefined,
  location: unknown,
) {
  if (!forwardedPath) return undefined;
  if (!statusCode || statusCode < 300 || statusCode >= 400) return undefined;
  // Only a same-origin path. An absolute URL is a move off this server, which
  // is the browser's to make even when the paths happen to line up.
  if (typeof location !== 'string' || !location.startsWith('/')) return undefined;
  const from = forwardedPath.split('?')[0];
  const to = location.split('?')[0];
  if (from === to) return undefined;
  return withoutTrailingSlash(from) === withoutTrailingSlash(to) ? location : undefined;
}

// '/' keeps its slash: against '' it is a move to the root, not a normalization.
function withoutTrailingSlash(value: string) {
  return value.length > 1 && value.endsWith('/') ? value.slice(0, -1) : value;
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

/**
 * Where an in-app URL has to point for the preview to reach it.
 *
 * The deployed site lives at /, so `href="/"` and `fetch('/api/x')` are the
 * correct code — and in preview they are the one form that cannot work: the
 * gateway forwards nothing but the prefix, so a root-absolute path leaves the
 * application and lands on the sandbox's own page, which answers 200 and looks
 * like the project rendered nothing. Restoring the prefix here is the same
 * decision `rewriteLocation` already makes for redirects, moved to the two
 * places a browser goes without asking the server first.
 *
 * The token is carried for the same reason: preview opens with it in the query
 * string and no in-app URL has a query of its own, so the first navigation used
 * to drop it and every later request went out unauthenticated.
 *
 * Returns undefined when the URL is already correct, which is most of them.
 */
export function previewRestoredUrl(
  rawUrl: string,
  pageUrl: string,
  prefix = '/preview',
  token = '',
) {
  const normalizedPrefix = normalizePreviewPrefix(prefix);
  if (!rawUrl || !normalizedPrefix) return undefined;
  let target: URL;
  let page: URL;
  try {
    page = new URL(pageUrl);
    target = new URL(rawUrl, pageUrl);
  } catch {
    return undefined;
  }
  // Another origin is not this application's to rewrite, and a scheme like
  // mailto: or javascript: has no path to prefix in the first place.
  if (target.origin !== page.origin || !/^https?:$/.test(target.protocol)) {
    return undefined;
  }
  const inside = target.pathname === normalizedPrefix
    || target.pathname.startsWith(`${normalizedPrefix}/`);
  const needsToken = Boolean(token) && !target.searchParams.has('access_token');
  if (inside && !needsToken) return undefined;
  if (!inside) target.pathname = `${normalizedPrefix}${target.pathname}`;
  if (needsToken) target.searchParams.set('access_token', token);
  return target.toString();
}

/**
 * The preview launch.
 *
 * Deliberately carries no `--area`: `makers dev` does not accept the flag (it is
 * absent from the command's own options and from its implementation), and the
 * CLI does not enable strictOptions, so passing it is silently dropped rather
 * than rejected. The acceleration area is decided before this runs, by
 * `ensureMakersPublishProject` creating the project through the SDK — that
 * create is what pins the area, and `dev` then reuses the project it finds.
 * Adding the flag back here would only make the launch look like it decides
 * something it does not.
 */
export function buildMakersDevLaunchCommand(port: number, projectName: string) {
  return [
    'edgeone makers dev',
    `--port ${port}`,
    '--skip-env-sync',
    '--skip-ai-gateway-sync',
    `--name ${shellQuote(projectName)}`,
  ].join(' ');
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

export type MakersDevBackgroundOptions = {
  makersPort: number;
  previewPort: number;
  previewPath: string;
  projectName: string;
  /** Name only; the launcher owns the value, which is always the live prefix. */
  assetPrefixEnvName: string;
  forceRestart?: boolean;
};

export function buildMakersDevBackgroundCommand({
  makersPort,
  previewPort,
  previewPath,
  projectName,
  assetPrefixEnvName,
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
    // Reuse only a proxy this agent would have written itself. An older one
    // answers every probe here while still mangling requests downstream.
    'preview_proxy_matches() {',
    '  rm -f /tmp/preview-proxy-health',
    `  curl --noproxy '*' -fsS -o /dev/null -D /tmp/preview-proxy-health \\`,
    `    ${shellQuote(proxyHealthUrl)} >/dev/null 2>&1 \\`,
    `    && grep -qi ${shellQuote(`x-edgeone-preview-proxy: ${proxyRevision}`)} \\`,
    '      /tmp/preview-proxy-health',
    '}',
    // fuser and lsof are the only way to name the holder of an arbitrary port,
    // and the image may ship neither, so every failure here is silenced. That
    // is survivable for the proxy port, which is why the proxy is reused rather
    // than replaced. The application port does not depend on this — see below.
    'free_port() {',
    '  if command -v fuser >/dev/null 2>&1; then fuser -k "$1/tcp" >/dev/null 2>&1 || true',
    '  elif command -v lsof >/dev/null 2>&1; then lsof -ti "tcp:$1" | xargs kill -9 >/dev/null 2>&1 || true',
    '  fi',
    '}',
    // Defined beside the other helpers so both the failure report and a live
    // tail can drop the same stacks. See makersDevLogExcerptScript.
    'report_makers_dev_log() {',
    makersDevLogExcerptScript('"$1"'),
    '}',
    ...(!forceRestart ? [
      `if preview_proxy_matches && curl --noproxy '*' -fsS ${shellQuote(readyUrl)} >/dev/null 2>&1; then`,
      '  echo "MAKERS_DEV_READY=already-running"',
      '  echo "MAKERS_DEV_EXIT:0"',
      '  exit 0',
      'fi',
    ] : []),
    // The proxy is stateless and the revision proves it forwards the way this
    // agent expects, so a live one is kept even when the application behind it
    // has died. Starting a second one instead only wins the port when the first
    // is gone: otherwise it exits EADDRINUSE, and the failure accounting below
    // then tears down the application that had just come up healthy.
    'if preview_proxy_matches; then reuse_proxy=1; else reuse_proxy=0; fi',
    // The previous server has to be gone before the CLI starts, and this is the
    // one way to be sure of it: the launcher recorded that pid itself, so no
    // port-inspection tool has to exist for the kill to land. Leaving it alive
    // does not fail loudly — the CLI takes the next free port instead, comes up
    // healthy on it, and reports itself ready while the proxy goes on polling a
    // port nothing will ever answer. That is a launch which cannot be recovered
    // by launching again, because the second attempt is held by the same
    // process and drifts to the same wrong port.
    buildMakersDevStopScript(makersPort),
    `if [ "$reuse_proxy" -ne 1 ]; then free_port ${previewPort}; fi`,
    'sleep 1',
    // After the stop, not before: a healthy preview that is already answering
    // exits above without waiting. A launch that reaches here is about to
    // start the framework, and starting it against a node_modules the warmup
    // is still writing is the 90-second ECONNREFUSED that used to be reported
    // as a preview timeout.
    buildNpmWarmupWaitScript(),
    `if ! node -e ${shellQuote(writeProxyScript)}; then`,
    '  echo "Failed to write the preview proxy script." >&2',
    '  echo "MAKERS_DEV_EXIT:125"',
    '  exit 0',
    'fi',
    `rm -f ${shellQuote(MAKERS_DEV_LOG_PATH)} /tmp/preview-proxy.log`,
    // Exported into the CLI so a framework that emits its own asset URLs can
    // prefix them. Nothing downstream is required to read it: a project that
    // ignores it behaves exactly as before.
    `${assetPrefixEnvName}=${shellQuote(prefix)} nohup ${launch} > ${shellQuote(MAKERS_DEV_LOG_PATH)} 2>&1 &`,
    'dev_pid=$!',
    // Recorded so a later deploy can stop this server before building in the
    // same directory; nothing here reads it back.
    `echo "$dev_pid" > ${shellQuote(MAKERS_DEV_PID_PATH)}`,
    "proxy_pid=''",
    'if [ "$reuse_proxy" -ne 1 ]; then',
    `  nohup node ${shellQuote(PREVIEW_PROXY_SCRIPT_PATH)} > /tmp/preview-proxy.log 2>&1 &`,
    '  proxy_pid=$!',
    'fi',
    "bound_port=''",
    'frontend_dead=0',
    `for i in $(seq 1 ${MAKERS_DEV_READY_POLL_SECONDS}); do`,
    `  if curl --noproxy '*' -fsS ${shellQuote(proxyHealthUrl)} >/dev/null 2>&1 \\`,
    `    && curl --noproxy '*' -fsS ${shellQuote(readyUrl)} >/dev/null 2>&1; then`,
    '    echo "MAKERS_DEV_READY=started"',
    '    echo "MAKERS_DEV_EXIT:0"',
    '    exit 0',
    '  fi',
    '  if ! kill -0 "$dev_pid" >/dev/null 2>&1; then break; fi',
    '  if [ -n "$proxy_pid" ] && ! kill -0 "$proxy_pid" >/dev/null 2>&1; then break; fi',
    // The CLI announces the port it took. Reading it turns the one failure that
    // looks like a slow start into a fact, and stops the polling that cannot
    // succeed: on a drifted port every second of the poll below is spent
    // waiting for an answer from a port the server never bound.
    '  if [ -z "$bound_port" ]; then',
    `    bound_port=$(grep -o 'Running at: http://localhost:[0-9]*' ${
      shellQuote(MAKERS_DEV_LOG_PATH)
    } 2>/dev/null | head -n 1 | tr -dc '0-9')`,
    '  fi',
    `  if [ -n "$bound_port" ] && [ "$bound_port" != "${makersPort}" ]; then break; fi`,
    // The CLI keeps proxying after its frontend child dies, and every later
    // second of this poll is a connection the child will never accept. The
    // line is the CLI's own, written once, so this is a fact rather than a guess.
    `  if grep -qE ${shellQuote('Dev command exited|Error executing dev command')} ${
      shellQuote(MAKERS_DEV_LOG_PATH)
    } 2>/dev/null; then frontend_dead=1; break; fi`,
    // The poll's own request is what makes the app throw, so the error count
    // climbs once per second for as long as we keep asking. Reading it turns
    // the second failure that looks like a slow start into a fact: the server
    // answered, and it will answer the same way until the code changes.
    `  app_errors=$(grep -cE ${shellQuote(MAKERS_DEV_APP_ERROR_PATTERN)} ${
      shellQuote(MAKERS_DEV_LOG_PATH)
    } 2>/dev/null || true)`,
    `  if [ "\${app_errors:-0}" -ge ${MAKERS_DEV_APP_ERROR_THRESHOLD} ]; then break; fi`,
    '  sleep 1',
    'done',
    `if [ -n "$bound_port" ] && [ "$bound_port" != "${makersPort}" ]; then`,
    `  echo "edgeone makers dev bound port $bound_port instead of the requested ${makersPort}, so the preview proxy has nothing to forward to. Port ${makersPort} was still held when the CLI started." >&2`,
    '  echo "--- makers-dev log ---" >&2',
    `  tail -n 60 ${shellQuote(MAKERS_DEV_LOG_PATH)} >&2 2>/dev/null || true`,
    '  kill $proxy_pid "$dev_pid" >/dev/null 2>&1 || true',
    `  echo "MAKERS_DEV_EXIT:${MAKERS_DEV_PORT_DRIFT_EXIT}"`,
    '  exit 0',
    'fi',
    // Ahead of the throw counter: a command that has exited can also have
    // printed Error: lines, and those are the exit, not a route that throws
    // on every request.
    'if [ "$frontend_dead" = 1 ]; then',
    `  echo "edgeone makers dev is listening on port ${makersPort}, but the frontend dev server it proxies to already exited, so the preview cannot become ready. Starting the preview again runs that same command and fails the same way. Fix what the log names." >&2`,
    '  echo "--- makers-dev log ---" >&2',
    `  report_makers_dev_log ${shellQuote(MAKERS_DEV_LOG_PATH)} >&2`,
    '  echo "--- preview proxy log ---" >&2',
    '  tail -n 80 /tmp/preview-proxy.log >&2 2>/dev/null || true',
    '  kill $proxy_pid "$dev_pid" >/dev/null 2>&1 || true',
    `  echo "MAKERS_DEV_EXIT:${MAKERS_DEV_FRONTEND_EXIT}"`,
    '  exit 0',
    'fi',
    `if [ "\${app_errors:-0}" -ge ${MAKERS_DEV_APP_ERROR_THRESHOLD} ]; then`,
    `  echo "edgeone makers dev is serving on port ${makersPort}, but the project throws on every request, so the preview cannot become ready. Fix what the error below names and start the preview again; relaunching on its own changes nothing." >&2`,
    // One throw repeated eighty times used to be the whole of this report, and
    // the cause was as hard to find as it would have been in silence. Dropping
    // the per-line timestamp makes the repeats identical so they collapse to
    // the handful of distinct errors the project actually has.
    '  echo "--- makers-dev errors ---" >&2',
    `  grep -E ${shellQuote(MAKERS_DEV_APP_ERROR_PATTERN)} ${
      shellQuote(MAKERS_DEV_LOG_PATH)
    } 2>/dev/null | sed -E "s/^[0-9]{1,2}:[0-9]{2}:[0-9]{2}( (AM|PM))? //" | awk '!seen[$0]++' | head -n 5 >&2 || true`,
    '  echo "--- makers-dev log ---" >&2',
    `  tail -n 40 ${shellQuote(MAKERS_DEV_LOG_PATH)} >&2 2>/dev/null || true`,
    '  kill $proxy_pid "$dev_pid" >/dev/null 2>&1 || true',
    `  echo "MAKERS_DEV_EXIT:${MAKERS_DEV_APP_ERROR_EXIT}"`,
    '  exit 0',
    'fi',
    `echo "edgeone makers dev did not become ready on port ${makersPort} (proxied via ${previewPort}${prefix}/). The CLI proxies the application to its frontend dev server; connection refused there means that server never accepted connections. Repeated proxy stacks are omitted below." >&2`,
    'echo "--- makers-dev log ---" >&2',
    `report_makers_dev_log ${shellQuote(MAKERS_DEV_LOG_PATH)} >&2`,
    'echo "--- preview proxy log ---" >&2',
    'tail -n 80 /tmp/preview-proxy.log >&2 2>/dev/null || true',
    'dev_status=124',
    'if ! kill -0 "$dev_pid" >/dev/null 2>&1; then',
    '  wait "$dev_pid" >/dev/null 2>&1',
    '  dev_status=$?',
    'fi',
    'if [ -n "$proxy_pid" ] && ! kill -0 "$proxy_pid" >/dev/null 2>&1; then',
    '  wait "$proxy_pid" >/dev/null 2>&1',
    '  proxy_status=$?',
    '  if [ "$dev_status" -eq 124 ]; then dev_status=$((125 + proxy_status)); fi',
    'fi',
    'kill $proxy_pid "$dev_pid" >/dev/null 2>&1 || true',
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
