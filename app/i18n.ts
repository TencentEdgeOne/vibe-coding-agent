'use client';

export type { Locale, HomeFeatureIcon } from './i18n/types.ts';
export { LANGUAGE_STORAGE_KEY } from './i18n/types.ts';
import type { Locale } from './i18n/types.ts';
import { zh as platformZh } from './i18n/zh.ts';
import { en as platformEn } from './i18n/en.ts';
import { applySiteCopy } from './i18n/site-copy.ts';

export const TRANSLATIONS = {
  zh: applySiteCopy('zh', platformZh),
  en: applySiteCopy('en', platformEn),
} as const;

export type UiCopy = (typeof TRANSLATIONS)[Locale];
export type FileCopy = UiCopy['files'];
export type SessionCopy = UiCopy['session'];
