import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAutonomy, renderReport } from './autonomy-check.js';

const NOW = Date.parse('2026-10-29T10:00:00Z');
const green = () => ({
  site: { gsc: 'sc-domain:x.com', ga4: '1', layoutTemplate: 'src/layouts/Layout.astro', autoRemediation: true, dailyLimit: 60 },
  google: { mode: 'own', status: 'active', error: null },
  sitemap: { status: 'registered', detail: 'https://x.com/sitemap.xml' },
  data: { gscAsOf: '2026-10-28' },
  agents: { ok: 20, insufficient: 3, error: 0, lastRunAt: '2026-10-29T01:35:00Z' },
  readiness: { items: [{ key: 'repo', label: 'GitHub repo', ok: true, detail: 'o/r' }, { key: 'analyst', label: 'Analyst', ok: true, detail: 'registered' }] },
  recommendations: { open: 5, blocked: 2 },
  ship: { last: { created_at: '2026-10-29T01:50:00Z', shipped: 4, failed: 0, stopped_reason: null, pr_url: 'https://github.com/o/r/pull/9' } },
  verify: { total: 12 },
  design: { usable: true, needsPerson: false, jobStatus: 'completed', workerSeen: true },
  analyst: { reachable: true, registered: true },
});
const statusOf = (v, name) => v.stages.find((s) => s.name === name)?.status;

describe('evaluateAutonomy', () => {
  test('a fully connected, fresh, shipping project is ready', () => {
    const v = evaluateAutonomy(green(), NOW);
    assert.equal(v.ready, true);
    assert.deepEqual(v.failing, []);
  });

  test('a stale Google sign-in, stale data and a dead analyst each stop it, with a reason', () => {
    const f = green();
    f.google.status = 'revoked'; f.google.error = 'token revoked';
    f.data.gscAsOf = '2026-10-20';
    f.analyst = { reachable: false, registered: null };
    const v = evaluateAutonomy(f, NOW);
    assert.equal(v.ready, false);
    assert.equal(statusOf(v, 'Google sign-in still valid'), 'fail');
    assert.equal(statusOf(v, 'Search Console data is fresh'), 'fail');
    assert.equal(statusOf(v, 'Data Analyst service'), 'fail');
  });

  test('a shipping run stopped by the design capture is red and says what it waits for', () => {
    const f = green();
    f.ship.last = { created_at: '2026-10-29T01:50:00Z', shipped: 0, failed: 0, stopped_reason: 'onboarding-analysis-pending', pr_url: null };
    f.design = { usable: false, needsPerson: false, jobStatus: 'queued', workerSeen: false };
    const v = evaluateAutonomy(f, NOW);
    const ship = v.stages.find((s) => s.name === 'Latest shipping run');
    assert.equal(ship.status, 'fail');
    assert.match(ship.fix, /design capture/);
    assert.equal(statusOf(v, 'Design profile (shipping waits for it)'), 'warn');
  });

  test('a design capture that failed every try is red, and autonomous fixes switched off is red', () => {
    const f = green();
    f.design = { usable: false, needsPerson: true, jobStatus: 'failed', workerSeen: true };
    f.site.autoRemediation = false;
    const v = evaluateAutonomy(f, NOW);
    assert.equal(statusOf(v, 'Design profile (shipping waits for it)'), 'fail');
    assert.equal(statusOf(v, 'Autonomous fixes switched on'), 'fail');
  });

  test('a missing layout file only warns (the page-level fixes still work)', () => {
    const f = green(); f.site.layoutTemplate = null;
    const v = evaluateAutonomy(f, NOW);
    assert.equal(statusOf(v, 'Shared layout file mapped'), 'warn');
    assert.equal(v.ready, true);
  });

  test('the shared Google account is a warning, never a failure', () => {
    const f = green(); f.google = { mode: 'shared', status: null, error: null };
    const v = evaluateAutonomy(f, NOW);
    assert.equal(statusOf(v, 'Google credential'), 'warn');
    assert.equal(v.ready, true);
  });

  test('the analyst line of the readiness check is reported once, under Platform', () => {
    const v = evaluateAutonomy(green(), NOW);
    assert.equal(v.stages.filter((s) => /Analyst/i.test(s.name) && s.stage !== 'Platform').length, 0);
    assert.ok(v.stages.filter((s) => /Analyst/i.test(s.name) && s.stage === 'Platform').length >= 2);
  });
});

describe('renderReport', () => {
  test('lists the failing stages at the bottom with the fix next to each', () => {
    const f = green(); f.site.autoRemediation = false;
    const text = renderReport({ id: 1, name: 'Demo' }, evaluateAutonomy(f, NOW));
    assert.match(text, /NOT READY: 1 stage/);
    assert.match(text, /✘ Autonomous fixes switched on/);
    assert.match(text, /→ switch on autonomous remediation/);
  });
  test('says READY when nothing fails', () => {
    assert.match(renderReport({ id: 1, name: 'Demo' }, evaluateAutonomy(green(), NOW)), /READY: every stage is green/);
  });
});
