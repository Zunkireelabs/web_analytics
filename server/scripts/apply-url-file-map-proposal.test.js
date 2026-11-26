import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { planProposal, checkGuards, PROPOSAL_DIR, ALLOWED_SITES } from './apply-url-file-map-proposal.js';

const load = (f) => JSON.parse(fs.readFileSync(path.join(PROPOSAL_DIR, f), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));

describe('planProposal — Zunkiree (site 1)', () => {
  const base = load('base-1.json'); const proposed = load('zunkiree-1-proposed-map.json');

  test('against the map it was written for, it renames services->solutions, drops the 4 dead products and adds the FAQ pattern', () => {
    const { conflicts, summary, merged } = planProposal(base, clone(base), proposed);
    assert.deepEqual(conflicts, []);
    assert.equal(summary.pagesAdded.length, 12);
    assert.equal(summary.pagesRemoved.length, 15);
    assert.deepEqual(summary.pagesChanged, ['/']);
    assert.equal(summary.patternsAfter, summary.patternsBefore + 1);
    assert.equal(merged.pages['/'].file, 'src/pages/homepage-v2.njk');
    assert.ok(merged.pages['/solutions/'].adapters.faq);
    assert.ok(!('/industries/real-estate/' in merged.pages), 'real-estate stays unmapped on purpose');
    assert.ok(merged.patterns.some((p) => p.match === '^/products/(orca|search|ai-crm)/?$'));
  });

  test("someone else's unrelated change made after the proposal is KEPT, not overwritten", () => {
    const current = clone(base); current.pages['/about'].file = 'src/pages/about-us.njk'; current._rev = 99;
    const { conflicts, merged } = planProposal(base, current, proposed);
    assert.deepEqual(conflicts, []);
    assert.equal(merged.pages['/about'].file, 'src/pages/about-us.njk');
    assert.equal(merged.pages['/solutions/'].file, 'src/pages/solutions.njk');
  });

  test('both sides changing the same key differently is a CONFLICT and nothing is guessed', () => {
    const current = clone(base); current.pages['/'].file = 'src/pages/other-home.njk';
    const { conflicts } = planProposal(base, current, proposed);
    assert.ok(conflicts.some((c) => c.includes('pages')), conflicts.join(','));
  });

  test('already applied -> noop (safe to re-run)', () => {
    const first = planProposal(base, clone(base), proposed).merged;
    assert.equal(planProposal(base, first, proposed).summary.noop, true);
  });
});

describe('planProposal — Admizz (site 8862)', () => {
  const base = load('base-8862.json');
  const p1 = load('admizz-8862-phase1-config-only-map.json'); const p2 = load('admizz-8862-phase2-needs-engine-map.json');

  test('phase 1 adds the own-folder pages and the FAQ/events adapters, removes nothing', () => {
    const { conflicts, summary, merged } = planProposal(base, clone(base), p1);
    assert.deepEqual(conflicts, []);
    assert.equal(summary.pagesAdded.length, 53);
    assert.equal(summary.pagesRemoved.length, 0);
    assert.equal(merged.pages['/study-in-south-korea-from-nepal'].file, 'src/app/study-in-south-korea-from-nepal/page.tsx');
    assert.ok(merged.pages['/events/uk-education-expo-oct-2026'].adapters['meta-title']);
    assert.equal(merged.pages['/study-in-canada'].adapters.faq.id, 'page-data-object');
  });

  test('phase 2 adds the {...post} FAQ adapters and the /answers/* pattern adapter on top of phase 1', () => {
    const afterP1 = planProposal(base, clone(base), p1).merged;
    const { conflicts, merged } = planProposal(base, afterP1, p2);
    assert.deepEqual(conflicts, []);
    assert.equal(merged.pages['/uk-student-visa-cost-2027'].adapters.faq.id, 'page-data-object');
    assert.equal(merged.patterns[3].adapters.faq.id, 'page-data-object');
  });

  test('the three shared-template targets are never mapped by these proposals', () => {
    const { merged } = planProposal(base, clone(base), p2);
    for (const entry of Object.values(merged.pages)) assert.ok(!/\[slug\]|\[course\]|\[country\]/.test(entry.file || ''), entry.file);
  });
});

