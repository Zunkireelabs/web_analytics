import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { runDesignValidationStage as realStage, isDesignAffectingGenerator, DesignValidationPending, isDesignPending, noPageLock, SITE_KEY } from './design-validation-stage.js';
// Single-process tests: no cross-worker lock (that path has its own database test).
const runDesignValidationStage = (opts) => realStage({ pageLock: noPageLock, ...opts });
import { createFetchCache, computeLayoutFingerprint, validatedContextFor } from './live-design-validation.js';
import { createReviewStore, reviewStateOf } from './design-review-store.js';

const O = 'https://x.test';
const page = (blocks) => `<html><body><main>${blocks.map((c) => `<section class="${c}"><p>t</p></section>`).join('')}</main></body></html>`;
const POST = ['post-wrap mx-auto max-w-3xl', 'post-title text-4xl font-bold', 'post-body prose prose-lg', 'author-box flex gap-4'];
const sec = (classes) => ({ role: 'content', classes, textHierarchy: [{ role: 'subheading', classes }] });
const site = (review) => ({
  id: 7, url_file_map: { siteRoot: {
    designProfile: { pages: [{ url: O + '/blog/a', sections: POST.map(sec) }], layoutGroups: { revision: 1, groups: [{ id: 'g1', sample: '/blog/a', members: ['/blog/a', '/blog/b'] }] } },
    ...(review ? { designReview: review } : {}),
  } },
});

// The store under test, backed by a fake locked row so what the stage persists can be read back.
function memoryStore(root) {
  let ufm = { siteRoot: root };
  const store = createReviewStore({ withSiteLock: async (id, fn) => { const out = await fn(JSON.parse(JSON.stringify(ufm))); if (out?.urlFileMap) ufm = out.urlFileMap; return out?.value; } });
  return { store, state: () => reviewStateOf(ufm.siteRoot), root: () => ufm.siteRoot };
}
const counter = () => { const c = { validate: 0, fetch: 0 }; return c; };
const okFetch = (c) => async () => { c.fetch++; return page(POST); };

describe('scope (H1): only edits that change what a visitor sees are validated', () => {
  for (const id of ['meta-title', 'canonical', 'open-graph', 'schema', 'schema-repair', 'alt-text', 'redirect-fix', 'broken-link-fix', 'html-lang', 'viewport', 'analytics-install', 'landing-page', 'blog-outline', 'missing-page-create']) {
    test(`${id}: skipped with no network and no validation`, async () => {
      const c = counter();
      const r = await runDesignValidationStage({ site: site(), generatorId: id, pageUrl: O + '/blog/b', validate: async () => { c.validate++; }, fetchHtml: okFetch(c), store: memoryStore(site().url_file_map.siteRoot).store });
      assert.equal(r.outcome, 'skipped'); assert.equal(c.validate + c.fetch, 0);
    });
  }
  test('faq / qa-content / expand-content / internal-links / refresh-content / blog-image / breadcrumbs are in scope', () => {
    for (const id of ['faq', 'qa-content', 'expand-content', 'internal-links', 'refresh-content', 'blog-image', 'breadcrumbs']) assert.equal(isDesignAffectingGenerator(id), true, id);
  });
  test('LIVE_DESIGN_VALIDATION=false skips everything', async () => {
    const r = await runDesignValidationStage({ site: site(), generatorId: 'faq', pageUrl: O + '/blog/b', env: { LIVE_DESIGN_VALIDATION: 'false' }, validate: async () => assert.fail('must not run') });
    assert.equal(r.reason, 'disabled');
  });
});

