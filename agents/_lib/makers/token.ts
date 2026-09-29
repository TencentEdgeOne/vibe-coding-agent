import type { AgentContext } from '../runtime/context.ts';
import { randomUUID } from 'node:crypto';
import { Makers, MakersError } from '@edgeone/makers-sdk';
import type { ProjectState } from '../types.ts';
import { readProjectGatewayEnv } from '../project/gateway.ts';
import { bindMakersApiRegion, bindMakersTenantId } from '../project/workspace-store.ts';

// Every preview start, wrapped CLI call and deploy mints its own token, so this
// only has to outlive a single CLI invocation. An hour is already far more than
// that, which leaves nothing here worth configuring.
const SUB_TOKEN_TTL_SECONDS = 60 * 60;

let cachedPlatformClient: { masterToken: string; client: Makers } | null = null;

function pickEnvValue(context: AgentContext, key: string) {
  const value = context?.env?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function resolveMakersMasterToken(context: AgentContext) {
  return pickEnvValue(context, 'API_TOKEN');
}

export function ensureMakersTenantId(state: ProjectState) {
  if (state.makersTenantId) {
    return state.makersTenantId;
  }

  // This identifier is persisted with project state but is not a credential.
  // Keeping it server-generated prevents a client-controlled conversation ID
  // from selecting another tenant.
  const tenantId = `vibe-${randomUUID().replaceAll('-', '')}`;
  return bindMakersTenantId(state, tenantId);
}

function getPlatformClient(masterToken: string) {
  if (cachedPlatformClient?.masterToken === masterToken) {
    return cachedPlatformClient.client;
  }

  // No host and no region: a production token finds its own home, because the
  // SDK probes the China endpoint first and caches whichever one answers.
  const client = new Makers({ token: masterToken });
  cachedPlatformClient = { masterToken, client };
  return client;
}

// The activity scrubber blanks whatever follows a "token:" label, so a message
// ending in one turns the actual cause into [REDACTED] before anyone reads it.
function formatTokenIssueError(error: unknown) {
  if (error instanceof MakersError) {
    const details = [
      error.message,
      error.code ? `code=${error.code}` : '',
      error.requestId ? `requestId=${error.requestId}` : '',
    ].filter(Boolean).join(', ');
    return `Failed to issue a temporary Makers tenant credential. ${details}`;
  }
  return `Failed to issue a temporary Makers tenant credential. ${
    error instanceof Error ? error.message : String(error)
  }`;
}

export async function issueSandboxMakersSubToken(
  state: ProjectState,
  masterToken: string,
) {
  if (!masterToken) {
    throw new Error('Missing API_TOKEN in the Agent Runtime.');
  }

  const tenantId = ensureMakersTenantId(state);
  const client = getPlatformClient(masterToken);
  try {
    const created = await client.tokens.create({
      tenantId,
      name: `vibe-coding-${tenantId}`,
      expiresIn: SUB_TOKEN_TTL_SECONDS,
    });
    const region = client.region === 'china' || client.region === 'global'
      ? client.region
      : undefined;
    if (region) {
      bindMakersApiRegion(state, region);
    }
    return created;
  } catch (error) {
    throw new Error(formatTokenIssueError(error));
  }
}

/**
 * The single decision about which credential reaches the sandbox.
 *
 * API_TOKEN never leaves the Agent Runtime: the CLI only ever sees a
 * short-lived token scoped to this conversation's tenant, injected as
 * EDGEONE_PAGES_API_TOKEN — the name the sandbox CLI still reads.
 */
export async function resolveSandboxMakersToken(
  state: ProjectState,
  masterToken: string,
) {
  // Nothing configured to exchange. Let the CLI report the missing credential
  // in its own words instead of failing the turn on a token request that was
  // never going to succeed.
  if (!masterToken) {
    return '';
  }
  return (await issueSandboxMakersSubToken(state, masterToken)).token;
}

/**
 * The sandbox CLI's own wording names EDGEONE_PAGES_API_TOKEN and a browser
 * login, neither of which the operator can do from this host. The missing
 * thing is the runtime key that would have minted a tenant credential.
 */
export function describeMissingMakersRuntimeToken(output = '') {
  if (!/not authenticated|browser login is unavailable|Please provide a token via/i.test(output)) {
    return '';
  }
  return [
    'Missing API_TOKEN in the Agent Runtime.',
    'Live preview and deploy run `edgeone makers dev` inside the sandbox, which cannot open a browser login.',
    'Add API_TOKEN to the project environment variables and restart.',
  ].join(' ');
}

const SANDBOX_GATEWAY_KEY = 'AI_GATEWAY_API_KEY';
const SANDBOX_GATEWAY_URL = 'AI_GATEWAY_BASE_URL';

export function resolveSandboxGatewayEnv(context: AgentContext): Record<string, string> {
  const key = pickEnvValue(context, SANDBOX_GATEWAY_KEY);
  const url = pickEnvValue(context, SANDBOX_GATEWAY_URL);
  return {
    ...(key ? { [SANDBOX_GATEWAY_KEY]: key } : {}),
    ...(url ? { [SANDBOX_GATEWAY_URL]: url } : {}),
  };
}

/**
 * Read gateway values the user already wrote into the project's `.env`.
 *
 * `--skip-ai-gateway-sync` keeps the CLI from fetching a key of its own and
 * from binding cloud credentials; it then loads whatever that file holds.
 * Deploy copies the same file onto the project with `setEnvs` (runtime
 * master token, not the sandbox tenant token) so the live site can read it
 * from `context.env`. Asking for a missing key is the agent's turn, not
 * this helper's. A skip must still leave preview and deploy able to run.
 */
export async function prepareSandboxGatewayEnv(
  context: AgentContext,
  state: ProjectState,
) {
  return readProjectGatewayEnv(context, state);
}

export function buildSandboxMakersEnv(
  sandboxToken = '',
  region?: ProjectState['makersApiRegion'],
): Record<string, string> {
  return {
    PAGES_SOURCE: 'skills',
    ...(sandboxToken ? { EDGEONE_PAGES_API_TOKEN: sandboxToken } : {}),
    // The CLI's getLoginRegion() does not probe EDGEONE_PAGES_API_TOKEN: without
    // this it logs "Invalid region: undefined" and every CAPI call becomes
    // Invalid URL. The value is the site the SDK just probed for this token,
    // not an operator switch.
    ...(region === 'china' || region === 'global' ? { EDGEONE_PAGES_API_REGION: region } : {}),
    // A generated project that imports @edgeone/pages-blob trades the API token
    // for storage credentials on every request, and that exchange is scoped to
    // this variable. Deploys never perform it — the pipeline substitutes a
    // credential into the artifact instead — which is why a store that works on
    // the live site answers CREDENTIAL_ERROR in preview once the two ends
    // disagree. Unset, the value comes from a constant compiled into the
    // sandbox CLI, so it is pinned here rather than trusting whichever
    // environment that CLI happened to be built for.
    PAGES_BLOB_STS_ENV: 'prod',
  };
}
