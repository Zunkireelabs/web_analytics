import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;

let policy;
let profile;
let pages;
let llmResponse;
let llmCalls;
let feedXml; // feedUrl -> xml string | Error

mock.module(resolve('../store/read.js'), { namedExports: { getSiteById: async () => ({ id: 1, name: 'Acme', domain: 'acme.test' }) } });
mock.module(resolve('../store/site-seo-policy.js'), { namedExports: { getSeoPolicy: async () => policy } });
mock.module(resolve('../store/data-analyst.js'), { namedExports: { getSiteProfile: async () => profile } });
mock.module(resolve('../store/page-inventory.js'), { namedExports: { listPageInventory: async () => pages } });
mock.module(resolve('../llm.js'), {
  namedExports: {
    callLLMForJson: async (system, user, opts) => {
      llmCalls.push({ system, user, opts });
      return llmResponse;
    },
  },
});

const { run, validateTopics, alreadyCovered, slugify, trendIndustries } = await import('./trend-radar.js');
const { feedsForTenant, parseFeed, recentItems, FEED_CATALOG } = await import('./lib/trend-feeds.js');

const NOW = Date.now();
const iso = (daysAgo) => new Date(NOW - daysAgo * 86_400_000).toUTCString();

function rss(items) {
  return `<?xml version="1.0"?><rss version="2.0"><channel>${items
    .map((i) => `<item><title>${i.title}</title><link>${i.link}</link><pubDate>${i.date}</pubDate><description>&lt;p&gt;${i.desc || ''}&lt;/p&gt;</description></item>`)
    .join('')}</channel></rss>`;
}