describe('blocked -> PENDING error (C2), with evidence and backoff (M2, M3)', () => {
  test('a block throws DesignValidationPending: not a refusal, not 4xx, flagged pending, evidence persisted', async () => {
    const m = memoryStore(site().url_file_map.siteRoot);
    const err = await runDesignValidationStage({
      site: site(), generatorId: 'faq', pageUrl: O + '/blog/b', store: m.store, pageCache: createFetchCache(), fetchHtml: async () => { throw new Error('down'); },
      validate: async () => ({ status: 'blocked', reason: 'page-unreachable', transient: true, context: null, proposal: null }),
    }).catch((e) => e);
    assert.ok(err instanceof DesignValidationPending);
    assert.equal(isDesignPending(err), true);
    assert.equal(err.refusal, undefined, 'never an honest refusal');
    assert.equal(err.status, 503, 'not a 4xx (the 4xx heuristic would read it as a refusal)');
    assert.equal(err.reason, 'design-validation-pending');
    const st = m.state();
    assert.equal(st.evidence.at(-1).status, 'blocked');
    assert.equal(st.pageResults['/blog/b'].outcome, 'blocked');
  });

  test('a page in backoff is NOT re-fetched or re-validated (no duplicate work), and still throws pending', async () => {
    const m = memoryStore(site().url_file_map.siteRoot);
    const blockedRun = () => runDesignValidationStage({ site: { ...site(), url_file_map: { siteRoot: m.root() } }, generatorId: 'faq', pageUrl: O + '/blog/b', store: m.store, pageCache: createFetchCache(), fetchHtml: async () => { throw new Error('down'); }, validate: async () => ({ status: 'blocked', reason: 'page-unreachable', transient: true }) });
    await blockedRun().catch(() => {});
    const c = counter();
    const err = await runDesignValidationStage({ site: { ...site(), url_file_map: { siteRoot: m.root() } }, generatorId: 'faq', pageUrl: O + '/blog/b', store: m.store, fetchHtml: okFetch(c), validate: async () => { c.validate++; } }).catch((e) => e);
    assert.ok(isDesignPending(err)); assert.equal(c.fetch + c.validate, 0);
    assert.ok(/waiting/.test(err.message));
  });

  test('a permanent block parks the page for review (exhausted) instead of retrying forever', async () => {
    const m = memoryStore(site().url_file_map.siteRoot);
    await runDesignValidationStage({ site: site(), generatorId: 'faq', pageUrl: O + '/blog/b', store: m.store, pageCache: createFetchCache(), fetchHtml: async () => page(['x']), validate: async () => ({ status: 'blocked', reason: 'page-structure-unreadable', transient: false }) }).catch(() => {});
    const err = await runDesignValidationStage({ site: { ...site(), url_file_map: { siteRoot: m.root() } }, generatorId: 'faq', pageUrl: O + '/blog/b', store: m.store, validate: async () => assert.fail('must not run') }).catch((e) => e);
    assert.equal(err.exhausted, true); assert.ok(/waiting for a design review/.test(err.message));
  });

  test('if recording evidence fails, the edit is not failed by it', async () => {
    const broken = { recordValidation: async () => { throw new Error('db down'); } };
    const ctx = { pagePath: '/blog/b', sections: POST.map(sec), groupId: 'g1', vocabulary: [] };
    const r = await runDesignValidationStage({ site: site(), generatorId: 'faq', pageUrl: O + '/blog/b', store: broken, pageCache: createFetchCache(), fetchHtml: async () => page(POST), log: { warn() {} }, validate: async () => ({ status: 'matched', context: ctx, proposal: null, fingerprint: { hash: 'h' } }) });
    assert.equal(r.outcome, 'matched');
  });
});

