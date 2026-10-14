import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { runDesignGates } from './design-gates.js';

const goodProfile = () => ({
  version: 2, typography: { body: 'b', heading: { item: 'hi', section: 'hs' } }, layout: { container: 'c', prose: 'p' }, spacing: { section: 's' },
  pages: [{ url: 'https://x.com/blog/a', pageType: 'blog-article' }],
});
const site = (profile) => ({ id: 7, url_file_map: { siteRoot: profile ? { designProfile: profile } : {} } });
const draft = { id: 99, action_type: 'blog-outline' };
const resolved = { body: '---\npermalink: /blog/new/\n---\n\n## Hi\n\nBody text here.', contentFormat: 'markdown' };

const notified = [];
const learned = [];
const requeued = [];
function harness(over = {}) {
  notified.length = 0; learned.length = 0; requeued.length = 0;
  const records = []; const stored = [];
  return { records, stored, notified, deps: {
    record: async (id, r) => { records.push(r); },
    storeRenderGate: async (id, g) => { stored.push([id, g]); },
    checkRender: async () => ({ ok: true, broken: false }),
    notify: async (...a) => { notified.push(a); },
    learnFailure: async (id, l) => { learned.push(['failure', id, l]); },
    learnFix: async (id, l) => { learned.push(['fix', id, l]); },
    hadRecentBlock: async () => false,
    requeueProfile: async (st) => { requeued.push(st.id); return { queued: true }; },
    ...over,
  } };
}
const setEnv = (env) => { for (const [k, v] of Object.entries(env)) { if (v == null) delete process.env[k]; else process.env[k] = v; } };
afterEach(() => setEnv({ DESIGN_GATE_MODE: null, DESIGN_GATE_FAIL_CLOSED: null, NEWPAGE_RENDER_GATE_ENABLED: null }));

describe('runDesignGates — modes', () => {
  test('off runs nothing and records nothing', async () => {
    const h = harness();
    const r = await runDesignGates(site(null), draft, resolved, h.deps);
    assert.deepEqual([r.ok, r.skipped], [true, 'off']);
    assert.equal(h.records.length, 0);
  });

  test('log mode: a site with no profile WOULD be blocked — recorded, and shipped anyway', async () => {
    setEnv({ DESIGN_GATE_MODE: 'log' });
    const h = harness();
    const r = await runDesignGates(site(null), draft, resolved, h.deps);
    assert.equal(r.ok, true, 'log mode never holds a draft');
    assert.equal(h.records[0].blocked, true);
    assert.equal(h.records[0].mode, 'log');
    assert.equal(h.records[0].reason, 'no-design-profile');
  });

  test('enforce mode holds the same draft, with the reason and the assessment', async () => {
    setEnv({ DESIGN_GATE_MODE: 'enforce' });
    const h = harness();
    const r = await runDesignGates(site(null), draft, resolved, h.deps);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'design-incomplete');
    assert.equal(r.designAssessment.repairable, true);
    assert.equal(h.records[0].mode, 'enforce');
  });

  test('the original DESIGN_GATE_FAIL_CLOSED switch still means enforce', async () => {
    setEnv({ DESIGN_GATE_FAIL_CLOSED: 'true' });
    assert.equal((await runDesignGates(site(null), draft, resolved, harness().deps)).ok, false);
  });

  test('a complete profile passes in every mode and records a non-blocking decision', async () => {
    setEnv({ DESIGN_GATE_MODE: 'enforce' });
    const h = harness();
    assert.equal((await runDesignGates(site(goodProfile()), draft, resolved, h.deps)).ok, true);
    assert.equal(h.records[0].blocked, false);
  });
});

