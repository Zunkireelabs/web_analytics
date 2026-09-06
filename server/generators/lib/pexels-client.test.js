import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  searchImage, buildImageQueries, configured, pexelsPhotoIdFromUrl,
} from './pexels-client.js';

const ORIG_ENV = { ...process.env };

function photo({
  alt, url = 'https://images.pexels.com/photos/1/x.jpeg', w = 1600, h = 1000, id = 1,
}) {
  return {
    id, alt, src: { large: url }, photographer: 'Someone', photographer_url: 'https://pexels.com/@someone', width: w, height: h,
  };
}

function mockFetchReturning(byQuery) {
  return mock.fn(async (url) => {
    const q = decodeURIComponent(/query=([^&]+)/.exec(url)?.[1] || '');
    const photos = byQuery[q] || [];
    return { ok: true, json: async () => ({ photos }) };
  });
}

describe('configured', () => {
  beforeEach(() => { process.env = { ...ORIG_ENV }; });
  afterEach(() => { process.env = { ...ORIG_ENV }; });

  test('requires both the key and the dedicated feature flag', () => {
    process.env.PEXELS_API_KEY = 'k'; process.env.BLOG_IMAGES_ENABLED = 'true';
    assert.equal(configured(), true);
    process.env.BLOG_IMAGES_ENABLED = 'false';
    assert.equal(configured(), false);
    delete process.env.PEXELS_API_KEY; process.env.BLOG_IMAGES_ENABLED = 'true';
    assert.equal(configured(), false);
  });
});

describe('buildImageQueries', () => {
  test('title first, topic second, fallback last', () => {
    assert.deepEqual(
      buildImageQueries({ title: 'Future Trends in AI Development in Nepal', topic: 'AI trends Nepal' }),
      ['Future Trends in AI Development in Nepal', 'AI trends Nepal', 'artificial intelligence technology'],
    );
  });

  test('skips a topic identical to the title, never duplicates', () => {
    assert.deepEqual(buildImageQueries({ title: 'X', topic: 'X' }), ['X', 'artificial intelligence technology']);
  });

  test('an empty call still returns the fallback', () => {
    assert.deepEqual(buildImageQueries({}), ['artificial intelligence technology']);
  });
});

