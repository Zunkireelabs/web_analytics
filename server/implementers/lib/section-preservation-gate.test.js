import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractStructuralLandmarks, findRemovedSections, validateSectionPreservation,
  REMOVAL_PERMITTED_ACTION_TYPES,
} from './section-preservation-gate.js';

// A realistic client page: chrome, three real sections, an anchor, a partial.
const LIVE_PAGE = `
<header class="site-header"><nav id="main-nav">...</nav></header>
<main>
  <section id="hero" class="py-20"><h1>Study Abroad</h1></section>
  <section id="services" class="py-16"><h2>What we do</h2><p>Copy.</p></section>
  <section id="faq" class="py-16">
    <!-- SEOAI:FAQ:START -->
    <dl><dt>Q?</dt><dd>A.</dd></dl>
    <!-- SEOAI:FAQ:END -->
  </section>
  {% include "components/cta.njk" %}
</main>
<footer class="site-footer">...</footer>
`;

describe('extractStructuralLandmarks', () => {
  test('counts real structural containers and names anchor ids', () => {
    const l = extractStructuralLandmarks(LIVE_PAGE);
    assert.equal(l.tags.section, 3);
    assert.equal(l.tags.header, 1);
    assert.equal(l.tags.footer, 1);
    assert.equal(l.tags.nav, 1);
    assert.equal(l.tags.main, 1);
    assert.deepEqual([...l.ids].sort(), ['faq', 'hero', 'main-nav', 'services']);
    assert.equal(l.includes['nunjucks/liquid include'], 1);
  });

  test('markup inside an HTML comment is not live structure', () => {
    // Tidying up already-dead markup must not read as deleting a section.
    const withDead = `${LIVE_PAGE}\n<!-- <section id="old-promo">retired</section> -->`;
    const l = extractStructuralLandmarks(withDead);
    assert.equal(l.tags.section, 3, 'the commented-out one is not counted');
    assert.ok(!l.ids.has('old-promo'));
  });
});

