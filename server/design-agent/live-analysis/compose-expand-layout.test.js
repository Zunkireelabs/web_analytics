import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validateGeneratedExpandLayout, composeGeneratedExpandLayout } from './compose-expand-layout.js';
import { DESIGN_PROFILE_VERSION } from '../lib/design-profile.js';

const TAILWIND_PROFILE = {
  version: DESIGN_PROFILE_VERSION,
  styling: 'tailwind',
  framework: 'eleventy',
  typography: {
    heading: { section: 'text-2xl font-semibold text-gray-900', item: 'text-lg font-medium text-gray-900' },
    body: 'text-gray-600 leading-relaxed',
    link: 'text-blue-600 hover:text-blue-800',
  },
  color: {
    text: 'text-gray-900', muted: 'text-gray-500', accent: 'text-blue-600', surface: 'bg-white', border: 'border-gray-200',
  },
  spacing: { section: 'py-12', itemGap: 'py-5' },
  layout: { container: 'max-w-3xl mx-auto', prose: 'prose prose-lg' },
  components: {
    card: { wrapper: 'rounded-lg border border-gray-200 p-6', body: 'space-y-2' },
    button: { primary: 'bg-blue-600 text-white px-5 py-2', secondary: 'text-blue-600' },
  },
};

// A candidate that uses only real brand tokens plus the fixed structural
// allowlist — must pass.
const VALID_CANDIDATE = {
  wrapper: '<div class="max-w-3xl mx-auto py-12 grid grid-cols-1 gap-6">\n{{ROWS}}\n</div>',
  row: '  <section class="rounded-lg border border-gray-200 p-6 shadow-sm">\n    <h2 class="text-2xl font-semibold text-gray-900">{{HEADING}}</h2>\n    <div class="text-gray-600 leading-relaxed">{{BODY}}</div>\n  </section>',
};

describe('validateGeneratedExpandLayout', () => {
  test('accepts a candidate built only from brand tokens and structural classes', () => {
    assert.equal(validateGeneratedExpandLayout(VALID_CANDIDATE, TAILWIND_PROFILE).ok, true);
  });

  test('rejects a missing wrapper/row', () => {
    assert.equal(validateGeneratedExpandLayout({ wrapper: '<div>{{ROWS}}</div>' }, TAILWIND_PROFILE).ok, false);
    assert.equal(validateGeneratedExpandLayout(null, TAILWIND_PROFILE).ok, false);
  });

  test('rejects a wrapper missing {{ROWS}}', () => {
    const result = validateGeneratedExpandLayout({ ...VALID_CANDIDATE, wrapper: '<div></div>' }, TAILWIND_PROFILE);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'missing-placeholder');
  });

  test('rejects a row missing {{HEADING}} or {{BODY}}', () => {
    const result = validateGeneratedExpandLayout({ ...VALID_CANDIDATE, row: '<section>{{HEADING}}</section>' }, TAILWIND_PROFILE);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'missing-placeholder');
  });

  test('rejects an invented class not present in brand tokens or the structural allowlist', () => {
    const result = validateGeneratedExpandLayout({
      ...VALID_CANDIDATE,
      // p-6 is already a real brand token (it's part of components.card.wrapper
      // above) so it must NOT be flagged — only the invented color is.
      row: '  <section class="bg-purple-700 p-6">\n    <h2>{{HEADING}}</h2>\n    <div>{{BODY}}</div>\n  </section>',
    }, TAILWIND_PROFILE);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'invented-classes');
    assert.deepEqual(result.detail, ['bg-purple-700']);
  });

  test('rejects an inline style attribute', () => {
    const result = validateGeneratedExpandLayout({
      ...VALID_CANDIDATE,
      row: '  <section style="color:red">\n    <h2>{{HEADING}}</h2>\n    <div>{{BODY}}</div>\n  </section>',
    }, TAILWIND_PROFILE);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'inline-style');
  });

  test('rejects a raw hex color value', () => {
    const result = validateGeneratedExpandLayout({
      ...VALID_CANDIDATE,
      row: '  <section>\n    <h2>{{HEADING}} #ff0000</h2>\n    <div>{{BODY}}</div>\n  </section>',
    }, TAILWIND_PROFILE);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'raw-color-value');
  });

  test('rejects a script tag or event handler', () => {
    const scripted = validateGeneratedExpandLayout({
      ...VALID_CANDIDATE,
      row: '  <section><script>alert(1)</script>{{HEADING}}{{BODY}}</section>',
    }, TAILWIND_PROFILE);
    assert.equal(scripted.ok, false);
    assert.equal(scripted.reason, 'unsafe-markup');

    const handler = validateGeneratedExpandLayout({
      ...VALID_CANDIDATE,
      row: '  <section onclick="doThing()">{{HEADING}}{{BODY}}</section>',
    }, TAILWIND_PROFILE);
    assert.equal(handler.ok, false);
    assert.equal(handler.reason, 'unsafe-markup');
  });

  test('accepts a responsive-prefixed structural class (md:grid-cols-2)', () => {
    const result = validateGeneratedExpandLayout({
      wrapper: '<div class="grid grid-cols-1 md:grid-cols-2 gap-6">\n{{ROWS}}\n</div>',
      row: VALID_CANDIDATE.row,
    }, TAILWIND_PROFILE);
    assert.equal(result.ok, true);
  });
});

describe('composeGeneratedExpandLayout', () => {
  test('returns null for a non-Tailwind site without calling the model', async () => {
    const result = await composeGeneratedExpandLayout({ ...TAILWIND_PROFILE, styling: 'plain-css' }, { siteId: 1 });
    assert.equal(result, null);
  });

  test('returns null for an unusable profile', async () => {
    const result = await composeGeneratedExpandLayout({ version: DESIGN_PROFILE_VERSION, styling: 'tailwind' }, { siteId: 1 });
    assert.equal(result, null);
  });
});
