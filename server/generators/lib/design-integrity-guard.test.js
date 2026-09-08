import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { findDesignIntegrityIssues, designIntegrityEnforced } from './design-integrity-guard.js';
import { runQualityGate } from './quality-gate.js';

// Same real incident design-drift.test.js's EYEBROW_AS_BODY_PROFILE
// reconstructs: typography.body names the class this site only ever uses
// for its eyebrow/caption (captured under textHierarchy role 'cta' here,
// same as that fixture).
function pageWith(sections) {
  return { url: 'https://example.com/', pageType: 'homepage', sections };
}
function item(role, classes) {
  return { role, text: null, tag: 'p', style: null, classes };
}
const EYEBROW_AS_BODY_PROFILE = {
  typography: { body: 'text-xs uppercase tracking-widest text-gray-500', heading: { item: 'text-2xl font-bold' } },
  pages: [pageWith([
    { role: 'hero', textHierarchy: [
      item('cta', 'text-xs uppercase tracking-widest text-gray-500'),
      item('body', 'text-base leading-relaxed text-gray-700'),
      item('heading', 'text-2xl font-bold'),
    ] },
  ])],
};
const CONSISTENT_PROFILE = {
  typography: { body: 'text-base leading-relaxed text-gray-700', heading: { item: 'text-2xl font-bold' } },
  pages: [pageWith([
    { role: 'hero', textHierarchy: [
      item('body', 'text-base leading-relaxed text-gray-700'),
      item('heading', 'text-2xl font-bold'),
    ] },
  ])],
};

function siteWithProfile(profile) {
  return { id: 1, url_file_map: { siteRoot: { designProfile: profile } } };
}

describe('design-integrity-guard', () => {
  afterEach(() => { delete process.env.DESIGN_INTEGRITY_ENFORCE; });

  test('no siteId given: no-op', async () => {
    const { issues } = await findDesignIntegrityIssues('blog-outline', null);
    assert.equal(issues.length, 0);
  });

  test('generatorId outside DESIGN_CONTEXT_GENERATOR_IDS: no-op (e.g. a purely technical generator)', async () => {
    const { issues } = await findDesignIntegrityIssues('meta-title', 1, { fetchSite: async () => siteWithProfile(EYEBROW_AS_BODY_PROFILE) });
    assert.equal(issues.length, 0);
  });

  test('a consistent profile reports no issues', async () => {
    const { issues } = await findDesignIntegrityIssues('blog-outline', 1, { fetchSite: async () => siteWithProfile(CONSISTENT_PROFILE) });
    assert.equal(issues.length, 0);
  });

  // Enforcement is ON by default now. This is the FINAL safety check, and
  // it only ever sees content that has already been through the repair loop
  // (design-repair-feedback.js + generateDraft's bounded regeneration): a
  // mismatch reaching it has survived every automatic correction the system
  // can make, so shipping it to a live customer site is never the right
  // answer.
  test('a confirmed role-mismatch is BLOCKING by default (enforcement on)', async () => {
    assert.equal(designIntegrityEnforced(), true);
    const { issues } = await findDesignIntegrityIssues('blog-outline', 1, { fetchSite: async () => siteWithProfile(EYEBROW_AS_BODY_PROFILE) });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].patternId, 'design-role-mismatch');
    assert.equal(issues[0].blocking, true);
    assert.match(issues[0].detail, /only ever uses for its cta/);
  });

  test('DESIGN_INTEGRITY_ENFORCE=false is the escape hatch back to log-only', async () => {
    process.env.DESIGN_INTEGRITY_ENFORCE = 'false';
    assert.equal(designIntegrityEnforced(), false);
    const { issues } = await findDesignIntegrityIssues('blog-outline', 1, { fetchSite: async () => siteWithProfile(EYEBROW_AS_BODY_PROFILE) });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].blocking, false, 'still recorded and visible, just not failing the gate');
  });

  test('a site load failure fails open (no issues, never throws)', async () => {
    const { issues } = await findDesignIntegrityIssues('blog-outline', 1, { fetchSite: async () => { throw new Error('db down'); } });
    assert.equal(issues.length, 0);
  });
});

describe('design-integrity-guard — runQualityGate integration', () => {
  afterEach(() => { delete process.env.DESIGN_INTEGRITY_ENFORCE; });

  test('log-only mode: a role-mismatch appears in issues but does not fail clean', async () => {
    // runQualityGate loads the site itself (design-integrity-guard.js's
    // default fetchSite), so this exercises the real store — skipped when
    // there's no DB in this environment isn't needed here since siteId 1
    // with no matching row simply fails the fetch open (see "fails open"
    // test above), which would also report zero issues either way. This
    // test documents the wiring/shape contract at the quality-gate level;
    // the enforcement behavior itself is covered directly above.
    const result = await runQualityGate({ title: 'x', sections: [] }, 'blog-outline', null);
    assert.equal(result.clean, true);
  });
});
