import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  localeFromLanguageTags,
  localeFromRootDomain,
  resolveInitialLocale,
} from '../app/i18n/detect.ts';
import { LANGUAGE_STORAGE_KEY } from '../app/i18n/types.ts';

test('browser language tags are matched in preference order', () => {
  assert.equal(localeFromLanguageTags(['fr-FR', 'en-US']), 'en');
  assert.equal(localeFromLanguageTags(['fr-FR', 'zh-CN', 'en-US']), 'zh');
  assert.equal(localeFromLanguageTags(['zh-Hant', 'en-US']), 'zh');
  assert.equal(localeFromLanguageTags(['EN-gb']), 'en');
  assert.equal(localeFromLanguageTags(['fr-FR']), null);
});

test('an English browser defaults to English regardless of the root domain', () => {
  assert.equal(resolveInitialLocale({
    languages: ['en-US'],
    domain: 'edgeone.cool',
  }), 'en');
});

test('a supported browser language wins over the root-domain fallback', () => {
  assert.equal(resolveInitialLocale({
    languages: ['zh-CN', 'en-US'],
    domain: 'edgeone.dev',
  }), 'zh');
});

test('an unsupported browser language falls back to the root domain', () => {
  assert.equal(resolveInitialLocale({
    languages: ['fr-FR'],
    domain: 'edgeone.dev',
  }), 'en');
  assert.equal(resolveInitialLocale({
    languages: ['fr-FR'],
    domain: 'edgeone.cool',
  }), 'zh');
});

test('unknown domains default to Chinese', () => {
  assert.equal(localeFromRootDomain('localhost'), 'zh');
  assert.equal(localeFromRootDomain(''), 'zh');
});

test('.dev hosts and casing resolve to English', () => {
  assert.equal(localeFromRootDomain('EdgeOne.Dev.'), 'en');
  assert.equal(localeFromRootDomain('vibe.edgeone.dev'), 'en');
  assert.equal(localeFromRootDomain('preview.example.dev'), 'en');
});

test('an explicit stored choice remains authoritative', () => {
  assert.equal(resolveInitialLocale({
    stored: 'en',
    languages: ['zh-CN'],
    domain: 'edgeone.cool',
  }), 'en');
});

test('automatic detection is not persisted as an explicit choice', async () => {
  const hook = await readFile(
    'app/features/workspace/hooks/use-platform-links.ts',
    'utf8',
  );
  assert.equal(
    hook.match(/localStorage\.setItem\(LANGUAGE_STORAGE_KEY/g)?.length,
    1,
    'only the language switch may persist a preference',
  );
  assert.match(hook, /localStorage\.getItem\(LANGUAGE_STORAGE_KEY\)/);
  assert.equal(LANGUAGE_STORAGE_KEY, 'vibe-coding-platform-language');
});
