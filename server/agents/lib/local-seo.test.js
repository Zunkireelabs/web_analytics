import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { targetPlaces, placeNames, placeSeedPhrases, localSeoNote, localMarketNames, suggestLocalKeywords, isUkSite, hasPlaces } from './local-seo.js';

// What matters: order is priority (home town before neighbours, always), nothing is inferred, and a site with no
// declared places behaves exactly as it did before.

const chayce = {
  country_code: 2826, language_code: 'en', target_scope: 'local',
  target_places: [
    { name: 'Wellingborough', tier: 'nearby' }, { name: 'Northampton', tier: 'primary' }, { name: 'Daventry', tier: 'nearby' },
  ],
};

describe('targetPlaces', () => {
  test('the primary place leads however it was written down', () => {
    assert.deepEqual(targetPlaces(chayce).map((p) => p.name), ['Northampton', 'Wellingborough', 'Daventry']);
  });

  test('nearby places keep the order they were given', () => {
    assert.deepEqual(placeNames(chayce), ['Northampton', 'Wellingborough', 'Daventry']);
  });

  test('duplicates (any case) and junk are dropped, never guessed at', () => {
    const out = targetPlaces({ target_places: ['Northampton', 'northampton', '', ' ', 'x', 'Kettering', null, 42, { name: 'Kettering' }] });
    assert.deepEqual(out.map((p) => p.name), ['Northampton', 'Kettering']);
  });

  test('a plain string is a nearby place, not a primary one', () => {
    assert.equal(targetPlaces({ target_places: ['Kettering'] })[0].tier, 'nearby');
  });

  test('no places is an empty list, not an error', () => {
    for (const site of [null, undefined, {}, { target_places: null }, { target_places: 'nonsense' }, { target_places: [] }]) {
      assert.deepEqual(targetPlaces(site), []);
      assert.equal(hasPlaces(site), false);
    }
  });

  test('the list is capped', () => {
    const many = { target_places: Array.from({ length: 30 }, (_, i) => `Place number ${i}`) };
    assert.equal(targetPlaces(many).length, 12);
  });
});

describe('placeSeedPhrases', () => {
  test('each service, then each service in the primary place BEFORE any neighbour', () => {
    const out = placeSeedPhrases(['estate agents', 'lettings'], targetPlaces(chayce));
    assert.deepEqual(out, [
      'estate agents', 'lettings',
      'estate agents northampton', 'lettings northampton',
      'estate agents wellingborough', 'lettings wellingborough',
      'estate agents daventry', 'lettings daventry',
    ]);
  });

  test('a cap trims the neighbours, never the home town', () => {
    const out = placeSeedPhrases(['estate agents', 'lettings'], targetPlaces(chayce), { max: 5 });
    assert.deepEqual(out.slice(2), ['estate agents northampton', 'lettings northampton', 'estate agents wellingborough']);
    assert.ok(!out.includes('lettings daventry'));
  });

  test('services are cleaned and de-duplicated', () => {
    const out = placeSeedPhrases(['  Estate  Agents ', 'estate agents', 'ab'], [{ name: 'Northampton', tier: 'primary' }]);
    assert.deepEqual(out, ['estate agents', 'estate agents northampton']);
  });

  test('no places returns just the services', () => {
    assert.deepEqual(placeSeedPhrases(['estate agents'], []), ['estate agents']);
  });
});

describe('localSeoNote', () => {
  const note = localSeoNote(chayce);

  test('it tells a generator where the client is based first, then nearby', () => {
    assert.match(note, /write for customers in Northampton first/);
    assert.match(note, /nearby Wellingborough, Daventry/);
  });

  test('it forbids claiming a presence the client never declared', () => {
    assert.match(note, /Never say or imply the business has an office, branch, team or presence in any place not named here/);
    assert.match(note, /never invent local facts/);
  });

  test('a UK client is told to write British English', () => {
    assert.match(note, /British English/);
    assert.match(note, /£/);
  });

  test('a UK site with no declared places still gets spelling guidance, and no place text', () => {
    const n = localSeoNote({ country_code: 2826, target_scope: 'local' });
    assert.match(n, /British English/);
    assert.ok(!/Local focus/.test(n));
  });

  test('a non-UK site with no places gets nothing at all, so its prompt is unchanged', () => {
    assert.equal(localSeoNote({ country_code: 2524, target_scope: 'local' }), null);
    assert.equal(localSeoNote({}), null);
  });

  test('a non-UK site with places gets the local focus but not British spelling', () => {
    const n = localSeoNote({ country_code: 2524, target_scope: 'local', target_places: [{ name: 'Pokhara', tier: 'primary' }] });
    assert.match(n, /Pokhara/);
    assert.ok(!/British/.test(n));
  });
});

describe('the rest of the helpers', () => {
  test('UK is recognised from the site\'s own market, not assumed', () => {
    assert.equal(isUkSite({ country_code: 2826, target_scope: 'local' }), true);
    assert.equal(isUkSite({ country_code: 2840, target_scope: 'local' }), false);
  });

  test('market names put the most specific place first, then the country', () => {
    assert.deepEqual(localMarketNames(chayce, ['the United Kingdom'], { maxPlaces: 2 }), ['Northampton', 'Wellingborough', 'the United Kingdom']);
  });

  test('suggested tracking keywords are the services in the PRIMARY place only', () => {
    assert.deepEqual(suggestLocalKeywords(chayce, ['estate agents', 'lettings']), ['estate agents northampton', 'lettings northampton']);
  });

  test('the bare service is never suggested as a tracked keyword', () => {
    assert.ok(suggestLocalKeywords(chayce, ['estate agents']).every((k) => k.endsWith('northampton')));
  });

  test('a site with no places suggests nothing to track', () => {
    assert.deepEqual(suggestLocalKeywords({}, ['estate agents']), []);
  });

  test('the suggestion list is capped', () => {
    const many = Array.from({ length: 20 }, (_, i) => `service number ${i}`);
    assert.equal(suggestLocalKeywords(chayce, many, { limit: 4 }).length, 4);
  });
});
