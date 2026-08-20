import {
  DEFAULT_MAKERS_DEPLOY_PROJECT_NAME,
  buildEdgeoneCliEnsureScript,
  buildMakersPreviewVerifyScript,
  formatMakersDeployFailure,
  parseMakersDeployJson,
  redactSecret,
  shellQuote,
} from '../../shared/makers-deploy';
import { parseEchoedExitCode } from '../../shared/tool-phase';
import { runSandboxCommand } from './_commands';
import type { ProjectState } from '../_types';

const CLI_INSTALL_TIMEOUT_S = 420;
const CLI_ENSURE_ATTEMPTS = 2;
const DEPLOY_TIMEOUT_S = 600;
const VERIFY_TIMEOUT_S = 45;

export type MakersDeployToolResult =
  | {
      ok: true;
      url: string;
      httpStatus: number;
      verified: boolean;
      warning?: string;
      projectId?: string;
      deploymentId?: string;
      consoleUrl?: string;
    }
  | { ok: false; error: string };

function pickEnvValue(context: any, key: string) {
  const value = context?.env?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function resolveMakersDeployConfig(context: any): {
  token: string;
  projectName: string;
} {
  const token = pickEnvValue(context, 'EDGEONE_PAGES_API_TOKEN');
  const projectName = pickEnvValue(context, 'MAKERS_DEPLOY_PROJECT_NAME')
    || DEFAULT_MAKERS_DEPLOY_PROJECT_NAME;
  return { token, projectName };
}

export async function deployProjectToMakers(
  context: any,
  state: ProjectState,
): Promise<MakersDeployToolResult> {
  const { token, projectName } = resolveMakersDeployConfig(context);
  if (!token) {
    return {
      ok: false,
      error: 'Missing EDGEONE_PAGES_API_TOKEN. Set it in the environment to mock-deploy generated projects to Makers.',
    };
  }

  const appDirExists = await context.sandbox.files.exists(state.appDir);
  if (!appDirExists) {
    return { ok: false, error: 'Project workspace not found. Generate a project first.' };
  }

  const installed = await ensureEdgeoneCli(context, token);
  if (!installed.ok) {
    return installed;
  }

  const quotedToken = shellQuote(token);
  const quotedName = shellQuote(projectName);
  const deployScript = [
    'set +e',
    'export PAGES_SOURCE=skills',
    `edgeone makers deploy -n ${quotedName} -t ${quotedToken} --json`,
    'status=$?',
    'echo EXIT:$status',
    'exit 0',
  ].join('\n');

  let deployed;
  try {
    deployed = await runSandboxCommand(context, deployScript, {
      cwd: state.appDir,
      timeout: DEPLOY_TIMEOUT_S,
    });
  } catch (error) {
    return {
      ok: false,
      error: redactSecret(
        error instanceof Error ? error.message : String(error),
        token,
      ),
    };
  }

  const stdout = redactSecret(deployed.stdout || '', token);
  const stderr = redactSecret(deployed.stderr || '', token);
  const exitCode = parseEchoedExitCode(`${stdout}\n${stderr}`) ?? deployed.exitCode;
  const parsed = parseMakersDeployJson(stdout, stderr);
  if (parsed.status !== 'success' || exitCode !== 0) {
    return {
      ok: false,
      error: formatMakersDeployFailure(stdout, stderr, `Deploy exited with code ${exitCode}.`),
    };
  }

  const verified = await verifyMakersDeployUrl(context, parsed.url, token);
  // The browser preview follows eo_token → cookie. A curl probe without a
  // cookie jar used to 401 and send the model on a 20-minute CLI debug loop.
  // Once the CLI issued a URL, publish it even if the probe is flaky.
  if (!verified.ok) {
    return {
      ok: true,
      url: parsed.url,
      httpStatus: 0,
      verified: false,
      warning: `Deploy succeeded. HTTP probe could not confirm the URL (${verified.error}). The preview panel still uses this URL.`,
      ...(parsed.projectId ? { projectId: parsed.projectId } : {}),
      ...(parsed.deploymentId ? { deploymentId: parsed.deploymentId } : {}),
      ...(parsed.consoleUrl ? { consoleUrl: parsed.consoleUrl } : {}),
    };
  }

  return {
    ok: true,
    url: parsed.url,
    httpStatus: verified.httpStatus,
    verified: true,
    ...(parsed.projectId ? { projectId: parsed.projectId } : {}),
    ...(parsed.deploymentId ? { deploymentId: parsed.deploymentId } : {}),
    ...(parsed.consoleUrl ? { consoleUrl: parsed.consoleUrl } : {}),
  };
}

function isRetryableCliEnsureError(error: string) {
  return /timeout|deadline_exceeded|SANDBOX_NETWORK_ERROR|ETIMEDOUT|ECONNRESET|npm ERR/i.test(error);
}

async function tryEnsureEdgeoneCli(
  context: any,
  token: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let check;
  try {
    check = await runSandboxCommand(context, buildEdgeoneCliEnsureScript(), {
      timeout: CLI_INSTALL_TIMEOUT_S,
    });
  } catch (error) {
    return {
      ok: false,
      error: redactSecret(
        error instanceof Error ? error.message : String(error),
        token,
      ),
    };
  }
  const output = redactSecret([check.stdout, check.stderr].filter(Boolean).join('\n'), token);
  const exitCode = parseEchoedExitCode(output) ?? check.exitCode;
  if (exitCode !== 0) {
    return {
      ok: false,
      error: output || 'Failed to install the EdgeOne CLI in the sandbox.',
    };
  }
  return { ok: true };
}

export async function ensureEdgeoneCli(
  context: any,
  token: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  let lastFailure: { ok: false; error: string } | null = null;
  for (let attempt = 1; attempt <= CLI_ENSURE_ATTEMPTS; attempt += 1) {
    const result = await tryEnsureEdgeoneCli(context, token);
    if (result.ok) {
      return result;
    }
    lastFailure = result;
    if (attempt < CLI_ENSURE_ATTEMPTS && isRetryableCliEnsureError(result.error)) {
      continue;
    }
    return result;
  }
  return lastFailure || { ok: false, error: 'Failed to install the EdgeOne CLI in the sandbox.' };
}

async function verifyMakersDeployUrl(
  context: any,
  url: string,
  token: string,
): Promise<{ ok: true; httpStatus: number } | { ok: false; error: string }> {
  const quotedUrl = shellQuote(url);
  let verified;
  try {
    verified = await runSandboxCommand(context, buildMakersPreviewVerifyScript(quotedUrl), {
      timeout: VERIFY_TIMEOUT_S,
    });
  } catch (error) {
    return {
      ok: false,
      error: redactSecret(
        error instanceof Error ? error.message : String(error),
        token,
      ),
    };
  }
  const output = redactSecret([verified.stdout, verified.stderr].filter(Boolean).join('\n'), token);
  const httpMatch = output.match(/HTTP:(\d+)/);
  const httpStatus = httpMatch ? Number(httpMatch[1]) : 0;
  const exitCode = parseEchoedExitCode(output) ?? verified.exitCode;

  if (exitCode === 0 && httpStatus >= 200 && httpStatus < 400) {
    return { ok: true, httpStatus };
  }
  if (exitCode === 2) {
    return { ok: false, error: `HTTP ${httpStatus || 'error'} from the deployed URL.` };
  }
  if (exitCode === 3) {
    return { ok: false, error: 'Deployed URL returned an empty body.' };
  }
  return {
    ok: false,
    error: output || 'Failed to fetch the deployed URL.',
  };
}
