import {
  MAKERS_DEV_PORT,
  PREVIEW_PATH_PREFIX,
  PREVIEW_PUBLIC_PORT,
  PREVIEW_SERVER_PORT,
} from '../_constants.ts';
import type { ProjectState } from '../_types.ts';
import {
  GENERATED_API_SMOKE,
  GENERATED_CHAT_SMOKE,
  SMOKE_EXIT,
  buildGeneratedApiSmokeScript,
  buildGeneratedChatSmokeScript,
  buildMakersDevBackgroundCommand,
  buildMakersDevLaunchCommand,
  parseMakersDevExitCode,
} from '../../shared/makers-dev.ts';
import { makersFileSemantic } from '../../shared/makers-file-semantics.ts';
import { redactSecret } from '../../shared/makers-deploy.ts';
import { shellQuote } from '../../shared/shell.ts';
import {
  MAKERS_CLI_UNAVAILABLE_ERROR_CODE,
  MAKERS_CLI_UNAVAILABLE_MESSAGE,
  isEdgeoneCliUnavailable,
} from '../../shared/tool-phase.ts';
import { runCommandCapturingExit, runSandboxCommand } from './_commands.ts';
import { assertMakersProjectCompatible } from './_makers-compat.ts';
import { resolveMakersProjectName } from './_makers-deploy.ts';
import {
  buildSandboxMakersEnv,
  resolveMakersMasterToken,
  resolveSandboxMakersToken,
} from './_makers-token.ts';

// Where Makers mounts generated HTTP handlers; both are optional in a project.
const CLOUD_FUNCTION_DIRECTORIES = ['cloud-functions', 'edge-functions'];

export async function resolvePublicLinks(context: any) {
  const previewHost = context.sandbox.getHost(PREVIEW_PUBLIC_PORT);
  const accessToken = context.sandbox.envdAccessToken;
  const previewBaseUrl = normalizePublicUrl(previewHost);
  const sandboxDebugUrl = normalizePublicUrl(context.sandbox.browser?.liveUrl);

  const previewUrl = (previewBaseUrl && accessToken)
    ? buildPublicPreviewUrl(previewBaseUrl, accessToken)
    : undefined;

  return {
    previewUrl,
    sandboxDebugUrl,
  };
}

function normalizePublicUrl(value: unknown) {
  if (typeof value !== 'string') {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function buildPublicPreviewUrl(baseUrl: string, token: string) {
  try {
    const parsed = new URL(baseUrl);
    parsed.pathname = PREVIEW_PATH_PREFIX;
    parsed.search = '';
    parsed.hash = '';
    return appendAccessToken(parsed.toString(), token);
  } catch {
    const trimmedBase = baseUrl.replace(/\/+$/, '');
    return appendAccessToken(`${trimmedBase}${PREVIEW_PATH_PREFIX}`, token);
  }
}

function appendAccessToken(url: string, token: string) {
  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has('access_token')) {
      parsed.searchParams.set('access_token', token);
    }
    return parsed.toString();
  } catch {
    const separator = url.includes('?') ? '&' : '?';
    return `${url}${separator}access_token=${encodeURIComponent(token)}`;
  }
}

