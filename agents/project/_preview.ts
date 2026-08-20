import {
  MAKERS_DEV_PORT,
  PREVIEW_PATH_PREFIX,
  PREVIEW_PUBLIC_PORT,
  PREVIEW_SERVER_PORT,
} from '../_constants';
import type { ProjectState } from '../_types';
import { debugLog } from '../utils/_debug';
import {
  PREVIEW_PROXY_SCRIPT_PATH,
  buildMakersDevLaunchCommand,
  buildPreviewProxyScript,
} from '../../shared/makers-dev';
import { redactSecret, shellQuote } from '../../shared/makers-deploy';
import { runCommandCapturingExit, runSandboxCommand } from './_commands';
import { ensureEdgeoneCli, resolveMakersDeployConfig } from './_makers-deploy';

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

function buildKillPortsScript(ports: number[]) {
  const fuser = ports.map((port) => `fuser -k ${port}/tcp 2>/dev/null || true;`).join(' ');
  const lsof = ports.map((port) => `lsof -ti tcp:${port} | xargs -r kill -9 2>/dev/null || true;`).join(' ');
  return [
    'if command -v fuser >/dev/null 2>&1; then',
    fuser,
    'elif command -v lsof >/dev/null 2>&1; then',
    lsof,
    'fi;',
    'sleep 1',
  ].join(' ');
}

export async function startPreviewServer(context: any, state: ProjectState) {
  const { token, projectName } = resolveMakersDeployConfig(context);
  const installed = await ensureEdgeoneCli(context, token);
  if (!installed.ok) {
    throw new Error(installed.error);
  }
  const launchCommand = buildMakersDevLaunchCommand(MAKERS_DEV_PORT, projectName);

  // makers-dev watches project files. On follow-up turns, keep the healthy
  // process instead of killing and rebuilding it. Agent routes get a smoke test;
  // if hot reload is still settling, fall back to a clean restart below.
  // The sandbox SDK throws SANDBOX_UNKNOWN_ERROR on a non-zero shell exit, so
  // a cold curl (exit 7 / connection refused) must not abort before we start
  // makers-dev. Always exit 0 and read EXIT:N.
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
      debugLog(context, '[preview-reuse-fallback]', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const release = await runSandboxCommand(
    context,
    buildKillPortsScript([PREVIEW_SERVER_PORT, MAKERS_DEV_PORT]),
    { timeout: 10 },
  );
  if (release.exitCode !== 0) {
    throw new Error(release.stderr || release.stdout || `Failed to free preview ports.`);
  }

  const proxyScript = buildPreviewProxyScript(
    PREVIEW_SERVER_PORT,
    MAKERS_DEV_PORT,
    PREVIEW_PATH_PREFIX.replace(/\/$/, ''),
  );
  const writeProxy = await runSandboxCommand(
    context,
    `node -e ${shellQuote(`require("fs").writeFileSync(${JSON.stringify(PREVIEW_PROXY_SCRIPT_PATH)}, ${JSON.stringify(proxyScript)})`)}`,
    { timeout: 10 },
  );
  if (writeProxy.exitCode !== 0) {
    throw new Error(writeProxy.stderr || writeProxy.stdout || 'Failed to write the preview proxy script.');
  }

  const startScript = [
    'set +e',
    'export PAGES_SOURCE=skills',
    token ? `export EDGEONE_PAGES_API_TOKEN=${shellQuote(token)}` : '',
    `: > /tmp/dev.log; : > /tmp/preview-proxy.log`,
    `nohup ${launchCommand} > /tmp/dev.log 2>&1 &`,
    `nohup node ${shellQuote(PREVIEW_PROXY_SCRIPT_PATH)} > /tmp/preview-proxy.log 2>&1 &`,
    'echo START_OK',
    'exit 0',
  ].filter(Boolean).join('\n');

  const startResult = await runSandboxCommand(context, startScript, {
    cwd: state.appDir,
    timeout: 15,
  });
  if (startResult.exitCode !== 0) {
    throw new Error(
      redactSecret(
        startResult.stderr || startResult.stdout || 'Failed to start edgeone makers dev.',
        token,
      ),
    );
  }

  const ready = await runSandboxCommand(
    context,
    [
      `for i in $(seq 1 60); do`,
      `  curl -fsS ${shellQuote(`http://127.0.0.1:${PREVIEW_SERVER_PORT}${PREVIEW_PATH_PREFIX}`)} >/dev/null && exit 0;`,
      '  sleep 1;',
      'done;',
      `echo "edgeone makers dev did not become ready on port ${MAKERS_DEV_PORT} (proxied via ${PREVIEW_SERVER_PORT}${PREVIEW_PATH_PREFIX})" >&2;`,
      'echo "--- makers-dev log ---" >&2;',
      'tail -n 120 /tmp/dev.log >&2 || true;',
      'echo "--- preview proxy log ---" >&2;',
      'tail -n 40 /tmp/preview-proxy.log >&2 || true;',
      'exit 1',
    ].join('\n'),
    { timeout: 80 },
  );

  if (ready.exitCode !== 0) {
    throw new Error(
      redactSecret(
        ready.stderr || ready.stdout || `Preview server did not become ready on port ${PREVIEW_SERVER_PORT}.`,
        token,
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
      `${smoke.stderr || smoke.stdout || 'Generated /chat endpoint smoke test failed.'}\nFix the generated agent or frontend configuration, then call publish_preview again. Do not probe external gateways or runtime internals.`,
    );
  }
}

export async function assertPreviewServerReady(context: any, readyPath = PREVIEW_PATH_PREFIX) {
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
    `curl -fsS ${shellQuote(`http://127.0.0.1:${PREVIEW_SERVER_PORT}${readyPath}`)} >/dev/null`,
    'echo EXIT:$?',
  ].join('\n');
}
