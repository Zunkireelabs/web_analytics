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

  test('wraps the body in the site prose typography wrapper', () => {
    const body = renderCompliancePageBody(content, {});
    assert.match(body, /<div class="prose prose-lg prose-gray[^"]*">/);
    assert.match(body, /<\/div>\n$/);
  });

  test('keeps a blank line right after the opening div and right before the closing div', () => {
    const body = renderCompliancePageBody(content, {});
    const openIdx = body.indexOf('<div class="prose');
    const openLineEnd = body.indexOf('\n', openIdx);
    assert.equal(body.slice(openLineEnd, openLineEnd + 2), '\n\n');

    const closeIdx = body.indexOf('</div>');
    assert.equal(body.slice(closeIdx - 2, closeIdx), '\n\n');
  });

  test('still contains the real markdown headings/sections/disclaimer inside the wrapper', () => {
    const body = renderCompliancePageBody(content, {});
    assert.match(body, /# Privacy Policy/);
    assert.match(body, /> \*\*This is a draft template, not legal advice\.\*\*/);
    assert.match(body, /## Introduction/);
    assert.match(body, /## Data We Collect/);
  });

  test('preserves an existing layout/permalink ahead of the prose wrapper', () => {
    const body = renderCompliancePageBody(content, { layout: 'base.njk', permalink: '/privacy/' });
    assert.match(body, /layout: "base\.njk"/);
    assert.match(body, /permalink: "\/privacy\/"/);
  });
});
