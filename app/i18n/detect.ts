import type { Locale } from './types.ts';

export function isLocale(value: unknown): value is Locale {
  return value === 'zh' || value === 'en';
}

export function localeFromLanguageTags(languages: readonly string[]): Locale | null {
  for (const language of languages) {
    const tag = language.trim().toLowerCase();
    if (tag === 'zh' || tag.startsWith('zh-')) return 'zh';
    if (tag === 'en' || tag.startsWith('en-')) return 'en';
  }
  return null;
}

export function localeFromRootDomain(domain: string): Locale {
  const normalized = domain.trim().toLowerCase().replace(/\.$/, '');
  return normalized === 'dev' || normalized.endsWith('.dev') ? 'en' : 'zh';
}

export function resolveInitialLocale(options: {
  stored?: string | null;
  languages?: readonly string[];
  domain?: string;
}): Locale {
  if (isLocale(options.stored)) return options.stored;
  return localeFromLanguageTags(options.languages ?? [])
    ?? localeFromRootDomain(options.domain ?? '');
}
