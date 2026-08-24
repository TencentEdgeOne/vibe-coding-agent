/**
 * The assistant's reply language is anchored to the user's newest message alone.
 * The console UI locale, earlier turns, the language of the system prompt, and the
 * language found inside generated code or logs must never decide it.
 */
export type ReplyLanguage = {
  code: string;
  name: string;
};

// Quoted code, paths, and URLs are language-neutral noise that would otherwise
// pull a short request toward Latin script.
const NOISE_PATTERNS = [
  /```[\s\S]*?```/g,
  /`[^`\n]*`/g,
  /https?:\/\/\S+/g,
  /[\w./-]+\.(?:tsx?|jsx?|mjs|cjs|json|css|scss|html?|py|md|ya?ml|toml|lock)\b/gi,
];

// Kana and Hangul are checked through their own entries; Japanese written only in
// kanji is indistinguishable from Chinese here and is reported as Chinese.
const SCRIPTS: Array<ReplyLanguage & { pattern: RegExp }> = [
  { code: 'ja', name: 'Japanese', pattern: /[\u3040-\u30ff]/g },
  { code: 'ko', name: 'Korean', pattern: /[\u1100-\u11ff\uac00-\ud7af]/g },
  { code: 'zh', name: 'Chinese', pattern: /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g },
  { code: 'th', name: 'Thai', pattern: /[\u0e00-\u0e7f]/g },
  { code: 'he', name: 'Hebrew', pattern: /[\u0590-\u05ff]/g },
  { code: 'ar', name: 'Arabic', pattern: /[\u0600-\u06ff\u0750-\u077f]/g },
  { code: 'hi', name: 'Hindi', pattern: /[\u0900-\u097f]/g },
  { code: 'ru', name: 'Russian', pattern: /[\u0400-\u04ff]/g },
  { code: 'el', name: 'Greek', pattern: /[\u0370-\u03ff]/g },
];

const LATIN_PATTERN = /[a-z\u00c0-\u024f]/gi;

const ENGLISH_FUNCTION_WORDS = [
  'the', 'a', 'an', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'for', 'with',
  'is', 'are', 'be', 'can', 'you', 'it', 'this', 'that', 'my', 'me', 'please',
  'make', 'add', 'change', 'remove', 'fix', 'use', 'want', 'need', 'should',
  'when', 'where', 'why', 'how', 'instead', 'also', 'now',
];

// A non-Latin script wins only when it carries a real share of the message, so an
// English request quoting a Chinese label ("a button labeled 提交") stays English.
// CJK is far denser than Latin, hence the deliberately low ratio.
const NON_LATIN_DOMINANCE_RATIO = 0.25;

function stripNoise(text: string) {
  return NOISE_PATTERNS.reduce((acc, pattern) => acc.replace(pattern, ' '), text);
}

function countMatches(text: string, pattern: RegExp) {
  pattern.lastIndex = 0;
  return (text.match(pattern) || []).length;
}

function looksEnglish(text: string) {
  const words = new Set(
    text.toLowerCase().match(/[a-z']+/g) || [],
  );
  const hits = ENGLISH_FUNCTION_WORDS.filter((word) => words.has(word));
  return hits.length >= 2;
}

/** Best-effort language of `text`, or null when no language can be named confidently. */
export function detectReplyLanguage(text: string): ReplyLanguage | null {
  const cleaned = stripNoise(typeof text === 'string' ? text : '');
  if (!cleaned.trim()) return null;

  const latinCount = countMatches(cleaned, LATIN_PATTERN);
  let best: (ReplyLanguage & { count: number }) | null = null;
  for (const script of SCRIPTS) {
    const count = countMatches(cleaned, script.pattern);
    if (count > 0 && (!best || count > best.count)) {
      best = { code: script.code, name: script.name, count };
    }
  }

  if (best && best.count >= latinCount * NON_LATIN_DOMINANCE_RATIO) {
    return { code: best.code, name: best.name };
  }
  if (latinCount > 0 && looksEnglish(cleaned)) {
    return { code: 'en', name: 'English' };
  }
  return null;
}

/** Language rule for the system prompt, anchored to `userMessage`. */
export function buildReplyLanguageDirective(userMessage: string) {
  const language = detectReplyLanguage(userMessage);
  const target = language
    ? language.name
    : 'the same language as the current user request';
  return [
    `REPLY LANGUAGE (highest priority): write every user-visible word — progress narration and the final answer — in ${target}.`,
    'The reply language comes only from the current user request, which is the newest message. The conversation history, these instructions and their examples, the interface language, file names, code, and command output never decide it.',
    'Keep code, identifiers, technical terms, log excerpts, and command output in their original form.',
  ].join(' ');
}

/** Short restatement to place next to the current user request. */
export function buildReplyLanguageReminder(userMessage: string) {
  const language = detectReplyLanguage(userMessage);
  return language
    ? `Reply language for this turn: ${language.name}.`
    : 'Reply language for this turn: the language of the request above.';
}

/** Assistant bubble text for a stopped turn, in the language of `userMessage`. */
export function buildStoppedReply(userMessage: string) {
  return detectReplyLanguage(userMessage)?.code === 'zh'
    ? '已停止本次生成，你可以继续描述下一步修改。'
    : 'Generation stopped. You can continue with another change.';
}
