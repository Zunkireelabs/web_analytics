import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { renderCompliancePageBody } from './newpage-render.js';

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
