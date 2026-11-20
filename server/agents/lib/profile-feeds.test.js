import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { feedsForProfile } from './profile-feeds.js';
import { normalizeProfile } from '../../lib/business-profile.js';

const ev = [{ source: 'page', ref: 'u', summary: 's', quote: 'q' }];
const F = (value) => ({ value, status: 'detected', confidence: 'high', evidence: ev });
const P = (fields) => normalizeProfile({ fields });

describe('feeds follow what the company sells, not its customers’ industry', () => {
  test('Zennly (software for salons): technology leads, salon trade news is only a capped secondary', () => {
    const feeds = feedsForProfile(P({
      ownIndustry: F({ label: 'Software (SaaS)' }), subIndustry: F('Spa and salon booking and management software'),
      targetCustomerIndustries: F(['Spas', 'Salons', 'Gyms', 'Beauty clinics']), coreTopics: F(['salon booking software']),
    }));
    const byCat = (c) => feeds.filter((x) => x.category === c);
    assert.ok(byCat('technology').length >= 3, 'technology feeds are primary');
    assert.ok(byCat('wellness').length > 0 && byCat('wellness').length <= 2, 'wellness is a secondary lens, at most two feeds');
    assert.equal(feeds[0].category, 'technology');
  });

  test('MOBILISE (B2B marketing agency) gets marketing feeds, which the shared catalog cannot provide', () => {
    const feeds = feedsForProfile(P({
      ownIndustry: F({ label: 'Marketing and advertising services' }), subIndustry: F('B2B marketing and demand generation services'),
      targetCustomerIndustries: F(['Technology', 'SaaS', 'Healthcare', 'Manufacturing']),
    }));
    assert.deepEqual(feeds.filter((x) => x.category === 'marketing').map((x) => x.id), ['marketingweek', 'martech', 'marketingdive']);
    assert.equal(feeds[0].category, 'marketing');
    assert.ok(feeds.every((x) => /^https:\/\//.test(x.url)));
  });

  test('SuperRank (AI SEO software) leads with technology news', () => {
    const feeds = feedsForProfile(P({ ownIndustry: F({ label: 'Software (SaaS)' }), coreTopics: F(['AI search visibility']) }));
    assert.equal(feeds[0].category, 'technology');
  });

  test('a company whose customers are in marketing is not given marketing news as primary', () => {
    const feeds = feedsForProfile(P({ ownIndustry: F({ label: 'Software (SaaS)' }), targetCustomerIndustries: F(['Marketing and advertising agencies']) }));
    assert.equal(feeds[0].category, 'technology');
    assert.ok(feeds.filter((x) => x.category === 'marketing').length <= 2);
  });

  test('no own industry, or nothing the catalog or extra groups cover, gives no feeds (reported, not forced)', () => {
    assert.deepEqual(feedsForProfile(P({})), []);
    assert.deepEqual(feedsForProfile(P({ ownIndustry: F({ label: 'Subsistence farming' }) })), []);
  });

  test('never more than twelve feeds, and no duplicates', () => {
    const feeds = feedsForProfile(P({ ownIndustry: F({ label: 'Software (SaaS) and marketing services' }), coreTopics: F(['education', 'healthcare', 'real estate', 'wellness']) }));
    assert.ok(feeds.length <= 12);
    assert.equal(new Set(feeds.map((x) => x.id)).size, feeds.length);
  });
});
