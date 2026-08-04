import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { renderLlmsTxt, buildRobotsDirectives } from './llms-txt.js';

// Regression coverage for a real finding from a separate spec-compliance
// checker (llmstxt.org convention): a real merged llms.txt draft came back
// as plain "Key Pages:\n- URL: ..." labeled text with no top-level heading
// and no markdown links, failing that check. renderLlmsTxt is the
// deterministic builder that replaced asking the LLM to format the whole
// file itself — these tests assert the three real spec signals directly,
// mirroring (not importing — separate project/repo) the same checks:
// hasH1 (first non-blank line matches /^#\s+\S/), hasLink (contains a real
// markdown link [text](url)), longEnough (>= 200 chars for a realistic case).

const hasH1 = (text) => /^#\s+\S/.test(text.split(/\r?\n/).find((l) => l.trim().length > 0) || '');
const hasMarkdownLink = (text) => /\[[^\]]+\]\([^)]+\)/.test(text);

describe('renderLlmsTxt', () => {
  test('always starts with a top-level "# Site Name" heading', () => {
    const text = renderLlmsTxt({ siteName: 'Zunkiree Labs', description: '', keyPages: [] });
    assert.equal(hasH1(text), true);
    assert.equal(text.startsWith('# Zunkiree Labs'), true);
  });

  test('real key pages become real markdown links, grounded in given data only', () => {
    const text = renderLlmsTxt({
      siteName: 'Zunkiree Labs',
      description: 'Zunkiree Labs builds AI systems and enterprise software for companies in Nepal.',
      keyPages: [
        { url: 'https://zunkireelabs.com/products/search/', title: 'Zunkiree Search', metaDescription: 'AI-native search platform.' },
        { url: 'https://zunkireelabs.com/products/gaamma/', title: 'Gaamma', metaDescription: 'Manufacturing ERP platform.' },
      ],
    });
    assert.equal(hasMarkdownLink(text), true);
    assert.match(text, /\[Zunkiree Search\]\(https:\/\/zunkireelabs\.com\/products\/search\/\): AI-native search platform\./);
    assert.match(text, /\[Gaamma\]\(https:\/\/zunkireelabs\.com\/products\/gaamma\/\): Manufacturing ERP platform\./);
  });

  test('a realistic full page (heading + description + several key pages) is long enough to pass a 200-char minimum', () => {
    const keyPages = Array.from({ length: 5 }, (_, i) => ({
      url: `https://zunkireelabs.com/blog/post-${i}/`,
      title: `Real Blog Post Title Number ${i}`,
      metaDescription: `A real, reasonably descriptive meta description for post ${i}, grounded in the actual page.`,
    }));
    const text = renderLlmsTxt({
      siteName: 'Zunkiree Labs',
      description: 'Zunkiree Labs is an AI development company in Nepal building custom AI systems, RAG pipelines, and enterprise software.',
      keyPages,
    });
    assert.equal(hasH1(text), true);
    assert.equal(hasMarkdownLink(text), true);
    assert.ok(text.length >= 200, `expected length >= 200, got ${text.length}`);
  });

  test('no key pages at all still produces a valid heading, never throws', () => {
    const text = renderLlmsTxt({ siteName: 'Zunkiree Labs', description: 'A short real description.', keyPages: [] });
    assert.equal(hasH1(text), true);
    assert.match(text, /## Key Pages/);
  });

  test('a literal "[" or "]" in a real page title never breaks the markdown link syntax around it', () => {
    const text = renderLlmsTxt({
      siteName: 'Zunkiree Labs',
      description: '',
      keyPages: [{ url: 'https://zunkireelabs.com/x/', title: 'Zunkiree [Beta] Launch', metaDescription: null }],
    });
    assert.match(text, /\[Zunkiree \(Beta\) Launch\]\(https:\/\/zunkireelabs\.com\/x\/\)/);
  });

  test('never invents a page fact — output is a pure function of exactly what was given', () => {
    const keyPages = [{ url: 'https://example.com/real-page/', title: 'Real Title', metaDescription: 'Real description.' }];
    const text = renderLlmsTxt({ siteName: 'Example Co', description: 'Real description of Example Co.', keyPages });
    assert.doesNotMatch(text, /invented|placeholder|lorem ipsum/i);
    assert.match(text, /Real Title/);
    assert.match(text, /Real description of Example Co\./);
  });
});

// Regression coverage for a second real finding: robotsDirectives used to be
// LLM-composed as a full-file body with no knowledge of the site's actual
// existing robots.txt content — a real site's custom per-path Allow/Disallow
// rules would have been silently destroyed on apply. buildRobotsDirectives
// replaced that with a deterministic builder that only ever appends to real
// existing content, or returns null when nothing needs to change.
describe('buildRobotsDirectives', () => {
  test('no existing robots.txt: builds a fresh minimal file allowing all 5 named AI crawlers and blocking Bytespider', () => {
    const text = buildRobotsDirectives({ hasRobotsTxt: false, robotsAllowsAiCrawlers: null, robotsText: null });
    assert.match(text, /User-agent: GPTBot\nAllow: \//);
    assert.match(text, /User-agent: ClaudeBot\nAllow: \//);
    assert.match(text, /User-agent: PerplexityBot\nAllow: \//);
    assert.match(text, /User-agent: Google-Extended\nAllow: \//);
    assert.match(text, /User-agent: Applebot-Extended\nAllow: \//);
    assert.match(text, /User-agent: Bytespider\nDisallow: \//);
  });

  test('existing robots.txt already allows AI crawlers: returns null, never fabricates a diff', () => {
    const result = buildRobotsDirectives({
      hasRobotsTxt: true,
      robotsAllowsAiCrawlers: true,
      robotsText: 'User-agent: *\nAllow: /\n',
    });
    assert.equal(result, null);
  });

  test('existing robots.txt blocks AI crawlers: real existing content is preserved verbatim, new blocks only appended', () => {
    const existing = 'User-agent: *\nDisallow: /private/\n\nUser-agent: GPTBot\nDisallow: /\n';
    const text = buildRobotsDirectives({ hasRobotsTxt: true, robotsAllowsAiCrawlers: false, robotsText: existing });
    assert.match(text, /^User-agent: \*\nDisallow: \/private\//);
    assert.match(text, /User-agent: GPTBot\nDisallow: \//); // the real original blocking line, untouched
    assert.match(text, /User-agent: GPTBot\nAllow: \//); // the new, more-specific override appended after it
    assert.match(text, /User-agent: ClaudeBot\nAllow: \//);
  });
});
