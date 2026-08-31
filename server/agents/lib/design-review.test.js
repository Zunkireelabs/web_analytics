import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sectionInventory, buildDesignReviewReport } from './design-review.js';
import { DESIGN_PROFILE_VERSION } from '../../design-agent/live-analysis/schema.js';

function page(url, pageType, sections) {
  return { url, pageType, sections };
}
function section(role, order, textHierarchy) {
  return { role, order, classes: '', alignment: 'left', width: 'normal', textHierarchy, components: [], spacing: { before: null, after: null }, imagery: { count: 0, hasBackground: false } };
}
function item(role, classes, tag = 'p') {
  return { role, text: null, tag, style: null, classes };
}

// A profile that would actually project every template (isProfileUsable
// requires typography.body, typography.heading.item, and layout.container
// or layout.prose) — real, correctly-role-assigned classes throughout.
const CLEAN_PROFILE = {
  version: DESIGN_PROFILE_VERSION,
  typography: {
    body: 'text-base leading-relaxed text-gray-700',
    heading: { section: 'text-3xl font-bold', item: 'text-2xl font-bold' },
    link: 'text-blue-600 underline',
  },
  layout: { container: 'max-w-7xl mx-auto' },
  spacing: {},
  components: {},
  pages: [
    page('https://x.com/', 'homepage', [
      section('hero', 0, [
        item('heading', 'text-3xl font-bold', 'h1'),
        item('body', 'text-base leading-relaxed text-gray-700'),
        item('link', 'text-blue-600 underline', 'a'),
      ]),
      // A real h3-level item, so typography.heading.item ('text-2xl
      // font-bold') has genuine observed evidence too, distinct from
      // heading.section's h1/h2-level 'text-3xl font-bold' above.
      section('faq', 1, [
        item('subheading', 'text-2xl font-bold', 'h3'),
      ]),
    ]),
  ],
};

describe('sectionInventory', () => {
  test('groups pages by pageType, sections sorted by their real captured order', () => {
    const profile = {
      pages: [
        page('https://x.com/blog/', 'blog-listing', [section('cta', 1, []), section('hero', 0, [])]),
        page('https://x.com/', 'homepage', [section('hero', 0, [])]),
      ],
    };
    const out = sectionInventory(profile);
    assert.deepEqual(Object.keys(out).sort(), ['blog-listing', 'homepage']);
    assert.deepEqual(out['blog-listing'][0].sections.map((s) => s.role), ['hero', 'cta']);
  });

  test('an empty profile produces an empty inventory, never throws', () => {
    assert.deepEqual(sectionInventory(null), {});
    assert.deepEqual(sectionInventory({}), {});
  });
});

describe('buildDesignReviewReport', () => {
  test('a site with no stored profile at all is reported honestly, not as a crash or an empty pass', () => {
    const report = buildDesignReviewReport({ url_file_map: {} });
    assert.equal(report.hasProfile, false);
    assert.deepEqual(report.templates, []);
    assert.equal(report.reviewState.ok, false);
    assert.equal(report.reviewState.reason, 'unreviewed');
  });

  test('a clean profile renders real sample markup for every template and passes every role check', () => {
    const site = { url_file_map: { siteRoot: { designProfile: CLEAN_PROFILE } } };
    const report = buildDesignReviewReport(site);
    assert.equal(report.hasProfile, true);

    const faq = report.templates.find((t) => t.actionType === 'faq');
    assert.equal(faq.available, true);
    assert.equal(faq.ok, true);
    assert.match(faq.sample, /Do you offer same-day service\?/);
    // Every field faq draws from resolved to a real observed example.
    for (const check of faq.roleChecks) {
      assert.equal(check.ok, true);
      assert.ok(check.example, `expected an example section for ${check.field}`);
    }

    const wrapper = report.templates.find((t) => t.actionType === 'content-wrapper');
    assert.equal(wrapper.ok, null, 'content-wrapper has no typography role field to judge');
    assert.match(wrapper.sample, /sample paragraph of body copy/);
  });

  // The incident this whole gate exists to catch, seen end-to-end through
  // the review report exactly as a human would see it on the screen: the
  // template that draws on the misassigned field is marked broken, and the
  // example section shows the class's REAL role (cta), not the one claimed.
  test('an eyebrow-as-body-copy profile marks every dependent template as failing, with the real role named', () => {
    const broken = {
      ...CLEAN_PROFILE,
      typography: { ...CLEAN_PROFILE.typography, body: 'text-xs uppercase tracking-widest text-gray-500' },
      pages: [
        page('https://x.com/', 'homepage', [
          section('hero', 0, [
            item('cta', 'text-xs uppercase tracking-widest text-gray-500'), // the real eyebrow
            item('body', 'text-base leading-relaxed text-gray-700'),
          ]),
        ]),
      ],
    };
    const report = buildDesignReviewReport({ url_file_map: { siteRoot: { designProfile: broken } } });

    const faq = report.templates.find((t) => t.actionType === 'faq');
    assert.equal(faq.ok, false);
    const bodyCheck = faq.roleChecks.find((c) => c.field === 'typography.body');
    assert.equal(bodyCheck.ok, false);
    assert.equal(bodyCheck.reason, 'role-mismatch');
    assert.equal(bodyCheck.example.itemRole, 'cta');
    assert.equal(bodyCheck.example.page, 'https://x.com/');

    // content-wrapper has no typography field, so it is unaffected by a
    // typography.body defect — it must not be reported as failing.
    const wrapper = report.templates.find((t) => t.actionType === 'content-wrapper');
    assert.equal(wrapper.ok, null);
  });

  test('reviewState/currentFingerprint reflect the profile actually reviewed, not a stale echo', () => {
    const site = { url_file_map: { siteRoot: { designProfile: CLEAN_PROFILE } } };
    const unreviewed = buildDesignReviewReport(site);
    assert.equal(unreviewed.reviewState.ok, false);
    assert.equal(unreviewed.reviewedAt, null);

    const reviewed = buildDesignReviewReport({ ...site, design_review_at: '2026-08-01T00:00:00Z', design_review_fingerprint: unreviewed.currentFingerprint });
    assert.equal(reviewed.reviewState.ok, true);
  });
});