describe('remembered answers (M3)', () => {
  test('an unchanged page reuses the remembered match: no validation, context rebuilt from the group sample', async () => {
    const fp = computeLayoutFingerprint(page(POST));
    const review = { version: 1, provisional: {}, history: [], evidence: [], pageResults: { '/blog/b': { outcome: 'matched', fingerprintHash: fp.hash, groupId: 'g1', expiresAt: '2999-01-01T00:00:00Z' } } };
    const s = site(review); const m = memoryStore(s.url_file_map.siteRoot);
    const r = await runDesignValidationStage({ site: s, generatorId: 'faq', pageUrl: O + '/blog/b', store: m.store, pageCache: createFetchCache(), fetchHtml: async () => page(POST), validate: async () => assert.fail('must not re-validate') });
    assert.equal(r.memo, 'hit'); assert.equal(r.context.groupId, 'g1');
    assert.equal(validatedContextFor(r.site, O + '/blog/b').groupId, 'g1');
    assert.equal(m.state().evidence.at(-1).memo, 'hit', 'reuse is recorded as evidence too');
  });

  test('a remembered PROVISIONAL capture is reused — no second browser capture for the same unchanged page', async () => {
    const fp = computeLayoutFingerprint(page(POST));
    const review = { version: 1, history: [], evidence: [], provisional: { p1: { id: 'p1', status: 'pending', entry: { url: O + '/blog/b', sections: POST.map(sec) } } }, pageResults: { '/blog/b': { outcome: 'provisional', fingerprintHash: fp.hash, provisionalId: 'p1', expiresAt: '2999-01-01T00:00:00Z' } } };
    const r = await runDesignValidationStage({ site: site(review), generatorId: 'faq', pageUrl: O + '/blog/b', store: memoryStore(site(review).url_file_map.siteRoot).store, pageCache: createFetchCache(), fetchHtml: async () => page(POST), validate: async () => assert.fail('must not re-capture') });
    assert.equal(r.context.source, 'remembered-capture'); assert.equal(r.context.provisional, true);
  });

  test('a CHANGED page ignores the memo and validates again', async () => {
    const review = { version: 1, provisional: {}, history: [], evidence: [], pageResults: { '/blog/b': { outcome: 'matched', fingerprintHash: 'old-hash', groupId: 'g1', expiresAt: '2999-01-01T00:00:00Z' } } };
    let ran = 0;
    await runDesignValidationStage({ site: site(review), generatorId: 'faq', pageUrl: O + '/blog/b', store: memoryStore(site(review).url_file_map.siteRoot).store, pageCache: createFetchCache(), fetchHtml: async () => page(POST), validate: async () => { ran++; return { status: 'matched', context: { pagePath: '/blog/b', groupId: 'g1' }, proposal: null }; } });
    assert.equal(ran, 1);
  });
});

describe('proposals are stored for review, never applied (H4)', () => {
  test('a provisional result stores ONE pending proposal and leaves layoutGroups untouched', async () => {
    const s = site(); const m = memoryStore(s.url_file_map.siteRoot);
    const groups = JSON.stringify(s.url_file_map.siteRoot.designProfile.layoutGroups);
    const ctx = { pagePath: '/blog/b', sections: POST.map(sec), provisional: true };
    const r = await runDesignValidationStage({ site: s, generatorId: 'faq', pageUrl: O + '/blog/b', store: m.store, pageCache: createFetchCache(), fetchHtml: async () => page(['n1 n2 n3 n4']), validate: async () => ({ status: 'provisional', context: ctx, proposal: { kind: 'new-group', pageUrl: O + '/blog/b', capture: { fingerprint: { hash: 'zz' } } }, fingerprint: { hash: 'zz' } }) });
    assert.ok(r.proposalId);
    assert.equal(Object.values(m.state().provisional).filter((p) => p.status === 'pending').length, 1);
    assert.equal(JSON.stringify(m.root().designProfile.layoutGroups), groups);
  });
});

