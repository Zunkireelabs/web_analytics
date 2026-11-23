import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { topicalPages, siteSections, looksLikeHub, structurePrompt } from './site-structure.js';

const inv = (...pages) => pages.map((p) => ({ page: `https://example.com${p}`, orphaned: false }));
const ROWS = [
  ...inv('/', '/services/', '/services/ai-ecommerce/', '/services/ai-chatbots/', '/services/seo-audit/', '/pricing/', '/blog/how-to-choose-a-crm/', '/blog/crm-for-plumbers/', '/about/'),
  { page: 'https://example.com/services/crm-setup/', orphaned: true },
];

describe('topicalPages', () => {
  test('finds pages whose address shares a meaningful word with the topic, best match first, shallow before deep', () => {
    assert.deepEqual(topicalPages(ROWS, 'AI chatbots for ecommerce stores').slice(0, 2), ['https://example.com/services/ai-chatbots/', 'https://example.com/services/ai-ecommerce/']);
    assert.deepEqual(topicalPages(ROWS, 'choosing a CRM for plumbers'), ['https://example.com/blog/crm-for-plumbers/', 'https://example.com/blog/how-to-choose-a-crm/']);
  });
  test('matches word stems (plumbers / plumber), skips the home page, orphans, excluded pages and stop words', () => {
    assert.equal(topicalPages(inv('/blog/plumber-tips/'), 'plumbers').length, 1);
    assert.deepEqual(topicalPages(ROWS, 'the best guide'), [], 'only stop words: nothing to match');
    assert.ok(!topicalPages(ROWS, 'crm setup').includes('https://example.com/services/crm-setup/'), 'an orphaned page is not linked');
    assert.deepEqual(topicalPages(ROWS, 'pricing', { exclude: new Set(['https://example.com/pricing/']) }), []);
  });
  test('capped, and tolerant of empty input', () => {
    assert.equal(topicalPages(inv(...Array.from({ length: 30 }, (_, i) => `/crm-${i}/`)), 'crm', { limit: 10 }).length, 10);
    assert.deepEqual(topicalPages(null, 'crm'), []); assert.deepEqual(topicalPages(ROWS, ''), []);
  });
});

describe('siteSections', () => {
  test('first path segment of every live page, biggest first; orphans and the home page do not count', () => {
    assert.deepEqual(siteSections(ROWS), ['/services/ (4 pages)', '/blog/ (2 pages)', '/about/ (1 page)', '/pricing/ (1 page)']);
    assert.deepEqual(siteSections([]), []);
  });
});

describe('structurePrompt', () => {
  test('says what the site really has, and for a hub topic asks for one section per relevant existing page', () => {
    const sections = siteSections(ROWS);
    const topical = topicalPages(ROWS, 'our AI services');
    const hub = structurePrompt({ sections, topical, topic: 'Types of AI services for small business' });
    assert.match(hub, /real sections.*\/services\/ \(4 pages\)/);
    assert.match(hub, /Only describe services.*this site actually has/);
    assert.match(hub, /overview post.*own short section with an inline link/);
    const plain = structurePrompt({ sections, topical, topic: 'Why page speed matters' });
    assert.ok(!/overview post/.test(plain));
  });
  test('a site with nothing recorded leaves the prompt exactly as it was', () => assert.equal(structurePrompt({ sections: [], topical: [], topic: 'anything' }), ''));
  test('hub detection', () => {
    for (const t of ['Types of CRM', 'complete guide to AI services', 'Our services overview']) assert.equal(looksLikeHub(t), true, t);
    for (const t of ['Why CRMs fail', 'Page speed tips']) assert.equal(looksLikeHub(t), false, t);
  });
});