describe('planProposal ignores key order (the database re-orders keys inside each entry)', () => {
  test('an already-applied map whose entries have reordered keys is a noop, not "changed"', () => {
    const base = load('base-8862.json'); const p1 = load('admizz-8862-phase1-config-only-map.json');
    const applied = planProposal(base, clone(base), p1).merged;
    const reordered = clone(applied);
    for (const e of Object.values(reordered.pages)) if (e.adapters) e.adapters = Object.fromEntries(Object.entries(e.adapters).reverse());
    const plan = planProposal(base, reordered, p1);
    assert.deepEqual(plan.summary.pagesChanged, []);
    assert.equal(plan.summary.noop, true);
  });
});

describe('planProposal — Chayce (site 8864): one blog pattern', () => {
  const base = load('base-8864.json'); const proposed = load('chayce-8864-proposed-map.json');
  test('adds exactly one pattern and changes no page entry', () => {
    const { conflicts, summary, merged } = planProposal(base, clone(base), proposed);
    assert.deepEqual(conflicts, []);
    assert.deepEqual([summary.pagesAdded.length, summary.pagesRemoved.length, summary.pagesChanged.length], [0, 0, 0]);
    assert.equal(summary.patternsAfter, summary.patternsBefore + 1);
    assert.deepEqual(merged.patterns[merged.patterns.length - 1], { match: '^/blog/([^/]+)/?$', file: 'src/blog/$1.md' });
  });
  test('re-running after it is applied is a noop', () => {
    const first = planProposal(base, clone(base), proposed).merged;
    assert.equal(planProposal(base, first, proposed).summary.noop, true);
  });
});

describe('planProposal — Admizz phase 3 on top of the applied phase 2 (--base)', () => {
  const base = load('admizz-8862-phase2-needs-engine-map.json'); const proposed = load('admizz-8862-phase3-faq-more-pages-map.json');
  test('only adds faq adapters to existing entries; no page added or removed; faqSchemaOnly pages stay out', () => {
    const { conflicts, summary, merged } = planProposal(base, clone(base), proposed);
    assert.deepEqual(conflicts, []);
    assert.equal(summary.pagesAdded.length, 0);
    assert.equal(summary.pagesRemoved.length, 0);
    assert.ok(summary.pagesChanged.length > 0);
    for (const u of summary.pagesChanged) assert.equal(merged.pages[u].adapters.faq.id, 'page-data-object', u);
    for (const u of ['/chevening-scholarship-complete-guide-for-nepali-students', '/janakpur', '/birgunj']) assert.ok(!merged.pages[u].adapters?.faq, u);
  });
});

describe('planProposal — Admizz phase 4 (city data FAQ, on top of the applied phase 3)', () => {
  const base = load('admizz-8862-phase3-faq-more-pages-map.json'); const proposed = load('admizz-8862-phase4-city-data-faq-map.json');
  test('adds the dataFile FAQ adapter to exactly /birgunj and /janakpur and nothing else', () => {
    const { conflicts, summary, merged } = planProposal(base, clone(base), proposed);
    assert.deepEqual(conflicts, []);
    assert.deepEqual(summary.pagesChanged.sort(), ['/birgunj', '/janakpur']);
    assert.equal(summary.pagesAdded.length + summary.pagesRemoved.length, 0);
    for (const [u, c] of [['/birgunj', 'birgunj'], ['/janakpur', 'janakpur']]) {
      const a = merged.pages[u].adapters.faq;
      assert.deepEqual([a.id, a.dataFile, a.exportName, a.itemsPath, a.itemKeys.question, a.itemKeys.answer], ['page-data-object', `src/data/cities/${c}.ts`, `${c}Data`, ['faq', 'items'], 'q', 'a']);
      assert.ok(merged.pages[u].adapters['meta-title'], 'existing adapters are kept');
    }
  });
});

