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
          { role: 'heading', text: 'x', tag: 'h2', style: null, classes: 'text-xl font-semibold' }, // matches
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

describe('compareSectionsToProfile — a fully-consistent site produces zero findings', () => {
  test('nothing is flagged when every real section matches the site\'s own real conventions', () => {
    const p = page({
      pageType: 'legal',
      sections: [section({
        role: 'content',
        classes: 'md:px-8',
        textHierarchy: [
          { role: 'heading', text: 'Privacy', tag: 'h2', style: null, classes: 'text-xl font-semibold' },
          { role: 'body', text: 'We collect...', tag: 'p', style: null, classes: 'text-gray-600 leading-relaxed' },
        ],
      })],
    });
    const findings = compareSectionsToProfile(BASE_PROFILE, [p]);
    assert.equal(findings.length, 0);
  });
});
