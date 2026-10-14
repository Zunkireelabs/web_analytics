import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { translateKeywords } from './keyword-translation.js';

const resolving = (obj) => async () => new Map(Object.entries(obj));

describe('translateKeywords (view over the shared query_translations cache)', () => {
  test('keeps non-English entries only', async () => {
    const out = await translateKeywords(['bedrijf', 'ai company nepal'], {
      translate: resolving({
        bedrijf: { language: 'Dutch', translation: 'company' },
        'ai company nepal': { language: 'English', translation: 'ai company nepal' },
      }),
    });
    assert.deepEqual(out, { bedrijf: { language: 'Dutch', english: 'company' } });
  });

  test('drops an entry whose translation is just the same text', async () => {
    const out = await translateKeywords(['zunkiree'], { translate: resolving({ zunkiree: { language: 'Nepali', translation: 'Zunkiree' } }) });
    assert.deepEqual(out, {});
  });

  test('drops unknown-language entries and incomplete rows', async () => {
    const out = await translateKeywords(['a', 'b'], {
      translate: resolving({ a: { language: 'unknown', translation: 'x' }, b: { language: 'German', translation: '' } }),
    });
    assert.deepEqual(out, {});
  });

  test('fails soft: a lookup error yields no translations, not a throw', async () => {
    const out = await translateKeywords(['bedrijf'], { translate: async () => { throw new Error('db down'); } });
    assert.deepEqual(out, {});
  });

  test('non-array input is passed through safely', async () => {
    const out = await translateKeywords(null, { translate: async () => new Map() });
    assert.deepEqual(out, {});
  });
});
