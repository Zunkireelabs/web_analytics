import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCandidateKind, validateCompetitorCandidate, excludedKindsFor, splitByDomainKind } from './competitor-category.js';
import { normalizeProfile } from '../../lib/business-profile.js';

const profile = (over = {}) => normalizeProfile({ fields: {
  ownIndustry: { value: { label: over.industry || 'Education consultancy' }, status: 'detected', confidence: 'high', evidence: [{ source: 'page', ref: 'u', summary: 's', quote: 'q' }] },
  ...(over.model ? { businessModel: { value: { model: over.model }, status: 'detected', evidence: [{ source: 'page', ref: 'u', summary: 's', quote: 'q' }] } } : {}),
  ...(over.exclude ? { competitorCategories: { value: { include: [], exclude: over.exclude }, status: 'assumed' } } : {}),
} });

// The actual domains that were stored as "real competitors" in production before this validator existed.
describe('the real wrong competitors found in production', () => {
  test('an embassy and a ministry are excluded for a study-abroad business', () => {
    const p = profile();
    for (const [d, kind] of [['indembkathmandu.gov.in', 'embassy'], ['moest.gov.np', 'government']]) {
      const v = validateCompetitorCandidate(d, {}, p);
      assert.equal(v.excluded, true, d);
      assert.equal(v.kind, kind, d);
      assert.equal(v.confidence, 'high');
      assert.ok(v.reasons.length > 0);
    }
  });

  test('directories and review sites are excluded for an AI company', () => {
    const p = profile({ industry: 'Software (SaaS)' });
    for (const d of ['crunchbase.com', 'techbehemoths.com', 'clutch.co', 'goodfirms.co', 'g2.com']) assert.equal(validateCompetitorCandidate(d, {}, p).excluded, true, d);
  });

  test('a removals marketplace is excluded for a removals company, but a real removals firm is not', () => {
    const p = profile({ industry: 'Removal and relocation services' });
    assert.equal(validateCompetitorCandidate('anyvan.com', {}, p).kind, 'marketplace');
    assert.equal(validateCompetitorCandidate('anyvan.com', {}, p).excluded, true);
    assert.equal(validateCompetitorCandidate('britannia-movers.co.uk', {}, p).excluded, false);
    assert.equal(validateCompetitorCandidate('holdemremovals.co.uk', {}, p).excluded, false);
  });

  test('genuine rivals pass untouched', () => {
    const p = profile({ industry: 'Software (SaaS)' });
    for (const d of ['fusemachines.com', 'zenoti.com', 'searchatlas.com', 'aeccglobal.com', 'newnorth.com']) assert.equal(validateCompetitorCandidate(d, {}, p).excluded, false, d);
  });
});

describe('what the business itself is decides what counts as a rival', () => {
  test('a directory business competes with directories', () => {
    const p = profile({ industry: 'Business directory and reviews', model: 'marketplace' });
    assert.equal(validateCompetitorCandidate('yelp.com', {}, p).excluded, false);
    assert.equal(validateCompetitorCandidate('moest.gov.np', {}, p).excluded, true); // a ministry is still not a rival
  });

  test('a country-level edu domain is not proof of a school: a Nepali study-abroad consultancy on edu.np stays a competitor (found in the dry run)', () => {
    for (const d of ['kiec.edu.np', 'someconsultancy.edu.pk', 'agency.ac.in']) assert.equal(validateCompetitorCandidate(d, {}, profile()).excluded, false, d);
  });

  test('a university is a destination for a study-abroad consultancy, not a competitor, but it is a competitor of another school', () => {
    assert.equal(validateCompetitorCandidate('ox.ac.uk', {}, profile()).kind, 'institution');
    assert.equal(validateCompetitorCandidate('ox.ac.uk', {}, profile()).excluded, true);
    assert.equal(validateCompetitorCandidate('mit.edu', {}, profile({ industry: 'Private university' })).excluded, false);
  });

  test('a publisher competes with other publishers', () => {
    assert.equal(validateCompetitorCandidate('forbes.com', {}, profile({ industry: 'Online news and media' })).excluded, false);
    assert.equal(validateCompetitorCandidate('forbes.com', {}, profile({ industry: 'Software (SaaS)' })).excluded, true);
  });

  test('the profile can add kinds that do not compete, in plain words', () => {
    const kinds = excludedKindsFor(profile({ exclude: ['directories', 'government bodies', 'review sites'] }));
    assert.ok(kinds.has('directory') && kinds.has('government') && kinds.has('review-site'));
  });

  test('with no profile at all the safe defaults still apply', () => {
    assert.equal(validateCompetitorCandidate('moest.gov.np', {}, null).excluded, true);
    assert.equal(validateCompetitorCandidate('fusemachines.com', {}, null).excluded, false);
  });
});

describe('what a homepage says about itself', () => {
  test('a ministry page on an ordinary domain is recognised, with medium confidence and a reason', () => {
    const v = validateCompetitorCandidate('educationnepal.org', { title: 'Ministry of Education, Science and Technology', text: 'The Ministry of Education is responsible for national education policy.' }, profile());
    assert.equal(v.kind, 'government');
    assert.equal(v.confidence, 'medium');
    assert.match(v.reasons[0], /ministry or government body/);
  });

  test('an embassy page is recognised', () => {
    assert.equal(classifyCandidateKind('visa-info.org', { text: 'Embassy of India in Kathmandu. Visa services.' }).kind, 'embassy');
  });

  test('a site that describes itself as a listing site needs two listing phrases, one is not enough', () => {
    assert.equal(classifyCandidateKind('studyguide.com', { text: 'Browse our universities and read reviews of every course. List your business with us.' }).kind, 'directory');
    assert.equal(classifyCandidateKind('studyplan.com', { text: 'We help you browse the options with a personal counsellor.' }).kind, null);
  });

  test('a business that merely mentions a ministry is not misread', () => {
    assert.equal(classifyCandidateKind('visaexperts.com', { text: 'We guide students through every step, from choosing a university to your visa interview.' }).kind, null);
  });
});

describe('splitByDomainKind: the cheap pass that runs before any page is fetched or any model is paid for', () => {
  test('only high-confidence domain evidence removes a candidate up front', () => {
    const { keep, excluded } = splitByDomainKind(['moest.gov.np', 'aeccglobal.com', 'crunchbase.com', 'idp.com'], profile());
    assert.deepEqual(keep, ['aeccglobal.com', 'idp.com']);
    assert.deepEqual(excluded.map((e) => e.domain), ['moest.gov.np', 'crunchbase.com']);
    assert.ok(excluded.every((e) => e.reasons.length > 0));
  });

  test('malformed input never throws', () => {
    assert.deepEqual(classifyCandidateKind(null).kind, null);
    assert.deepEqual(classifyCandidateKind('not a domain').kind, null);
    assert.deepEqual(splitByDomainKind([]), { keep: [], excluded: [] });
  });
});
