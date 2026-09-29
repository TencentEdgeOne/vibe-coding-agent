/**
 * Models API key collection for a generated AI project.
 *
 * `.env.example` declares the names. The host records that a key is needed as
 * soon as it sees an AI project; the input card appears after that turn.
 * Submitting a key starts a coding-agent turn. The transcript shows a masked
 * "API Key" line; the system prompt tells the agent to restart the preview.
 */

import { persistWorkspace, setGatewayPending, setGatewaySkipped } from './workspace-store.ts';
import { requireSandbox, type AgentContext, type SandboxCapable } from '../runtime/context.ts';
import type { ProjectState, StreamSend } from '../types.ts';
import { getFileTree } from './fs.ts';
import { AGENT_GATEWAY_ENV_KEYS } from '../makers/declarations.ts';

/** Origin the Claude Agent SDK wants. OpenAI-compatible clients need `/v1` on top. */
export const AI_GATEWAY_ORIGIN = 'https://ai-gateway.edgeone.link';

/** Default written into a generated project's `.env` (DeepAgents / LangGraph / OpenAI). */
export const DEFAULT_AI_GATEWAY_BASE_URL = `${AI_GATEWAY_ORIGIN}/v1`;

/**
 * Claude's client treats the base as an origin and appends its own path.
 * OpenAI-compatible clients append `/chat/completions`, so they need `/v1`.
 */
export function gatewayBaseUrlForAgentFramework(framework?: string | null) {
  return framework === 'claude-agent-sdk' ? AI_GATEWAY_ORIGIN : DEFAULT_AI_GATEWAY_BASE_URL;
}

export const GATEWAY_CREDENTIALS_PAUSE_MESSAGE = [
  'AI_GATEWAY_API_KEY is not set in the project .env.',
  'The API key input card appears after this turn finishes.',
  'Do not call deploy_project or run a deploy command until they provide a key or skip.',
  'A missing key is not a preview failure, but a live publish still needs the card answered.',
].join(' ');

export function declaredGatewayKeys(content: string): string[] {
  return AGENT_GATEWAY_ENV_KEYS.filter((key) => (
    new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`, 'm').test(content)
  ));
}

export function envAssignmentValue(content: string, key: string): string {
  const match = content.match(new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=(.*)$`, 'm'));
  if (!match) return '';
  let value = match[1].trim();
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return value.trim();
}

async function readProjectFile(context: SandboxCapable, state: ProjectState, relPath: string) {
  try {
    const content = await requireSandbox(context).files.read(`${state.appDir}/${relPath}`);
    return typeof content === 'string' ? content : '';
  } catch {
    return '';
  }
}

export async function projectDeclaresGatewayKeys(
  context: AgentContext,
  state: ProjectState,
): Promise<boolean> {
  const content = await readProjectFile(context, state, '.env.example');
  return Boolean(content) && declaredGatewayKeys(content).length > 0;
}

async function projectHasAgentsDirectory(context: AgentContext, state: ProjectState) {
  try {
    return Boolean(await requireSandbox(context).files.exists(`${state.appDir}/agents`));
  } catch {
    return false;
  }
}

export async function projectNeedsGatewayKey(
  context: AgentContext,
  state: ProjectState,
): Promise<boolean> {
  return await projectDeclaresGatewayKeys(context, state)
    || await projectHasAgentsDirectory(context, state);
}

export async function sandboxGatewayKeyIsSet(
  context: AgentContext,
  state: ProjectState,
): Promise<boolean> {
  const content = await readProjectFile(context, state, '.env');
  return Boolean(content) && Boolean(envAssignmentValue(content, 'AI_GATEWAY_API_KEY'));
}

async function readProjectAgentFramework(context: AgentContext, state: ProjectState) {
  const content = await readProjectFile(context, state, 'edgeone.json');
  if (!content) return '';
  try {
    const framework = JSON.parse(content)?.agents?.framework;
    return typeof framework === 'string' ? framework : '';
  } catch {
    return '';
  }
}

export async function readProjectGatewayEnv(
  context: AgentContext,
  state: ProjectState,
): Promise<Record<string, string>> {
  const content = await readProjectFile(context, state, '.env');
  if (!content) return {};
  const apiKey = envAssignmentValue(content, 'AI_GATEWAY_API_KEY');
  if (!apiKey) return {};
  return {
    AI_GATEWAY_API_KEY: apiKey,
    AI_GATEWAY_BASE_URL: envAssignmentValue(content, 'AI_GATEWAY_BASE_URL')
      || gatewayBaseUrlForAgentFramework(await readProjectAgentFramework(context, state)),
  };
}

