import assert from 'node:assert/strict';
import test from 'node:test';
import {
  displayPublishOrigin,
  resolveMakersPublishTarget,
  stripReturnedPublishLinks,
} from '../shared/publish-target.ts';

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

test('stripReturnedPublishLinks removes Pages URLs and leftover labels', () => {
  const signed = 'https://vibe-ad99404c5f7a4321.edgeone.cool/?eo_token=abc&eo_time=123';
  const origin = 'https://vibe-ad99404c5f7a4321.edgeone.cool';

  assert.equal(
    stripReturnedPublishLinks(`项目已成功部署上线，访问地址：${signed}`, signed),
    '项目已成功部署上线',
  );
  assert.equal(
    stripReturnedPublishLinks(`The project is live: [site](${signed})`, signed),
    'The project is live:',
  );
  assert.equal(
    stripReturnedPublishLinks(`Done. ${origin}?eo_token=leaked`, signed),
    'Done.',
  );
  assert.equal(
    stripReturnedPublishLinks(' open https://other.edgeone.dev/path?eo_token=x ', undefined, {
      preserveEdges: true,
    }),
    ' open  ',
  );
  assert.equal(stripReturnedPublishLinks('  项目已部署上线。  '), '项目已部署上线。');
});
