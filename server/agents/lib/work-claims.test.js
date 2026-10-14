import { test, describe, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const resolve = (p) => fileURLToPath(new URL(p, import.meta.url));

// A tiny in-memory stand-in for the work_claims table that enforces the ONE
// invariant the real schema enforces: at most one open row per
// (site_id, scope, scope_key). Without that, a test of "the second producer
// loses" would be testing the mock rather than the design.
let rows;
let nextId;
let failNextQuery;
let queries;

beforeEach(() => {
  rows = [];
  nextId = 1;
  failNextQuery = false;
  queries = [];
});

function openRow(siteId, scope, scopeKey) {
  return rows.find((r) => r.site_id === siteId && r.scope === scope && r.scope_key === scopeKey && r.status === 'open');
}

mock.module(resolve('../../db.js'), {
  namedExports: {
    query: async (sql, params = []) => {
      queries.push(sql);
      if (failNextQuery) throw new Error('db unreachable');

      if (/^\s*UPDATE work_claims SET status = 'expired'/.test(sql) && params.length === 3) {
        const [siteId, scope, scopeKey] = params;
        for (const r of rows) {
          if (r.site_id === siteId && r.scope === scope && r.scope_key === scopeKey && r.status === 'open' && r.expired) {
            r.status = 'expired';
          }
        }
        return { rows: [] };
      }
      if (/^\s*UPDATE work_claims SET status = 'expired'/.test(sql)) {
        const swept = rows.filter((r) => r.status === 'open' && r.expired);
        for (const r of swept) r.status = 'expired';
        return { rows: swept.map((r) => ({ id: r.id })) };
      }
      if (/SELECT id, intent, producer/.test(sql)) {
        const [siteId, scope, scopeKey] = params;
        const found = openRow(siteId, scope, scopeKey);
        return { rows: found ? [found] : [] };
      }
      if (/INSERT INTO work_claims/.test(sql)) {
        const [siteId, scope, scopeKey, intent, producer, generatorId, recommendationId, draftId] = params;
        if (openRow(siteId, scope, scopeKey)) return { rows: [] }; // the partial unique index
        const row = {
          id: nextId++, site_id: siteId, scope, scope_key: scopeKey, intent, producer,
          generator_id: generatorId, recommendation_id: recommendationId, draft_id: draftId,
          status: 'open', expired: false,
        };
        rows.push(row);
        return { rows: [{ id: row.id }] };
      }
      if (/SET status = 'superseded'/.test(sql)) {
        const row = rows.find((r) => r.id === params[0] && r.status === 'open');
        if (!row) return { rows: [] };
        row.status = 'superseded';
        return { rows: [{ id: row.id }] };
      }
      if (/SET status = \$2/.test(sql)) {
        const row = rows.find((r) => r.id === params[0] && r.status === 'open');
        if (!row) return { rows: [] };
        row.status = params[1];
        return { rows: [{ id: row.id }] };
      }
      throw new Error(`unexpected sql: ${sql}`);
    },
  },
});

const {
  claimWork, releaseClaim, activeClaimFor, expireStaleClaims,
  normalizeScopeKey, resolveIntentConflict, DEFAULT_TTL_HOURS,
  intentForGenerator, claimScopeFor, claimForItem,
} = await import('./work-claims.js');

const claim = (over = {}) => claimWork({
  siteId: 1, scope: 'page', scopeKey: '/pricing', intent: 'meta', producer: 'daily-roster', ...over,
});

describe('normalizeScopeKey', () => {
  test('one page claimed by live URL or by permalink is one key', () => {
    assert.equal(
      normalizeScopeKey('page', 'https://www.example.com/pricing/'),
      normalizeScopeKey('page', '/pricing')
    );
  });

  test('case, hash and query string do not create a second owner', () => {
    const base = normalizeScopeKey('page', '/pricing');
    assert.equal(normalizeScopeKey('page', '/Pricing'), base);
    assert.equal(normalizeScopeKey('page', '/pricing#plans'), base);
    assert.equal(normalizeScopeKey('page', '/pricing?utm_source=x'), base);
  });

  test('the site root stays distinct from empty', () => {
    assert.equal(normalizeScopeKey('page', '/'), '/');
    assert.equal(normalizeScopeKey('page', ''), '');
  });

  test('topic spelling variants collapse to one topic', () => {
    const k = normalizeScopeKey('topic', 'AI content tools');
    assert.equal(normalizeScopeKey('topic', 'ai  content   tools'), k);
    assert.equal(normalizeScopeKey('topic', 'ai-content-tools'), k);
  });

  test('non-ASCII topics are preserved rather than stripped to nothing', () => {
    assert.equal(normalizeScopeKey('topic', 'Übersetzung Dienste'), 'übersetzung-dienste');
  });
});

describe('resolveIntentConflict', () => {
  test('a covered topic prefers linking over publishing another page', () => {
    const r = resolveIntentConflict({ existingIntent: 'new-blog', incomingIntent: 'internal-link', coverageStatus: 'covered' });
    assert.equal(r.winner, 'incoming');
  });

  test('a duplicate topic prefers expanding over publishing another page', () => {
    const r = resolveIntentConflict({ existingIntent: 'new-blog', incomingIntent: 'expand-existing', coverageStatus: 'duplicate' });
    assert.equal(r.winner, 'incoming');
  });

  test('a genuine gap prefers a new page over expanding', () => {
    const r = resolveIntentConflict({ existingIntent: 'expand-existing', incomingIntent: 'new-blog', coverageStatus: 'opportunity' });
    assert.equal(r.winner, 'incoming');
  });

  test('the ranking inverts with coverage — the same pair decides oppositely', () => {
    const covered = resolveIntentConflict({ existingIntent: 'expand-existing', incomingIntent: 'new-blog', coverageStatus: 'covered' });
    const gap = resolveIntentConflict({ existingIntent: 'expand-existing', incomingIntent: 'new-blog', coverageStatus: 'opportunity' });
    assert.equal(covered.winner, 'existing');
    assert.equal(gap.winner, 'incoming');
  });

  test('unknown coverage is treated as a gap, not as covered', () => {
    const r = resolveIntentConflict({ existingIntent: 'expand-existing', incomingIntent: 'new-blog' });
    assert.equal(r.winner, 'incoming');
  });

  test('the incumbent keeps the claim for an identical intent', () => {
    const r = resolveIntentConflict({ existingIntent: 'new-blog', incomingIntent: 'new-blog' });
    assert.equal(r.winner, 'existing');
    assert.equal(r.reason, 'same-intent');
  });

  test('a non-content intent never evicts a content one, and vice versa', () => {
    assert.equal(resolveIntentConflict({ existingIntent: 'new-blog', incomingIntent: 'repair' }).winner, 'existing');
    assert.equal(resolveIntentConflict({ existingIntent: 'repair', incomingIntent: 'new-blog' }).winner, 'existing');
  });
});

describe('claimWork', () => {
  test('the first producer takes the claim', async () => {
    const r = await claim();
    assert.equal(r.ok, true);
    assert.ok(r.claimId);
  });

  test('a second producer loses the same page, and is told who holds it', async () => {
    await claim({ producer: 'daily-roster' });
    const second = await claim({ producer: 'content-repair' });

    assert.equal(second.ok, false);
    assert.equal(second.heldBy.producer, 'daily-roster');
  });

  test('the generator is NOT part of the key — the whole point of this table', async () => {
    // Under the recommendations index these two are different rows, so both
    // would be drafted and both would edit the same file.
    await claim({ generatorId: 'meta-title', intent: 'meta' });
    const second = await claim({ generatorId: 'expand-content', intent: 'meta' });
    assert.equal(second.ok, false);
  });

  test('different pages on the same site do not contend', async () => {
    await claim({ scopeKey: '/pricing' });
    const other = await claim({ scopeKey: '/about' });
    assert.equal(other.ok, true);
  });

  test('the same path on different sites does not contend', async () => {
    await claim({ siteId: 1 });
    const other = await claim({ siteId: 2 });
    assert.equal(other.ok, true);
  });

  test('a page and a topic with the same text are different scopes', async () => {
    await claim({ scope: 'page', scopeKey: 'pricing' });
    const topic = await claim({ scope: 'topic', scopeKey: 'pricing', intent: 'new-blog' });
    assert.equal(topic.ok, true);
  });

  test('releasing frees the key for the next producer', async () => {
    const first = await claim();
    await releaseClaim(first.claimId);
    const second = await claim({ producer: 'content-repair' });
    assert.equal(second.ok, true);
  });

  test('an outranking intent supersedes the incumbent and takes over', async () => {
    const first = await claim({ scope: 'topic', scopeKey: 'ai tools', intent: 'new-blog', producer: 'keyword-gap' });
    const second = await claim({
      scope: 'topic', scopeKey: 'ai tools', intent: 'internal-link',
      producer: 'analyst-fusion', coverageStatus: 'covered',
    });

    assert.equal(second.ok, true);
    assert.equal(second.superseded, first.claimId);
    const held = await activeClaimFor(1, 'topic', 'ai tools');
    assert.equal(held.intent, 'internal-link');
  });

  test('an outranked intent leaves the incumbent untouched', async () => {
    await claim({ scope: 'topic', scopeKey: 'ai tools', intent: 'internal-link', coverageStatus: 'covered' });
    const second = await claim({
      scope: 'topic', scopeKey: 'ai tools', intent: 'new-blog', coverageStatus: 'covered',
    });

    assert.equal(second.ok, false);
    const held = await activeClaimFor(1, 'topic', 'ai tools');
    assert.equal(held.intent, 'internal-link');
  });

  test('an unkeyable scope is not claimable, so site-level work does not all collide', async () => {
    // recommendationPageKey returns '' for SITE_LEVEL_GENERATOR_IDS; every
    // one of those must not end up contending for a single empty-string key.
    const a = await claim({ scopeKey: '' });
    const b = await claim({ scopeKey: '' });

    assert.equal(a.ok, true);
    assert.equal(a.claimId, null);
    assert.equal(a.reason, 'unkeyed');
    assert.equal(b.ok, true);
  });

  test('an unreachable ledger fails SOFT — real work proceeds unclaimed', async () => {
    failNextQuery = true;
    const r = await claim();

    assert.equal(r.ok, true, 'a DB hiccup must not look like a platform outage');
    assert.equal(r.claimId, null);
    assert.equal(r.reason, 'unavailable');
  });

  test('an unknown scope or intent is a programming error, not a soft failure', async () => {
    await assert.rejects(() => claim({ scope: 'nonsense' }), /unknown scope/);
    await assert.rejects(() => claim({ intent: 'nonsense' }), /unknown intent/);
  });

  test('the default lease matches the reconciler window it is paired with', () => {
    assert.equal(DEFAULT_TTL_HOURS, 24);
  });
});

describe('intentForGenerator / claimScopeFor', () => {
  test('generators that produce a new page share one intent', () => {
    for (const g of ['blog-outline', 'landing-page', 'comparison-page']) {
      assert.equal(intentForGenerator(g), 'new-blog', g);
    }
  });

  test('generators that add to an existing page share one intent', () => {
    for (const g of ['expand-content', 'faq', 'qa-content']) {
      assert.equal(intentForGenerator(g), 'expand-existing', g);
    }
  });

  test('an unknown generator is technical, never a content intent', () => {
    // A content intent would let a new generator silently start evicting
    // blog posts from topics it knows nothing about.
    assert.equal(intentForGenerator('some-new-generator'), 'technical');
    assert.equal(intentForGenerator(undefined), 'technical');
  });

  test('content generators contend on their TOPIC, not a page they have not created', () => {
    // blog-outline and landing-page carry no `page` param at all — the same
    // reason recommendationPageKey special-cases them.
    assert.deepEqual(
      claimScopeFor({ generatorId: 'blog-outline', params: { topic: 'ai tools' } }),
      { scope: 'topic', scopeKey: 'ai tools' }
    );
    assert.deepEqual(
      claimScopeFor({ generatorId: 'landing-page', params: { market: 'Nepal' } }),
      { scope: 'topic', scopeKey: 'Nepal' }
    );
  });

  test('page fixes contend on their page', () => {
    assert.deepEqual(
      claimScopeFor({ generatorId: 'meta-title', params: { page: '/pricing' } }),
      { scope: 'page', scopeKey: '/pricing' }
    );
  });

  test('a blog post and a landing page for ONE topic contend with each other', async () => {
    // The duplicate the recommendations index structurally cannot see: two
    // different recommendation_types, one piece of real work.
    process.env.WORK_CLAIMS_ENABLED = 'true';
    try {
      const first = await claimForItem(1, { generatorId: 'blog-outline', params: { topic: 'ai tools' } }, 'keyword-gap');
      const second = await claimForItem(1, { generatorId: 'landing-page', params: { topic: 'ai tools' } }, 'daily-roster');
      assert.equal(first.ok, true);
      assert.equal(second.ok, false);
    } finally {
      delete process.env.WORK_CLAIMS_ENABLED;
    }
  });

  test('with the flag off, nothing is ever claimed or refused', async () => {
    delete process.env.WORK_CLAIMS_ENABLED;
    const first = await claimForItem(1, { generatorId: 'blog-outline', params: { topic: 'ai tools' } }, 'keyword-gap');
    const second = await claimForItem(1, { generatorId: 'landing-page', params: { topic: 'ai tools' } }, 'daily-roster');

    assert.equal(first.ok, true);
    assert.equal(first.reason, 'disabled');
    assert.equal(second.ok, true, 'the deploy must be behaviourally inert until enabled');
    assert.equal(rows.length, 0, 'nothing is written to the ledger either');
  });
});

describe('expiry', () => {
  test('an expired claim does not starve a live producer', async () => {
    const first = await claim({ producer: 'dead-producer' });
    rows.find((r) => r.id === first.claimId).expired = true;

    const second = await claim({ producer: 'live-producer' });
    assert.equal(second.ok, true, 'a producer that died mid-run must not hold the page forever');
  });

  test('the sweep reports how many it reclaimed', async () => {
    const a = await claim({ scopeKey: '/a' });
    await claim({ scopeKey: '/b' });
    rows.find((r) => r.id === a.claimId).expired = true;

    assert.equal(await expireStaleClaims(), 1);
  });

  test('a failing sweep returns zero rather than throwing into the cron lane', async () => {
    failNextQuery = true;
    assert.equal(await expireStaleClaims(), 0);
  });

  test('activeClaimFor reports the holder, and nothing once released', async () => {
    const first = await claim();
    assert.equal((await activeClaimFor(1, 'page', '/pricing')).producer, 'daily-roster');
    await releaseClaim(first.claimId, 'released');
    assert.equal(await activeClaimFor(1, 'page', '/pricing'), null);
  });
});
