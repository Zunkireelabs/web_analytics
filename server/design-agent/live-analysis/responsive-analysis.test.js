import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeResponsive, detectResponsiveIssues, RESPONSIVE_FINDING_IDS } from './responsive-analysis.js';

function measurement(overrides = {}) {
  return {
    viewportWidth: 390,
    documentScrollWidth: 390,
    overflowPx: 0,
    overflowingElements: [],
    blocks: [],
    navigation: { visibleLinks: 1, totalLinks: 6, hasVisibleToggle: true },
    typography: { heading: { fontSize: 28, lineHeight: 34 }, body: { fontSize: 16, lineHeight: 24 } },
    smallTapTargets: [],
    clippedElements: [],
    ...overrides,
  };
}

function block(overrides = {}) {
  return {
    order: 0, tag: 'section', classes: '', width: 390, height: 300,
    columns: 1, paddingTop: 32, paddingLeft: 16, outerHtml: '<section></section>',
    ...overrides,
  };
}

function capture({ desktop, tablet, mobile, url = 'https://example.com/' } = {}) {
  const byViewport = {};
  if (desktop) byViewport.desktop = desktop;
  if (tablet) byViewport.tablet = tablet;
  if (mobile) byViewport.mobile = mobile;
  return {
    viewports: [
      { name: 'desktop', width: 1440, height: 900 },
      { name: 'tablet', width: 834, height: 1112 },
      { name: 'mobile', width: 390, height: 844 },
    ],
    pages: [{ url, pageType: 'homepage', byViewport }],
  };
}

describe('summarizeResponsive — measured Design Memory', () => {
  test('returns null when nothing was measured, so "not looked at" never reads as "no responsive behaviour"', () => {
    assert.equal(summarizeResponsive(null), null);
    assert.equal(summarizeResponsive({ pages: [] }), null);
  });

  test('a site whose desktop columns become one column at mobile is recorded as stacking', () => {
    const summary = summarizeResponsive(capture({
      desktop: measurement({ viewportWidth: 1440, blocks: [block({ order: 0, columns: 3 }), block({ order: 1, columns: 2 })] }),
      mobile: measurement({ blocks: [block({ order: 0, columns: 1 }), block({ order: 1, columns: 1 })] }),
    }));
    assert.equal(summary.stacksAtMobile, true);
  });

  test('a site that keeps its columns at mobile is recorded as NOT stacking', () => {
    const summary = summarizeResponsive(capture({
      desktop: measurement({ viewportWidth: 1440, blocks: [block({ order: 0, columns: 3 }), block({ order: 1, columns: 3 })] }),
      mobile: measurement({ blocks: [block({ order: 0, columns: 3 }), block({ order: 1, columns: 3 })] }),
    }));
    assert.equal(summary.stacksAtMobile, false);
  });

  test('stacking is null — not false — when nothing was in columns at desktop to begin with', () => {
    const summary = summarizeResponsive(capture({
      desktop: measurement({ viewportWidth: 1440, blocks: [block({ columns: 1 })] }),
      mobile: measurement({ blocks: [block({ columns: 1 })] }),
    }));
    assert.equal(summary.stacksAtMobile, null);
  });

  test('nav collapse needs BOTH a visible toggle and a real drop in visible links', () => {
    const collapsing = summarizeResponsive(capture({
      desktop: measurement({ viewportWidth: 1440, navigation: { visibleLinks: 6, totalLinks: 6, hasVisibleToggle: false } }),
      mobile: measurement({ navigation: { visibleLinks: 0, totalLinks: 6, hasVisibleToggle: true } }),
    }));
    assert.equal(collapsing.navCollapsesAtMobile, true);

    // A toggle that is always present, with every link still on screen, is
    // not a collapsed nav.
    const notCollapsing = summarizeResponsive(capture({
      desktop: measurement({ viewportWidth: 1440, navigation: { visibleLinks: 6, totalLinks: 6, hasVisibleToggle: true } }),
      mobile: measurement({ navigation: { visibleLinks: 6, totalLinks: 6, hasVisibleToggle: true } }),
    }));
    assert.equal(notCollapsing.navCollapsesAtMobile, false);
  });

  test('captures the real type scale and section padding per viewport', () => {
    const summary = summarizeResponsive(capture({
      desktop: measurement({
        viewportWidth: 1440,
        typography: { heading: { fontSize: 48, lineHeight: 56 }, body: { fontSize: 18, lineHeight: 28 } },
        blocks: [block({ paddingTop: 96 })],
      }),
      mobile: measurement({
        typography: { heading: { fontSize: 30, lineHeight: 36 }, body: { fontSize: 16, lineHeight: 24 } },
        blocks: [block({ paddingTop: 40 })],
      }),
    }));
    assert.deepEqual(summary.typeScale.desktop, { heading: 48, body: 18 });
    assert.deepEqual(summary.typeScale.mobile, { heading: 30, body: 16 });
    assert.equal(summary.sectionPadding.desktop, 96);
    assert.equal(summary.sectionPadding.mobile, 40);
    assert.equal(summary.typeScale.tablet, null, 'a viewport that was never measured stays null');
  });

  test('counts how many measured pages actually overflow', () => {
    const summary = summarizeResponsive({
      viewports: [{ name: 'mobile', width: 390, height: 844 }],
      pages: [
        { url: 'a', pageType: 'homepage', byViewport: { mobile: measurement({ overflowPx: 240 }) } },
        { url: 'b', pageType: 'service', byViewport: { mobile: measurement({ overflowPx: 0 }) } },
      ],
    });
    assert.deepEqual(summary.horizontalOverflow.mobile, { pagesAffected: 1, pagesMeasured: 2 });
  });
});