describe('findRemovedSections — what a real break looks like', () => {
  test('a dropped <section> is caught, and named', () => {
    const after = LIVE_PAGE.replace(/<section id="services"[\s\S]*?<\/section>/, '');
    const losses = findRemovedSections(LIVE_PAGE, after);
    assert.ok(losses.some((l) => /<section> element\(s\) removed \(3 → 2\)/.test(l)));
    assert.ok(losses.some((l) => /#services/.test(l)), 'the anchor loss is reported by name');
  });

  test('a dropped template include is caught even though no tag count changes', () => {
    const after = LIVE_PAGE.replace('{% include "components/cta.njk" %}', '');
    const losses = findRemovedSections(LIVE_PAGE, after);
    assert.equal(losses.length, 1);
    assert.match(losses[0], /nunjucks\/liquid include\(s\) removed \(1 → 0\)/);
  });

  test('the whole page being replaced by a generic flat one is caught', () => {
    // CLAUDE.md §5's "flat/generic" failure, as it actually arrives: valid
    // markup that simply is not this site's page any more.
    const flat = '<main><h1>Study Abroad</h1><p>Some text.</p><dl><dt>Q?</dt><dd>A.</dd></dl></main>';
    const losses = findRemovedSections(LIVE_PAGE, flat);
    assert.ok(losses.length >= 4, 'sections, header, footer, nav and the includes all register as losses');
  });

  test('losing a footer or nav is a loss like any other', () => {
    const after = LIVE_PAGE.replace(/<footer[\s\S]*?<\/footer>/, '');
    assert.ok(findRemovedSections(LIVE_PAGE, after).some((l) => /<footer>/.test(l)));
  });
});

describe('findRemovedSections — what it must NEVER block', () => {
  test('ADDING a section is always fine', () => {
    const after = LIVE_PAGE.replace('</main>', '<section id="new-faq">added</section></main>');
    assert.deepEqual(findRemovedSections(LIVE_PAGE, after), []);
  });

  test('rewriting the content inside a marker is fine — that is the whole job', () => {
    const after = LIVE_PAGE.replace(
      '<dl><dt>Q?</dt><dd>A.</dd></dl>',
      '<dl><dt>A much better question?</dt><dd>A much longer, freshly generated answer.</dd>'
      + '<dt>A second question?</dt><dd>Another answer.</dd></dl>',
    );
    assert.deepEqual(findRemovedSections(LIVE_PAGE, after), []);
  });

  test('restyling — changing classes throughout — is fine', () => {
    const after = LIVE_PAGE.replace(/class="py-16"/g, 'class="py-12 md:py-20 bg-slate-50"');
    assert.deepEqual(findRemovedSections(LIVE_PAGE, after), []);
  });

  test('reformatting/whitespace changes are fine', () => {
    const after = LIVE_PAGE.replace(/\n\s*/g, '\n');
    assert.deepEqual(findRemovedSections(LIVE_PAGE, after), []);
  });
});

describe('validateSectionPreservation — the gate as pushDraftBranch calls it', () => {
  const site = { id: 1, repo_default_branch: 'main' };
  const fetchLive = async () => ({ content: LIVE_PAGE, sha: 'abc' });

  test('refuses a draft that would remove a live section, naming the file and the loss', async () => {
    const files = [{ path: 'src/pages/about.njk', content: LIVE_PAGE.replace(/<section id="services"[\s\S]*?<\/section>/, '') }];
    const result = await validateSectionPreservation(site, { action_type: 'faq' }, files, { fetchFile: fetchLive });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'section-removed');
    assert.equal(result.path, 'src/pages/about.njk');
    assert.match(result.error, /src\/pages\/about\.njk/);
    assert.match(result.error, /never take away a section/);
  });

  test('allows an ordinary additive FAQ draft', async () => {
    const files = [{ path: 'src/pages/about.njk', content: LIVE_PAGE.replace('<dt>Q?</dt><dd>A.</dd>', '<dt>Q?</dt><dd>A.</dd><dt>Q2?</dt><dd>A2.</dd>') }];
    const result = await validateSectionPreservation(site, { action_type: 'faq' }, files, { fetchFile: fetchLive });
    assert.deepEqual(result, { ok: true });
  });

  test('a brand-new page has no before-state to preserve', async () => {
    const files = [{ path: 'src/pages/new-landing.njk', content: '<main><section>New</section></main>' }];
    const result = await validateSectionPreservation(site, { action_type: 'landing-page' }, files, { fetchFile: async () => null });
    assert.deepEqual(result, { ok: true });
  });

  test('fails OPEN when the base file cannot be read — an infra failure is not evidence of deletion', async () => {
    const files = [{ path: 'src/pages/about.njk', content: '<main></main>' }];
    const result = await validateSectionPreservation(site, { action_type: 'faq' }, files, {
      fetchFile: async () => { throw new Error('502 from GitHub'); },
    });
    assert.deepEqual(result, { ok: true });
  });

  test('a removal-purpose action type is exempt — removing IS its job', async () => {
    // content-integrity-repair's duplicate-faq/malformed-table fixTypes exist
    // precisely to delete markup; gating them would break the repair that
    // enforces visible_faq_cap.
    const files = [{ path: 'src/pages/about.njk', content: LIVE_PAGE.replace(/<section id="faq"[\s\S]*?<\/section>/, '') }];
    const result = await validateSectionPreservation(site, { action_type: 'content-integrity-repair' }, files, { fetchFile: fetchLive });
    assert.deepEqual(result, { ok: true });
    assert.ok(REMOVAL_PERMITTED_ACTION_TYPES.has('content-integrity-repair'));
  });

  test('checks every file in the batch, not just the first', async () => {
    const files = [
      { path: 'ok.njk', content: LIVE_PAGE },
      { path: 'broken.njk', content: LIVE_PAGE.replace(/<footer[\s\S]*?<\/footer>/, '') },
    ];
    const result = await validateSectionPreservation(site, { action_type: 'expand-content' }, files, { fetchFile: fetchLive });
    assert.equal(result.ok, false);
    assert.equal(result.path, 'broken.njk');
  });
});
