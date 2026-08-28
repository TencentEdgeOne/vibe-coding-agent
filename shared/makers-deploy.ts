/**
 * Runtime-agnostic helpers for Makers CLI --json deploy output and URL detection.
 * Keep this free of sandbox / React imports so tests and the frontend can share it.
 */

import type { DeploymentInfo } from './protocol.ts';
import { MAKERS_CLI_UNAVAILABLE_MESSAGE, isEdgeoneCliUnavailable } from './tool-phase.ts';

export function buildMakersDeployCommand(projectName: string, requestedCommand = '') {
  const previewEnvironment = /(?:^|\s)(?:-e|--environment)(?:\s+|=)preview(?:\s|$)/i
    .test(requestedCommand);
  const launch = [
    'edgeone makers deploy',
    `-n ${shellQuote(projectName)}`,
    '--json',
    previewEnvironment ? '-e preview' : '',
  ].filter(Boolean).join(' ');
  return [
    'set +e',
    'rm -f /tmp/makers-deploy.log',
    `${launch} > /tmp/makers-deploy.log 2>&1`,
    'deploy_status=$?',
    'cat /tmp/makers-deploy.log',
    'echo "MAKERS_DEPLOY_EXIT:$deploy_status"',
    // Preserve the CLI output even on failure; the command adapter converts
    // the marker back into an MCP tool error after parsing it.
    'exit 0',
  ].join('\n');
}

export function parseMakersDeployExitCode(output: string) {
  const matches = [...output.matchAll(/(?:^|\n)MAKERS_DEPLOY_EXIT:(\d+)(?=\s|$)/g)];
  if (matches.length === 0) return undefined;
  const value = Number(matches.at(-1)?.[1]);
  return Number.isInteger(value) ? value : undefined;
}

export type MakersDeploySuccess = {
  status: 'success';
  url: string;
  type?: string;
  projectId?: string;
  deploymentId?: string;
  consoleUrl?: string;
};

export type MakersDeployFailure = {
  status: 'error';
  error: string;
};

export type MakersDeployJson = MakersDeploySuccess | MakersDeployFailure;

export function parseMakersDeployJson(stdout: string, stderr = ''): MakersDeployJson {
  const combined = [stdout, stderr].filter(Boolean).join('\n');
  const lines = combined
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.status === 'success' && typeof parsed.url === 'string' && parsed.url.trim()) {
        return {
          status: 'success',
          url: parsed.url.trim(),
          ...(typeof parsed.type === 'string' ? { type: parsed.type } : {}),
          ...(typeof parsed.projectId === 'string' ? { projectId: parsed.projectId } : {}),
          ...(typeof parsed.deploymentId === 'string' ? { deploymentId: parsed.deploymentId } : {}),
          ...(typeof parsed.consoleUrl === 'string' ? { consoleUrl: parsed.consoleUrl } : {}),
        };
      }
      if (parsed.status === 'error') {
        const error = typeof parsed.error === 'string' && parsed.error.trim()
          ? parsed.error.trim()
          : 'Deploy failed.';
        return { status: 'error', error };
      }
    } catch {
      // Keep scanning earlier lines; CLI may print non-JSON before the result.
    }
  }

  const textMatch = combined.match(/EDGEONE_DEPLOY_URL=(\S+)/);
  if (textMatch?.[1]) {
    return { status: 'success', url: textMatch[1] };
  }

  const quota = combined.match(/Makers project exceeds \d+ limit/i);
  if (quota) {
    return { status: 'error', error: quota[0] };
  }

  return {
    status: 'error',
    error: 'Deploy did not return a parseable --json result.',
  };
}

export function formatMakersDeployFailure(stdout: string, stderr = '', fallback = ''): string {
  const parsed = parseMakersDeployJson(stdout, stderr);
  const combined = [stderr, stdout, fallback].filter(Boolean).join('\n').trim();
  let error = parsed.status === 'error' ? parsed.error : '';
  if (!error || error === 'Deploy did not return a parseable --json result.') {
    error = combined.slice(-1500) || fallback || 'Deploy failed.';
  }
  if (/exceeds \d+ limit/i.test(error) || /exceeds \d+ limit/i.test(combined)) {
    return [
      error.includes('exceeds') ? error : 'Makers project exceeds the account limit.',
      'Do not delete other Makers projects and do not call Pages APIs.',
      'Tell the user the account is out of project quota and present only these choices: free a slot in the console, or reuse an existing project name before rerunning the direct CLI deploy.',
    ].join(' ');
  }
  return error;
}

export type MakersDeployOutcome =
  | Omit<MakersDeploySuccess, 'type'>
  | { status: 'cli-missing'; error: string }
  | { status: 'error'; error: string; exitCode?: number };

/**
 * The single reading of what the CLI just did.
 *
 * Two callers publish — the model through its command tool, and the deploy
 * button through its own pipeline — and a disagreement between them would show
 * as a deployment the UI calls failed while the site is live, or the reverse.
 */
export function readMakersDeployOutcome(
  stdout: string,
  stderr = '',
  secret = '',
): MakersDeployOutcome {
  const combined = [stdout, stderr].filter(Boolean).join('\n');
  if (isEdgeoneCliUnavailable(combined)) {
    return { status: 'cli-missing', error: MAKERS_CLI_UNAVAILABLE_MESSAGE };
  }

  // Read before redacting: the deploy URL carries a token query value that can
  // overlap the credential, and redacting first would cut the link in half.
  const parsed = parseMakersDeployJson(stdout, stderr);
  const exitCode = parseMakersDeployExitCode(combined);
  if (parsed.status === 'success' && (exitCode == null || exitCode === 0)) {
    return {
      status: 'success',
      url: parsed.url,
      ...(parsed.projectId ? { projectId: parsed.projectId } : {}),
      ...(parsed.deploymentId ? { deploymentId: parsed.deploymentId } : {}),
      ...(parsed.consoleUrl ? { consoleUrl: parsed.consoleUrl } : {}),
    };
  }

  return {
    status: 'error',
    error: redactSecret(
      parsed.status === 'error'
        ? parsed.error
        : `edgeone makers deploy exited with code ${exitCode}.`,
      secret,
    ),
    ...(exitCode != null ? { exitCode } : {}),
  };
}

export function describeMakersDeployment(
  outcome: MakersDeployOutcome,
  timing: { startedAt: number; finishedAt?: number },
): DeploymentInfo {
  const finishedAt = timing.finishedAt ?? Date.now();
  if (outcome.status === 'success') {
    const { status, ...details } = outcome;
    return {
      status: 'success',
      startedAt: timing.startedAt,
      finishedAt,
      ...details,
    };
  }
  return {
    status: 'failed',
    startedAt: timing.startedAt,
    finishedAt,
    error: outcome.error,
  };
}

export function isMakersDeployUrl(url?: string | null): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (parsed.pathname === '/preview/' || parsed.pathname.startsWith('/preview/')) {
      return false;
    }
    return /(?:^|\.)edgeone\.(?:cool|ai|link)$/i.test(parsed.hostname)
      || /(?:^|\.)pages\.edgeone\./i.test(parsed.hostname)
      || /(?:^|\.)edgeone\.page$/i.test(parsed.hostname);
  } catch {
    return false;
  }
}

export function redactSecret(text: string, secret: string) {
  if (!secret) return text;
  return text.split(secret).join('[redacted]');
}

export function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
