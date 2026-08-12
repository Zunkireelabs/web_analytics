import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderCompliancePageBody, renderLandingPageBody, renderBlogOutlineBody,
  renderDirectAnswerBody, renderTranslationBody,
} from './newpage-render.js';

describe('renderCompliancePageBody', () => {
  const content = {
    headline: 'Privacy Policy',
    metaTitle: 'Privacy Policy — Zunkiree Labs',
    metaDescription: 'How we handle data.',
    disclaimer: 'This is a draft template, not legal advice.',
    sections: [
      { heading: 'Introduction', body: 'We respect your privacy.' },
      { heading: 'Data We Collect', body: 'Only what is listed here.' },
    ],
  };

  test('with no contentWrapper configured for the site, ships plain markdown unchanged (safe default for a new/unconfigured tenant)', () => {
    const body = renderCompliancePageBody(content, {}, { url_file_map: {} });
    assert.doesNotMatch(body, /<div/);
    assert.match(body, /# Privacy Policy/);
  });

  test('with no site argument at all, still ships plain markdown unchanged', () => {
    const body = renderCompliancePageBody(content, {});
    assert.doesNotMatch(body, /<div/);
    assert.match(body, /# Privacy Policy/);
  });

  test('with a site-specific contentWrapper componentTemplate configured, wraps the body in that real, per-tenant markup', () => {
    const site = {
      url_file_map: {
        siteRoot: {
          componentTemplates: {
            contentWrapper: { wrapper: '<div class="prose prose-lg prose-gray">\n{{BODY}}\n</div>' },
          },
        },
      },
    };
    const body = renderCompliancePageBody(content, {}, site);
    assert.match(body, /<div class="prose prose-lg prose-gray">/);
    assert.match(body, /<\/div>\n$/);
  });

  test('keeps a blank line right after the opening wrapper tag and right before the closing tag', () => {
    const site = {
      url_file_map: {
        siteRoot: { componentTemplates: { contentWrapper: { wrapper: '<div class="prose">\n{{BODY}}\n</div>' } } },
      },
    };
    const body = renderCompliancePageBody(content, {}, site);
    const openIdx = body.indexOf('<div class="prose">');
    const openLineEnd = body.indexOf('\n', openIdx);
    assert.equal(body.slice(openLineEnd, openLineEnd + 2), '\n\n');

    const closeIdx = body.indexOf('</div>');
    assert.equal(body.slice(closeIdx - 2, closeIdx), '\n\n');
  });

  test('a contentWrapper template missing the {{BODY}} placeholder is ignored, not applied broken', () => {
    const site = {
      url_file_map: {
        siteRoot: { componentTemplates: { contentWrapper: { wrapper: '<div class="prose"></div>' } } },
      },
    };
    const body = renderCompliancePageBody(content, {}, site);
    assert.doesNotMatch(body, /<div/);
  });

  test('still contains the real markdown headings/sections/disclaimer regardless of wrapper', () => {
    const body = renderCompliancePageBody(content, {});
    assert.match(body, /# Privacy Policy/);
    assert.match(body, /> \*\*This is a draft template, not legal advice\.\*\*/);
    assert.match(body, /## Introduction/);
    assert.match(body, /## Data We Collect/);
  });

  test('preserves an existing layout/permalink ahead of the body', () => {
    const body = renderCompliancePageBody(content, { layout: 'base.njk', permalink: '/privacy/' });
    assert.match(body, /layout: "base\.njk"/);
    assert.match(body, /permalink: "\/privacy\/"/);
  });
});

// The compliance trio was wrapped in the site's own prose markup; the other
// four net-new page types were not, so landing pages, blog posts,
// direct-answer pages and translations shipped bare <h1>/<h2>/<p> into real
// PRs — the same unstyled-body failure already confirmed live on
// zunkireelabs-web's /terms/, /privacy/ and /cookies/ before contentWrapper
// was captured for it.
describe('site prose wrapper across every net-new page type', () => {
  const siteWithWrapper = {
    url_file_map: {
      siteRoot: { componentTemplates: { contentWrapper: { wrapper: '<article class="prose prose-lg">\n{{BODY}}\n</article>' } } },
    },
  };
  const bare = { url_file_map: {} };

  const cases = [
    ['renderLandingPageBody', renderLandingPageBody, { headline: 'Plumbers in Leeds', subheadline: 'Fast callouts.', sections: [{ heading: 'Why us', body: 'We show up.' }], cta: 'Book now' }, /# Plumbers in Leeds/],
    ['renderBlogOutlineBody', renderBlogOutlineBody, { title: 'Boiler care', sections: [{ heading: 'Bleeding radiators', body: 'Turn the valve.' }] }, /## Bleeding radiators/],
    ['renderDirectAnswerBody', renderDirectAnswerBody, { heading: 'How long does a boiler last?', directAnswer: 'Typically 10-15 years.' }, /# How long does a boiler last\?/],
    ['renderTranslationBody', renderTranslationBody, { translatedTitle: 'Servicios', translatedContent: '# Servicios\n\nOfrecemos fontanería.' }, /# Servicios/],
  ];

  for (const [name, render, content, bodyPattern] of cases) {
    test(`${name} wraps its body in the site's real prose markup when one is configured`, () => {
      const out = render(content, siteWithWrapper);
      assert.match(out, /<article class="prose prose-lg">/);
      assert.match(out, /<\/article>/);
      assert.match(out, bodyPattern, 'the real content survives the wrapping');
    });

    test(`${name} ships plain markdown when the site has no contentWrapper yet`, () => {
      const out = render(content, bare);
      assert.doesNotMatch(out, /<article/);
      assert.match(out, bodyPattern);
    });
  }

  test('front matter stays outside the wrapper — wrapping it would break the page', () => {
    const out = renderLandingPageBody({ headline: 'Leeds', metaTitle: 'Leeds' }, siteWithWrapper);
    const frontMatterEnd = out.indexOf('---', 3);
    assert.ok(out.indexOf('<article') > frontMatterEnd, 'wrapper opens after the closing front-matter fence');
  });
});