describe('runDesignGates — render gate', () => {
  const on = { DESIGN_GATE_MODE: 'enforce', NEWPAGE_RENDER_GATE_ENABLED: 'true' };

  test('a measured deviation holds the draft and stores the evidence on it', async () => {
    setEnv(on);
    const h = harness({ checkRender: async () => ({ ok: true, broken: true, referenceUrl: 'https://x.com/blog/a', deviations: [{ kind: 'heading-scale', expected: 28, actual: 48, viewport: 'desktop' }] }) });
    const r = await runDesignGates(site(goodProfile()), draft, resolved, h.deps);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'render-deviation');
    assert.match(r.error, /heading-scale 28 → 48 \(desktop\)/);
    assert.equal(h.stored[0][0], 99);
    assert.equal(h.stored[0][1].reason, 'render-deviation');
  });

  test('no comparable reference page is held for a human, not shipped silently', async () => {
    setEnv(on);
    const p = goodProfile(); p.pages = [];
    const r = await runDesignGates(site(p), draft, resolved, harness().deps);
    assert.equal(r.reason, 'needs-human-review');
  });

  test('log mode records the same deviation and ships', async () => {
    setEnv({ DESIGN_GATE_MODE: 'log', NEWPAGE_RENDER_GATE_ENABLED: 'true' });
    const h = harness({ checkRender: async () => ({ ok: true, broken: true, deviations: [{ kind: 'body-size', expected: 18, actual: 20, viewport: 'mobile' }] }) });
    const r = await runDesignGates(site(goodProfile()), draft, resolved, h.deps);
    assert.equal(r.ok, true);
    const render = h.records.find((x) => x.gate === 'render');
    assert.deepEqual([render.blocked, render.reason, render.mode], [true, 'render-deviation', 'log']);
  });

  test('without NEWPAGE_RENDER_GATE_ENABLED no browser check runs at all', async () => {
    setEnv({ DESIGN_GATE_MODE: 'enforce' });
    let calls = 0;
    await runDesignGates(site(goodProfile()), draft, resolved, harness({ checkRender: async () => { calls++; return { ok: true }; } }).deps);
    assert.equal(calls, 0);
  });

  test('a JSX body is recorded as skipped, never faked into HTML', async () => {
    setEnv(on);
    const h = harness();
    const r = await runDesignGates(site(goodProfile()), draft, { body: 'export default x', contentFormat: 'jsx' }, h.deps);
    assert.equal(r.ok, true);
    assert.equal(h.records.find((x) => x.gate === 'render').reason, 'jsx-not-renderable');
  });

  test('an unreachable reference does not hold a draft the role evidence is confident about', async () => {
    setEnv(on);
    const h = harness({ checkRender: async () => ({ ok: false, reason: 'unreachable', error: 'timeout' }) });
    assert.equal((await runDesignGates(site(goodProfile()), draft, resolved, h.deps)).ok, true);
  });

  test('the repo-layout tier feeds the role', async () => {
    setEnv({ DESIGN_GATE_MODE: 'log' });
    const h = harness({ deriveContract: async () => ({ layout: 'layouts/post.njk', unknown: false }) });
    const r = await runDesignGates(site(goodProfile()), { id: 1, action_type: 'missing-page' }, { body: '---\npermalink: /zzz/q/\n---\nx' }, h.deps);
    assert.equal(r.role.source, 'repo-layout');
  });
});

describe('runDesignGates — one alert per episode', () => {
  test('a held draft announces itself, with the reason', async () => {
    setEnv({ DESIGN_GATE_MODE: 'enforce' });
    const h = harness();
    await runDesignGates(site(null), draft, resolved, h.deps);
    assert.equal(h.notified.length, 1);
    assert.deepEqual(h.notified[0][1], { reason: 'design-incomplete', actionType: 'blog-outline' });
  });
  test('log mode holds nothing, so it announces nothing', async () => {
    setEnv({ DESIGN_GATE_MODE: 'log' });
    const h = harness();
    await runDesignGates(site(null), draft, resolved, h.deps);
    assert.equal(h.notified.length, 0);
  });
  test('a passing draft announces nothing', async () => {
    setEnv({ DESIGN_GATE_MODE: 'enforce' });
    const h = harness();
    await runDesignGates(site(goodProfile()), draft, resolved, h.deps);
    assert.equal(h.notified.length, 0);
  });
  test('a failing notifier can never fail the gate', async () => {
    setEnv({ DESIGN_GATE_MODE: 'enforce' });
    const h = harness({ notify: async () => { throw new Error('smtp down'); } });
    const r = await runDesignGates(site(null), draft, resolved, h.deps);
    assert.equal(r.reason, 'design-incomplete');
  });
});

describe('runDesignGates — learning from the result', () => {
  test('a completeness block is kept as an anti-pattern for the tenant and a repairable gap re-queues the profile', async () => {
    setEnv({ DESIGN_GATE_MODE: 'enforce' });
    const h = harness();
    await runDesignGates(site(null), draft, resolved, h.deps);
    assert.equal(learned.length, 1);
    assert.equal(learned[0][0], 'failure');
    assert.equal(learned[0][1], 7, 'keyed to the site');
    assert.equal(learned[0][2].patternId, 'design-incomplete');
    assert.deepEqual(requeued, [7]);
  });

  test('log mode learns from a would-block too (the week of evidence is also knowledge)', async () => {
    setEnv({ DESIGN_GATE_MODE: 'log' });
    await runDesignGates(site(null), draft, resolved, harness().deps);
    assert.equal(learned[0]?.[0], 'failure');
  });

  test('a complete profile that passes learns nothing', async () => {
    setEnv({ DESIGN_GATE_MODE: 'enforce' });
    await runDesignGates(site(goodProfile()), draft, resolved, harness().deps);
    assert.equal(learned.length, 0);
    assert.equal(requeued.length, 0);
  });

  test('the completeness record says whether the gap was repairable (what the re-queue counts)', async () => {
    setEnv({ DESIGN_GATE_MODE: 'log' });
    const h = harness();
    await runDesignGates(site(null), draft, resolved, h.deps);
    assert.equal(h.records[0].detail.repairable, true);
  });
});
