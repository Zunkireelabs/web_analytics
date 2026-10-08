import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifySectionRole, rolesOf, normalizeExpectedRoles, orderIssues } from './section-roles.js';
import { checkStructureConformance } from './structure-conformance.js';

const sec = (heading, body = 'x '.repeat(200)) => ({ heading, body });

describe('classifySectionRole', () => {
  test('a heading that says FAQ is faq; one that says get in touch is cta', () => {
    assert.equal(classifySectionRole(sec('Frequently asked questions'), { index: 2, total: 4 }), 'faq');
    assert.equal(classifySectionRole(sec('Get in touch'), { index: 3, total: 4 }), 'cta');
  });
  test('a short opening block is the hero; a long one is content', () => {
    assert.equal(classifySectionRole(sec('Welcome', 'Short intro line.'), { index: 0, total: 4 }), 'hero');
    assert.equal(classifySectionRole(sec('Welcome', 'word '.repeat(200)), { index: 0, total: 4 }), 'content');
  });
  test('a hero can only be first', () => {
    assert.equal(classifySectionRole(sec('Welcome', 'Short intro line.'), { index: 2, total: 4 }), 'content');
  });
  test('anything it cannot place is content, never a guessed specific role', () => {
    assert.equal(classifySectionRole(sec('The history of visas'), { index: 1, total: 4 }), 'content');
  });
  test('a closing imperative in the last section is a cta even with a neutral heading', () => {
    assert.equal(classifySectionRole({ heading: 'Next steps', body: 'x '.repeat(100) + ' Ready to begin? Book a call today.' }, { index: 3, total: 4 }), 'cta');
  });
});

describe('order', () => {
  test('capture-side labels normalise onto the same vocabulary; unknown labels become content', () => {
    assert.deepEqual(normalizeExpectedRoles(['header', 'weird-label', 'faq', 'cta', 'footer']), ['hero', 'content', 'faq', 'cta']);
  });
  test('extra content sections are not an ordering problem', () => {
    const r = orderIssues(['hero', 'content', 'content', 'faq', 'cta'], ['hero', 'content', 'faq', 'cta']);
    assert.deepEqual(r, { outOfOrder: [], missing: [] });
  });
  test('a cta before the faq on a site that closes with the cta is out of order', () => {
    const r = orderIssues(['hero', 'cta', 'faq'], ['hero', 'faq', 'cta']);
    assert.equal(r.outOfOrder[0].role, 'faq');
  });
  test('a role the site always has and the draft lacks is reported missing', () => {
    assert.deepEqual(orderIssues(['hero', 'content'], ['hero', 'content', 'faq', 'cta']).missing, ['faq', 'cta']);
  });
  test('a role the site never uses is not our concern', () => {
    assert.deepEqual(orderIssues(['hero', 'testimonials'], ['hero']).outOfOrder, []);
  });
});

describe('checkStructureConformance — order, behind STRUCTURE_ORDER_CHECK', () => {
  const site = { url_file_map: { siteRoot: { pageTemplates: { 'blog-article': { pageType: 'blog-article', sectionOrder: ['hero', 'content', 'faq', 'cta'], textRoles: ['x'] } } } } };
  const content = { sections: [sec('Welcome', 'Short intro.'), sec('Ready to start? Contact us'), sec('FAQ'), sec('More on visas')] };

  test('off by default: no order issue is raised', () => {
    delete process.env.STRUCTURE_ORDER_CHECK;
    assert.equal(checkStructureConformance(content, 'blog-outline', site).issues.some((i) => i.patternId === 'structure-section-order'), false);
  });
  test('on: an out-of-order draft gets a correction naming the site order', () => {
    process.env.STRUCTURE_ORDER_CHECK = 'true';
    try {
      const issues = checkStructureConformance(content, 'blog-outline', site).issues;
      const order = issues.find((i) => i.patternId === 'structure-section-order');
      assert.ok(order);
      assert.match(order.correction, /hero -> content -> faq -> cta/);
    } finally { delete process.env.STRUCTURE_ORDER_CHECK; }
  });
});