function upsertEnvValues(content: string, values: Record<string, string>) {
  let next = content.replace(/\r\n/g, '\n');
  for (const [key, value] of Object.entries(values)) {
    const pattern = new RegExp(`^(\\s*(?:export\\s+)?${key}\\s*=).*$`, 'm');
    if (pattern.test(next)) {
      next = next.replace(pattern, (_match, prefix: string) => `${prefix}${value}`);
      continue;
    }
    next = `${next.replace(/\n*$/, '\n')}${key}=${value}\n`;
  }
  return next.replace(/^\n+/, '').replace(/\n*$/, '\n');
}

export async function writeSandboxGatewayEnv(
  context: AgentContext,
  state: ProjectState,
  values: Record<string, string>,
) {
  if (Object.keys(values).length === 0) return;
  const envPath = `${state.appDir}/.env`;
  let current = '';
  try {
    const existing = await requireSandbox(context).files.read(envPath);
    if (typeof existing === 'string') current = existing;
  } catch {
    current = '';
  }
  const next = upsertEnvValues(current, values);
  if (next === current.replace(/\r\n/g, '\n').replace(/\n*$/, '\n')) return;
  await requireSandbox(context).files.write(envPath, next);
}

async function publishFileTreeAfterEnvWrite(
  context: AgentContext,
  state: ProjectState,
  send?: StreamSend,
) {
  if (!send) return;
  try {
    send({
      type: 'file_tree',
      data: {
        root: state.appDir,
        items: await getFileTree(context, state),
      },
    });
  } catch {
    // The files panel still receives the listing on this SSE when a turn is live.
  }
}

export type GatewayPromptOptions = {
  conversationId?: string;
  send?: StreamSend;
};

function emitGatewayNeeded(send: StreamSend | undefined) {
  send?.({
    type: 'gateway_credentials',
    data: {
      status: 'needed',
      keys: [...AGENT_GATEWAY_ENV_KEYS],
    },
  });
}

function emitGatewayResolved(send: StreamSend | undefined, skipped = false) {
  send?.({
    type: 'gateway_credentials',
    data: {
      status: 'resolved',
      ...(skipped ? { skipped: true } : {}),
    },
  });
}

export async function askUserForGatewayCredentials(
  context: AgentContext,
  state: ProjectState,
  options: GatewayPromptOptions = {},
) {
  if (state.gatewaySkipped) return;
  if (await sandboxGatewayKeyIsSet(context, state)) return;
  if (state.gatewayPromptPending) {
    emitGatewayNeeded(options.send);
    return;
  }
  setGatewayPending(state, true);
  await persistGatewayState(context, options.conversationId || '', state);
  emitGatewayNeeded(options.send);
}

export function writeSuggestsAiGatewayProject(relPath: string, content: string) {
  const path = relPath.replace(/^\.?\//, '');
  if (path === 'agents' || path.startsWith('agents/')) return true;
  if (path === '.env.example' || path.endsWith('/.env.example')) {
    return declaredGatewayKeys(content).length > 0;
  }
  return false;
}

export async function shouldPauseForGatewayCredentials(
  context: AgentContext,
  state: ProjectState,
): Promise<boolean> {
  if (state.gatewaySkipped) return false;
  if (await sandboxGatewayKeyIsSet(context, state)) return false;
  return projectNeedsGatewayKey(context, state);
}

export async function pauseForGatewayCredentialsIfNeeded(
  context: AgentContext,
  state: ProjectState,
  options: GatewayPromptOptions = {},
): Promise<string> {
  if (!await shouldPauseForGatewayCredentials(context, state)) return '';
  await askUserForGatewayCredentials(context, state, options);
  return GATEWAY_CREDENTIALS_PAUSE_MESSAGE;
}

async function persistGatewayState(
  context: AgentContext,
  conversationId: string,
  state: ProjectState,
) {
  const id = conversationId.trim();
  if (!id) return;
  try {
    await persistWorkspace(context, id, state);
  } catch {
    // The card and `.env` write are still useful without a durable flag.
  }
}

export async function applyUserGatewayDecision(
  context: AgentContext,
  state: ProjectState,
  conversationId: string,
  decision: { apiKey?: string; skip?: boolean },
  send?: StreamSend,
): Promise<{ AI_GATEWAY_API_KEY?: string; AI_GATEWAY_BASE_URL?: string }> {
  if (decision.skip) {
    setGatewaySkipped(state, true);
    await persistGatewayState(context, conversationId, state);
    emitGatewayResolved(send, true);
    return {};
  }

  const apiKey = (decision.apiKey || '').trim();
  if (!apiKey) return {};

  const values = {
    AI_GATEWAY_API_KEY: apiKey,
    AI_GATEWAY_BASE_URL: gatewayBaseUrlForAgentFramework(
      await readProjectAgentFramework(context, state),
    ),
  };
  await writeSandboxGatewayEnv(context, state, values);
  setGatewayPending(state, false);
  setGatewaySkipped(state, false);
  await persistGatewayState(context, conversationId, state);
  await publishFileTreeAfterEnvWrite(context, state, send);
  emitGatewayResolved(send);
  return values;
}
