import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { scanVisibleFaqSignals, hasExistingFaqSchema, hasVisibleFaqSignal, hasSafeInsertionPoint, inspectRenderMode, INSPECTABLE_ACTION_TYPES } from './render-inspector.js';

// Only exercises the deterministic paths (regex/structural evidence, the
// sitewide cap short-circuit) — llmAssistedInspection needs a real LLM call
// and is intentionally left to manual/sandbox verification, same convention
// as generators/faq.test.js for prompt-content coverage.

describe('scanVisibleFaqSignals', () => {
  test('a real templating loop over question/answer fields is strong evidence', () => {
    const { strength, evidence } = scanVisibleFaqSignals('{% for item in faq %}{{ item.question }}{% endfor %}');
    assert.equal(strength, 'strong');
    assert.ok(evidence.length > 0);
  });

  test('an existing FAQPage schema block is strong evidence even with no visible markup', () => {
    const { strength } = scanVisibleFaqSignals('<script type="application/ld+json">{"@type":"FAQPage"}</script>');
    assert.equal(strength, 'strong');
  });

  test('a lone accordion keyword or "FAQ" text mention alone is only weak, never strong', () => {
    assert.equal(scanVisibleFaqSignals('<div class="accordion">unrelated</div>').strength, 'weak');
    assert.equal(scanVisibleFaqSignals('See our FAQ page').strength, 'weak');
  });

  test('no signals at all is none', () => {
    assert.equal(scanVisibleFaqSignals('<p>Just some page content.</p>').strength, 'none');
  });

  // scanVisibleFaqSignals is a pure function of whatever content it's given
  // — stripping the tool's own managed markers is inspectRenderMode's job
  // (done before calling this), not this function's. See the
  // inspectRenderMode and hasVisibleFaqSignal describe blocks below for the
  // actual marker-stripped behavior.
});

describe('hasExistingFaqSchema', () => {
  test('true when FAQPage JSON-LD is present', () => {
    assert.equal(hasExistingFaqSchema('<script type="application/ld+json">{"@type": "FAQPage"}</script>'), true);
  });

  test('false otherwise', () => {
    assert.equal(hasExistingFaqSchema('<p>no schema here</p>'), false);
  });
});

describe('hasVisibleFaqSignal (used by the "Recalculate FAQ baseline" scan)', () => {
  test('true for a real rendering loop', () => {
    assert.equal(hasVisibleFaqSignal('{% for item in faq %}{{ item.question }}{% endfor %}'), true);
  });

  test('true for an accordion component combined with FAQ text', () => {
    assert.equal(hasVisibleFaqSignal('<div class="faq-item accordion">Frequently Asked Questions</div>'), true);
  });

  test('false for schema-only pages — a baseline count must not include pages with no VISIBLE FAQ', () => {
    assert.equal(hasVisibleFaqSignal('<script type="application/ld+json">{"@type":"FAQPage"}</script>'), false);
  });

  test('false when the only "FAQ" text comes from this tool\'s own marker', () => {
    assert.equal(hasVisibleFaqSignal('<!-- SEOAI:FAQ:START --><!-- SEOAI:FAQ:END -->'), false);
  });

  test('false for plain page content', () => {
    assert.equal(hasVisibleFaqSignal('<p>Just some page content.</p>'), false);
  });
});

describe('hasSafeInsertionPoint', () => {
  test('false for empty/non-string content', () => {
    assert.equal(hasSafeInsertionPoint(''), false);
    assert.equal(hasSafeInsertionPoint('   '), false);
    assert.equal(hasSafeInsertionPoint(null), false);
  });

  test('true for real content', () => {
    assert.equal(hasSafeInsertionPoint('<p>hello</p>'), true);
  });
});

describe('inspectRenderMode — deterministic short-circuits', () => {
  test('action types other than faq always get visible, no inspection needed', async () => {
    const result = await inspectRenderMode('<p>anything</p>', 'meta-title');
    assert.deepEqual(result, {
      mode: 'visible', confidence: 100,
      reason: '"meta-title" has only one representation — no mode decision to make.',
      source: 'deterministic',
    });
  });

  test('empty file content fails honestly, never guesses a mode', async () => {
    const result = await inspectRenderMode('   ', 'faq');
    assert.equal(result.mode, null);
    assert.equal(result.confidence, 0);
  });

  test('a page with strong existing-FAQ evidence always gets schema-only, regardless of cap headroom', async () => {
    const result = await inspectRenderMode('{% for item in faq %}{{ item.question }}{% endfor %}', 'faq', {
      visibleFaqCount: 0, visibleFaqCap: 5,
    });
    assert.equal(result.mode, 'schema-only');
    assert.equal(result.source, 'deterministic');
  });

  test('sitewide cap reached (tool-injected + baseline) forces schema-only even with no existing FAQ on this page', async () => {
    const result = await inspectRenderMode('<p>plain page</p>', 'faq', { visibleFaqCount: 5, visibleFaqCap: 5 });
    assert.equal(result.mode, 'schema-only');
    assert.equal(result.source, 'cap');
    assert.match(result.reason, /5\/5/);
  });

  test('cap check applies to visibleFaqCount as a combined total — a full baseline alone is enough to trip it', async () => {
    // visibleFaqCount here already represents tool-injected(0) + baseline(5) —
    // the caller (countVisibleFaqPages) is responsible for combining them
    // before this is ever called; this only proves the comparison itself.
    const result = await inspectRenderMode('<p>plain page</p>', 'faq', { visibleFaqCount: 5, visibleFaqCap: 5 });
    assert.equal(result.mode, 'schema-only');
  });

  test('no existing FAQ and cap not reached gets visible with no LLM call needed', async () => {
    const result = await inspectRenderMode('<p>Welcome to our homepage.</p>', 'faq', {
      visibleFaqCount: 0, visibleFaqCap: 5,
    });
    assert.equal(result.mode, 'visible');
    assert.equal(result.source, 'deterministic');
  });

  // Regression: qa-content renders its own visible accordion (same
  // ACCORDION_KEYWORD_PATTERN markup as a dedicated FAQ block) but used to
  // skip this whole cap/dedup system entirely, always rendering visible —
  // confirmed live as a real duplicate-FAQ bug. It must now behave exactly
  // like 'faq' at every one of these decision points.
  test('qa-content is inspectable, same as faq', () => {
    assert.ok(INSPECTABLE_ACTION_TYPES.includes('qa-content'));
  });

  test('qa-content gets schema-only on strong existing-FAQ evidence, same as faq', async () => {
    const result = await inspectRenderMode('{% for item in faq %}{{ item.question }}{% endfor %}', 'qa-content', {
      visibleFaqCount: 0, visibleFaqCap: 5,
    });
    assert.equal(result.mode, 'schema-only');
    assert.equal(result.source, 'deterministic');
  });

  test('qa-content is subject to the sitewide visible-FAQ cap, same as faq', async () => {
    const result = await inspectRenderMode('<p>plain page</p>', 'qa-content', { visibleFaqCount: 5, visibleFaqCap: 5 });
    assert.equal(result.mode, 'schema-only');
    assert.equal(result.source, 'cap');
  });

  test('qa-content gets visible when no existing FAQ and cap not reached', async () => {
    const result = await inspectRenderMode('<p>Welcome to our homepage.</p>', 'qa-content', {
      visibleFaqCount: 0, visibleFaqCap: 5,
    });
    assert.equal(result.mode, 'visible');
    assert.equal(result.source, 'deterministic');
  });
});
