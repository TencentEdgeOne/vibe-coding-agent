import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_CONVERSATION_ID_HEADER,
  DEFAULT_SDK_PATH,
  buildCustomHeaders,
  resolveModelAccess,
} from '../agents/core/_model-access.ts';
import {
  DEFAULT_PATH,
  GATEWAY_CONVERSATION_ID_HEADER_NAME,
  GATEWAY_QUOTA_BYPASS_HEADER,
  GATEWAY_QUOTA_PROMPT_HEADER,
} from '../agents/_constants.ts';
import { createRecordConfigPort } from '../agents/core/adapters/_local.ts';

const GATEWAY_HEADERS = [GATEWAY_QUOTA_BYPASS_HEADER, GATEWAY_QUOTA_PROMPT_HEADER];

function resolve(config: Record<string, string>, overrides: Record<string, unknown> = {}) {
  return resolveModelAccess(createRecordConfigPort(config), {
    conversationId: 'conv-1',
    defaultModel: 'default-model',
    extraHeaders: GATEWAY_HEADERS,
    ...overrides,
  });
}

// The extraction must not quietly drift from the constants the runtime uses.
test('core defaults match the runtime constants they were lifted from', () => {
  assert.equal(DEFAULT_SDK_PATH, DEFAULT_PATH);
  assert.equal(DEFAULT_CONVERSATION_ID_HEADER, GATEWAY_CONVERSATION_ID_HEADER_NAME);
});

test('the gateway key wins over the Anthropic and DeepSeek fallbacks', () => {
  const result = resolve({
    AI_GATEWAY_API_KEY: 'gateway-key',
    ANTHROPIC_API_KEY: 'anthropic-key',
    DEEPSEEK_API_KEY: 'deepseek-key',
    AI_GATEWAY_BASE_URL: 'https://gateway.example.com',
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.access.apiKey, 'gateway-key');
  assert.equal(result.ok && result.access.baseUrl, 'https://gateway.example.com');
});

test('a DeepSeek key alone satisfies both the key and the auth token slot', () => {
  const result = resolve({
    DEEPSEEK_API_KEY: 'deepseek-key',
    DEEPSEEK_BASE_URL: 'https://deepseek.example.com',
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.access.apiKey, 'deepseek-key');
  assert.equal(result.ok && result.access.authToken, 'deepseek-key');
});

// Mirrors the original: an auth token with no API key still populates
// ANTHROPIC_API_KEY, because the SDK reads that slot.
test('an auth token backfills the API key the SDK reads', () => {
  const result = resolve({
    ANTHROPIC_AUTH_TOKEN: 'auth-token',
    ANTHROPIC_BASE_URL: 'https://anthropic.example.com',
  });

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.access.env?.ANTHROPIC_AUTH_TOKEN, 'auth-token');
  assert.equal(result.ok && result.access.env?.ANTHROPIC_API_KEY, 'auth-token');
  assert.equal(result.ok && result.access.apiKey, undefined);
});

test('missing credentials and missing base URL are distinct reason codes', () => {
  const noCredentials = resolve({ AI_GATEWAY_BASE_URL: 'https://gateway.example.com' });
  assert.equal(noCredentials.ok, false);
  assert.equal(!noCredentials.ok && noCredentials.reason, 'missing_credentials');

  const noBaseUrl = resolve({ AI_GATEWAY_API_KEY: 'k' });
  assert.equal(noBaseUrl.ok, false);
  assert.equal(!noBaseUrl.ok && noBaseUrl.reason, 'missing_base_url');

  // Codes, not prose: no English sentence for a host to have to translate.
  assert.doesNotMatch(JSON.stringify(noBaseUrl), /cannot call the model/i);
});

test('a validated request model outranks the configured default', () => {
  const config = {
    AI_GATEWAY_API_KEY: 'k',
    AI_GATEWAY_BASE_URL: 'https://gateway.example.com',
    AI_GATEWAY_MODEL: 'configured-model',
  };

  const configured = resolve(config);
  assert.equal(configured.ok && configured.access.model, 'configured-model');

  const chosen = resolve(config, { requestedModel: 'chosen-model' });
  assert.equal(chosen.ok && chosen.access.model, 'chosen-model');

  // An empty choice means "no choice", not "no model".
  const blank = resolve(config, { requestedModel: '   ' });
  assert.equal(blank.ok && blank.access.model, 'configured-model');

  const bare = resolve({ AI_GATEWAY_API_KEY: 'k', AI_GATEWAY_BASE_URL: 'https://x.example.com' });
  assert.equal(bare.ok && bare.access.model, 'default-model');
});

test('custom headers carry the conversation id and the gateway flags', () => {
  const headers = buildCustomHeaders('X-Existing: 1', 'conv-42', GATEWAY_HEADERS);
  const lines = headers.split('\n');

  assert.deepEqual(lines, [
    'X-Existing: 1',
    GATEWAY_QUOTA_BYPASS_HEADER,
    GATEWAY_QUOTA_PROMPT_HEADER,
    `${GATEWAY_CONVERSATION_ID_HEADER_NAME}: conv-42`,
  ]);
});

// Header injection guard carried over from the original sanitizeHeaderValue.
test('a conversation id cannot inject extra headers', () => {
  const headers = buildCustomHeaders('', 'conv\r\nX-Injected: evil', []);
  assert.equal(headers, `${GATEWAY_CONVERSATION_ID_HEADER_NAME}: conv X-Injected: evil`);
  assert.equal(headers.split('\n').length, 1);
});

test('an empty conversation id contributes no header line', () => {
  assert.equal(buildCustomHeaders('', '', []), '');
  assert.equal(buildCustomHeaders('', '   ', GATEWAY_HEADERS), GATEWAY_HEADERS.join('\n'));
});

test('process env defaults fill in only when the host supplies nothing', () => {
  const bare = resolve({ AI_GATEWAY_API_KEY: 'k', AI_GATEWAY_BASE_URL: 'https://x.example.com' });
  assert.equal(bare.ok && bare.access.env?.PATH, DEFAULT_PATH);
  assert.equal(bare.ok && bare.access.env?.HOME, '/tmp');
  assert.equal(bare.ok && bare.access.env?.CLAUDE_CONFIG_DIR, '/tmp/.claude');

  const custom = resolve({
    AI_GATEWAY_API_KEY: 'k',
    AI_GATEWAY_BASE_URL: 'https://x.example.com',
    PATH: '/custom/bin',
    HOME: '/home/agent',
    CLAUDE_CONFIG_DIR: '/home/agent/.claude',
  });
  assert.equal(custom.ok && custom.access.env?.PATH, '/custom/bin');
  assert.equal(custom.ok && custom.access.env?.HOME, '/home/agent');
});

test('resolving model access needs no context, only a config port', async () => {
  const source = await import('node:fs/promises')
    .then((fs) => fs.readFile('agents/core/_model-access.ts', 'utf8'));
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  assert.doesNotMatch(code, /context/);
  assert.doesNotMatch(code, /process\.env/);
});
