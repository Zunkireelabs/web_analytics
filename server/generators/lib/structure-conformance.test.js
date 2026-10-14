import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkStructureConformance } from './structure-conformance.js';
import { buildCorrectionFeedback, canonicalTemplateForFeedback } from './design-repair-feedback.js';
import { PAGE_TEMPLATE_TYPES_FOR_GENERATOR } from '../../design-agent/lib/page-templates.js';

function siteWithTemplate(template) {
  return { id: 1, url_file_map: { siteRoot: { pageTemplates: template ? { 'blog-article': template } : {} } } };
}

const CANONICAL = {
  version: 1,
  pageType: 'blog-article',
  sectionOrder: ['intro', 'context', 'detail', 'evidence', 'takeaway', 'cta'],
  textRoles: ['heading', 'body', 'cta'],
};

function sections(n) {
  return Array.from({ length: n }, (_, i) => ({ heading: `Heading ${i + 1}`, body: 'Real prose body.' }));
}

describe('checkStructureConformance — grounding', () => {
  test('a site with no canonical template produces no issues (never invents an expected shape)', () => {
    const { issues } = checkStructureConformance({ sections: sections(1) }, 'blog-outline', siteWithTemplate(null));
    assert.deepEqual(issues, []);
  });

  test('a generator with no page-template concept is untouched', () => {
    const { issues } = checkStructureConformance({ sections: sections(1) }, 'meta-title', siteWithTemplate(CANONICAL));
    assert.deepEqual(issues, []);
  });

  test('content with no sections array is not judged', () => {
    const { issues } = checkStructureConformance({ title: 'x' }, 'blog-outline', siteWithTemplate(CANONICAL));
    assert.deepEqual(issues, []);
  });

  test('a section count close to the canonical shape passes', () => {
    const { issues } = checkStructureConformance({ sections: sections(5) }, 'blog-outline', siteWithTemplate(CANONICAL));
    assert.deepEqual(issues, []);
  });
});

describe('checkStructureConformance — real mismatches', () => {
  test('a page structurally nothing like the site (6 canonical sections answered with 1) is caught', () => {
    const { issues } = checkStructureConformance({ sections: sections(1) }, 'blog-outline', siteWithTemplate(CANONICAL));
    assert.equal(issues.length, 1);
    assert.equal(issues[0].patternId, 'structure-section-count');
    assert.match(issues[0].detail, /6 sections/);
    assert.ok(issues[0].correction, 'a mismatch must carry a correction, so it can be repaired rather than refused');
    assert.match(issues[0].correction, /intro -> context -> detail/);
  });

  test('a wildly over-sectioned page is caught too', () => {
    const { issues } = checkStructureConformance({ sections: sections(20) }, 'blog-outline', siteWithTemplate(CANONICAL));
    assert.equal(issues[0].patternId, 'structure-section-count');
  });

  test('a section with no heading cannot occupy a position in an ordered structure', () => {
    const withBlank = [...sections(5), { heading: '   ', body: 'text' }];
    const { issues } = checkStructureConformance({ sections: withBlank }, 'blog-outline', siteWithTemplate(CANONICAL));
    const headingIssue = issues.find((i) => i.patternId === 'structure-missing-heading');
    assert.ok(headingIssue);
    assert.ok(headingIssue.correction);
  });

  test('a thin canonical template (under 3 sections) is not used for ratio checks — too vague to mean anything', () => {
    const thin = { ...CANONICAL, sectionOrder: ['intro', 'cta'] };
    const { issues } = checkStructureConformance({ sections: sections(9) }, 'blog-outline', siteWithTemplate(thin));
    assert.deepEqual(issues, []);
  });
});

// The scenario the whole loop exists for: a deliberate design mismatch must
// come back as an actionable instruction routed to the generator, NOT as a
// refusal handed to a human.
describe('the repair loop: a deliberate mismatch produces a real correction, not a rejection', () => {
  test('diagnose -> correction feedback names the problem and restates the site\'s own design', () => {
    const site = siteWithTemplate(CANONICAL);
    const { issues } = checkStructureConformance({ sections: sections(1) }, 'blog-outline', site);
    assert.ok(issues.length, 'precondition: the mismatch is detected');

    const template = canonicalTemplateForFeedback(site, 'blog-outline', PAGE_TEMPLATE_TYPES_FOR_GENERATOR);
    assert.equal(template.pageType, 'blog-article');

    const feedback = buildCorrectionFeedback(issues, { site, canonicalTemplate: template });
    assert.ok(feedback, 'a correctable issue must yield feedback the generator can act on');
    assert.match(feedback, /CORRECTION REQUIRED/);
    assert.match(feedback, /Restructure the content into roughly 6 sections/);
    assert.match(feedback, /intro -> context -> detail -> evidence -> takeaway -> cta/);
    assert.match(feedback, /keep everything else you already wrote/i, 'a repair must preserve the work, not discard it');
  });

  test('issues with no correction yield no feedback, so the caller falls back to a plain retry', () => {
    const feedback = buildCorrectionFeedback(
      [{ patternId: 'some-other-guard', detail: 'unrelated' }],
      { site: siteWithTemplate(CANONICAL) },
    );
    assert.equal(feedback, null);
  });

  test('feedback survives an empty/absent issue list without throwing', () => {
    assert.equal(buildCorrectionFeedback([], {}), null);
    assert.equal(buildCorrectionFeedback(null, {}), null);
  });
});
