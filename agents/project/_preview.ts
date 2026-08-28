import {
  MAKERS_DEV_PORT,
  PREVIEW_PATH_PREFIX,
  PREVIEW_PUBLIC_PORT,
  PREVIEW_SERVER_PORT,
} from '../_constants.ts';
import type { ProjectState } from '../_types.ts';
import { debugLog } from '../utils/_debug.ts';
import {
  buildMakersDevBackgroundCommand,
  buildMakersDevLaunchCommand,
  parseMakersDevExitCode,
} from '../../shared/makers-dev.ts';
import { redactSecret, shellQuote } from '../../shared/makers-deploy.ts';
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

export async function resolvePublicLinks(context: any) {
  const previewHost = context.sandbox.getHost(PREVIEW_PUBLIC_PORT);
  const accessToken = context.sandbox.envdAccessToken;
  const previewBaseUrl = normalizePublicUrl(previewHost);
  const sandboxDebugUrl = normalizePublicUrl(context.sandbox.browser?.liveUrl);
  debugLog(context, '[preview-link]', {
    internalPort: PREVIEW_SERVER_PORT,
    publicPort: PREVIEW_PUBLIC_PORT,
    makersDevPort: MAKERS_DEV_PORT,
    proxyPath: PREVIEW_PATH_PREFIX,
    hasPreviewHost: Boolean(previewBaseUrl),
    hasEnvdAccessToken: Boolean(accessToken),
    hasSandboxDebugUrl: Boolean(sandboxDebugUrl),
  });

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
      await assertGeneratedAgentChatReady(context, state);
      debugLog(context, '[preview-reuse]', {
        framework: 'makers-dev',
        makersDevPort: MAKERS_DEV_PORT,
        proxyPort: PREVIEW_SERVER_PORT,
      });
      return previewServerInfo(launchCommand);
    } catch (error) {
      forceRestart = true;
      debugLog(context, '[preview-reuse-fallback]', {
        message: error instanceof Error ? error.message : String(error),
      });
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
      env: buildSandboxMakersEnv(context, sandboxToken),
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

  await assertGeneratedAgentChatReady(context, state);

  debugLog(context, '[preview-start]', {
    framework: 'makers-dev',
    makersDevPort: MAKERS_DEV_PORT,
    proxyPort: PREVIEW_SERVER_PORT,
    readyPath: PREVIEW_PATH_PREFIX,
  });

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
  const smoke = await runSandboxCommand(
    context,
    [
      'rm -f /tmp/agent-chat-smoke-body /tmp/agent-chat-smoke-headers',
      [
        'curl -sS -N --max-time 45',
        "--noproxy '*'",
        '-D /tmp/agent-chat-smoke-headers',
        '-o /tmp/agent-chat-smoke-body',
        `-X POST ${shellQuote(endpoint)}`,
        `-H ${shellQuote('Content-Type: application/json')}`,
        `-H ${shellQuote('makers-conversation-id: preview-smoke-test')}`,
        `--data ${shellQuote(payload)}`,
      ].join(' '),
      'status=$?',
      'http=$(awk \'NR==1 {print $2}\' /tmp/agent-chat-smoke-headers 2>/dev/null)',
      'if [ "$status" -ne 0 ] || [ "$http" != "200" ]; then',
      '  echo "Generated /chat endpoint did not return HTTP 200." >&2',
      '  cat /tmp/agent-chat-smoke-body >&2 2>/dev/null || true',
      '  exit 1',
      'fi',
      'if ! grep -q \'data:\' /tmp/agent-chat-smoke-body || ! grep -q \'\\[DONE\\]\' /tmp/agent-chat-smoke-body; then',
      '  echo "Generated /chat endpoint did not return a complete SSE stream." >&2',
      '  cat /tmp/agent-chat-smoke-body >&2 2>/dev/null || true',
      '  exit 1',
      'fi',
      'if grep -Eq \'"(event|type)"[[:space:]]*:[[:space:]]*"(error|error_message)"\' /tmp/agent-chat-smoke-body; then',
      '  echo "Generated /chat endpoint returned an SSE error event." >&2',
      '  cat /tmp/agent-chat-smoke-body >&2 2>/dev/null || true',
      '  exit 1',
      'fi',
    ].join('\n'),
    { cwd: state.appDir, timeout: 55 },
  );
  if (smoke.exitCode !== 0) {
    throw new Error(
      `${smoke.stderr || smoke.stdout || 'Generated /chat endpoint smoke test failed.'}\nFix the generated agent or frontend configuration, then rerun edgeone makers dev. Do not probe external gateways or runtime internals.`,
    );
  }
}

export async function publishRunningPreview(context: any, state: ProjectState) {
  await assertPreviewServerReady(context);
  await assertGeneratedAgentChatReady(context, state);
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
