import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { query, pool } from '../../db.js';
import { upsertCompetitorProfile } from '../../store/competitor-profiles.js';
import { _clearCompetitorPolicyCache } from '../../agents/lib/competitor-policy.js';
import { domainLabel, findCompetitorProminenceIssues } from './competitor-prominence.js';
import { runQualityGate } from './quality-gate.js';

describe('competitor-prominence — domainLabel', () => {
  test('derives a separator-free label that matches a real display name', () => {
    assert.equal(domainLabel('paailatechnology.com'), 'paailatechnology');
    assert.equal(domainLabel('www.f1soft.com'), 'f1soft');
    assert.equal(domainLabel('shkhina-ai-labs.com'), 'shkhinaailabs');
  });

  test('skips a label too short to match without colliding with ordinary prose', () => {
    assert.equal(domainLabel('ai.com'), null);
  });
});

describe('competitor-prominence — findCompetitorProminenceIssues / quality-gate integration', () => {
  let site;

  before(async () => {
    const { rows } = await query(
      `INSERT INTO sites (name, gsc_property, ga4_property_id, website_domain)
       VALUES ('Zunkiree Labs Prominence Test', 'sc-domain:prominence-test.example', 'test-ga4', 'zunkireelabs.com')
       RETURNING *`
    );
    site = rows[0];
    for (const domain of ['f1soft.com', 'logpoint.com', 'paailatechnology.com', 'verisk.com', 'naamii.org', 'joomni.com']) {
      await upsertCompetitorProfile(site.id, domain, {}, new Date(), null);
    }
  });

  after(async () => {
    await query('DELETE FROM competitor_profiles WHERE site_id = $1', [site.id]);
    await query('DELETE FROM sites WHERE id = $1', [site.id]);
    await pool.end();
  });

  beforeEach(() => {
    _clearCompetitorPolicyCache();
  });

  // The whole point of the policy: this must pass. A genuine comparison names
  // a competitor, weighs it honestly, and argues the client is the better fit.
  const legitimateComparison = {
    title: 'Zunkiree Labs vs F1Soft: Choosing an AI Partner in Nepal',
    description: 'How Zunkiree Labs compares to F1Soft for enterprise AI search.',
    sections: [
      { heading: 'Why Zunkiree Labs', body: 'Zunkiree Labs builds AI search that ships to production. Zunkiree owns the full retrieval stack.' },
      { heading: 'How F1Soft Compares', body: 'F1Soft is strong in fintech rails, but F1Soft does not offer AI-native search, which is where Zunkiree Labs wins.' },
    ],
  };

  test('a real comparison that names a competitor but keeps the client dominant passes clean', async () => {
    const { issues } = await findCompetitorProminenceIssues(legitimateComparison, site.id);
    assert.deepEqual(issues, []);
  });

  test('flags a competitor owning the title/H1/meta with the client absent from them', async () => {
    const content = {
      title: 'F1Soft International: Nepal\'s Best Fintech Employer',
      description: 'Why F1Soft leads the market.',
      sections: [{ heading: 'Overview', body: 'Zunkiree Labs also exists. Zunkiree Labs is fine. Zunkiree Labs works.' }],
    };
    const { issues } = await findCompetitorProminenceIssues(content, site.id);
    const hit = issues.find((i) => i.patternId === 'competitor-headline');
    assert.ok(hit, 'expected a competitor-headline issue');
    assert.match(hit.snippet, /f1soft\.com/);
  });

  test('flags competitors outweighing the client brand in the body', async () => {
    // The live shape: three flattering competitor sections, one client section,
    // and not a single outbound link for the link guard to catch.
    const content = {
      title: 'Top IT Companies to Work for in Nepal',
      sections: [
        { heading: 'Zunkiree Labs', body: 'Zunkiree Labs builds AI infrastructure.' },
        { heading: 'F1Soft International', body: 'F1Soft is a great employer. F1Soft invests in staff. F1Soft leads fintech.' },
        { heading: 'LogPoint', body: 'LogPoint masters cybersecurity. LogPoint trains its people well.' },
        { heading: 'Paaila Technology', body: 'Paaila Technology fosters cloud innovation at Paaila Technology.' },
      ],
    };
    const { issues } = await findCompetitorProminenceIssues(content, site.id);
    assert.ok(issues.some((i) => i.patternId === 'competitor-outweighs-brand'));
  });

  test('flags a directory that profiles many competitors in a row', async () => {
    const content = {
      title: 'Zunkiree Labs Guide to Top Tech Companies in Nepal 2026',
      sections: [
        { heading: 'Zunkiree Labs', body: 'Zunkiree Labs. Zunkiree Labs. Zunkiree Labs. Zunkiree Labs. Zunkiree Labs. Zunkiree Labs. Zunkiree Labs. Zunkiree Labs. Zunkiree Labs. Zunkiree Labs.' },
        { heading: 'F1Soft', body: 'F1Soft profile.' },
        { heading: 'LogPoint', body: 'LogPoint profile.' },
        { heading: 'Paaila Technology', body: 'Paaila Technology profile.' },
        { heading: 'Verisk', body: 'Verisk profile.' },
        { heading: 'NAAMII', body: 'NAAMII profile.' },
        { heading: 'Joomni', body: 'Joomni profile.' },
      ],
    };
    const { issues } = await findCompetitorProminenceIssues(content, site.id);
    const hit = issues.find((i) => i.patternId === 'competitor-directory');
    assert.ok(hit, 'expected a competitor-directory issue');
    // Client brand deliberately dominates the body here, so this must be the
    // directory rule firing on its own — not a side effect of the ratio rule.
    assert.equal(issues.some((i) => i.patternId === 'competitor-outweighs-brand'), false);
  });

  test('no siteId given: no-op, never blocks generation', async () => {
    const { issues } = await findCompetitorProminenceIssues({ title: 'F1Soft is great' }, null);
    assert.deepEqual(issues, []);
  });

  test('runQualityGate blocks a competitor-dominated draft and passes a balanced comparison', async () => {
    const dominated = {
      title: 'F1Soft International: The Best Place to Work',
      sections: [{ heading: 'F1Soft', body: 'F1Soft leads. F1Soft wins. F1Soft grows.' }],
    };
    const blocked = await runQualityGate(dominated, 'blog-outline', site.id);
    assert.equal(blocked.clean, false);
    assert.ok(blocked.issues.some((i) => i.patternId.startsWith('competitor-')));

    const allowed = await runQualityGate(legitimateComparison, 'blog-outline', site.id);
    assert.equal(allowed.issues.some((i) => i.patternId.startsWith('competitor-')), false);
  });
});
