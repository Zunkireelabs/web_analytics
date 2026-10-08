import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildCorrectionFeedback, canonicalTemplateForFeedback } from './design-repair-feedback.js';
import { PAGE_TEMPLATE_TYPES_FOR_GENERATOR } from '../../design-agent/lib/page-templates.js';

const issue = { patternId: 'structure-section-order', detail: 'order differs', correction: 'put the FAQ last' };

describe('buildCorrectionFeedback', () => {
  test('null with nothing correctable, even when knowledge exists (caller re-rolls as before)', () => {
    assert.equal(buildCorrectionFeedback([{ patternId: 'x' }], { knowledge: 'KNOWN' }), null);
  });
  test('names the problem and the correction', () => {
    const t = buildCorrectionFeedback([issue]);
    assert.match(t, /order differs -> put the FAQ last/);
  });
  test('appends what is already known about this tenant, after the correction', () => {
    const t = buildCorrectionFeedback([issue], { knowledge: 'KNOWN ABOUT THIS SITE\'S DESIGN: x' });
    assert.ok(t.indexOf('put the FAQ last') < t.indexOf('KNOWN ABOUT THIS SITE'));
  });
});

describe('canonicalTemplateForFeedback — page types', () => {
  const site = { url_file_map: { siteRoot: { pageTemplates: { 'case-study': { pageType: 'case-study', sectionOrder: ['hero', 'content'] } } } } };
  test('a missing-page draft finds the closest real page type the site has', () => {
    assert.equal(canonicalTemplateForFeedback(site, 'missing-page-create', PAGE_TEMPLATE_TYPES_FOR_GENERATOR).pageType, 'case-study');
  });
  test('an unmapped generator has no template (unchanged)', () => {
    assert.equal(canonicalTemplateForFeedback(site, 'faq', PAGE_TEMPLATE_TYPES_FOR_GENERATOR), null);
  });
});
