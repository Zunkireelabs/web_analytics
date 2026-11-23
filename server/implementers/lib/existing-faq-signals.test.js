import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { scanVisibleFaqSignals, hasVisibleFaqSignal } from './render-inspector.js';
import { hasOrganicFaqSignal } from '../../lib/faq-signal.js';

// 2026-11-23: pages that already had a FAQ written in Markdown (`## FAQ` + questions) or in a faq-classed block were
// each given a second one, because only loops and accordion keywords counted as "has a FAQ".
const mdFaq = '---\ntitle: "T"\n---\n\nBody.\n\n## FAQ\n\n### Does blocking GPTBot remove me?\n\nNot automatically.\n\n### Should I add llms.txt?\n\nOptional.\n\n## Next step\n\nGo.\n';
const quickFaq = '## Quick FAQ\n\n**How long does it take?** An hour.\n\n**What first?** Crawling.\n';
const classed = '<section class="faq-x" id="faqs"><div class="faq-x__in"><h2>Frequently asked questions</h2></div></section>';
const navOnly = '<nav><a href="/faq">FAQ</a></nav><p>Hello</p>';
const ours = '<!-- SEOAI:FAQ:START --><dl class="faq"><dt>Q?</dt><dd>A</dd></dl><!-- SEOAI:FAQ:END -->';

describe('a FAQ the page already has is recognised', () => {
  test('Markdown "## FAQ" and "## Quick FAQ" sections', () => {
    for (const src of [mdFaq, quickFaq]) {
      assert.equal(hasOrganicFaqSignal(src), true);
      assert.equal(hasVisibleFaqSignal(src), true);
      assert.equal(scanVisibleFaqSignals(src).strength, 'strong');
    }
  });
  test('a faq-classed section whose class names carry none of the accordion keywords', () => {
    assert.equal(hasOrganicFaqSignal(classed), true);
    assert.equal(scanVisibleFaqSignals(classed).strength, 'strong');
  });
  test('a nav link that only says "FAQ" is not a FAQ', () => {
    assert.equal(hasOrganicFaqSignal(navOnly), false);
    assert.equal(hasVisibleFaqSignal(navOnly), false);
  });
  test('our own marker block is never the site\'s FAQ', () => {
    assert.equal(hasOrganicFaqSignal(ours), false);
    assert.equal(hasVisibleFaqSignal(ours), false);
  });
});
