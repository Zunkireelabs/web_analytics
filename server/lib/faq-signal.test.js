import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { hasOrganicFaqSignal } from './faq-signal.js';

describe('hasOrganicFaqSignal', () => {
  test('detects a real Nunjucks FAQ loop', () => {
    assert.ok(hasOrganicFaqSignal('{% for item in faq %}{{ item.question }}{% endfor %}'));
  });

  test('detects an accordion component with FAQ text', () => {
    assert.ok(hasOrganicFaqSignal('<div x-data="{ activeIndex: null }"><h3>Frequently Asked Questions</h3></div>'));
  });

  test('ignores content that only exists inside a tool-managed marker block', () => {
    const html = '<!-- SEOAI:FAQ:START -->{% for item in faq %}{{ item.question }}{% endfor %}<!-- SEOAI:FAQ:END -->';
    assert.equal(hasOrganicFaqSignal(html), false);
  });

  test('returns false for a page with no FAQ evidence at all', () => {
    assert.equal(hasOrganicFaqSignal('<h1>Welcome</h1><p>Nothing FAQ-related here.</p>'), false);
  });

  test('an accordion keyword alone, with no FAQ text, is not enough', () => {
    assert.equal(hasOrganicFaqSignal('<div class="accordion">Unrelated expandable content</div>'), false);
  });
});