describe('detectResponsiveIssues — measured defects', () => {
  test('a clean page produces no findings', () => {
    const findings = detectResponsiveIssues(capture({
      desktop: measurement({ viewportWidth: 1440 }),
      tablet: measurement({ viewportWidth: 834 }),
      mobile: measurement(),
    }));
    assert.deepEqual(findings, []);
  });

  test('horizontal overflow is reported with the real numbers and an anchor', () => {
    const findings = detectResponsiveIssues(capture({
      mobile: measurement({
        overflowPx: 240,
        documentScrollWidth: 630,
        overflowingElements: [{ tag: 'div', classes: 'hero-grid', width: 630, overflowBy: 240, outerHtml: '<div class="hero-grid">' }],
      }),
    }));
    const overflow = findings.find((f) => f.id === RESPONSIVE_FINDING_IDS.HORIZONTAL_OVERFLOW);
    assert.ok(overflow);
    assert.equal(overflow.evidence.overflowPx, 240);
    assert.equal(overflow.evidence.viewport, 'mobile');
    assert.equal(overflow.evidence.outerHtml, '<div class="hero-grid">');
  });

  test('sub-pixel and 1px overflow is ignored as noise', () => {
    const findings = detectResponsiveIssues(capture({ mobile: measurement({ overflowPx: 2 }) }));
    assert.equal(findings.length, 0);
  });

  test('a section that keeps its columns at mobile is flagged, one that stacks is not', () => {
    const findings = detectResponsiveIssues(capture({
      desktop: measurement({ viewportWidth: 1440, blocks: [block({ order: 0, columns: 3 }), block({ order: 1, columns: 2 })] }),
      mobile: measurement({ blocks: [block({ order: 0, columns: 3, classes: 'grid grid-cols-3' }), block({ order: 1, columns: 1 })] }),
    }));
    const stuck = findings.filter((f) => f.id === RESPONSIVE_FINDING_IDS.SECTION_DOES_NOT_STACK);
    assert.equal(stuck.length, 1);
    assert.equal(stuck[0].sectionOrder, 0);
    assert.equal(stuck[0].evidence.columnsAtMobile, 3);
    assert.equal(stuck[0].evidence.columnsAtDesktop, 3);
  });

  test('a block that was always single-column is never reported as failing to stack', () => {
    const findings = detectResponsiveIssues(capture({
      desktop: measurement({ viewportWidth: 1440, blocks: [block({ order: 0, columns: 1 })] }),
      mobile: measurement({ blocks: [block({ order: 0, columns: 1 })] }),
    }));
    assert.equal(findings.length, 0);
  });

  test('tap targets under the WCAG minimum are reported at mobile only', () => {
    const small = [{ tag: 'a', classes: 'icon', text: 'x', minSide: 16, outerHtml: '<a class="icon">' }];
    const findings = detectResponsiveIssues(capture({
      tablet: measurement({ viewportWidth: 834, smallTapTargets: small }),
      mobile: measurement({ smallTapTargets: small }),
    }));
    const tap = findings.filter((f) => f.id === RESPONSIVE_FINDING_IDS.TAP_TARGET_TOO_SMALL);
    assert.equal(tap.length, 1, 'reported once, for mobile');
    assert.equal(tap[0].evidence.viewport, 'mobile');
    assert.equal(tap[0].evidence.minimumPx, 24);
  });

  test('clipped content is reported with how much is cut off', () => {
    const findings = detectResponsiveIssues(capture({
      mobile: measurement({ clippedElements: [{ tag: 'section', classes: 'row', clippedBy: 120, outerHtml: '<section class="row">' }] }),
    }));
    const clipped = findings.find((f) => f.id === RESPONSIVE_FINDING_IDS.CONTENT_CLIPPED);
    assert.ok(clipped);
    assert.equal(clipped.evidence.clippedBy, 120);
  });

  test('every finding carries the page it came from, so it is tenant- and page-attributable', () => {
    const findings = detectResponsiveIssues(capture({
      url: 'https://client.example/pricing',
      mobile: measurement({ overflowPx: 90 }),
    }));
    assert.ok(findings.length > 0);
    for (const f of findings) {
      assert.equal(f.pageUrl, 'https://client.example/pricing');
      assert.equal(f.pageType, 'homepage');
    }
  });
});
