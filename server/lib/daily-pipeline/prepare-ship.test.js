import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { prepareItem, prepareSite } from './prepare.js';
import { shipPreparedForSite, shipPreparedForAllSites } from './ship.js';

// An in-memory shipping queue with the SAME rules as store/shipping-queue.js's SQL:
//   enqueue dedupes on an active row with the same key; claimForPreparation moves queued -> preparing;
//   claimForShipping moves ONLY prepared rows (WHERE state = 'prepared'); releaseItem: not retryable -> failed,
//   retryable without a draft -> queued, retryable with a draft -> prepared.
function queue() {
  const rows = []; let next = 1;
  const ACTIVE = ['queued', 'preparing', 'prepared', 'shipping'];
  return {
    rows,
    async enqueue(siteId, it) {
      const key = it.findingId ? `finding:${it.findingId}` : `${it.generatorId}:${JSON.stringify(it.params)}`;
      const live = rows.find((r) => r.site_id === siteId && r.key === key && ACTIVE.includes(r.state));
      if (live) return live;
      const r = { id: next++, site_id: siteId, key, state: 'queued', generator_id: it.generatorId, params: it.params, finding_id: it.findingId, source: it.source, draft_id: null, attempts: 0 };
      rows.push(r); return r;
    },
    async claimForPreparation(siteId, { limit = 25 } = {}) {
      const got = rows.filter((r) => r.site_id === siteId && r.state === 'queued').slice(0, limit);
      for (const r of got) { r.state = 'preparing'; r.attempts += 1; }
      return got.map((r) => ({ ...r }));
    },
    async markPrepared(id, { draftId }) { const r = rows.find((x) => x.id === id); if (r.state === 'shipped') return null; Object.assign(r, { state: 'prepared', draft_id: draftId }); return r; },
    async listByState(siteId, state) { return rows.filter((r) => r.site_id === siteId && r.state === state).map((r) => ({ ...r })); },
    async claimForShipping(siteId, ids, batchId) {
      const got = rows.filter((r) => r.site_id === siteId && ids.includes(r.id) && r.state === 'prepared');
      for (const r of got) Object.assign(r, { state: 'shipping', batch_id: batchId });
      return got.map((r) => ({ ...r }));
    },
    async markShipped(id) { Object.assign(rows.find((x) => x.id === id), { state: 'shipped' }); },
    async releaseItem(id, { retryable, error }) {
      const r = rows.find((x) => x.id === id); if (r.state === 'shipped') return null;
      r.state = !retryable ? 'failed' : (r.draft_id == null ? 'queued' : 'prepared'); r.last_error = error; return r;
    },
    state: (id) => rows.find((x) => x.id === id)?.state,
  };
}

const site = { id: 1, name: 'A' };
const page = 'https://a.example/pricing';
function prepDeps(q, over = {}) {
  const calls = [];
  const d = {
    calls,
    generateDraft: async (_s, { findingId }) => { calls.push(`generate:${findingId}`); return { id: 100 + calls.length }; },
    submitDraftForApproval: async (_s, id) => { calls.push(`submit:${id}`); },
    validateDraft: async (_s, id) => { calls.push(`validate:${id}`); return { draft: { id } }; },
    markPrepared: async (id, v) => { calls.push(`markPrepared:${id}`); return q.markPrepared(id, v); },
    releaseItem: (id, v) => { calls.push(`release:${id}:${v.retryable}`); return q.releaseItem(id, v); },
    abandonDraft: async (_s, id) => { calls.push(`abandon:${id}`); },
    hasUsableDesignProfile: () => true,
    queueDesignDerivation: async () => { calls.push('queueDesign'); },
    ...over,
  };
  return d;
}
const one = async (q) => { await q.enqueue(1, { findingId: 'f1', generatorId: 'meta-title', params: { page } }); return (await q.claimForPreparation(1))[0]; };