/** Rotate envdAccessToken on an already-published preview URL (same host/path). */
export function rewritePreviewAccessToken(existingUrl: string, token: string) {
  try {
    const parsed = new URL(existingUrl);
    parsed.searchParams.set('access_token', token);
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export async function startPreviewServer(context: any, state: ProjectState) {
  await assertMakersProjectCompatible(context, state);
  const masterToken = resolveMakersMasterToken(context);
  const projectName = resolveMakersProjectName(context, state);
  const launchCommand = buildMakersDevLaunchCommand(MAKERS_DEV_PORT, projectName);
  let forceRestart = false;

  // makers-dev watches project files. On resume, keep a healthy process rather
  // than starting a second CLI instance on the same port.
  const warm = await runCommandCapturingExit(
    context,
    probePreviewReadyCommand(),
    { timeout: 5 },
  );
  if (warm.exitCode === 0) {
    try {
      await assertGeneratedRoutesReady(context, state);
      return previewServerInfo(launchCommand);
    } catch (error) {
      // A warm port that fails to answer is a stale server, not a preview. One
      // that answers wrongly is a code bug the restart would only delay.
      if (!previewFailureWarrantsRestart(error)) throw error;
      forceRestart = true;
    }
  }

  // Scoped to this conversation, and redacted out of CLI output before the
  // model or the UI sees it.
  const sandboxToken = await resolveSandboxMakersToken(context, state, masterToken);

  const startResult = await runSandboxCommand(
    context,
    buildMakersDevBackgroundCommand({
      makersPort: MAKERS_DEV_PORT,
      previewPort: PREVIEW_SERVER_PORT,
      previewPath: PREVIEW_PATH_PREFIX,
      projectName,
      forceRestart,
    }),
    {
      cwd: state.appDir,
      timeout: 110,
      env: buildSandboxMakersEnv(sandboxToken),
    },
  );
  const startOutput = [startResult.stdout, startResult.stderr].filter(Boolean).join('\n');
  const capturedExitCode = parseMakersDevExitCode(startOutput);
  if (
    startResult.exitCode !== 0
    || (capturedExitCode != null && capturedExitCode !== 0)
  ) {
    const failure = isEdgeoneCliUnavailable(startOutput)
      ? `${MAKERS_CLI_UNAVAILABLE_ERROR_CODE}: ${MAKERS_CLI_UNAVAILABLE_MESSAGE}`
      : startOutput || 'Failed to start edgeone makers dev.';
    throw new Error(
      redactSecret(
        failure,
        sandboxToken,
      ),
    );
  }

  await assertGeneratedRoutesReady(context, state);

  return previewServerInfo(launchCommand);
}

function previewServerInfo(launchCommand: string) {
  return {
    port: PREVIEW_SERVER_PORT,
    publicPort: PREVIEW_PUBLIC_PORT,
    makersDevPort: MAKERS_DEV_PORT,
    proxyPath: PREVIEW_PATH_PREFIX,
    framework: 'makers-dev',
    command: launchCommand,
    readyPath: PREVIEW_PATH_PREFIX,
    ready: true,
  };
}

class GeneratedChatSmokeError extends Error {
  readonly kind: 'transport' | 'application';

  constructor(message: string, kind: 'transport' | 'application') {
    super(message);
    this.name = 'GeneratedChatSmokeError';
    this.kind = kind;
  }
}

/**
 * Restarting makers dev only helps when nothing answered, or answered wrong at
 * the transport level. Unknown failures keep the old behaviour and restart.
 */
export function previewFailureWarrantsRestart(error: unknown) {
  return !(error instanceof GeneratedChatSmokeError) || error.kind === 'transport';
}

/**
 * Both functional gates for a generated preview, cheapest first: a route that
 * 500s fails before the chat probe spends a model call on the same server.
 */
async function assertGeneratedRoutesReady(context: any, state: ProjectState) {
  await assertGeneratedApiRoutesReady(context, state);
  await assertGeneratedAgentChatReady(context, state);
}

function smokeFailure(exitCode: number | undefined, detail: string, guidance: string) {
  if (exitCode === SMOKE_EXIT.application) {
    return new GeneratedChatSmokeError(`${detail}\n${guidance}`, 'application');
  }
  return new GeneratedChatSmokeError(detail, 'transport');
}

/**
 * Probe the routes the generated project actually declares. Cloud functions get
 * no other functional gate: assertPreviewServerReady only proves the proxy and
 * the home page answer, so without this a project whose API throws on every
 * request still publishes a preview that looks fine until the user clicks.
 */
async function assertGeneratedApiRoutesReady(context: any, state: ProjectState) {
  // Scoped to the function directories rather than the whole file tree: this runs
  // on every preview publish, and getFileTree also repairs the app-dir layout.
  const listing = await runSandboxCommand(
    context,
    `find ${CLOUD_FUNCTION_DIRECTORIES.join(' ')} -type f 2>/dev/null | head -50 || true`,
    { cwd: state.appDir, timeout: 10 },
  );
  const paths = (listing.stdout || '')
    .split('\n')
    .map((line) => line.trim().replace(/^\.\//, ''))
    .filter(Boolean);
  const routes = [...new Set(
    paths
      .map((path) => makersFileSemantic({ path, type: 'file' }))
      .filter((semantic) => semantic?.capability === 'cloud-function'
        || semantic?.capability === 'edge-function')
      .map((semantic) => semantic?.route)
      // Dynamic and catch-all routes have no probeable form: there is no id to
      // invent for /api/:id, and a wildcard says nothing about what is mounted.
      .filter((route): route is string => typeof route === 'string'
        && route.length > 0
        && !route.includes(':')
        && !route.includes('*')),
  )];
  if (routes.length === 0) return;

  const smoke = await runSandboxCommand(
    context,
    buildGeneratedApiSmokeScript({
      baseUrl: `http://127.0.0.1:${PREVIEW_SERVER_PORT}${PREVIEW_PATH_PREFIX}`.replace(/\/$/, ''),
      routes,
    }),
    { cwd: state.appDir, timeout: GENERATED_API_SMOKE.commandTimeoutSeconds },
  );
  if (smoke.exitCode === 0) return;

  throw smokeFailure(
    smoke.exitCode,
    smoke.stderr || smoke.stdout || 'Generated API route smoke test failed.',
    "The preview server itself is healthy: the route answered with a server error or never answered at all, so fix the generated function. Only 5xx and hangs are treated as failures — 401, 403, 404 and 405 all pass. Do not probe external gateways or runtime internals.",
  );
}

async function assertGeneratedAgentChatReady(context: any, state: ProjectState) {
  const hasChatAgent = await Promise.all([
    context.sandbox.files.exists(`${state.appDir}/agents/chat.ts`),
    context.sandbox.files.exists(`${state.appDir}/agents/chat.js`),
  ]).then((matches) => matches.some(Boolean));
  if (!hasChatAgent) return;

  const endpoint = `http://127.0.0.1:${PREVIEW_SERVER_PORT}${PREVIEW_PATH_PREFIX}chat`;
  const payload = JSON.stringify({
    message: 'Reply with OK.',
    messages: [{ role: 'user', content: 'Reply with OK.' }],
  });
  // Fresh per probe: a fixed id accumulates history in the generated app's own
  // store, so every later probe pays for a longer prompt and gets a less
  // predictable reply to assert on.
  const smokeConversationId = `preview-smoke-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const smoke = await runSandboxCommand(
    context,
    buildGeneratedChatSmokeScript({
      endpoint,
      payload,
      conversationId: smokeConversationId,
    }),
    { cwd: state.appDir, timeout: GENERATED_CHAT_SMOKE.commandTimeoutSeconds },
  );
  if (smoke.exitCode === 0) return;

  const detail = smoke.stderr || smoke.stdout || 'Generated /chat endpoint smoke test failed.';
  throw smokeFailure(
    smoke.exitCode,
    detail,
    "The preview server itself is healthy: fix the generated agent's response, and makers dev will pick it up on save. Restarting the dev server will not change this. Do not probe external gateways or runtime internals.",
  );
}

export async function publishRunningPreview(
  context: any,
  state: ProjectState,
  options: { routesAlreadyVerified?: boolean } = {},
) {
  await assertPreviewServerReady(context);
  // The chat probe is a real model call against the generated agent, so skip the
  // whole gate when startPreviewServer just ran it.
  if (!options.routesAlreadyVerified) {
    await assertGeneratedRoutesReady(context, state);
  }
  const links = await resolvePublicLinks(context);
  if (!links.previewUrl) {
    throw new Error(`Makers dev is ready, but the sandbox did not return a public URL for port ${PREVIEW_PUBLIC_PORT}.`);
  }
  state.previewUrl = links.previewUrl;
  state.sandboxDebugUrl = links.sandboxDebugUrl;
  state.previewKind = 'sandbox';
  state.previewPublished = true;
  return {
    url: links.previewUrl,
    sandboxDebugUrl: links.sandboxDebugUrl,
    kind: 'sandbox' as const,
  };
}

export async function assertPreviewServerReady(
  context: any,
  readyPath = PREVIEW_PATH_PREFIX,
) {
  const result = await runCommandCapturingExit(
    context,
    probePreviewReadyCommand(readyPath),
    { timeout: 10 },
  );

  if (result.exitCode !== 0) {
    throw new Error(`Preview server is not ready on port ${PREVIEW_SERVER_PORT}${readyPath}.`);
  }
}

function probePreviewReadyCommand(readyPath = PREVIEW_PATH_PREFIX) {
  return [
    'set +e',
    `curl --noproxy '*' -fsS ${shellQuote(`http://127.0.0.1:${PREVIEW_SERVER_PORT}/__edgeone_preview_proxy_health`)} >/dev/null \\`,
    `  && curl --noproxy '*' -fsS ${shellQuote(`http://127.0.0.1:${PREVIEW_SERVER_PORT}${readyPath}`)} >/dev/null`,
    'echo EXIT:$?',
  ].join('\n');
}
