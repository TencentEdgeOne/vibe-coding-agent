import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveMakersPublishTarget } from '../shared/publish-target.ts';

test('international .dev sites use overseas acceleration', () => {
  assert.deepEqual(resolveMakersPublishTarget('edgeone.dev'), {
    area: 'overseas',
  });
});

test('china .cool sites use the global acceleration area', () => {
  assert.deepEqual(resolveMakersPublishTarget('edgeone.cool'), {
    area: 'global',
  });
});

test('non-dev hosts default to the global acceleration area', () => {
  assert.deepEqual(resolveMakersPublishTarget(''), {
    area: 'global',
  });
  assert.deepEqual(resolveMakersPublishTarget('localhost'), {
    area: 'global',
  });
});
