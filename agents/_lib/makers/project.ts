import type { AgentContext } from '../runtime/context.ts';
import { createHash } from 'node:crypto';
import { ConflictError, Makers } from '@edgeone/makers-sdk';
import type { ProjectState } from '../types.ts';
import { resolveMakersPublishTarget } from '../../../shared/publish-target.ts';

// One project per conversation, for preview and deployment alike.
//
// Both CLI commands resolve a project by name and create it when the lookup
// misses, so the name decides which project the conversation owns. A name
// shared by every conversation cannot work: a tenant token only sees projects
// its own tenant created, so the lookup misses a project another tenant
// already holds, the create then collides with the existing name, and preview
// dies on "Failed to create pages project" before it starts. Deploy has the
// same shape with a worse ending — it would publish over someone else's live
// site.
//
// Being a pure function of the session directory, the name needs no storage:
// every turn of the same conversation resolves to the same project.
const PROJECT_NAME_PREFIX = 'vibe';

function pickEnvValue(context: AgentContext, key: string) {
  const value = context?.env?.[key];
  return typeof value === 'string' ? value.trim() : '';
}

export function resolveMakersProjectName(context: AgentContext, state: ProjectState) {
  // An explicit name is an operator decision: honour it exactly, including the
  // consequence that every conversation then shares the one project.
  const pinned = pickEnvValue(context, 'MAKERS_DEPLOY_PROJECT_NAME');
  if (pinned) {
    return pinned;
  }

  // Hashed rather than embedded: the conversation ID ends up in a public
  // hostname once the project is deployed.
  const digest = createHash('sha256').update(state.sessionDir).digest('hex').slice(0, 10);
  return `${PROJECT_NAME_PREFIX}-${digest}`;
}

export function resolveConversationPublishArea(state: ProjectState) {
  return resolveMakersPublishTarget(state.siteDomain || '').area;
}

export type MakersPublishProjectClient = {
  projects: {
    list(options: { name: string; pageSize?: number }): Promise<{ items: Array<{ name: string }> }>;
    create(input: { name: string; area?: string }): Promise<unknown>;
  };
};

export type MakersProjectEnvClient = {
  projects: {
    list(options: { name: string; pageSize?: number }): Promise<{
      items: Array<{ name: string; projectId: string }>;
    }>;
    setEnvs(input: {
      projectId: string;
      envVars: ReadonlyArray<{ key: string; value: string }>;
    }): Promise<void>;
  };
};

const PUBLISHABLE_ENV_KEY = /^[A-Za-z][A-Za-z0-9_]*$/;
const UNPUBLISHED_ENV_KEYS = new Set([
  'API_TOKEN',
  'EDGEONE_PAGES_API_TOKEN',
  'PAGES_SOURCE',
]);

function isPublishableEnvKey(key: string) {
  return PUBLISHABLE_ENV_KEY.test(key)
    && !UNPUBLISHED_ENV_KEYS.has(key)
    && !key.startsWith('EDGEONE_PREVIEW_');
}

function unquoteEnvValue(value: string) {
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Local `.env` assignments that belong on the live Makers project.
 *
 * Preview already loads this file. Deploy has to copy it with the runtime
 * master token: `--skip-ai-gateway-sync` skips the bind that would otherwise
 * put a key into `context.env` on the live site, and tenant tokens are
 * rejected on `DescribePagesProjectEnvs` / `ModifyPagesProjectEnvs` (error
 * 107, "Action has not found").
 */
export function parsePublishableDotEnv(content: string) {
  const values: Record<string, string> = {};
  for (const rawLine of content.replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (!match) continue;
    const key = match[1];
    const value = unquoteEnvValue(match[2].trim());
    if (!value || !isPublishableEnvKey(key)) continue;
    values[key] = value;
  }
  return values;
}

async function readSandboxDotEnv(context: AgentContext, state: ProjectState) {
  try {
    const content = await context?.sandbox?.files?.read?.(`${state.appDir}/.env`);
    return typeof content === 'string' ? content : '';
  } catch {
    return '';
  }
}

function makersClient(
  token: string,
  region?: ProjectState['makersApiRegion'],
) {
  return new Makers({
    token,
    ...(region === 'china' || region === 'global' ? { region } : {}),
  });
}

/**
 * Create the conversation's Makers project with the right acceleration area
 * before `makers dev` runs. The sandbox CLI's auto-link still hardcodes
 * Area=global, and `--area` on `makers dev` is ignored by CLIs that predate
 * that flag — so leaving creation to the CLI is how a .dev site still ships
 * a global project.
 */
export async function ensureMakersPublishProject(
  token: string,
  projectName: string,
  area: string,
  region?: ProjectState['makersApiRegion'],
  client?: MakersPublishProjectClient,
) {
  if (!token || !projectName) return;

  const publishArea = area === 'overseas' ? 'overseas' : 'global';
  const projects = (client ?? makersClient(token, region)).projects;

  try {
    const listed = await projects.list({ name: projectName, pageSize: 10 });
    if (listed.items.some((project) => project.name === projectName)) {
      return;
    }
  } catch {
    // Create below is what pins the area. A list failure must not skip it:
    // ConflictError is how a project that existed all along is recognised.
  }

  try {
    await projects.create({ name: projectName, area: publishArea });
  } catch (error) {
    if (error instanceof ConflictError) return;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to create the Makers project before preview. ${detail}`);
  }
}

/**
 * Copy the sandbox project's `.env` onto the conversation's Makers project
 * before `makers deploy`. The CLI still skips AI Gateway bind — tenant tokens
 * fail that call — so this writes ordinary env vars with the runtime master
 * token, which is what generated agents read from `context.env` after publish.
 *
 * Listing also uses the master token: the conversation's project was created
 * under this account, and a tenant token cannot call the env APIs that
 * `setEnvs` depends on.
 */
export async function syncSandboxEnvToMakersProject(
  context: AgentContext,
  state: ProjectState,
  masterToken: string,
  projectName: string,
  region?: ProjectState['makersApiRegion'],
  client?: MakersProjectEnvClient,
) {
  if (!masterToken || !projectName) return;

  const envVars = Object.entries(parsePublishableDotEnv(
    await readSandboxDotEnv(context, state),
  )).map(([key, value]) => ({ key, value }));
  if (envVars.length === 0) return;

  const projects = (client ?? makersClient(masterToken, region)).projects;
  let projectId = '';
  try {
    const listed = await projects.list({ name: projectName, pageSize: 10 });
    projectId = listed.items.find((project) => project.name === projectName)?.projectId || '';
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to copy the project .env onto the live site. ${detail}`);
  }
  if (!projectId) {
    throw new Error('Failed to copy the project .env onto the live site. The Makers project was not found.');
  }

  try {
    await projects.setEnvs({ projectId, envVars });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to copy the project .env onto the live site. ${detail}`);
  }
}