describe('feedsForTenant', () => {
  test('maps industries onto catalog feeds without any site id', () => {
    const it = feedsForTenant({ industries: ['IT services'] });
    assert.ok(it.length > 0 && it.every((f) => f.category === 'technology'));
    const edu = feedsForTenant({ industries: ['Education'] });
    assert.ok(edu.every((f) => f.category === 'education'));
  });

  test('"AI in education" site gets both education and technology feeds via main_topics', () => {
    const feeds = feedsForTenant({ industries: ['Education'], topics: ['AI tutoring', 'study abroad'] });
    const cats = new Set(feeds.map((f) => f.category));
    assert.ok(cats.has('education') && cats.has('technology'));
  });

  test('an education site gets its own feeds first, with only a couple of tech feeds for the AI angle', () => {
    const feeds = feedsForTenant({ industries: ['Education'], topics: ['AI in education'] });
    const edu = feeds.filter((f) => f.category === 'education').length;
    const tech = feeds.filter((f) => f.category === 'technology').length;
    assert.equal(edu, 4);
    assert.equal(tech, 2);
  });

  test('lowercase "it" inside ordinary prose does not make a site a tech site', () => {
    assert.deepEqual(feedsForTenant({ industries: ['Florist'], topics: ['how it works'] }), []);
  });

  test('override replaces the catalog and rejects non-https urls', () => {
    const feeds = feedsForTenant({ industries: ['Education'], override: [{ url: 'https://x.test/feed' }, { url: 'http://insecure.test/feed' }] });
    assert.equal(feeds.length, 1);
    assert.equal(feeds[0].url, 'https://x.test/feed');
  });

  test('every catalog feed is https', () => {
    for (const e of FEED_CATALOG) for (const f of e.feeds) assert.match(f.url, /^https:\/\//);
  });
});

describe('per-client lens', () => {
  const cats = (feeds) => [...new Set(feeds.map((f) => f.category))];

  test('site 1 (AI dev agency) trends on tech, not on the industries it sells to', () => {
    const industries = trendIndustries({ target_industries: ['Education', 'Healthcare', 'Real Estate', 'Hospitality', 'Agencies'] }, { industry: 'AI software development' });
    assert.deepEqual(industries, ['AI software development']);
    assert.deepEqual(cats(feedsForTenant({ industries })), ['technology']);
  });

  test('policy list is only a fallback when the profile has no industry', () => {
    assert.deepEqual(trendIndustries({ target_industries: ['Education'] }, null), ['Education']);
    assert.equal(trendIndustries(null, null), null);
  });

  test('real estate client gets real-estate feeds', () => {
    const feeds = feedsForTenant({ industries: ['Real estate'] });
    assert.deepEqual(cats(feeds), ['real-estate']);
  });

  test('Zennly-style booking product for spas/gyms leads with wellness feeds, tech capped at 2, no healthcare', () => {
    const feeds = feedsForTenant({ industries: ['Booking software for spas, salons and gyms'] });
    assert.equal(feeds.filter((f) => f.category === 'healthcare').length, 0);
    assert.equal(feeds.filter((f) => f.category === 'wellness').length, 3);
    assert.equal(feeds.filter((f) => f.category === 'technology').length, 2);
    assert.equal(feeds[0].category, 'wellness');
  });
});

describe('parseFeed / recentItems', () => {
  test('parses RSS, strips html, drops undated or linkless items', () => {
    const items = parseFeed(rss([
      { title: 'Good', link: 'https://a.test/1', date: iso(1), desc: 'hello <b>world</b>' },
      { title: 'No date', link: 'https://a.test/2', date: '' },
      { title: 'No link', link: '', date: iso(1) },
    ]), { feedId: 'a', feedName: 'A' });
    assert.equal(items.length, 1);
    assert.equal(items[0].summary, 'hello world');
    assert.equal(items[0].source, 'A');
  });

  test('perFeedLimit stops one noisy feed filling the window', () => {
    const mk = (feedId, n) => ({ title: `${feedId}${n}`, url: `https://${feedId}/${n}`, feedId, publishedAt: new Date(NOW - n * 3_600_000).toISOString() });
    const noisy = Array.from({ length: 30 }, (_, i) => mk('hn', i));
    const niche = [mk('edsurge', 40), mk('edsurge', 41)];
    const out = recentItems([...noisy, ...niche], { maxAgeDays: 7, now: NOW, limit: 60, perFeedLimit: 10 });
    assert.equal(out.filter((i) => i.feedId === 'hn').length, 10);
    assert.equal(out.filter((i) => i.feedId === 'edsurge').length, 2);
  });

  test('parses Atom entries', () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>T</title><link href="https://a.test/x"/><updated>${new Date(NOW).toISOString()}</updated></entry></feed>`;
    assert.equal(parseFeed(xml, { feedId: 'a' }).length, 1);
  });

  test('recentItems drops old and duplicate-url items, newest first', () => {
    const mk = (url, daysAgo) => ({ title: url, url, publishedAt: new Date(NOW - daysAgo * 86_400_000).toISOString() });
    const out = recentItems([mk('https://a/1', 10), mk('https://a/2', 2), mk('https://a/2', 2), mk('https://a/3', 1)], { maxAgeDays: 7, now: NOW });
    assert.deepEqual(out.map((i) => i.url), ['https://a/3', 'https://a/2']);
  });
});

describe('validateTopics', () => {
  const items = [
    { title: 'a', url: 'https://x/a', source: 'S1', publishedAt: '2026-10-01T00:00:00Z' },
    { title: 'b', url: 'https://x/b', source: 'S2', publishedAt: '2026-10-02T00:00:00Z' },
    { title: 'c', url: 'https://x/c', source: 'S1', publishedAt: '2026-09-30T00:00:00Z' },
  ];

  test('drops topics citing no real item and recomputes strength itself', () => {
    const out = validateTopics([
      { topic: 'Ghost topic', sources: [99] },
      { topic: 'Real topic', sources: [0, 1, 7], distinctSources: 50 },
      { topic: '', sources: [0] },
    ], items);
    assert.equal(out.length, 1);
    assert.equal(out[0].distinctSources, 2);
    assert.equal(out[0].sources.length, 2);
  });

  test('ranks more distinct outlets first and drops duplicate slugs', () => {
    const out = validateTopics([
      { topic: 'Single outlet story', sources: [0, 2] },
      { topic: 'Multi outlet story', sources: [0, 1] },
      { topic: 'Multi outlet story!', sources: [1] },
    ], items);
    assert.deepEqual(out.map((t) => t.topic), ['Multi outlet story', 'Single outlet story']);
  });

  test('non-array input yields nothing', () => {
    assert.deepEqual(validateTopics(null, items), []);
  });
});

describe('alreadyCovered', () => {
  test('matches a topic against an existing blog slug', () => {
    assert.ok(alreadyCovered('What is superintelligence and why is it called that', ['/blog/what-is-superintelligence']));
    assert.ok(!alreadyCovered('AI tutors in classrooms', ['/blog/what-is-superintelligence']));
  });
  test('slugify is stable', () => {
    assert.equal(slugify('What is Superintelligence?'), 'superintelligence');
  });
});

describe('run', () => {
  const realFetch = globalThis.fetch;

  function stubFetch() {
    globalThis.fetch = async (url) => {
      const v = feedXml[url];
      if (v instanceof Error) throw v;
      if (v == null) return { ok: false, status: 404, text: async () => '' };
      return { ok: true, status: 200, text: async () => v };
    };
  }

  beforeEach(() => {
    policy = null;
    profile = { industry: 'IT services', main_topics: ['cloud'] };
    pages = [];
    llmCalls = [];
    llmResponse = { topics: [] };
    feedXml = {};
    stubFetch();
  });

  test('insufficient-data when the tenant has no known industry', async () => {
    profile = null;
    const out = await run({ siteId: 1 });
    assert.equal(out.status, 'insufficient-data');
    assert.equal(llmCalls.length, 0);
  });

  test('insufficient-data (and no LLM call) when every feed fails', async () => {
    const out = await run({ siteId: 1 });
    assert.equal(out.status, 'insufficient-data');
    assert.equal(llmCalls.length, 0);
    assert.ok(out.facts.feedsFailed.length > 0);
  });

  test('produces cited, demand-unverified findings with a blog-outline action, and skips covered topics', async () => {
    const items = Array.from({ length: 6 }, (_, i) => ({ title: `Headline ${i}`, link: `https://n.test/${i}`, date: iso(1) }));
    feedXml['https://hnrss.org/frontpage'] = rss(items.slice(0, 3));
    feedXml['https://techcrunch.com/feed/'] = rss(items.slice(3));
    feedXml['https://feeds.arstechnica.com/arstechnica/index'] = new Error('boom');
    pages = [{ page: '/blog/what-is-superintelligence' }];
    llmResponse = {
      topics: [
        { topic: 'What is superintelligence and why is it called that', angle: 'a', whyRelevant: 'w', sources: [0, 3] },
        { topic: 'Quantum networking basics', angle: 'a', whyRelevant: 'Teams ask.', sources: [1, 4] },
        { topic: 'Invented topic', angle: 'a', whyRelevant: 'w', sources: [42] },
      ],
    };
    const out = await run({ siteId: 1 });
    assert.equal(out.status, 'ok');
    assert.equal(out.facts.findings.length, 1);
    const f = out.facts.findings[0];
    assert.equal(f.id, 'trend-radar:quantum-networking-basics');
    assert.equal(f.recommendedAction.generatorId, 'blog-outline');
    assert.equal(f.recommendedAction.params.topic, 'Quantum networking basics');
    assert.equal(f.recommendedAction.params.category, 'Insights');
    assert.match(f.recommendedAction.params.context, /https:\/\/n\.test\//);
    assert.match(f.recommendedAction.params.context, /ONLY from the headlines/);
    assert.match(f.recommendedAction.params.context, /direct answer/);
    assert.match(f.recommendedAction.params.context, /headings as the questions/);
    assert.equal(f.evidence.demand.available, false);
    assert.ok(f.evidence.sources.every((s) => /^https:\/\/n\.test\//.test(s.url)));
    assert.deepEqual(out.facts.skippedAlreadyCovered, ['What is superintelligence and why is it called that']);
    assert.ok(out.facts.feedsFailed.some((x) => x.feedId === 'ars'));
    assert.match(llmCalls[0].user, /Industry: IT services/);
  });
});

test.after?.(() => {});
