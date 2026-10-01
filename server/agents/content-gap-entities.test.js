import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isTopicalPage, dropAlreadyCovered } from './content-gap.js';

describe('entity suggestions only where "what is missing" is meaningful', () => {
  test('team, about, contact, blog index and blog pagination pages are not topical', () => {
    for (const p of ['https://x.com/team/', 'https://x.com/about/', 'https://x.com/contact', 'https://x.com/blog/', 'https://x.com/blog/page/4/', 'https://x.com/cookie-policy/']) {
      assert.equal(isTopicalPage(p), false, p);
    }
  });
  test('service, location and article pages are topical', () => {
    for (const p of ['https://x.com/agentic-as-a-service/', 'https://x.com/locations/pokhara/', 'https://x.com/blog/some-post/']) {
      assert.equal(isTopicalPage(p), true, p);
    }
  });
});

describe('dropAlreadyCovered', () => {
  const body = 'We run smart city initiatives and local IoT startups programs for tourism operators.';
  test('drops a suggestion whose every meaningful word is already on the page', () => {
    const out = dropAlreadyCovered([{ entity: 'Smart city initiatives' }, { entity: 'IoT in agriculture' }], body);
    assert.deepEqual(out.map((s) => s.entity), ['IoT in agriculture']);
  });
  test('keeps everything when the page text is empty (nothing to contradict the model)', () => {
    assert.equal(dropAlreadyCovered([{ entity: 'Anything useful' }], '').length, 1);
  });
});
