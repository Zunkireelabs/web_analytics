import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { compareSectionsToProfile } from './consistency-check.js';

function section(overrides = {}) {
  return {
    role: 'content', order: 0, classes: '', alignment: 'left', width: 'normal',
    textHierarchy: [], components: [], spacing: { before: null, after: null },
    imagery: { count: 0, hasBackground: false }, follows: null, precedes: null,
    ...overrides,
  };
}

function page(overrides = {}) {
  return { url: 'https://example.com/a', pageType: 'other', title: 'A', sections: [section()], ...overrides };
}

const BASE_PROFILE = {
  version: 2,
  typography: { heading: { section: 'text-3xl font-bold', item: 'text-xl font-semibold' }, body: 'text-gray-600 leading-relaxed' },
  components: { table: { wrapper: 'w-full border-collapse', headerCell: 'font-bold', row: 'border-b', cell: 'p-3' } },
  responsive: { breakpoints: ['sm:', 'md:', 'lg:'] },
};

describe('compareSectionsToProfile — table drift', () => {
  test('a table whose wrapper class shares nothing with the site\'s real table convention is flagged', () => {
    const p = page({
      sections: [section({
        components: [{ type: 'table', classes: { wrapper: 'basic-table plain', headerCell: '', row: '', cell: '' } }],
      })],
    });
    const findings = compareSectionsToProfile(BASE_PROFILE, [p]);
    assert.ok(findings.some((f) => f.id === 'table-style-drift'));
  });

  test('a table matching the real convention is never flagged', () => {
    const p = page({
      sections: [section({
        components: [{ type: 'table', classes: { wrapper: 'w-full border-collapse mt-4', headerCell: '', row: '', cell: '' } }],
      })],
    });
    const findings = compareSectionsToProfile(BASE_PROFILE, [p]);
    assert.equal(findings.filter((f) => f.id === 'table-style-drift').length, 0);
  });

  test('with no real site-wide table convention (profile has none), a table is never flagged — nothing honest to compare against', () => {
    const noTableProfile = { ...BASE_PROFILE, components: {} };
    const p = page({
      sections: [section({
        components: [{ type: 'table', classes: { wrapper: 'anything', headerCell: '', row: '', cell: '' } }],
      })],
    });
    const findings = compareSectionsToProfile(noTableProfile, [p]);
    assert.equal(findings.filter((f) => f.id === 'table-style-drift').length, 0);
  });
});

describe('compareSectionsToProfile — missing responsive classes', () => {
  test('a section with none of the site\'s real breakpoint prefixes is flagged', () => {
    const p = page({ sections: [section({ classes: 'flex flex-col gap-4' })] });
    const findings = compareSectionsToProfile(BASE_PROFILE, [p]);
    assert.ok(findings.some((f) => f.id === 'missing-responsive-classes'));
  });

  test('a section that DOES use one of the site\'s real breakpoints is never flagged', () => {
    const p = page({ sections: [section({ classes: 'flex flex-col md:flex-row gap-4' })] });
    const findings = compareSectionsToProfile(BASE_PROFILE, [p]);
    assert.equal(findings.filter((f) => f.id === 'missing-responsive-classes').length, 0);
  });

  test('a site that has never used a responsive prefix anywhere never triggers this check at all', () => {
    const noResponsiveProfile = { ...BASE_PROFILE, responsive: { breakpoints: [] } };
    const p = page({ sections: [section({ classes: 'flex flex-col' })] });
    const findings = compareSectionsToProfile(noResponsiveProfile, [p]);
    assert.equal(findings.filter((f) => f.id === 'missing-responsive-classes').length, 0);
  });

  test('a breakpoint prefix inside a textHierarchy item also counts', () => {
    const p = page({
      sections: [section({ classes: 'flex', textHierarchy: [{ role: 'body', text: 'x', tag: 'p', style: null, classes: 'md:text-lg' }] })],
    });
    const findings = compareSectionsToProfile(BASE_PROFILE, [p]);
    assert.equal(findings.filter((f) => f.id === 'missing-responsive-classes').length, 0);
  });
});