describe('planProposal — Chayce phase 2 (city actions, on top of the applied blog pattern)', () => {
  const base = load('chayce-8864-proposed-map.json'); const proposed = load('chayce-8864-phase2-city-actions-map.json');
  test('adds faq, internal-links, expand-content and qa-content adapters to the city pattern, and declares schema not applicable', () => {
    const { conflicts, summary, merged } = planProposal(base, clone(base), proposed);
    assert.deepEqual(conflicts, []);
    assert.equal(summary.pagesAdded.length + summary.pagesRemoved.length + summary.pagesChanged.length, 0, 'no page entry changes');
    const city = merged.patterns.find((p) => /elderly-removals-\(kettering/.test(p.match));
    assert.deepEqual(Object.keys(city.adapters).sort(), ['expand-content', 'faq', 'internal-links', 'meta-title', 'qa-content']);
    assert.deepEqual(city.adapters.faq.itemKeys, { question: 'q', answer: 'a' });
    assert.equal(city.adapters['internal-links'].itemsField, 'relatedPosts');
    assert.equal(merged.notApplicable.length, 2);
    assert.ok(merged.notApplicable.every((r) => r.reason && r.actions.length));
  });
  test('the existing meta-title adapter and the blog pattern are untouched', () => {
    const { merged } = planProposal(base, clone(base), proposed);
    const city = merged.patterns.find((p) => /elderly-removals-\(kettering/.test(p.match));
    assert.deepEqual(city.adapters['meta-title'], base.patterns.find((p) => /elderly-removals-\(kettering/.test(p.match)).adapters['meta-title']);
    assert.ok(merged.patterns.some((p) => p.match === '^/blog/([^/]+)/?$'));
  });
  test('it refuses to run before the engine is deployed', () => {
    assert.match(checkGuards({ site: 8864, proposalName: 'chayce-8864-phase2-city-actions-map.json', engineDeployed: false }), /engine change deployed/);
    assert.equal(checkGuards({ site: 8864, proposalName: 'chayce-8864-phase2-city-actions-map.json', engineDeployed: true }), null);
    // Zennly (8872) accepts only its Eleventy-source map proposal; no other site's proposal may be pointed at it, and its proposal may not be pointed at another site.
    assert.equal(checkGuards({ site: 8872, proposalName: 'zennly-8872-eleventy-source-map-proposed.json', engineDeployed: false }), null);
    assert.match(checkGuards({ site: 8872, proposalName: 'chayce-8864-proposed-map.json', engineDeployed: false }), /accepts only the zennly-8872-eleventy-source-map proposal/);
    assert.match(checkGuards({ site: 8872, proposalName: 'zennly-8872-areas-map-v2.json', engineDeployed: false }), /accepts only/);
    assert.match(checkGuards({ site: 8864, proposalName: 'zennly-8872-eleventy-source-map-proposed.json', engineDeployed: false }), /does not belong to site 8864/);
  });
});

describe('planProposal — Zunkiree phase 2 (industries pattern, on top of the applied phase 1)', () => {
  const base = load('zunkiree-1-proposed-map.json'); const proposed = load('zunkiree-1-phase2-industries-map.json');
  test('adds one industries pattern with five adapters and two schema declarations, and changes no page entry', () => {
    const { conflicts, summary, merged } = planProposal(base, clone(base), proposed);
    assert.deepEqual(conflicts, []);
    assert.equal(summary.pagesAdded.length + summary.pagesRemoved.length + summary.pagesChanged.length, 0);
    assert.equal(summary.patternsAfter, summary.patternsBefore + 1);
    const p = merged.patterns.find((x) => x.match === '^/industries/([^/]+)/?$');
    assert.deepEqual(Object.keys(p.adapters).sort(), ['expand-content', 'faq', 'internal-links', 'meta-title', 'qa-content']);
    assert.equal(p.adapters['internal-links'].itemsField, 'relatedPosts');
    assert.equal(p.adapters.faq.dataFile, 'src/_data/industries.js');
    assert.deepEqual(merged.notApplicable.map((r) => r.actions), [['schema'], ['schema']]);
    assert.ok(merged.notApplicable.every((r) => r.reason.length > 20));
  });
  test('refuses to run before the engine is deployed', () => {
    assert.match(checkGuards({ site: 1, proposalName: 'zunkiree-1-phase2-industries-map.json', engineDeployed: false }), /engine change deployed/);
    assert.equal(checkGuards({ site: 1, proposalName: 'zunkiree-1-phase2-industries-map.json', engineDeployed: true }), null);
  });
});

describe('planProposal — Admizz phase 5 (new-page targets), merged against the applied phase 3', () => {
  const base = load('admizz-8862-phase3-faq-more-pages-map.json'); const proposed = load('admizz-8862-phase5-targets-map.json');
  test('moves the blog and answer targets out of /blogs, removes the three stale targets and declares the hand-built types', () => {
    const { conflicts, merged } = planProposal(base, clone(base), proposed);
    assert.deepEqual(conflicts, []);
    const t = merged.newContentTargets;
    assert.equal(t['blog-outline'].dir, 'src/app');
    assert.equal(t['blog-outline'].urlPattern, '/{slug}');
    assert.deepEqual(t['blog-outline'].postContract.requiredContent, ['quickAnswer', 'faqItems', 'sources']);
    assert.equal(t['direct-answer'].dir, 'src/app/answers');
    assert.equal(t['direct-answer'].urlPattern, '/answers/{slug}');
    for (const k of ['landing-page', 'cookie-policy', 'terms-of-service']) assert.equal(k in t, false, k);
    assert.deepEqual(Object.keys(merged.newContentNotApplicable).sort(), ['cookie-policy', 'landing-page', 'privacy-policy', 'terms-of-service', 'translation']);
    assert.ok(Object.values(merged.newContentNotApplicable).every((r) => r.length > 20));
  });
  test('independent of phase 4: applying phase 4 first and then phase 5 gives both, with no conflict', () => {
    const p4 = load('admizz-8862-phase4-city-data-faq-map.json');
    const afterP4 = planProposal(base, clone(base), p4).merged;
    const { conflicts, merged } = planProposal(base, afterP4, proposed);
    assert.deepEqual(conflicts, []);
    assert.equal(merged.pages['/birgunj'].adapters.faq.dataFile, 'src/data/cities/birgunj.ts');
    assert.equal(merged.newContentTargets['blog-outline'].dir, 'src/app');
  });
  test('no page entry changes', () => {
    const { summary } = planProposal(base, clone(base), proposed);
    assert.equal(summary.pagesAdded.length + summary.pagesRemoved.length + summary.pagesChanged.length, 0);
  });
  test('refuses to run before the engine is deployed', () => {
    assert.match(checkGuards({ site: 8862, proposalName: 'admizz-8862-phase5-targets-map.json', engineDeployed: false }), /engine change deployed/);
  });
});

describe('checkGuards', () => {
  test('only sites 1, 8862, 8864, 8872 (its Eleventy-source proposal only) and 8874 (hold-back only) are allowed', () => {
    assert.deepEqual([...ALLOWED_SITES].sort((a, b) => a - b), [1, 8862, 8864, 8872, 8874]);
    assert.match(checkGuards({ site: 8871, proposalName: 'zunkiree-1-proposed-map.json' }), /not allowed/);
    assert.match(checkGuards({ site: 8872, proposalName: 'chayce-8864-proposed-map.json' }), /accepts only the zennly-8872-eleventy-source-map proposal/);
    assert.match(checkGuards({ site: 8873, proposalName: 'zennly-8872-eleventy-source-map-proposed.json' }), /not allowed/);
    assert.match(checkGuards({ site: 8874, proposalName: 'chayce-8864-proposed-map.json' }), /accepts only the mobilise-8874-section-order-off and mobilise-8874-blog-target/);
  });
  test('a proposal cannot be applied to the wrong site (multi-tenant isolation)', () => {
    assert.match(checkGuards({ site: 1, proposalName: 'admizz-8862-phase1-config-only-map.json' }), /does not belong to site 1/);
    assert.match(checkGuards({ site: 8862, proposalName: 'zunkiree-1-proposed-map.json' }), /does not belong to site 8862/);
  });
  test('a Chayce proposal only applies to site 8864, and other proposals not to 8864', () => {
    assert.equal(checkGuards({ site: 8864, proposalName: 'chayce-8864-proposed-map.json' }), null);
    assert.match(checkGuards({ site: 8864, proposalName: 'zunkiree-1-proposed-map.json' }), /does not belong to site 8864/);
    assert.match(checkGuards({ site: 1, proposalName: 'chayce-8864-proposed-map.json' }), /does not belong to site 1/);
  });
  test('phase 2 and phase 4 refuse without --engine-deployed', () => {
    assert.match(checkGuards({ site: 8862, proposalName: 'admizz-8862-phase4-city-data-faq-map.json', engineDeployed: false }), /engine change deployed/);
    assert.equal(checkGuards({ site: 8862, proposalName: 'admizz-8862-phase4-city-data-faq-map.json', engineDeployed: true }), null);
    assert.match(checkGuards({ site: 8862, proposalName: 'admizz-8862-phase2-needs-engine-map.json', engineDeployed: false }), /engine change deployed/);
    assert.equal(checkGuards({ site: 8862, proposalName: 'admizz-8862-phase2-needs-engine-map.json', engineDeployed: true }), null);
  });
  test('phase 1 and Zunkiree are allowed without the flag', () => {
    assert.equal(checkGuards({ site: 8862, proposalName: 'admizz-8862-phase1-config-only-map.json', engineDeployed: false }), null);
    assert.equal(checkGuards({ site: 1, proposalName: 'zunkiree-1-proposed-map.json', engineDeployed: false }), null);
  });
});

describe('site 8874 (MOBILISE): only the section-order hold-back may be applied', () => {
  test('the hold-back proposal is accepted for 8874', () => {
    assert.equal(checkGuards({ site: 8874, proposalName: 'mobilise-8874-section-order-off-map.json', engineDeployed: false }), null);
  });
  test('any other proposal, for 8874 or from 8874 on another site, is refused', () => {
    assert.match(checkGuards({ site: 8874, proposalName: 'mobilise-8874-pages-map.json', engineDeployed: false }), /accepts only the mobilise-8874-section-order-off and mobilise-8874-blog-target/);
    assert.match(checkGuards({ site: 8874, proposalName: 'admizz-8862-proposed-map.json', engineDeployed: false }), /accepts only/);
    assert.match(checkGuards({ site: 8872, proposalName: 'mobilise-8874-section-order-off-map.json', engineDeployed: false }), /accepts only the zennly-8872-eleventy-source-map proposal/);
  });
  test('the proposal changes only siteRoot.sectionOrder', () => {
    const base = load('mobilise-8874-base-rev31.json'); const prop = load('mobilise-8874-section-order-off-map.json');
    const { conflicts, merged, summary } = planProposal(base, clone(base), prop);
    assert.deepEqual(conflicts, []);
    assert.equal(merged.siteRoot.sectionOrder, 'off');
    assert.equal(summary.pagesAdded.length + summary.pagesRemoved.length + summary.pagesChanged.length, 0);
    const strip = (m) => { const c = clone(m); delete c.siteRoot.sectionOrder; return JSON.stringify(c); };
    assert.equal(strip(merged), strip(base), 'nothing else differs from the live map');
  });
});

describe('MOBILISE blog target (clone-sibling): prepared change for new posts', () => {
  const base = () => load('mobilise-8874-blog-target-base-rev33.json'); const prop = () => load('mobilise-8874-blog-target-map.json');
  test('needs the engine deployed first, and is accepted for 8874 once it is', () => {
    assert.match(checkGuards({ site: 8874, proposalName: 'mobilise-8874-blog-target-map.json', engineDeployed: false }), /need the engine change deployed first/);
    assert.equal(checkGuards({ site: 8874, proposalName: 'mobilise-8874-blog-target-map.json', engineDeployed: true }), null);
  });
  test('changes only newContentTargets["blog-outline"], touching no page or pattern and no other target', () => {
    const { conflicts, merged, summary } = planProposal(base(), clone(base()), prop());
    assert.deepEqual(conflicts, []);
    assert.equal(merged.newContentTargets['blog-outline'].mode, 'clone-sibling');
    assert.equal(merged.newContentTargets['blog-outline'].referencePage, 'src/blog/ai-influencers-brand-marketing/index.njk');
    assert.equal(summary.pagesAdded.length + summary.pagesRemoved.length + summary.pagesChanged.length, 0);
    const strip = (m) => { const c = clone(m); delete c.newContentTargets['blog-outline']; return JSON.stringify(c); };
    assert.equal(strip(merged), strip(base()), 'nothing else differs from the live map');
  });
});
