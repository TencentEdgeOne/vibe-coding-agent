import { randomUUID } from 'node:crypto';
import { Makers, MakersError } from '@edgeone/makers-sdk';
import type { ProjectState } from '../_types';

const DEFAULT_SUB_TOKEN_TTL_SECONDS = 60 * 60;
const MIN_SUB_TOKEN_TTL_SECONDS = 15 * 60;
const MAX_SUB_TOKEN_TTL_SECONDS = 24 * 60 * 60;
const MAKERS_CLIENT_SOURCE = 'vibe-coding-agent';

type MakersApiEnv = 'prod' | 'pre' | 'test';
type MakersRegion = 'china' | 'global';

// Mirrors the CLI's own tables (tef-cli src/common/urls.ts). The sandbox CLI
// picks its host from API_ENV plus EDGEONE_PAGES_API_REGION, so the SDK has to
// resolve that same pair here. Whenever the two ends can drift apart, the
// temporary token is issued by one environment and verified by another, and
// the sandbox only reports a bare "Your token is not valid".
const MAKERS_API_ENDPOINTS: Record<MakersApiEnv, Record<MakersRegion, string>> = {
  prod: {
    china: 'https://pages-api.cloud.tencent.com/v1',
    global: 'https://pages-api.edgeone.ai/v1',
  },
  pre: {
    china: 'https://pre-api.edgeone.ai/v1',
    global: 'https://pre-api.edgeone.ai/v1',
  },
  test: {
    china: 'https://eo-test.qcloud.com/v1',
    global: 'https://test-api.edgeone.ai/v1',
  },
};

type MakersEndpoint = {
  apiEnv: MakersApiEnv;
  region: MakersRegion | '';
  baseUrl: string;
};

let cachedPlatformClient:
  | { masterToken: string; baseUrl: string; region: string; client: Makers }
  | null = null;

function pickEnvValue(context: any, key: string) {
  const value = context?.env?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

function resolveMakersApiEnv(context: any): MakersApiEnv {
  const raw = pickEnvValue(context, 'MAKERS_API_ENV').toLowerCase();
  if (!raw) {
    return 'prod';
  }
  if (raw !== 'prod' && raw !== 'pre' && raw !== 'test') {
    throw new Error('MAKERS_API_ENV must be one of prod, pre, test.');
  }
  return raw;
}

function resolveMakersRegion(context: any): MakersRegion | '' {
  const raw = pickEnvValue(context, 'MAKERS_API_REGION').toLowerCase();
  if (!raw) {
    return '';
  }
  if (raw !== 'china' && raw !== 'global') {
    throw new Error('MAKERS_API_REGION must be either china or global.');
  }
  return raw;
}

export function resolveMakersEndpoint(context: any): MakersEndpoint {
  const apiEnv = resolveMakersApiEnv(context);
  const region = resolveMakersRegion(context);

  // A production token can find its own home: the SDK probes china first and
  // caches the hit, which keeps single-region tokens working with no config.
  // Test and pre hosts are never probed, so they have to be named outright.
  if (apiEnv === 'prod' && !region) {
    return { apiEnv, region: '', baseUrl: '' };
  }

  const resolvedRegion = region || 'china';
  return {
    apiEnv,
    region: resolvedRegion,
    baseUrl: MAKERS_API_ENDPOINTS[apiEnv][resolvedRegion],
  };
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

function getPlatformClient(masterToken: string, endpoint: MakersEndpoint) {
  if (
    cachedPlatformClient?.masterToken === masterToken
    && cachedPlatformClient.baseUrl === endpoint.baseUrl
    && cachedPlatformClient.region === endpoint.region
  ) {
    return cachedPlatformClient.client;
  }

  const client = new Makers({
    token: masterToken,
    source: MAKERS_CLIENT_SOURCE,
    ...(endpoint.baseUrl ? { baseUrl: endpoint.baseUrl } : {}),
    ...(endpoint.region ? { region: endpoint.region } : {}),
  });
  cachedPlatformClient = {
    masterToken,
    baseUrl: endpoint.baseUrl,
    region: endpoint.region,
    client,
  };
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
    return await getPlatformClient(
      masterToken,
      resolveMakersEndpoint(context),
    ).tokens.create({
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

export function buildSandboxMakersEnv(
  context: any,
  sandboxToken = '',
): Record<string, string> {
  const endpoint = resolveMakersEndpoint(context);
  return {
    PAGES_SOURCE: 'skills',
    ...(sandboxToken ? { EDGEONE_PAGES_API_TOKEN: sandboxToken } : {}),
    // The CLI treats an absent API_ENV as production. Pinning the region as
    // well keeps it off its own detection path, which probes production hosts
    // and would send a test credential to a production endpoint.
    ...(endpoint.apiEnv === 'prod' ? {} : { API_ENV: endpoint.apiEnv }),
    ...(endpoint.region ? { EDGEONE_PAGES_API_REGION: endpoint.region } : {}),
    // A generated project that imports @edgeone/pages-blob trades the API token
    // for storage credentials on every request, and that exchange is scoped to
    // this variable. Deploys never perform it — the pipeline substitutes a
    // credential into the artifact instead — which is why a store that works on
    // the live site answers CREDENTIAL_ERROR in preview once the two ends
    // disagree. Unset, the value comes from a constant compiled into the
    // sandbox CLI, so it is pinned here for production too rather than trusting
    // whichever environment that CLI happened to be built for.
    PAGES_BLOB_STS_ENV: endpoint.apiEnv === 'test' ? 'test' : 'prod',
  };
}
