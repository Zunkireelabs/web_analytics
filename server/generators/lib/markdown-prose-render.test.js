import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { projectMarkdownProseInBody } from './markdown-prose-render.js';

// Site 1's real captured typography — the classes that already existed in
// the design profile and were never reaching generated prose.
const profile = {
  typography: {
    body: 'text-gray-600 leading-relaxed',
    link: 'text-zunkiree-600 hover:underline',
    heading: {
      item: 'text-2xl md:text-3xl font-normal text-gray-900',
      section: 'text-3xl md:text-4xl lg:text-5xl font-normal text-gray-900',
    },
  },
};

describe('projectMarkdownProseInBody', () => {
  test('headings and paragraphs get the site\'s own classes instead of rendering bare', () => {
    const out = projectMarkdownProseInBody('## What we do\n\nWe build things.', profile);
    assert.match(out, /<h2 class="text-3xl md:text-4xl lg:text-5xl font-normal text-gray-900">What we do<\/h2>/);
    assert.match(out, /<p class="text-gray-600 leading-relaxed">We build things\.<\/p>/);
  });

  test('h3 and deeper use the smaller item heading, matching how the profile splits them', () => {
    const out = projectMarkdownProseInBody('### A detail', profile);
    assert.match(out, /<h3 class="text-2xl md:text-3xl font-normal text-gray-900">A detail<\/h3>/);
  });

  test('inline links keep their href and gain the link class', () => {
    const out = projectMarkdownProseInBody('See [our pricing](/pricing/) for details.', profile);
    assert.match(out, /<a href="\/pricing\/" class="text-zunkiree-600 hover:underline">our pricing<\/a>/);
  });

  test('a site with no design profile gets its body back untouched', () => {
    const body = '## Heading\n\nA paragraph.';
    assert.equal(projectMarkdownProseInBody(body, null), body);
    assert.equal(projectMarkdownProseInBody(body, { typography: null }), body);
  });

  // Everything below is "do not touch" — this pass must only style plain
  // prose, never restructure the document.
  test('list items, quotes and table rows are left exactly as they were', () => {
    const body = '- one\n- two\n\n> a quote\n\n| a | b |\n| - | - |';
    assert.equal(projectMarkdownProseInBody(body, profile), body);
  });

  test('fenced code blocks are never rewritten, even when they contain prose', () => {
    const body = '```\n## not a heading\njust text\n```';
    assert.equal(projectMarkdownProseInBody(body, profile), body);
  });

  test('already-HTML lines (e.g. a projected table) pass straight through', () => {
    const body = '<table class="w-full"><tr><td>x</td></tr></table>';
    assert.equal(projectMarkdownProseInBody(body, profile), body);
  });

  test('a multi-line paragraph becomes one <p>, and blank lines survive', () => {
    const out = projectMarkdownProseInBody('first line\nsecond line\n\nnext para', profile);
    assert.match(out, /<p class="text-gray-600 leading-relaxed">first line second line<\/p>/);
    assert.match(out, /<p class="text-gray-600 leading-relaxed">next para<\/p>/);
  });
});

// CommonMark does not parse Markdown inside block-level raw HTML, so once a
// paragraph is emitted as <p>, its inline Markdown must already be HTML or it
// ships to the live page as literal asterisks/backticks.
describe('inline Markdown inside projected blocks', () => {
  test('bold and italic become real tags, not literal asterisks', () => {
    const out = projectMarkdownProseInBody('This is **bold** and *italic* text.', profile);
    assert.match(out, /<strong>bold<\/strong>/);
    assert.match(out, /<em>italic<\/em>/);
    assert.doesNotMatch(out, /\*\*/);
  });

  test('code spans survive and their contents are never treated as emphasis', () => {
    const out = projectMarkdownProseInBody('Run `npm *test*` now.', profile);
    assert.match(out, /<code>npm \*test\*<\/code>/);
    assert.doesNotMatch(out, /<em>/);
  });

  test('emphasis inside a heading is converted too', () => {
    const out = projectMarkdownProseInBody('## Why **we** win', profile);
    assert.match(out, /<h2 [^>]*>Why <strong>we<\/strong> win<\/h2>/);
  });
});
