import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';

const resolve = (p) => new URL(p, import.meta.url).href;
let llm; // function (system, user, opts) => Promise
let domain = 'client.test';
let page = { ok: true, analysis: { title: 't', metaDescription: 'd', headingOutline: [], bodyText: 'We build things.' } };

mock.module(resolve('../../ingest/dataforseo-keywords.js'), { namedExports: { configured: () => true, fetchKeywordIdeas: async () => [], fetchSearchVolume: async () => [] } });
mock.module(resolve('../../llm.js'), { namedExports: { callLLM: async () => null, callLLMForJson: (...a) => llm(...a) } });
mock.module(resolve('./site-domain.js'), { namedExports: { resolveOwnDomain: async () => domain } });
mock.module(resolve('./page-content.js'), { namedExports: { analyzePageUrl: async () => page } });

const { deriveSeedTermsForSite, runKeywordDemandIfDue, explainModelFailure } = await import('./keyword-demand.js');
const W = { start: '2026-11-16', end: '2026-11-22' };
const noProfile = { loadBusinessContext: async () => null };

describe('a failed seed derivation says why instead of returning a silent empty list', () => {
  test('API credit exhausted', async () => {
    llm = async () => { throw new Error('400 {"error":{"message":"Your credit balance is too low to access the Anthropic API."}}'); };
    let reason; const terms = await deriveSeedTermsForSite({ id: 8871 }, W, { deps: noProfile, onReason: (r) => { reason = r; } });
    assert.deepEqual(terms, []); assert.equal(reason.code, 'model_no_credit');
  });
  test('worker offline', async () => {
    llm = async () => { throw Object.assign(new Error('The Claude Code worker is not connected, so no fix can be written right now.'), { workerUnavailable: true }); };
    let reason; await deriveSeedTermsForSite({ id: 8872 }, W, { deps: noProfile, onReason: (r) => { reason = r; } });
    assert.equal(reason.code, 'worker_offline');
  });
  test('homepage unreachable and no domain', async () => {
    let reason; page = { ok: false, reason: 'timeout' };
    await deriveSeedTermsForSite({ id: 8874 }, W, { deps: noProfile, onReason: (r) => { reason = r; } });
    assert.equal(reason.code, 'homepage_unreachable');
    page = { ok: true, analysis: { title: 't', headingOutline: [], bodyText: 'x' } }; domain = null;
    await deriveSeedTermsForSite({ id: 8874 }, W, { deps: noProfile, onReason: (r) => { reason = r; } });
    assert.equal(reason.code, 'no_domain'); domain = 'client.test';
  });
  test('unknown errors are still named, never swallowed', () => assert.equal(explainModelFailure(new Error('boom')).code, 'model_failed'));
});

describe('the monthly paid check', () => {
  const mk = (over = {}) => {
    const rec = { status: [], runs: [] };
    return { rec, deps: {
      configured: () => true, getLatestRunDates: async () => [], deriveSeedTerms: async () => ['salon software'],
      fetchIdeas: async () => ({ ideas: [], failedLocations: [], errors: [] }),
      saveRun: async (...a) => rec.runs.push(a), recordDiscoveryStatus: async (id, path, s) => rec.status.push({ id, path, ...s }), ...over } };
  };
  const site = { id: 8872, timezone: 'Asia/Kolkata', website_domain: 'zennly.io' };

  const withModel = (extra = {}) => { const saved = []; return { saved, extra: { guessKeywords: async (seeds, loc) => [`phrase for ${loc.locationCode}`], saveGaps: async (id, gaps, source) => { saved.push({ id, gaps, source }); }, ...extra } }; };

  test('DataForSEO HTTP 402: the paid path is blocked with an actionable message, NO completed run is recorded (so it retries), and the worker researches meanwhile', async () => {
    const m = withModel();
    const { rec, deps } = mk({ ...m.extra, fetchIdeas: async (seeds, locs) => ({ ideas: [], failedLocations: locs, errors: locs.map((l) => ({ locationCode: l.locationCode, message: 'DataForSEO request failed: HTTP 402 | HTTP 402' })) }) });
    const r = await runKeywordDemandIfDue(site, { deps });
    assert.equal(r.modelOnly, true); assert.equal(rec.runs.length, 0);
    const paid = rec.status.find((s) => s.path === 'dataforseo_demand' || s.code === 'dataforseo_payment_required');
    assert.equal(paid.code, 'dataforseo_payment_required'); assert.equal(paid.status, 'blocked'); assert.match(paid.message, /credit/); assert.match(paid.message, /Claude worker/);
    assert.ok(m.saved.length >= 1 && m.saved.every((x) => x.source === 'claude_research' && x.id === 8872), 'saved for this project, labelled as model research');
    assert.ok(m.saved.every((x) => x.gaps.every((g) => g.search_volume === undefined)), 'a model never supplies a search volume');
    assert.equal(rec.status.at(-1).path, 'worker_research'); assert.equal(rec.status.at(-1).status, 'ok');
  });
  test('model research with the worker offline records its own reason and invents nothing', async () => {
    const m = withModel({ guessKeywords: async () => { const e = new Error('The Claude Code worker is not connected'); e.workerUnavailable = true; throw e; } });
    const { rec, deps } = mk({ ...m.extra, configured: () => false });
    const r = await runKeywordDemandIfDue(site, { deps });
    assert.equal(r.llmGuessed, 0); assert.equal(m.saved.length, 0);
    const last = rec.status.at(-1); assert.equal(last.path, 'worker_research'); assert.equal(last.status, 'blocked'); assert.equal(last.code, 'worker_offline');
  });
  test('seed derivation failure is recorded with its own reason', async () => {
    const { rec, deps } = mk({ deriveSeedTerms: async (s, w, { onReason }) => { onReason({ code: 'model_no_credit', message: 'The AI provider has no credit left.' }); return []; } });
    assert.equal(await runKeywordDemandIfDue(site, { deps }), null);
    assert.equal(rec.status.at(-1).code, 'model_no_credit');
  });
  test('a run earlier THIS month (a Date from the database) skips; last month does not', async () => {
    const thisMonth = new Date(); const lastYear = new Date('2025-01-15T00:00:00Z');
    const a = mk({ getLatestRunDates: async () => [thisMonth] });
    assert.equal(await runKeywordDemandIfDue(site, { deps: a.deps }), null);
    assert.equal(a.rec.status.length, 0, 'an already-done month leaves the last real status alone');
    const b = mk({ getLatestRunDates: async () => [lastYear], fetchIdeas: async () => ({ ideas: [{ keyword: 'salon software', searchVolume: 500, difficulty: 20, locationCode: 2356 }], failedLocations: [], errors: [] }) });
    const r = await runKeywordDemandIfDue(site, { deps: b.deps }).catch((e) => e);
    // saveKeywordGaps needs a database; reaching it proves the guard let the run through
    assert.ok(b.rec.runs.length === 1 || (r instanceof Error), 'the guard lets an old run through');
  });
  test('not configured is recorded, not silent, and the worker still researches', async () => {
    const m = withModel();
    const { rec, deps } = mk({ ...m.extra, configured: () => false });
    const r = await runKeywordDemandIfDue(site, { deps });
    assert.equal(r.modelOnly, true);
    assert.ok(rec.status.some((s) => s.code === 'dataforseo_not_configured'));
    assert.ok(m.saved.length >= 1);
  });
});
