import assert from 'node:assert/strict';
import test from 'node:test';
import { displayPublishOrigin, resolveMakersPublishTarget } from '../shared/publish-target.ts';

test('international .dev sites use the global endpoint and overseas area', () => {
  assert.deepEqual(resolveMakersPublishTarget('edgeone.dev'), {
    region: 'global',
    area: 'overseas',
  });
});

test('china .cool sites use the china endpoint and global area', () => {
  assert.deepEqual(resolveMakersPublishTarget('edgeone.cool'), {
    region: 'china',
    area: 'global',
  });
});

test('non-dev hosts default to the china endpoint', () => {
  assert.deepEqual(resolveMakersPublishTarget(''), {
    region: 'china',
    area: 'global',
  });
  assert.deepEqual(resolveMakersPublishTarget('localhost'), {
    region: 'china',
    area: 'global',
  });
});

test('displayPublishOrigin strips signed query params from the visible host', () => {
  const signed = 'https://vibe-ad99404c5f7a4321.edgeone.cool/?eo_token=abc&eo_time=123';
  assert.equal(displayPublishOrigin(signed), 'https://vibe-ad99404c5f7a4321.edgeone.cool');
  assert.match(signed, /eo_token=/);
  assert.equal(
    displayPublishOrigin('https://vibe-ad99404c5f7a4321.edgeone.cool'),
    'https://vibe-ad99404c5f7a4321.edgeone.cool',
  );
  assert.equal(displayPublishOrigin(''), '');
});
