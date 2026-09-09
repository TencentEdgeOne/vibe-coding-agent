import assert from 'node:assert/strict';
import test from 'node:test';

import { PREVIEW_PATH_PREFIX } from '../agents/_constants.ts';
import {
  DEFAULT_PREVIEW_PATH_PREFIX,
  appendAccessToken,
  buildPublicPreviewUrl,
  normalizePublicUrl,
  previewTargetsMatch,
  resolvePreviewAllowedHost,
  resolvePreviewUrl,
  rewritePreviewAccessToken,
} from '../agents/core/_preview-url.ts';

test('the core default matches the runtime preview prefix', () => {
  assert.equal(DEFAULT_PREVIEW_PATH_PREFIX, PREVIEW_PATH_PREFIX);
});

test('a bare host is upgraded to https and a full URL is left alone', () => {
  assert.equal(normalizePublicUrl('host.example.com'), 'https://host.example.com');
  assert.equal(normalizePublicUrl('  host.example.com  '), 'https://host.example.com');
  assert.equal(normalizePublicUrl('http://host.example.com'), 'http://host.example.com');
  assert.equal(normalizePublicUrl('https://host.example.com'), 'https://host.example.com');

  for (const empty of ['', '   ', undefined, null, 42, {}]) {
    assert.equal(normalizePublicUrl(empty), undefined);
  }
});

test('the public preview URL is the origin plus the prefix, with a token', () => {
  const url = buildPublicPreviewUrl('https://host.example.com', 'tok');
  assert.equal(url, 'https://host.example.com/preview/?access_token=tok');
});

// The base may arrive carrying a path, query, or hash from an earlier session.
test('building a preview URL discards any inherited path, query, and hash', () => {
  const url = buildPublicPreviewUrl('https://host.example.com/old/path?a=1#frag', 'tok');
  const parsed = new URL(url);

  assert.equal(parsed.pathname, '/preview/');
  assert.equal(parsed.hash, '');
  assert.equal(parsed.searchParams.get('a'), null);
  assert.equal(parsed.searchParams.get('access_token'), 'tok');
});

test('an unparseable base still yields a usable URL via string fallback', () => {
  const url = buildPublicPreviewUrl('not a url///', 'tok');
  assert.equal(url, 'not a url/preview/?access_token=tok');
});

test('appending a token never clobbers one that is already there', () => {
  assert.equal(
    appendAccessToken('https://host.example.com/preview/?access_token=first', 'second'),
    'https://host.example.com/preview/?access_token=first',
  );
  assert.equal(
    appendAccessToken('https://host.example.com/preview/?keep=1', 'tok'),
    'https://host.example.com/preview/?keep=1&access_token=tok',
  );
});

// Rotation is the opposite: the whole point is replacing an expired token.
test('rewriting a token replaces the existing one and keeps other params', () => {
  assert.equal(
    rewritePreviewAccessToken('https://host.example.com/preview/?access_token=old&keep=1', 'new'),
    'https://host.example.com/preview/?access_token=new&keep=1',
  );
  assert.equal(rewritePreviewAccessToken('not a url', 'new'), undefined);
});

test('the browser live origin wins over the raw port host', () => {
  const url = resolvePreviewUrl({
    previewHost: 'raw.example.com',
    browserLiveUrl: 'https://live.example.com/session/xyz?q=1',
    accessToken: 'tok',
  });

  // Only the origin of the live URL is used; its own path is not preserved.
  assert.equal(url, 'https://live.example.com/preview/?access_token=tok');
});

test('a preview URL needs both a host and a token', () => {
  assert.equal(resolvePreviewUrl({ previewHost: 'host.example.com' }), undefined);
  assert.equal(resolvePreviewUrl({ accessToken: 'tok' }), undefined);
  assert.equal(resolvePreviewUrl({}), undefined);
  assert.equal(
    resolvePreviewUrl({ previewHost: 'host.example.com', accessToken: '' }),
    undefined,
  );
});

test('a host that only serves a browser live URL still resolves', () => {
  const url = resolvePreviewUrl({
    browserLiveUrl: 'https://live.example.com',
    accessToken: 'tok',
  });
  assert.equal(url, 'https://live.example.com/preview/?access_token=tok');
});

test('preview targets compare host, port, and path but ignore the rotating token', () => {
  const base = 'https://host.example.com/preview/';

  assert.equal(previewTargetsMatch(`${base}?access_token=a`, `${base}?access_token=b`), true);
  assert.equal(previewTargetsMatch(base, `${base}#section`), true);

  assert.equal(previewTargetsMatch(base, 'https://other.example.com/preview/'), false);
  assert.equal(previewTargetsMatch(base, 'http://host.example.com/preview/'), false);
  assert.equal(previewTargetsMatch(base, 'https://host.example.com:8443/preview/'), false);
  assert.equal(previewTargetsMatch(base, 'https://host.example.com/other/'), false);

  // A malformed URL must not throw, and must not be treated as a match.
  assert.equal(previewTargetsMatch(base, 'not a url'), false);
  assert.equal(previewTargetsMatch('not a url', 'not a url'), false);
});

test('the allowed host is the hostname alone, without scheme or port', () => {
  assert.equal(resolvePreviewAllowedHost('host.example.com'), 'host.example.com');
  assert.equal(resolvePreviewAllowedHost('https://host.example.com:9000'), 'host.example.com');
  assert.equal(resolvePreviewAllowedHost(''), '');
  assert.equal(resolvePreviewAllowedHost(undefined), '');
});

test('a custom path prefix is honored so a host is not forced onto /preview/', () => {
  const url = resolvePreviewUrl({
    previewHost: 'host.example.com',
    accessToken: 'tok',
    pathPrefix: '/live/',
  });
  assert.equal(url, 'https://host.example.com/live/?access_token=tok');
});

test('preview URL logic needs no host runtime', async () => {
  const source = await import('node:fs/promises')
    .then((fs) => fs.readFile('agents/core/_preview-url.ts', 'utf8'));
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  assert.doesNotMatch(code, /context/);
  assert.doesNotMatch(code, /sandbox/);
});
