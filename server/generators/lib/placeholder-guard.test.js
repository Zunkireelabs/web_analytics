import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { checkPlaceholders } from './placeholder-guard.js';

// Every fixture below is real content that shipped to zunkireelabs.com's live
// pages and had to be removed by hand on 2026-08-31.
describe('content that actually shipped', () => {
  test('flags a comparison table built against an invented competitor', () => {
    const { issues } = checkPlaceholders({
      sections: [{
        heading: 'Comparison Table',
        body: 'Below are key comparison points to help you decide.',
        table: [
          { feature: 'Location', zunkiree_labs: 'Kathmandu, Nepal', competitor_x: '[Competitor Location]' },
          { feature: 'Response Time', zunkiree_labs: 'Commitment to timely responses', competitor_x: '24-48 hours' },
        ],
      }],
    });
    assert.ok(issues.length, 'must not pass');
    assert.match(issues.map((i) => i.patternId).join(' '), /unfilled-placeholder/);
  });

  test('flags an unresolved markdown link', () => {
    const { issues } = checkPlaceholders({
      sections: [{
        heading: 'Understanding AI-Native Search',
        body: 'For an overview of AI-native search technologies, refer to [Authoritative Source on AI in Search](URL).',
      }],
    });
    assert.equal(issues.length, 1);
    assert.equal(issues[0].patternId, 'unresolved-link');
  });

  test('flags "Competitor A/B/C" naming', () => {
    const { issues } = checkPlaceholders({
      sections: [{ heading: 'Benefits', body: 'Unlike Competitor A, we offer remote work.' }],
    });
    assert.match(issues.map((i) => i.patternId).join(' '), /fabricated-competitor/);
  });

  test('finds a placeholder buried in a structured table cell', () => {
    // The original incident lived only here — no prose-level check saw it.
    const { issues } = checkPlaceholders({
      sections: [{ heading: 'x', body: 'clean prose', table: [{ a: 'Pokhara', b: '[Competitor Region]' }] }],
    });
    assert.ok(issues.length);
  });
});

describe('legitimate content passes', () => {
  const clean = (content) => assert.deepEqual(checkPlaceholders(content).issues, []);

  test('a real markdown link', () => {
    clean({ body: 'See [our pricing](https://zunkireelabs.com/pricing/) for details.' });
    clean({ body: 'Read the [State of AI report](/resources/state-of-ai-nepal-2026/).' });
  });

  test('a named real competitor', () => {
    // "Zunkiree vs Algolia" is a real comparison page on the site.
    clean({ sections: [{ heading: 'Zunkiree vs Algolia', body: 'Algolia charges per search operation.' }] });
    clean({ body: 'Competitors such as Elasticsearch take a different approach.' });
  });

  test('ordinary bracketed prose is not a placeholder', () => {
    clean({ body: 'The report [sic] covers 2026 adoption rates.' });
    clean({ body: 'Adoption rose 40% [2026 figures] year over year.' });
  });

  test('an anchor link with a real fragment', () => {
    clean({ body: 'Jump to [the pricing table](#pricing).' });
  });

  test('empty and non-string content', () => {
    clean({});
    clean({ sections: [] });
    clean({ count: 5, enabled: true, nothing: null });
  });
});

describe('reporting', () => {
  test('one issue per distinct problem, not per occurrence', () => {
    const { issues } = checkPlaceholders({
      sections: [
        { body: 'See [A](URL).' },
        { body: 'See [B](URL).' },
        { body: 'Unlike Competitor X, we ship fast.' },
      ],
    });
    assert.equal(issues.length, 2, 'link problem + competitor problem');
  });

  test('the message names the offending text and refuses a guessed fix', () => {
    const { issues } = checkPlaceholders({ body: 'Located in [Competitor Location] today.' });
    assert.match(issues[0].snippet, /\[Competitor Location\]/);
    assert.match(issues[0].detail, /do not fill it in with a plausible guess/);
    assert.ok(issues[0].path, 'names where in the content it was found');
  });
});
