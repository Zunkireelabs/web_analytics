import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { assessDesignCompleteness, artifactsFor, isDesignGateFailClosed, describeBlocks } from './design-completeness.js';

const full = () => ({
  typography: { body: 'b', heading: { item: 'hi', section: 'hs' } },
  layout: { container: 'c', prose: 'p' },
  spacing: { section: 's' },
  components: { accordion: { trigger: 't', panel: 'p' }, card: { wrapper: 'w' }, table: { x: 1 }, button: { primary: 'btn' } },
});

describe('artifactsFor', () => {
  test('metadata-only actions render no styled copy and need nothing', () => {
    assert.deepEqual(artifactsFor('meta-title'), []);
  });
  test('a missing-page that resolved to an article needs the article fields', () => {
    assert.deepEqual(artifactsFor('missing-page', 'inline-article'), ['inline-article']);
    assert.deepEqual(artifactsFor('missing-page', 'section-page'), ['section-page']);
  });
});

describe('assessDesignCompleteness', () => {
  test('a technical action is complete without looking at the profile at all', () => {
    assert.equal(assessDesignCompleteness(null, { actionType: 'meta-title' }).ok, true);
  });

  test('a complete profile is complete', () => {
    const out = assessDesignCompleteness(full(), { actionType: 'landing-page' });
    assert.equal(out.tier, 'complete');
    assert.deepEqual(out.blocks, []);
  });

  test('no profile at all blocks, and is repairable by re-deriving', () => {
    const out = assessDesignCompleteness(null, { actionType: 'blog-outline' });
    assert.equal(out.ok, false);
    assert.equal(out.tier, 'thin');
    assert.equal(out.repairable, true);
    assert.equal(out.blocks[0].reason, 'no-design-profile');
  });

  test('a missing heading.section is DERIVED from heading.item, not blocked', () => {
    // The owner's rule: never call a design thin when the site's own language fills it in.
    const p = full();
    delete p.typography.heading.section;
    const out = assessDesignCompleteness(p, { actionType: 'blog-outline' });
    assert.equal(out.ok, true);
    assert.equal(out.tier, 'partial');
    assert.deepEqual(out.derived.map((d) => d.field), ['typography.heading.section']);
  });

  test('a missing prose width falls back to the container', () => {
    const p = full();
    delete p.layout.prose;
    assert.equal(assessDesignCompleteness(p, { actionType: 'blog-outline' }).tier, 'partial');
  });

  test('no prose width AND no container cannot be derived, so it blocks', () => {
    const p = full();
    delete p.layout.prose; delete p.layout.container;
    const out = assessDesignCompleteness(p, { actionType: 'blog-outline' });
    assert.equal(out.ok, false);
    assert.equal(out.blocks[0].field, 'layout.prose');
  });

  test("a card the site has never shown is NOT invented — expand-content blocks", () => {
    const p = full();
    delete p.components.card;
    const out = assessDesignCompleteness(p, { actionType: 'expand-content' });
    assert.equal(out.ok, false);
    assert.equal(out.blocks[0].field, 'components.card');
    assert.equal(out.repairable, false);
  });

  test('a missing accordion falls back to the definition list the projector already uses', () => {
    const p = full();
    delete p.components.accordion;
    assert.equal(assessDesignCompleteness(p, { actionType: 'faq' }).tier, 'partial');
  });

  test('a section page needs spacing.section, which cannot be derived', () => {
    const p = full();
    delete p.spacing.section;
    assert.equal(assessDesignCompleteness(p, { actionType: 'landing-page' }).blocks[0].field, 'spacing.section');
  });

  test('only the fields THIS artifact renders matter', () => {
    const p = full();
    delete p.components.card; delete p.spacing.section;
    assert.equal(assessDesignCompleteness(p, { actionType: 'blog-outline' }).ok, true);
  });

  test('a contradicted profile blocks and is repairable', () => {
    const out = assessDesignCompleteness(full(), { actionType: 'landing-page', roleCheck: { ok: false, field: 'typography.body', reason: 'role-mismatch' } });
    assert.equal(out.ok, false);
    assert.equal(out.repairable, true);
  });

  test('a stale profile blocks', () => {
    assert.equal(assessDesignCompleteness(full(), { actionType: 'landing-page', stale: true }).blocks[0].reason, 'stale-profile');
  });

  test('inline-prose mode blocks article drafts only once required, never by default', () => {
    assert.equal(assessDesignCompleteness(full(), { actionType: 'blog-outline' }).ok, true);
    const strict = assessDesignCompleteness(full(), { actionType: 'blog-outline', requireInlineProseMode: true });
    assert.equal(strict.blocks[0].reason, 'inline-prose-mode-unresolved');
    assert.equal(assessDesignCompleteness(full(), { actionType: 'blog-outline', requireInlineProseMode: true, inlineProse: 'layout' }).ok, true);
    // not an article, not affected
    assert.equal(assessDesignCompleteness(full(), { actionType: 'landing-page', requireInlineProseMode: true }).ok, true);
  });
});

test('flag and description helpers', () => {
  assert.equal(isDesignGateFailClosed({}), false);
  assert.equal(isDesignGateFailClosed({ DESIGN_GATE_FAIL_CLOSED: 'true' }), true);
  assert.match(describeBlocks({ blocks: [{ field: 'a', reason: 'r', detail: 'd' }] }), /a: r \(d\)/);
});
