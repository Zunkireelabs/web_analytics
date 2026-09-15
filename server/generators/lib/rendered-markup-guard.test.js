import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { findBareMarkupIssues } from './rendered-markup-guard.js';

const REAL_PROFILE = {
  typography: {
    body: 'text-lg text-gray-600 leading-relaxed',
    link: 'text-zunkiree-600 hover:underline',
    heading: { section: 'text-2xl font-bold text-gray-900' },
  },
  components: { list: { wrapper: 'space-y-2', item: 'flex gap-2' } },
};

describe('findBareMarkupIssues', () => {
  test('no-op for an actionType buildMergeValues has no HTML-rendering branch for', () => {
    const { issues } = findBareMarkupIssues('meta-title', { selectedTitle: 'Title' }, {}, REAL_PROFILE);
    assert.equal(issues.length, 0);
  });

  test('no-op with no design profile — nothing to check a bare tag against', () => {
    const { issues } = findBareMarkupIssues('expand-content', { sections: [{ heading: 'H', body: 'Body text.' }] }, {}, null);
    assert.equal(issues.length, 0);
  });

  test('no-op when the profile has no real typography.body evidence (a plain-css site, or a thin capture)', () => {
    const { issues } = findBareMarkupIssues('expand-content', { sections: [{ heading: 'H', body: 'Body text.' }] }, {}, { typography: {} });
    assert.equal(issues.length, 0);
  });

  test('a real captured template plus a real design profile grounds both heading and body prose — no issues', () => {
    const componentTemplates = {
      expandContent: { wrapper: '<div>\n{{ROWS}}\n</div>', row: '<h2 class="text-2xl font-bold text-gray-900">{{HEADING}}</h2>{{BODY}}' },
    };
    const { issues } = findBareMarkupIssues('expand-content', {
      sections: [{ heading: 'H', body: 'Body text with a [link](https://example.com) and\n\n- one\n- two' }],
    }, componentTemplates, REAL_PROFILE);
    assert.equal(issues.length, 0);
  });

  // DEFAULT_EXPAND_TEMPLATE (no componentTemplates.expandContent configured
  // and no card/projected variant available) is intentionally the platform's
  // own bare fallback markup, not a captured or projected one — so its own
  // <h2> heading IS a real, correctly-flagged finding here, distinct from
  // the body prose this guard's sibling fix (proseStyleFor) already grounds
  // regardless of which row template is in play.
  test('the platform default template\'s own bare heading is a real finding, not a false positive', () => {
    const { issues } = findBareMarkupIssues('expand-content', {
      sections: [{ heading: 'H', body: 'Body text.' }],
    }, {}, REAL_PROFILE);
    assert.equal(issues.length, 1);
    assert.match(issues[0].snippet, /<h2>/);
  });

  // proseStyleFor grounds the BODY of an expand-content row regardless of
  // componentTemplates, but the row's own HEADING still comes straight from
  // whatever template is configured — a captured/legacy template with a
  // classless heading tag is exactly the kind of gap this guard exists to
  // catch even though it isn't the specific bug already fixed.
  test('flags a bare heading from a configured template with no class on it, even though body prose is grounded', () => {
    const componentTemplates = {
      expandContent: { wrapper: '<div>\n{{ROWS}}\n</div>', row: '<h2>{{HEADING}}</h2><div>{{BODY}}</div>' },
    };
    const { issues } = findBareMarkupIssues('expand-content', {
      sections: [{ heading: 'H', body: 'Body text.' }],
    }, componentTemplates, REAL_PROFILE);
    assert.equal(issues.length, 1);
    assert.equal(issues[0].patternId, 'bare-unstyled-markup');
    assert.equal(issues[0].blocking, true);
    assert.match(issues[0].snippet, /<h2>/);
  });

  test('a captured template with real classes on the heading silences the same case', () => {
    const componentTemplates = {
      expandContent: { wrapper: '<div>\n{{ROWS}}\n</div>', row: '<h2 class="text-2xl font-bold text-gray-900">{{HEADING}}</h2><div>{{BODY}}</div>' },
    };
    const { issues } = findBareMarkupIssues('expand-content', {
      sections: [{ heading: 'H', body: 'Body text.' }],
    }, componentTemplates, REAL_PROFILE);
    assert.equal(issues.length, 0);
  });

  test('a failed render (no sections) produces no issues — not this check\'s concern', () => {
    const { issues } = findBareMarkupIssues('expand-content', { sections: [] }, {}, REAL_PROFILE);
    assert.equal(issues.length, 0);
  });

  test('one finding per distinct bare tag type per field, not one per occurrence', () => {
    const componentTemplates = {
      expandContent: { wrapper: '<div>\n{{ROWS}}\n</div>', row: '<h2>{{HEADING}}</h2><div>{{BODY}}</div>' },
    };
    const { issues } = findBareMarkupIssues('expand-content', {
      sections: [{ heading: 'H1', body: 'One.' }, { heading: 'H2', body: 'Two.' }, { heading: 'H3', body: 'Three.' }],
    }, componentTemplates, REAL_PROFILE);
    assert.equal(issues.length, 1, 'three bare <h2> occurrences collapse to one finding for the "expandedContent" field');
  });
});
