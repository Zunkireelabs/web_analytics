import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { query, pool } from '../../db.js';
import { upsertCompetitorProfile } from '../../store/competitor-profiles.js';
import { _clearCompetitorPolicyCache } from '../../agents/lib/competitor-policy.js';
import { extractOutboundLinks, findCompetitorLinks } from './outbound-link-guard.js';
import { runQualityGate } from './quality-gate.js';

describe('outbound-link-guard — extraction', () => {
  test('extracts markdown links, raw URLs, and table-cell URLs, with their content path', () => {
    const content = {
      sections: [
        { heading: 'References', body: 'See [Real Source](https://real-source.example.com/article) and also https://raw-url.example.com/page directly.' },
      ],
      table: [{ feature: 'Website', value: '[link](https://table-cell.example.com/)' }],
    };
    const links = extractOutboundLinks(content);
    const urls = links.map((l) => l.url).sort();
    assert.deepEqual(urls, [
      'https://raw-url.example.com/page',
      'https://real-source.example.com/article',
      'https://table-cell.example.com/',
    ]);
    const markdownHit = links.find((l) => l.url === 'https://real-source.example.com/article');
    assert.equal(markdownHit.path, 'sections[0].body');
  });

  test('a markdown link URL is not double-counted as a second raw URL', () => {
    const content = { body: 'Only here: [text](https://once.example.com/page).' };
    const links = extractOutboundLinks(content);
    assert.equal(links.length, 1);
  });
});

describe('outbound-link-guard — findCompetitorLinks / quality-gate integration', () => {
  let site;

  before(async () => {
    const { rows } = await query(
      `INSERT INTO sites (name, gsc_property, ga4_property_id) VALUES ('Outbound Link Guard Test Site', 'sc-domain:outbound-link-guard-test.example', 'test-ga4') RETURNING *`
    );
    site = rows[0];
    await upsertCompetitorProfile(site.id, 'f1soft.com', {}, new Date(), null);
  });

  after(async () => {
    await query('DELETE FROM competitor_profiles WHERE site_id = $1', [site.id]);
    await query('DELETE FROM sites WHERE id = $1', [site.id]);
    await pool.end();
  });

  beforeEach(() => {
    _clearCompetitorPolicyCache();
  });

  // Shape mirrors the actual live incident: a blog-outline "top companies"
  // section naming and linking a real, configured competitor.
  const contentWithCompetitorLink = {
    title: 'Exploring the Best IT Companies in Nepal',
    sections: [
      { heading: 'F1Soft International', body: 'F1Soft pioneered digital payments in Nepal.\n\n**Website**: [f1soft.com](https://f1soft.com)' },
    ],
  };
  const contentWithoutCompetitorLink = {
    title: 'Exploring the Best IT Companies in Nepal',
    sections: [
      { heading: 'Government Policy', body: 'See the official policy at [nitc.gov.np](https://nitc.gov.np/policy).' },
    ],
  };

  test('flags a generated competitor link with the competitor-link patternId', async () => {
    const { issues } = await findCompetitorLinks(contentWithCompetitorLink, site.id);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].patternId, 'competitor-link');
    assert.match(issues[0].snippet, /f1soft\.com/);
    assert.equal(issues[0].path, 'sections[0].body');
  });

  test('does not flag a link to a non-competitor authoritative domain', async () => {
    const { issues } = await findCompetitorLinks(contentWithoutCompetitorLink, site.id);
    assert.equal(issues.length, 0);
  });

  test('no siteId given: no-op, never blocks generation', async () => {
    const { issues } = await findCompetitorLinks(contentWithCompetitorLink, null);
    assert.equal(issues.length, 0);
  });

  test('runQualityGate (the actual generation + approval choke point) rejects blog-outline content containing a competitor link', async () => {
    const result = await runQualityGate(contentWithCompetitorLink, 'blog-outline', site.id);
    assert.equal(result.clean, false);
    assert.ok(result.issues.some((i) => i.patternId === 'competitor-link'));
  });

  test('runQualityGate passes the same content shape through clean when it has no competitor link', async () => {
    const result = await runQualityGate(contentWithoutCompetitorLink, 'blog-outline', site.id);
    assert.equal(result.issues.some((i) => i.patternId === 'competitor-link'), false);
  });
});