describe('prepare: generation, then validation, then markPrepared; nothing published', () => {
  test('the order is generate -> submit -> validate -> markPrepared, and nothing approves or pushes', async () => {
    const q = queue(); const d = prepDeps(q); const item = await one(q);
    const out = await prepareItem(site, item, d);
    assert.equal(out.outcome, 'prepared');
    assert.deepEqual(d.calls.map((c) => c.split(':')[0]), ['generate', 'submit', 'validate', 'markPrepared']);
    assert.equal(q.state(item.id), 'prepared');
    assert.ok(!('approveAndPublishDraftUnattended' in d) && !('finalizeBatchPr' in d), 'prepare has no way to publish');
  });

  test('a validation failure is NEVER marked prepared: the draft is abandoned and the item fails', async () => {
    const q = queue(); const item = await one(q);
    const d = prepDeps(q, { validateDraft: async () => { const e = new Error('This draft can\'t be approved yet — layout regression'); e.status = 422; throw e; } });
    const out = await prepareItem(site, item, d);
    assert.equal(out.outcome, 'failed');
    assert.equal(q.state(item.id), 'failed');
    assert.ok(!d.calls.some((c) => c.startsWith('markPrepared')));
    assert.ok(d.calls.some((c) => c.startsWith('abandon:')));
  });

  test('a Quality Gate refusal at generation fails the item the same way', async () => {
    const q = queue(); const item = await one(q);
    const d = prepDeps(q, { generateDraft: async () => { const e = new Error('generator output failed the Quality Gate after regeneration'); e.status = 502; throw e; } });
    assert.equal((await prepareItem(site, item, d)).outcome, 'failed');
    assert.equal(q.state(item.id), 'failed');
  });

  test('an outage during generation goes back to the queue (no draft yet) for the next pass', async () => {
    const q = queue(); const item = await one(q);
    const d = prepDeps(q, { generateDraft: async () => { throw new Error('socket hang up'); } });
    assert.equal((await prepareItem(site, item, d)).outcome, 'retry-later');
    assert.equal(q.state(item.id), 'queued');
  });

  test('without a usable design profile a page fix waits for the Design Agent, and is not prepared', async () => {
    const q = queue(); const item = await one(q);
    const d = prepDeps(q, { hasUsableDesignProfile: () => false });
    assert.equal((await prepareItem(site, item, d)).outcome, 'awaiting-design');
    assert.ok(d.calls.includes('queueDesign'));
    assert.equal(q.state(item.id), 'queued');
    assert.ok(!d.calls.some((c) => c.startsWith('generate')));
  });

  test('past the deadline nothing new is prepared: claimed items go straight back to the queue', async () => {
    const q = queue(); const d = prepDeps(q);
    const out = await prepareSite(site, { ...d, enqueue: q.enqueue.bind(q), claimForPreparation: q.claimForPreparation.bind(q), selectCandidates: async () => [{ findingId: 'f1', generatorId: 'meta-title', params: { page } }], deadlineAt: 10, now: () => 20 });
    assert.equal(out.deferred, 1);
    assert.equal(out.prepared, 0);
    assert.equal(q.rows[0].state, 'queued');
  });

  test('the same candidate offered twice becomes ONE queue item (no duplicate work)', async () => {
    const q = queue(); const d = prepDeps(q);
    const cands = [{ findingId: 'f1', generatorId: 'meta-title', params: { page } }, { findingId: 'f1', generatorId: 'meta-title', params: { page } }];
    const out = await prepareSite(site, { ...d, enqueue: q.enqueue.bind(q), claimForPreparation: q.claimForPreparation.bind(q), selectCandidates: async () => cands });
    assert.equal(q.rows.length, 1);
    assert.equal(out.prepared, 1);
  });
});

function shipDeps(q, over = {}) {
  const calls = [];
  return {
    calls,
    listByState: q.listByState.bind(q), claimForShipping: q.claimForShipping.bind(q), markShipped: q.markShipped.bind(q),
    releaseItem: (id, v) => { calls.push(`release:${id}:${v.retryable}`); return q.releaseItem(id, v); },
    batchBranchName: () => 'superrank/batch-2026-11-06',
    beginBatchPush: () => { calls.push('beginBatchPush'); },
    approveAndPublishDraftUnattended: async (_s, draftId, opts) => { calls.push(`push:${draftId}:${opts.deferPr}`); return { id: draftId, status: 'branch_pushed' }; },
    finalizeBatchPr: async (_s, _b, ids) => { calls.push(`openPR:${ids.join(',')}`); return { ok: true, prNumber: 7, prUrl: 'https://github.com/a/b/pull/7' }; },
    abandonDraft: async (_s, id) => { calls.push(`abandon:${id}`); },
    ...over,
  };
}
async function seeded() {
  const q = queue();
  for (const [f, state, draft] of [['p1', 'prepared', 11], ['p2', 'prepared', 12], ['q1', 'queued', null], ['w1', 'preparing', null], ['x1', 'failed', 13]]) {
    const r = await q.enqueue(1, { findingId: f, generatorId: 'meta-title', params: { page } });
    Object.assign(r, { state, draft_id: draft });
  }
  return q;
}

