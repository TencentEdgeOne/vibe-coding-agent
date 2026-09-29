/**
 * Display-only masking for a Models API key in the conversation.
 *
 * The real value is sent beside this string, written to `.env`, and never
 * stored in the transcript.
 */
export function maskApiKey(value: string): string {
  const text = value.trim();
  if (!text) return '';
  if (text.length <= 4) return '•'.repeat(text.length);

  const prefix = text.startsWith('sk-') ? 'sk-' : '';
  const rest = prefix ? text.slice(3) : text;
  const tail = rest.slice(-4);
  const hidden = Math.max(4, Math.min(8, rest.length - 4));
  return `${prefix}${'•'.repeat(hidden)}${tail}`;
}

const NOT_A_KEY = /^(skip|none|null|undefined|true|false|yes|no|preview|deploy|token|key|apikey|api|跳过|预览|部署|没有|好的|继续)$/i;

/** sk- / gsk_ tokens, even when the sentence has no "api key" wording. */
const SHAPED_KEY = /\b(sk-ant-[A-Za-z0-9_\-]{8,}|sk-[A-Za-z0-9_\-]{8,}|gsk_[A-Za-z0-9_\-]{8,})\b/;

/**
 * "我的 apikey 是 …" / "API Key: …" / AI_GATEWAY_API_KEY=…
 * A connector is required so "API Key 输入框" is not treated as a secret.
 */
const LABELED_KEY = new RegExp(
  [
    '(?:api[\\s_-]*key|apikey|secret[\\s_-]*key|AI_GATEWAY_API_KEY|models?\\s+api\\s+key|密钥|钥匙)',
    '\\s*(?:is|=|：|:|为|是|配成|设为|设置为|set\\s+to)\\s*',
    '[`\'"]?([^\\s，。、；;\'"`]+)[`\'"]?',
  ].join(''),
  'i',
);

function isExtractableApiKey(value: string) {
  const key = value.trim();
  if (!key || key.length < 3 || key.includes('•')) return false;
  return !NOT_A_KEY.test(key);
}

export function redactApiKeyInText(text: string, apiKey: string): string {
  const key = apiKey.trim();
  if (!key || !text.includes(key)) return text;
  return text.split(key).join(maskApiKey(key));
}

/**
 * Pull a Models API key out of a chat sentence so the host can write `.env`
 * the same way the input card does. The returned text is what belongs in the
 * transcript — the raw value is never stored there.
 */
export function extractApiKeyFromUserText(text: string): { apiKey: string; maskedText: string } | null {
  const source = text.trim();
  if (!source) return null;

  let apiKey = '';
  const labeled = source.match(LABELED_KEY);
  if (labeled && isExtractableApiKey(labeled[1] || '')) {
    apiKey = labeled[1].trim();
  }
  if (!apiKey) {
    const shaped = source.match(SHAPED_KEY);
    if (shaped && isExtractableApiKey(shaped[1] || '')) {
      apiKey = shaped[1];
    }
  }
  if (!apiKey && /^[A-Za-z0-9_\-]{16,}$/.test(source) && isExtractableApiKey(source)) {
    apiKey = source;
  }
  if (!apiKey) return null;
  return { apiKey, maskedText: redactApiKeyInText(source, apiKey) };
}

export function resolveGatewayUserTurn(message: string, apiKeyFromBody?: string) {
  const extracted = extractApiKeyFromUserText(message);
  const apiKey = (apiKeyFromBody || extracted?.apiKey || '').trim();
  return {
    message: apiKey ? redactApiKeyInText(message, apiKey) : message,
    ...(apiKey ? { apiKey } : {}),
  };
}
