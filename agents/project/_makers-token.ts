import { randomUUID } from 'node:crypto';
import { Makers, MakersError } from '@edgeone/makers-sdk';
import type { ProjectState } from '../_types.ts';

const DEFAULT_SUB_TOKEN_TTL_SECONDS = 60 * 60;
const MIN_SUB_TOKEN_TTL_SECONDS = 15 * 60;
const MAX_SUB_TOKEN_TTL_SECONDS = 24 * 60 * 60;
const MAKERS_CLIENT_SOURCE = 'vibe-coding-agent';

let cachedPlatformClient: { masterToken: string; client: Makers } | null = null;

function pickEnvValue(context: any, key: string) {
  const value = context?.env?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function resolveMakersMasterToken(context: any) {
  return pickEnvValue(context, 'EDGEONE_PAGES_API_TOKEN');
}

export function resolveMakersSubTokenTtl(context: any) {
  const raw = pickEnvValue(context, 'MAKERS_SUB_TOKEN_TTL_SECONDS');
  if (!raw) {
    return DEFAULT_SUB_TOKEN_TTL_SECONDS;
  }

  const ttl = Number(raw);
  if (
    !Number.isInteger(ttl)
    || ttl < MIN_SUB_TOKEN_TTL_SECONDS
    || ttl > MAX_SUB_TOKEN_TTL_SECONDS
  ) {
    throw new Error(
      `MAKERS_SUB_TOKEN_TTL_SECONDS must be an integer between ${MIN_SUB_TOKEN_TTL_SECONDS} and ${MAX_SUB_TOKEN_TTL_SECONDS}.`,
    );
  }
  return ttl;
}

export function ensureMakersTenantId(state: ProjectState) {
  if (state.makersTenantId) {
    return state.makersTenantId;
  }

  // This identifier is persisted with project state but is not a credential.
  // Keeping it server-generated prevents a client-controlled conversation ID
  // from selecting another tenant.
  const tenantId = `vibe-${randomUUID().replaceAll('-', '')}`;
  state.makersTenantId = tenantId;
  return tenantId;
}

function getPlatformClient(masterToken: string) {
  if (cachedPlatformClient?.masterToken === masterToken) {
    return cachedPlatformClient.client;
  }

  // No host and no region: a production token finds its own home, because the
  // SDK probes the China endpoint first and caches whichever one answers.
  const client = new Makers({ token: masterToken, source: MAKERS_CLIENT_SOURCE });
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
  context: any,
  state: ProjectState,
  masterToken: string,
) {
  if (!masterToken) {
    throw new Error('Missing EDGEONE_PAGES_API_TOKEN in the Agent Runtime.');
  }

  const tenantId = ensureMakersTenantId(state);
  try {
    return await getPlatformClient(masterToken).tokens.create({
      tenantId,
      name: `vibe-coding-${tenantId}`,
      expiresIn: resolveMakersSubTokenTtl(context),
    });
  } catch (error) {
    throw new Error(formatTokenIssueError(error));
  }
}

/**
 * The single decision about which credential reaches the sandbox.
 *
 * EDGEONE_PAGES_API_TOKEN never leaves the Agent Runtime: the CLI only ever
 * sees a short-lived token scoped to this conversation's tenant.
 */
export async function resolveSandboxMakersToken(
  context: any,
  state: ProjectState,
  masterToken: string,
) {
  // Nothing configured to exchange. Let the CLI report the missing credential
  // in its own words instead of failing the turn on a token request that was
  // never going to succeed.
  if (!masterToken) {
    return '';
  }
  return (await issueSandboxMakersSubToken(context, state, masterToken)).token;
}

export function buildSandboxMakersEnv(sandboxToken = ''): Record<string, string> {
  return {
    PAGES_SOURCE: 'skills',
    ...(sandboxToken ? { EDGEONE_PAGES_API_TOKEN: sandboxToken } : {}),
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