describe('ship: prepared work only, one PR, never a merge', () => {
  test('ONLY prepared items are pushed; queued, preparing and failed ones are never touched', async () => {
    const q = await seeded(); const d = shipDeps(q);
    const out = await shipPreparedForSite(site, d);
    assert.equal(out.shipped, 2);
    assert.deepEqual(d.calls.filter((c) => c.startsWith('push:')), ['push:11:true', 'push:12:true']);
    assert.deepEqual(q.rows.map((r) => r.state), ['shipped', 'shipped', 'queued', 'preparing', 'failed']);
  });

  test('one pull request for the whole batch, opened once, and nothing in shipping can merge', async () => {
    const q = await seeded(); const d = shipDeps(q);
    const out = await shipPreparedForSite(site, d);
    assert.deepEqual(d.calls.filter((c) => c.startsWith('openPR')), ['openPR:11,12']);
    assert.equal(out.pr.number, 7);
    assert.ok(!Object.keys(d).some((k) => /merge/i.test(k)), 'the ship stage is given no merge capability at all');
  });

  test('a row that stopped being prepared between listing and claiming is not shipped (the claim is the gate)', async () => {
    const q = await seeded(); const d = shipDeps(q, { listByState: async (s, st) => { const l = await q.listByState(s, st); q.rows[1].state = 'failed'; return l; } });
    const out = await shipPreparedForSite(site, d);
    assert.equal(out.shipped, 1);
    assert.ok(!d.calls.includes('push:12:true'));
  });

  test('file-edit queue items (content/template repair) are prepared but have no draft: the prepared-only run leaves them to their own drain', async () => {
    const q = queue(); const d = shipDeps(q);
    q.rows.push({ id: 90, site_id: 1, state: 'prepared', kind: 'file-edits', draft_id: null, source: 'content-repair', params: { edits: [] } });
    const out = await shipPreparedForSite({ id: 1 }, d, { now: new Date() });
    assert.equal(out.claimed, 0); assert.equal(q.state(90), 'prepared');
  });
  test('a second ship run the same day claims nothing: no second push, no duplicate PR', async () => {
    const q = await seeded(); const d = shipDeps(q);
    await shipPreparedForSite(site, d);
    const again = await shipPreparedForSite(site, d);
    assert.equal(again.claimed, 0);
    assert.equal(d.calls.filter((c) => c.startsWith('openPR')).length, 1);
  });

  test('a draft refused at push time fails its item; an outage at push time returns it to prepared', async () => {
    const q = await seeded();
    const d = shipDeps(q, { approveAndPublishDraftUnattended: async (_s, id) => { if (id === 11) { const e = new Error('content no longer valid'); e.status = 422; throw e; } throw new Error('GitHub 502 Bad Gateway'); } });
    const out = await shipPreparedForSite(site, d);
    assert.equal(out.shipped, 0);
    assert.equal(q.rows[0].state, 'failed');
    assert.equal(q.rows[1].state, 'prepared');
    assert.ok(!d.calls.some((c) => c.startsWith('openPR')), 'no PR when nothing was pushed');
  });

  test('if the PR cannot be opened NOTHING is marked shipped: drafts abandoned, items failed, next cycle re-prepares', async () => {
    const q = await seeded(); const d = shipDeps(q, { finalizeBatchPr: async () => ({ ok: false, error: 'PR creation failed' }) });
    const out = await shipPreparedForSite(site, d);
    assert.equal(out.shipped, 0);
    assert.deepEqual(q.rows.slice(0, 2).map((r) => r.state), ['failed', 'failed']);
    assert.deepEqual(d.calls.filter((c) => c.startsWith('abandon')), ['abandon:11', 'abandon:12']);
  });

  test('nothing prepared means no batch, no push and no PR at all', async () => {
    const q = queue(); const d = shipDeps(q);
    const out = await shipPreparedForSite(site, d);
    assert.equal(out.claimed, 0);
    assert.ok(!d.calls.includes('beginBatchPush'));
  });
});

describe('the 11:00 guard', () => {
  const cfg = { shipPreparedOnly: true, shipAt: '11:00', timezone: 'Asia/Kathmandu' };
  test('before 11:00 Kathmandu nothing ships', async () => {
    const q = await seeded(); const d = shipDeps(q);
    const out = await shipPreparedForAllSites({ sites: [site], deps: d, config: cfg, localMinutes: () => 10 * 60 + 59 });
    assert.match(out.skipped, /before 11:00/);
    assert.ok(!d.calls.some((c) => c.startsWith('push')));
  });
  test('with prepared-only shipping switched off, this run never ships', async () => {
    const q = await seeded(); const d = shipDeps(q);
    const out = await shipPreparedForAllSites({ sites: [site], deps: d, config: { ...cfg, shipPreparedOnly: false }, localMinutes: () => 12 * 60 });
    assert.match(out.skipped, /switched off/);
  });
  test('at 11:00 it ships the prepared work, once', async () => {
    const q = await seeded(); const d = shipDeps(q);
    const out = await shipPreparedForAllSites({ sites: [site], deps: d, config: cfg, localMinutes: () => 11 * 60 });
    assert.equal(out.results[0].shipped, 2);
  });
});