describe('compareSectionsToProfile — typography drift', () => {
  test('a prose-like section\'s heading class sharing nothing with the site convention is flagged', () => {
    const p = page({
      sections: [section({
        role: 'faq',
        textHierarchy: [{ role: 'heading', text: 'Q', tag: 'h3', style: null, classes: 'text-sm text-black' }],
      })],
    });
    const findings = compareSectionsToProfile(BASE_PROFILE, [p]);
    assert.ok(findings.some((f) => f.id === 'typography-drift' && f.evidence.textRole === 'heading'));
  });

  test('a heading class matching the real convention is never flagged', () => {
    const p = page({
      sections: [section({
        role: 'faq',
        textHierarchy: [{ role: 'heading', text: 'Q', tag: 'h3', style: null, classes: 'text-xl font-semibold mb-2' }],
      })],
    });
    const findings = compareSectionsToProfile(BASE_PROFILE, [p]);
    assert.equal(findings.filter((f) => f.id === 'typography-drift').length, 0);
  });

  test('a hero/cta section is never checked — it is allowed to look different on purpose', () => {
    const p = page({
      sections: [section({
        role: 'hero',
        textHierarchy: [{ role: 'heading', text: 'x', tag: 'h1', style: null, classes: 'totally-unrelated-classes' }],
      })],
    });
    const findings = compareSectionsToProfile(BASE_PROFILE, [p]);
    assert.equal(findings.filter((f) => f.id === 'typography-drift').length, 0);
  });

  test('body text is checked independently of heading', () => {
    const p = page({
      sections: [section({
        role: 'content',
        textHierarchy: [
          { role: 'heading', text: 'x', tag: 'h2', style: null, classes: 'text-3xl font-bold' }, // matches heading.section
          { role: 'body', text: 'y', tag: 'p', style: null, classes: 'totally-different' }, // does not
        ],
      })],
    });
    const findings = compareSectionsToProfile(BASE_PROFILE, [p]);
    const drifts = findings.filter((f) => f.id === 'typography-drift');
    assert.equal(drifts.length, 1);
    assert.equal(drifts[0].evidence.textRole, 'body');
  });
});

describe('compareSectionsToProfile — h1 resolved per hero/standard context', () => {
  const PROFILE_WITH_PAGE_CONTEXT = {
    ...BASE_PROFILE,
    typography: {
      ...BASE_PROFILE.typography,
      heading: { ...BASE_PROFILE.typography.heading, page: { hero: 'text-6xl font-black', standard: 'text-4xl font-bold' } },
    },
  };

  test('an h1 outside a hero section is checked against the site\'s own standard (non-hero) page-title convention', () => {
    const p = page({
      sections: [section({
        role: 'content',
        textHierarchy: [{ role: 'heading', text: 'Privacy Policy', tag: 'h1', style: null, classes: 'text-4xl font-bold' }],
      })],
    });
    const findings = compareSectionsToProfile(PROFILE_WITH_PAGE_CONTEXT, [p]);
    assert.equal(findings.filter((f) => f.id === 'typography-drift').length, 0);
  });

  test('an h1 outside a hero section rendered at the hero size (not the standard size) is flagged, not treated as correct', () => {
    const p = page({
      sections: [section({
        role: 'content',
        textHierarchy: [{ role: 'heading', text: 'Privacy Policy', tag: 'h1', style: null, classes: 'text-6xl font-black' }],
      })],
    });
    const findings = compareSectionsToProfile(PROFILE_WITH_PAGE_CONTEXT, [p]);
    const drift = findings.find((f) => f.id === 'typography-drift');
    assert.ok(drift);
    assert.equal(drift.evidence.siteConvention, 'text-4xl font-bold');
  });

  test('with no page-context evidence at all, an h1 outside a hero falls back to the flat item/section convention (pre-existing profile shape)', () => {
    const p = page({
      sections: [section({
        role: 'content',
        textHierarchy: [{ role: 'heading', text: 'x', tag: 'h1', style: null, classes: 'text-xl font-semibold' }],
      })],
    });
    const findings = compareSectionsToProfile(BASE_PROFILE, [p]);
    assert.equal(findings.filter((f) => f.id === 'typography-drift').length, 0);
  });
});

