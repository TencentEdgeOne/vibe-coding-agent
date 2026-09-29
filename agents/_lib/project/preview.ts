import { requireSandbox, type AgentContext } from '../runtime/context.ts';
import {
  PREVIEW_PATH_PREFIX,
  PREVIEW_PUBLIC_PORT,
  PREVIEW_SERVER_PORT,
} from '../constants.ts';
import type { ProjectState } from '../types.ts';
import { shellQuote } from '../utils/shell.ts';
import { runCommandCapturingExit, runSandboxCommand } from './commands.ts';
import { SITE_PREVIEW_LOG, buildSitePreviewLaunch, syncVitePreviewConfig } from '../site/preview-launch.ts';

export async function resolvePublicLinks(context: AgentContext) {
  const sandbox = requireSandbox(context);
  const previewHost = await Promise.resolve(sandbox.getHost?.(PREVIEW_PUBLIC_PORT));
  const accessToken = sandbox.envdAccessToken;
  const previewBaseUrl = normalizePublicUrl(previewHost);
  const sandboxDebugUrl = normalizePublicUrl(sandbox.browser?.liveUrl);

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

/** How often a running preview may repaint the log a person is watching. */
const PREVIEW_LOG_POLL_MS = 2000;

const sleep = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * The stage, then the log underneath it.
 *
 * The stage is what is happening before the log exists — an install that has
 * not printed yet, a server that has not opened its file. Once the log has
 * lines, they are the process, and the stage stays as the heading so a tail
 * of framework output still says which step it belongs to.
 */
export function formatPreviewProgress(stage: string, log = '') {
  const body = log.trim();
  return body ? `${stage}\n\n${body}` : stage;
}

/**
 * The tail of a file some other command is writing, until `stop` says the
 * command has finished.
 *
 * The launcher keeps the dev server's own output in a file and does not return
 * until the server answers, so awaiting that command is a blank row for as
 * long as the boot takes. Reading the file from a second command is what
 * makes the wait visible. A read that fails says nothing about the boot.
 */
export async function followSandboxLog(
  context: AgentContext,
  logPath: string,
  stop: () => boolean,
  onTail: (tail: string) => void,
  readCommand?: string,
) {
  let previous = '';
  while (!stop()) {
    await sleep(PREVIEW_LOG_POLL_MS);
    if (stop()) return;
    try {
      const poll = await runSandboxCommand(
        context,
        readCommand ?? `tail -n 40 ${shellQuote(logPath)} 2>/dev/null || true`,
        { timeout: 15 },
      );
      const tail = poll.stdout.trim();
      if (tail && tail !== previous) {
        previous = tail;
        onTail(tail);
      }
    } catch {
      // A missed read is not a failed preview. The command writing the file
      // is still the thing that decides the outcome.
    }
  }
}

type PreviewServerOptions = {
  forceRestart?: boolean;
  /** Live text for the row a person is watching. Absent callers stay quiet. */
  onProgress?: (text: string) => void;
};

const previewStarts = new Map<string, Promise<ReturnType<typeof previewServerInfo>>>();

/**
 * One start per project at a time. The preview panel, the agent's
 * start_preview tool all end up here, often together; a second dev server on
 * the same port breaks the first. A caller
 * that does not force a restart joins the start in flight; a forced restart
 * runs after it.
 */
export function startPreviewServer(
  context: AgentContext,
  state: ProjectState,
  options: PreviewServerOptions = {},
) {
  const key = state.appDir;
  const inFlight = previewStarts.get(key);
  if (inFlight && !options.forceRestart) return inFlight;
  const start = (inFlight ?? Promise.resolve())
    .catch(() => undefined)
    .then(() => launchPreviewServer(context, state, options));
  previewStarts.set(key, start);
  const clear = () => {
    if (previewStarts.get(key) === start) previewStarts.delete(key);
  };
  start.then(clear, clear);
  return start;
}

/**
 * Start the site's own dev server and report where it is listening.
 * A slow boot stays on the progress row; a server that never answers fails.
 */
async function launchPreviewServer(
  context: AgentContext,
  state: ProjectState,
  options: PreviewServerOptions,
) {
  const forceRestart = options.forceRestart === true || await syncVitePreviewConfig(context, state);

  if (!forceRestart) {
    const warm = await runCommandCapturingExit(
      context,
      probePreviewReadyCommand(),
      { timeout: 5 },
    );
    if (warm.exitCode === 0) {
      return previewServerInfo('reuse', 'vite', false);
    }
  }

  options.onProgress?.(formatPreviewProgress('Starting the preview server'));
  const launch = await buildSitePreviewLaunch(context, state);
  let launchStopped = false;
  const followingLaunch = options.onProgress
    ? followSandboxLog(context, SITE_PREVIEW_LOG, () => launchStopped, (tail) => {
      options.onProgress?.(formatPreviewProgress('Starting the preview server', tail));
    })
    : Promise.resolve();
  let startResult: Awaited<ReturnType<typeof runSandboxCommand>>;
  try {
    startResult = await runSandboxCommand(context, launch.command, {
      cwd: state.appDir,
      timeout: 90,
    });
  } finally {
    launchStopped = true;
    await followingLaunch;
  }
  if (startResult.exitCode !== 0) {
    const failure = [startResult.stdout, startResult.stderr].filter(Boolean).join('\n').trim();
    throw new Error(failure || 'Failed to start the preview server.');
  }

  return previewServerInfo(launch.command, launch.framework, true);
}

/**
 * `restarted` is for the iframe: a reused process is still serving the page the
 * client already has, and a fresh one is not, so only the second case has to
 * cost the user a remount.
 */
function previewServerInfo(
  launchCommand: string,
  framework: string,
  restarted: boolean,
) {
  return {
    port: PREVIEW_SERVER_PORT,
    publicPort: PREVIEW_PUBLIC_PORT,
    proxyPath: PREVIEW_PATH_PREFIX,
    framework,
    command: launchCommand,
    readyPath: PREVIEW_PATH_PREFIX,
    ready: true,
    restarted,
  };
}

export async function isPreviewServerReady(
  context: AgentContext,
  readyPath = PREVIEW_PATH_PREFIX,
) {
  const result = await runCommandCapturingExit(
    context,
    probePreviewReadyCommand(readyPath),
    { timeout: 5 },
  );
  return result.exitCode === 0;
}

export async function assertPreviewServerReady(
  context: AgentContext,
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
    `curl --noproxy '*' -fsS ${shellQuote(`http://127.0.0.1:${PREVIEW_SERVER_PORT}${readyPath}`)} >/dev/null`,
    'echo EXIT:$?',
  ].join('\n');
}
