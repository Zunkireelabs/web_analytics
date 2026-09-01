import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { query, pool } from '../../db.js';
import { upsertCompetitorProfile } from '../../store/competitor-profiles.js';
import {
  normalizeHost, getCompetitorDomainSet, isCompetitorUrl, filterCompetitorCandidates,
  _clearCompetitorPolicyCache,
} from './competitor-policy.js';

// Multi-tenant isolation is the whole point of this module — a shared cache
// or a query that forgot its own WHERE site_id = $1 would leak one tenant's
// competitors into another's content-generation or validation. Every test
// below creates two REAL, distinct sites (Tenant A, Tenant B) with their own
// competitor_profiles rows, exactly the way blog-outline.test.js already
// establishes real-DB test conventions in this repo.
describe('competitor-policy — tenant isolation', () => {
  let siteA, siteB;

  before(async () => {
    const a = await query(
      `INSERT INTO sites (name, gsc_property, ga4_property_id) VALUES ('Competitor Policy Tenant A', 'sc-domain:tenant-a-competitor-policy.example', 'test-ga4-a') RETURNING *`
    );
    const b = await query(
      `INSERT INTO sites (name, gsc_property, ga4_property_id) VALUES ('Competitor Policy Tenant B', 'sc-domain:tenant-b-competitor-policy.example', 'test-ga4-b') RETURNING *`
    );
    siteA = a.rows[0];
    siteB = b.rows[0];

    const runAt = new Date();
    await upsertCompetitorProfile(siteA.id, 'competitor-a.com', {}, runAt, null);
    await upsertCompetitorProfile(siteB.id, 'competitor-b.com', {}, runAt, null);
    // A false-positive platform row for Tenant A, to prove excluded_reason
    // is actually honored (not just present in the schema).
    await upsertCompetitorProfile(siteA.id, 'facebook.com', {}, runAt, 'platform');
  });

  after(async () => {
    await query('DELETE FROM competitor_profiles WHERE site_id = ANY($1)', [[siteA.id, siteB.id]]);
    await query('DELETE FROM sites WHERE id = ANY($1)', [[siteA.id, siteB.id]]);
    await pool.end();
  });

  beforeEach(() => {
    _clearCompetitorPolicyCache();
  });

  test('normalizeHost strips protocol, www, and trailing slash, case-insensitively', () => {
    assert.equal(normalizeHost('https://WWW.Competitor-A.com/'), 'competitor-a.com');
    assert.equal(normalizeHost('http://competitor-a.com/page?x=1'), 'competitor-a.com');
    assert.equal(normalizeHost('competitor-a.com'), 'competitor-a.com');
    assert.equal(normalizeHost(''), null);
    assert.equal(normalizeHost(null), null);
  });

  test("Tenant A's competitor is blocked for Tenant A", async () => {
    assert.equal(await isCompetitorUrl('https://competitor-a.com/blog', siteA.id), true);
    assert.equal(await isCompetitorUrl('https://www.competitor-a.com/', siteA.id), true);
    assert.equal(await isCompetitorUrl('https://sub.competitor-a.com/', siteA.id), true, 'subdomain of a configured competitor also matches');
  });

  test("Tenant B's competitor is blocked for Tenant B", async () => {
    assert.equal(await isCompetitorUrl('https://competitor-b.com/', siteB.id), true);
  });

  test("Tenant A's competitor is NOT blocked for Tenant B, and vice versa — no cross-tenant leakage", async () => {
    assert.equal(await isCompetitorUrl('https://competitor-a.com/', siteB.id), false);
    assert.equal(await isCompetitorUrl('https://competitor-b.com/', siteA.id), false);
  });

  test('excluded_reason IS NULL rows are active competitors; non-null rows (platform false positives) are not blocked', async () => {
    const domainsA = await getCompetitorDomainSet(siteA.id);
    assert.ok(domainsA.has('competitor-a.com'));
    assert.ok(!domainsA.has('facebook.com'), 'a row with excluded_reason set must not be treated as an active competitor');
    assert.equal(await isCompetitorUrl('https://facebook.com/zunkiree', siteA.id), false);
  });

  test('missing/unknown site_id fails open (empty set), never blocking generation and never matching another tenant', async () => {
    const domains = await getCompetitorDomainSet(999999999);
    assert.equal(domains.size, 0);
    assert.equal(await isCompetitorUrl('https://competitor-a.com/', 999999999), false);
    assert.equal(await isCompetitorUrl('https://competitor-a.com/', null), false);
  });

  test('filterCompetitorCandidates splits allowed vs removed and never leaks across tenants', async () => {
    const candidates = [
      { url: 'https://competitor-a.com/article' },
      { url: 'https://gov.example/report' },
      { url: 'https://competitor-b.com/article' },
    ];
    const { allowed, removed } = await filterCompetitorCandidates(candidates, siteA.id);
    assert.deepEqual(removed.map((c) => c.url), ['https://competitor-a.com/article']);
    assert.deepEqual(allowed.map((c) => c.url), ['https://gov.example/report', 'https://competitor-b.com/article']);
  });
});

// Static proof that this implementation is a generic multi-tenant
// capability, not a Zunkiree/site_id=1 patch — grepping the actual diff
// rather than trusting a comment, since a hardcoded special case is exactly
// the kind of thing that's easy to miss in review.
describe('competitor-policy — no hardcoded single-tenant behavior', () => {
  const MODULE_FILES = [
    '../../agents/lib/competitor-policy.js',
    '../../agents/lib/competitor-analysis.js',
    '../../generators/lib/outbound-link-guard.js',
    '../../generators/expand-content.js',
  ];

  test('none of the new/touched competitor-policy files contain live code referencing site_id 1 or a Zunkiree-specific domain', () => {
    // Strips `//` line comments before matching — a comment documenting the
    // real motivating incident (e.g. "shipped to zunkireelabs.com", the same
    // convention placeholder-guard.js already uses) is documentation, not
    // the client-specific special-casing this test guards against. Only
    // live code is checked. The Zunkiree pattern requires an actual domain
    // literal (zunkiree*.com) rather than any substring, so it doesn't flag
    // expand-content.js's pre-existing, unrelated "zunkiree_labs" sample
    // JSON key (an illustrative column name in a comparison-table prompt
    // example, not a hardcoded tenant reference).
    const FORBIDDEN = [/site_id\s*===?\s*1\b/i, /siteId\s*===?\s*1\b/i, /zunkiree\w*\.com/i];
    for (const rel of MODULE_FILES) {
      const path = fileURLToPath(new URL(rel, import.meta.url));
      const codeOnly = readFileSync(path, 'utf8')
        .split('\n')
        .map((line) => line.replace(/\/\/.*$/, ''))
        .join('\n');
      for (const pattern of FORBIDDEN) {
        assert.equal(pattern.test(codeOnly), false, `${rel} must not contain ${pattern} in live code — this must stay a generic multi-tenant capability`);
      }
    }
  });
});