describe('compareSectionsToProfile — a fully-consistent site produces zero findings', () => {
  test('nothing is flagged when every real section matches the site\'s own real conventions', () => {
    const p = page({
      pageType: 'legal',
      sections: [section({
        role: 'content',
        classes: 'md:px-8',
        textHierarchy: [
          { role: 'heading', text: 'Privacy', tag: 'h2', style: null, classes: 'text-3xl font-bold' },
          { role: 'body', text: 'We collect...', tag: 'p', style: null, classes: 'text-gray-600 leading-relaxed' },
        ],
      })],
    });
    const findings = compareSectionsToProfile(BASE_PROFILE, [p]);
    assert.equal(findings.length, 0);
  });
});

// Measurement supersedes inference. `missing-responsive-classes` was only
// ever a proxy for "this probably breaks on a phone", and a bad one in both
// directions — a section can be perfectly responsive with no prefixed class
// (plain flex-wrap, a max-width, CSS grid auto-fit, or any non-Tailwind
// stylesheet), and one covered in md:/lg: classes can still overflow. When
// responsive-analysis.js has REAL measurements for a page, the heuristic is
// switched off for that page and the measured defects stand in its place.
describe('compareSectionsToProfile — responsive measurements supersede the class-name heuristic', () => {
  const unresponsiveSection = section({ classes: 'flex gap-4', order: 0 });
  const pageWithNoPrefixedClasses = page({ url: 'https://example.com/x', sections: [unresponsiveSection] });

  test('without measurements, the class-name heuristic still runs (unchanged fallback)', () => {
    const findings = compareSectionsToProfile(BASE_PROFILE, [pageWithNoPrefixedClasses]);
    assert.ok(findings.some((f) => f.id === 'missing-responsive-classes'));
  });

  test('with measurements for that page, the heuristic is skipped', () => {
    const responsive = {
      pages: [{ url: 'https://example.com/x', pageType: 'other', byViewport: { mobile: { blocks: [] } } }],
    };
    const findings = compareSectionsToProfile(BASE_PROFILE, [pageWithNoPrefixedClasses], { responsive });
    assert.equal(findings.filter((f) => f.id === 'missing-responsive-classes').length, 0);
  });

  test('a page that was NOT measured keeps the heuristic even when other pages were', () => {
    const responsive = {
      pages: [{ url: 'https://example.com/measured', pageType: 'other', byViewport: { mobile: { blocks: [] } } }],
    };
    const findings = compareSectionsToProfile(BASE_PROFILE, [pageWithNoPrefixedClasses], { responsive });
    assert.ok(findings.some((f) => f.id === 'missing-responsive-classes'));
  });

  test('a page whose every viewport failed to measure is treated as unmeasured', () => {
    const responsive = {
      pages: [{ url: 'https://example.com/x', pageType: 'other', byViewport: {} }],
    };
    const findings = compareSectionsToProfile(BASE_PROFILE, [pageWithNoPrefixedClasses], { responsive });
    assert.ok(findings.some((f) => f.id === 'missing-responsive-classes'));
  });

  test('table and typography drift are unaffected by responsive measurements', () => {
    const p = page({
      url: 'https://example.com/x',
      sections: [section({ components: [{ type: 'table', classes: { wrapper: 'basic-table plain' } }] })],
    });
    const responsive = { pages: [{ url: 'https://example.com/x', byViewport: { mobile: { blocks: [] } } }] };
    const findings = compareSectionsToProfile(BASE_PROFILE, [p], { responsive });
    assert.ok(findings.some((f) => f.id === 'table-style-drift'));
  });
});