describe('searchImage — real fetch behavior, mocked at the network boundary', () => {
  let originalFetch;
  beforeEach(() => {
    process.env = { ...ORIG_ENV, PEXELS_API_KEY: 'k', BLOG_IMAGES_ENABLED: 'true' };
    originalFetch = global.fetch;
  });
  afterEach(() => { process.env = { ...ORIG_ENV }; global.fetch = originalFetch; });

  test('the original incident: a generic-but-plausible result loses to nothing when nothing scores well', async () => {
    // "Future Trends in AI Development in Nepal" really did return a toy-robot
    // photo whose alt text has almost no overlap with the query.
    global.fetch = mockFetchReturning({
      'Future Trends in AI Development in Nepal': [
        photo({ alt: 'A sleek modern robot toy standing against a colorful gradient backdrop, offering ample copy space' }),
      ],
      'artificial intelligence technology': [
        photo({ alt: 'A sleek modern robot toy standing against a colorful gradient backdrop, offering ample copy space' }),
      ],
    });
    const result = await searchImage(['Future Trends in AI Development in Nepal', 'artificial intelligence technology']);
    assert.equal(result, null, 'a low-relevance match must not be returned just because it is the only result');
  });

  test('picks the genuinely relevant candidate over the first-returned one', async () => {
    global.fetch = mockFetchReturning({
      'How to Build a RAG Pipeline': [
        photo({ alt: 'Woman drinking coffee at a cafe table', url: 'https://images.pexels.com/photos/1/coffee.jpeg' }),
        photo({ alt: 'Software engineer diagramming a retrieval augmented generation pipeline architecture', url: 'https://images.pexels.com/photos/2/rag.jpeg' }),
      ],
    });
    const result = await searchImage(['How to Build a RAG Pipeline']);
    assert.equal(result.url, 'https://images.pexels.com/photos/2/rag.jpeg');
  });

  test('a strong match on a later, broader query beats a weak match on the specific title', async () => {
    global.fetch = mockFetchReturning({
      'Understanding Zunkiree Labs Market Presence': [
        photo({ alt: 'Abstract blue background pattern', url: 'https://images.pexels.com/photos/1/abstract.jpeg' }),
      ],
      'artificial intelligence technology': [
        photo({ alt: 'Artificial intelligence technology concept with neural network visualization', url: 'https://images.pexels.com/photos/2/ai.jpeg' }),
      ],
    });
    const result = await searchImage(['Understanding Zunkiree Labs Market Presence', 'artificial intelligence technology']);
    assert.equal(result.url, 'https://images.pexels.com/photos/2/ai.jpeg');
  });

  test('penalizes generic stock-filler language even with keyword overlap', async () => {
    global.fetch = mockFetchReturning({
      'dental ai scheduling': [
        photo({ alt: 'dental icon isolated vector clipart on white background', url: 'https://images.pexels.com/photos/1/icon.jpeg' }),
        photo({ alt: 'Dentist reviewing an AI scheduling dashboard at a clinic', url: 'https://images.pexels.com/photos/2/dentist.jpeg' }),
      ],
    });
    const result = await searchImage(['dental ai scheduling']);
    assert.equal(result.url, 'https://images.pexels.com/photos/2/dentist.jpeg');
  });

  test('returns null rather than throwing when every query comes back empty', async () => {
    global.fetch = mockFetchReturning({});
    assert.equal(await searchImage(['nothing matches this']), null);
  });

  test('returns null on a network failure', async () => {
    global.fetch = mock.fn(async () => { throw new Error('network down'); });
    assert.equal(await searchImage(['anything']), null);
  });

  test('disabled feature flag short-circuits before any fetch', async () => {
    process.env.BLOG_IMAGES_ENABLED = 'false';
    const fetchSpy = mock.fn();
    global.fetch = fetchSpy;
    assert.equal(await searchImage(['x']), null);
    assert.equal(fetchSpy.mock.callCount(), 0);
  });

  test('a single string query still works (not just an array)', async () => {
    global.fetch = mockFetchReturning({
      'rag pipeline architecture': [photo({ alt: 'RAG pipeline architecture diagram on a whiteboard' })],
    });
    const result = await searchImage('rag pipeline architecture');
    assert.ok(result);
  });

  test('a query stops trying further, broader queries once it clears the relevance bar', async () => {
    // Regression: pooling every query together let the fallback query's own
    // near-verbatim match beat a genuinely on-topic (but not perfect) title
    // match, which is why unrelated posts kept converging on the same
    // generic photo. The specific title here clears the bar on its own, so
    // the fallback query must never even be fetched.
    const fetchSpy = mockFetchReturning({
      'How to Build a RAG Pipeline': [
        photo({ alt: 'Software engineer diagramming a retrieval augmented generation pipeline architecture', url: 'https://images.pexels.com/photos/2/rag.jpeg', id: 2 }),
      ],
      'artificial intelligence technology': [
        photo({ alt: 'Artificial intelligence technology concept with neural network visualization', url: 'https://images.pexels.com/photos/3/ai.jpeg', id: 3 }),
      ],
    });
    global.fetch = fetchSpy;
    const result = await searchImage(['How to Build a RAG Pipeline', 'artificial intelligence technology']);
    assert.equal(result.url, 'https://images.pexels.com/photos/2/rag.jpeg');
    assert.equal(fetchSpy.mock.callCount(), 1, 'the broader fallback query must never be fetched once the title query already won');
  });

  test('excludePhotoIds skips a photo already used elsewhere on the site, even if it would otherwise win', async () => {
    global.fetch = mockFetchReturning({
      'How to Build a RAG Pipeline': [
        photo({ alt: 'Software engineer diagramming a retrieval augmented generation pipeline architecture', url: 'https://images.pexels.com/photos/2/rag.jpeg', id: 2 }),
      ],
    });
    const result = await searchImage(['How to Build a RAG Pipeline'], { excludePhotoIds: new Set([2]) });
    assert.equal(result, null);
  });
});

describe('pexelsPhotoIdFromUrl', () => {
  test('extracts the numeric id regardless of size/crop query params', () => {
    assert.equal(pexelsPhotoIdFromUrl('https://images.pexels.com/photos/12345/pexels-photo-12345.jpeg?auto=compress&cs=tinysrgb&w=1260'), 12345);
  });

  test('null for a non-Pexels or malformed url', () => {
    assert.equal(pexelsPhotoIdFromUrl('https://example.com/a.jpg'), null);
    assert.equal(pexelsPhotoIdFromUrl(null), null);
  });
});
