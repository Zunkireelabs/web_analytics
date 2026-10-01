import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildReferencesSections, isRelevantSource, hostOf } from './expand-content.js';
import { queryTokens, searchGroundedSources, clearSearchCache } from '../ingest/search-grounding-providers/index.js';

const topic = queryTokens('ai companies in nepal');
const src = (title, url, extra = {}) => ({ title, url, content: '', ...extra });

describe('buildReferencesSections (no-LLM citations)', () => {
  test('builds one References section with a link and host per source', () => {
    const [sec] = buildReferencesSections([src('AI companies in Nepal 2026', 'https://www.example.org/report')], topic);
    assert.equal(sec.heading, 'References');
    assert.equal(sec.body, '- [AI companies in Nepal 2026](https://www.example.org/report) — example.org');
  });
  test('drops sources that share no meaningful word with the page topic', () => {
    assert.deepEqual(buildReferencesSections([src('Best pizza recipes', 'https://food.example.com/p')], topic), []);
  });
  test('drops a source below the relevance score floor, keeps one without a score', () => {
    const out = buildReferencesSections([src('AI in Nepal', 'https://a.example.com/x', { score: 0.1 }), src('AI in Nepal overview', 'https://b.example.com/y')], topic);
    assert.equal(out[0].body.split('\n').length, 1);
    assert.match(out[0].body, /b\.example\.com/);
  });
  test('ranks institutional domains first and keeps one source per host', () => {
    const out = buildReferencesSections([
      src('Nepal AI blog', 'https://blog.example.com/1'),
      src('Nepal AI policy', 'https://moic.gov.np/ai'),
      src('Nepal AI blog two', 'https://blog.example.com/2'),
    ], topic);
    const lines = out[0].body.split('\n');
    assert.match(lines[0], /moic\.gov\.np/);
    assert.equal(lines.length, 2);
  });
  test('never emits a non-http URL and strips brackets from titles', () => {
    const out = buildReferencesSections([src('Nepal [AI] guide', 'javascript:alert(1)'), src('Nepal [AI] guide', 'https://ok.example.com/g')], topic);
    assert.equal(out[0].body.split('\n').length, 1);
    assert.match(out[0].body, /\[Nepal AI guide\]/);
  });
  test('caps the list at the citation count', () => {
    const many = Array.from({ length: 6 }, (_, i) => src(`Nepal AI ${i}`, `https://h${i}.example.com/p`));
    assert.equal(buildReferencesSections(many, topic)[0].body.split('\n').length, 3);
  });
  test('hostOf strips www and survives garbage', () => {
    assert.equal(hostOf('https://www.X.com/a'), 'x.com');
    assert.equal(hostOf('nope'), '');
  });
});

describe('low-value and weak matches', () => {
  test('company-directory hosts are never cited, even on a word match', () => {
    assert.deepEqual(buildReferencesSections([src('IT Training Nepal Competitors', 'https://rocketreach.co/x')], queryTokens('best it companies in nepal')), []);
  });
  test('a result matching only one topic word is not relevant for a multi-word topic', () => {
    assert.equal(isRelevantSource({ title: 'Nepal travel guide', content: '' }, queryTokens('ai development in nepal')), false);
  });
});

describe('isRelevantSource', () => {
  test('matches on the excerpt, not just the title', () => {
    assert.equal(isRelevantSource({ title: 'Report', content: 'a study of AI startups in Nepal' }, topic), true);
  });
});

describe('shared search cache', () => {
  test('a near-identical query on the same topic is served without a second Tavily call', async () => {
    process.env.TAVILY_API_KEY = 'test-key'; process.env.TAVILY_MAX_QUERIES_PER_DAY = '100';
    const original = globalThis.fetch; let calls = 0;
    globalThis.fetch = async () => { calls++; return { ok: true, json: async () => ({ results: [{ title: 'T', url: 'https://x.example.com', content: 'c', score: 0.9 }] }) }; };
    try {
      clearSearchCache();
      await searchGroundedSources('best it companies in nepal', 8);
      await searchGroundedSources('top IT companies Nepal', 3);
      assert.equal(calls, 1);
      await searchGroundedSources('dental ai scheduling software', 3);
      assert.equal(calls, 2, 'an unrelated topic still searches');
    } finally { globalThis.fetch = original; }
  });
});
