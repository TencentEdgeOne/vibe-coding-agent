/**
 * Resolve how to reach the model, from config alone.
 *
 * Lifted out of runCodingAgent, where this sat inline as ~40 lines of
 * `pickEnvValue(context, ...)` calls. It is pure decision logic with no reason
 * to need an EdgeOne context, and pulling it out means the credential fallback
 * chain can finally be tested directly instead of through a live agent turn.
 */

import type { ConfigPort, ModelAccess } from './_ports.ts';

export const DEFAULT_SDK_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

/**
 * Header the gateway reads to attribute a request to a conversation. The name
 * is host protocol, so it is a caller-supplied parameter rather than a literal
 * baked into the core.
 */
export const DEFAULT_CONVERSATION_ID_HEADER = 'Makers-Conversation-Id';

export type ModelAccessFailure =
  | 'missing_credentials'
  | 'missing_base_url';

export type ModelAccessResult =
  | { ok: true; access: ModelAccess }
  | { ok: false; reason: ModelAccessFailure; checkedKeys: string[] };

const API_KEY_KEYS = ['AI_GATEWAY_API_KEY', 'ANTHROPIC_API_KEY', 'DEEPSEEK_API_KEY'];
const AUTH_TOKEN_KEYS = ['ANTHROPIC_AUTH_TOKEN', 'DEEPSEEK_API_KEY'];
const BASE_URL_KEYS = ['AI_GATEWAY_BASE_URL', 'ANTHROPIC_BASE_URL', 'DEEPSEEK_BASE_URL'];
const MODEL_KEYS = ['AI_GATEWAY_MODEL', 'ANTHROPIC_MODEL', 'DEEPSEEK_MODEL'];

function firstValue(config: ConfigPort, keys: string[]) {
  for (const key of keys) {
    const value = config.get(key);
    if (value) return value;
  }
  return '';
}

function sanitizeHeaderValue(value: string) {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/**
 * Attach the conversation id so the gateway can attribute the request.
 * Newlines are stripped because these are joined into a header block.
 */
export function buildCustomHeaders(
  customHeaders: string,
  conversationId: string,
  extraHeaders: string[] = [],
  conversationIdHeaderName = DEFAULT_CONVERSATION_ID_HEADER,
) {
  const safeConversationId = sanitizeHeaderValue(conversationId);
  return [
    customHeaders,
    ...extraHeaders,
    safeConversationId ? `${conversationIdHeaderName}: ${safeConversationId}` : '',
  ].filter(Boolean).join('\n');
}

export function resolveModelAccess(
  config: ConfigPort,
  options: {
    conversationId: string;
    /** A validated per-turn choice; '' falls back to the deployment default. */
    requestedModel?: string;
    defaultModel: string;
    extraHeaders?: string[];
    conversationIdHeaderName?: string;
  },
): ModelAccessResult {
  const apiKey = firstValue(config, API_KEY_KEYS);
  const authToken = firstValue(config, AUTH_TOKEN_KEYS);

  if (!apiKey && !authToken) {
    return { ok: false, reason: 'missing_credentials', checkedKeys: [...API_KEY_KEYS, ...AUTH_TOKEN_KEYS] };
  }

  const baseUrl = firstValue(config, BASE_URL_KEYS);
  if (!baseUrl) {
    return { ok: false, reason: 'missing_base_url', checkedKeys: BASE_URL_KEYS };
  }

  const model = (options.requestedModel || '').trim()
    || firstValue(config, MODEL_KEYS)
    || options.defaultModel;

  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_MODEL: model,
    ANTHROPIC_CUSTOM_HEADERS: buildCustomHeaders(
      config.get('ANTHROPIC_CUSTOM_HEADERS'),
      options.conversationId,
      options.extraHeaders,
      options.conversationIdHeaderName,
    ),
    PATH: config.get('PATH') || DEFAULT_SDK_PATH,
    HOME: config.get('HOME') || '/tmp',
    CLAUDE_CONFIG_DIR: config.get('CLAUDE_CONFIG_DIR') || '/tmp/.claude',
  };

  if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
  if (authToken) env.ANTHROPIC_AUTH_TOKEN = authToken;
  // Some gateways authenticate with a token but the SDK only reads the key slot.
  if (!env.ANTHROPIC_API_KEY && authToken) env.ANTHROPIC_API_KEY = authToken;

  return {
    ok: true,
    access: {
      model,
      baseUrl,
      apiKey: apiKey || undefined,
      authToken: authToken || undefined,
      customHeaders: env.ANTHROPIC_CUSTOM_HEADERS,
      env,
    },
  };
}
