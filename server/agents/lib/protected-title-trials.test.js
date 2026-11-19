import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { makeAllowance, onTrialMeasured, isRestore, PROTECTED_TITLE_WEEKLY_LIMIT } from './protected-title-trials.js';
import { PROTECTED_PAGE_REASON } from './protected-pages.js';
import { generate } from '../../generators/meta-title.js';

const protectedTitle = (id) => ({ id, recommendation_type: 'meta-title', params: { page: `https://x.test/${id}`, query: 'q' } });
const held = { decision: 'NEEDS_HUMAN_REVIEW', reason: PROTECTED_PAGE_REASON };

describe('weekly allowance for title changes on protected pages', () => {
  test('defaults to 3 a week', () => assert.equal(PROTECTED_TITLE_WEEKLY_LIMIT, 3));
  test('lets through only what is left of the week', () => {
    const a = makeAllowance(1, 3);
    assert.deepEqual([1, 2, 3, 4].map((id) => a.allow(protectedTitle(id), held)), [true, true, false, false]);
    assert.deepEqual([...a.granted], [1, 2]);
  });
  test('a failed count (Infinity) grants nothing', () => assert.equal(makeAllowance(Infinity, 3).allow(protectedTitle(1), held), false));
  test('only title fixes held for protection qualify: not other generators, not other reasons', () => {
    const a = makeAllowance(0, 3);
    assert.equal(a.allow({ ...protectedTitle(1), recommendation_type: 'expand-content' }, held), false);
    assert.equal(a.allow(protectedTitle(2), { decision: 'NEEDS_HUMAN_REVIEW', reason: 'learned: failing' }), false);
    assert.equal(a.allow(protectedTitle(3), { decision: 'NEEDS_HUMAN_REVIEW', reason: 'some url_file_map gap' }), false);
  });
  test('a restore always passes and never uses the allowance', () => {
    const a = makeAllowance(3, 3);
    const r = { ...protectedTitle(9), params: { page: 'p', query: 'q', restore: { title: 'Old' } } };
    assert.equal(isRestore(r), true);
    assert.equal(a.allow(r, held), true);
    assert.equal(a.granted.size, 0);
  });
});

describe('after measurement: keep or put back', () => {
  const fakeDeps = (trial) => {
    const calls = { updates: [], inserted: null };
    return {
      calls,
      deps: {
        query: async (sql, params) => { if (/^SELECT/.test(sql.trim())) return { rows: trial ? [trial] : [] }; calls.updates.push(params); return { rows: [] }; },
        insertRecommendation: async (siteId, rec) => { calls.inserted = { siteId, ...rec }; return { id: 77 }; },
      },
    };
  };
  const trial = { id: 5, site_id: 1, draft_id: 40, page: 'https://x.test/a', query: 'seo report', previous_title: 'Old title', previous_description: 'Old desc' };

  test('a supported click drop queues a restore with the old title and description', async () => {
    const { calls, deps } = fakeDeps(trial);
    const r = await onTrialMeasured(40, 'impact-negative', deps);
    assert.equal(r.action, 'restore-queued');
    assert.equal(calls.inserted.recommendationType, 'meta-title');
    assert.deepEqual(calls.inserted.params.restore, { title: 'Old title', description: 'Old desc', ofDraftId: 40 });
    assert.equal(calls.inserted.riskTier, 'safe');
  });
  test('no drop, or a drop inside noise (inconclusive), keeps the new title', async () => {
    for (const v of ['impact-positive', 'impact-inconclusive']) {
      const { calls, deps } = fakeDeps(trial);
      assert.equal((await onTrialMeasured(40, v, deps)).action, 'kept');
      assert.equal(calls.inserted, null);
    }
  });
  test('a draft that was not a trial is left alone', async () => {
    const { deps } = fakeDeps(null);
    assert.equal((await onTrialMeasured(41, 'impact-negative', deps)).action, 'none');
  });
});

test('restore mode puts back the exact previous wording without a model call', async () => {
  const { content } = await generate({ siteId: 1, params: { page: 'https://x.test/a', query: 'seo report', restore: { title: 'Old title | Brand', description: 'Old desc', ofDraftId: 40 } } });
  assert.deepEqual(content.titles, ['Old title | Brand']);
  assert.equal(content.selectedTitle, 'Old title | Brand');
  assert.equal(content.metaDescription, 'Old desc');
  assert.equal(content.restoreOfDraftId, 40);
});

// ── against a real local Postgres (skipped elsewhere): the table, the weekly count and the queued restore row ──
process.env.DATABASE_URL ||= 'postgres://test:test@localhost:5432/test';
const isLocal = (() => { try { return ['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL).hostname); } catch { return false; } })();
let skip = isLocal ? false : 'not a local database';
const dbm = await import('../../db.js');
if (!skip) { try { await dbm.query('SELECT 1 FROM protected_title_trials LIMIT 1'); } catch (e) { skip = `no migration 251 (${e.code || e.message})`; } }

describe('on a real database', { skip }, () => {
  const created = [];
  after(async () => { for (const id of created) await dbm.query('DELETE FROM sites WHERE id = $1', [id]).catch(() => {}); });

  test('a shipped trial counts toward the week, and a measured drop writes a real restore recommendation', async () => {
    const { recordTrial, countTrialsThisWeek } = await import('./protected-title-trials.js');
    const { createDraft } = await import('../../store/drafts.js');
    const site = await dbm.createClientSite({ name: `title-trial-${crypto.randomBytes(3).toString('hex')}`, websiteDomain: 'trial.test', timezone: 'UTC', propertyType: 'website' });
    created.push(site.id);
    const content = { query: 'seo report', page: 'https://trial.test/a', titles: ['New'], selectedTitle: 'New', metaDescription: 'n', previous: { title: 'Old title', description: 'Old desc' } };
    const draft = await createDraft(site.id, { actionType: 'meta-title', source: 'auto-remediation', input: {}, content, findingId: `t-${site.id}` });
    assert.equal(await countTrialsThisWeek(site.id), 0);
    await recordTrial(site.id, { id: null, params: { page: content.page, query: content.query } }, draft);
    assert.equal(await countTrialsThisWeek(site.id), 1);

    const r = await onTrialMeasured(draft.id, 'impact-negative');
    assert.equal(r.action, 'restore-queued');
    const rec = (await dbm.query('SELECT * FROM recommendations WHERE id = $1', [r.recommendationId])).rows[0];
    assert.equal(rec.site_id, site.id);
    assert.equal(rec.risk_tier, 'safe');
    assert.equal(rec.params.restore.title, 'Old title');
    const t = (await dbm.query('SELECT status, verdict FROM protected_title_trials WHERE draft_id = $1', [draft.id])).rows[0];
    assert.deepEqual(t, { status: 'restore-queued', verdict: 'impact-negative' });
    assert.equal((await onTrialMeasured(draft.id, 'impact-negative')).action, 'none', 'measured once, decided once');
  });
});