describe('recovery paths (G)', () => {
  test('a WHOLE-SITE outage marks the site down: its other pages fail fast with no fetch, and another site is unaffected', async () => {
    const m = memoryStore(site().url_file_map.siteRoot);
    const down = async () => { throw new Error('ECONNREFUSED'); };
    await runDesignValidationStage({ site: site(), generatorId: 'faq', pageUrl: O + '/blog/b', store: m.store, pageCache: createFetchCache(), fetchHtml: down,
      validate: async () => ({ status: 'blocked', reason: 'page-unreachable', transient: true }) }).catch(() => {});
    assert.equal(m.state().pageResults[SITE_KEY].reason, 'site-unreachable');
    const c = counter();
    const err = await runDesignValidationStage({ site: { ...site(), url_file_map: { siteRoot: m.root() } }, generatorId: 'faq', pageUrl: O + '/services/other', store: m.store, fetchHtml: okFetch(c), validate: async () => { c.validate++; } }).catch((e) => e);
    assert.equal(err.pendingReason, 'site-unreachable'); assert.equal(c.fetch + c.validate, 0, 'a different page of the down site costs nothing');
    const other = { ...site(), id: 99 };
    const ok = await runDesignValidationStage({ site: other, generatorId: 'faq', pageUrl: 'https://other.test/blog/b', store: memoryStore(other.url_file_map.siteRoot).store, pageCache: createFetchCache(), fetchHtml: async () => page(POST),
      validate: async () => ({ status: 'matched', context: { pagePath: '/blog/b', groupId: 'g1' }, proposal: null }) });
    assert.equal(ok.outcome, 'matched', 'unrelated sites keep working');
  });

  test('one page down but the site up is NOT a site outage', async () => {
    const m = memoryStore(site().url_file_map.siteRoot);
    await runDesignValidationStage({ site: site(), generatorId: 'faq', pageUrl: O + '/blog/b', store: m.store, pageCache: createFetchCache(),
      fetchHtml: async (u) => { if (u.endsWith('/blog/b')) throw new Error('timeout'); return page(POST); },
      validate: async () => ({ status: 'blocked', reason: 'page-unreachable', transient: true }) }).catch(() => {});
    assert.equal(m.state().pageResults[SITE_KEY], undefined);
  });

  test('a 404 is re-checked before anything is concluded; a SECOND 404 creates a page-gone proposal for review and parks the page', async () => {
    const m = memoryStore(site().url_file_map.siteRoot);
    const gone = { status: 'blocked', reason: 'page-gone', transient: false, httpStatus: 404 };
    const first = await runDesignValidationStage({ site: site(), generatorId: 'faq', pageUrl: O + '/blog/b', store: m.store, pageCache: createFetchCache(), validate: async () => gone }).catch((e) => e);
    assert.equal(first.exhausted, false); assert.ok(/checked again in an hour/.test(first.message));
    assert.equal(Object.values(m.state().provisional).length, 0, 'nothing proposed on a single 404');
    const retryAfter = Date.parse(m.state().pageResults['/blog/b'].retryAfter);
    assert.ok(retryAfter - Date.now() >= 59 * 60_000, 'at least an hour before the re-check');
    // an hour later
    const later = () => new Date(retryAfter + 1000);
    const second = await runDesignValidationStage({ site: { ...site(), url_file_map: { siteRoot: m.root() } }, generatorId: 'faq', pageUrl: O + '/blog/b', store: m.store, pageCache: createFetchCache(), now: later, validate: async () => gone }).catch((e) => e);
    assert.equal(second.exhausted, true);
    const props = Object.values(m.state().provisional).filter((p) => p.status === 'pending');
    assert.deepEqual(props.map((p) => p.kind), ['page-gone']);
  });

  test('a page that is BACK after one 404 is validated normally (no proposal)', async () => {
    const m = memoryStore(site().url_file_map.siteRoot);
    await runDesignValidationStage({ site: site(), generatorId: 'faq', pageUrl: O + '/blog/b', store: m.store, pageCache: createFetchCache(), validate: async () => ({ status: 'blocked', reason: 'page-gone', transient: false }) }).catch(() => {});
    const retryAfter = Date.parse(m.state().pageResults['/blog/b'].retryAfter);
    const r = await runDesignValidationStage({ site: { ...site(), url_file_map: { siteRoot: m.root() } }, generatorId: 'faq', pageUrl: O + '/blog/b', store: m.store, pageCache: createFetchCache(), now: () => new Date(retryAfter + 1000), fetchHtml: async () => page(POST),
      validate: async () => ({ status: 'matched', context: { pagePath: '/blog/b', groupId: 'g1' }, proposal: null }) });
    assert.equal(r.outcome, 'matched');
    assert.equal(Object.values(m.state().provisional).length, 0);
  });
});
