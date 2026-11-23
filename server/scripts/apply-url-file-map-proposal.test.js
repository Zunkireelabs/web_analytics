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

describe('checkGuards', () => {
  test('only sites 1 and 8862 are allowed', () => {
    assert.deepEqual([...ALLOWED_SITES].sort(), [1, 8862]);
    assert.match(checkGuards({ site: 8864, proposalName: 'zunkiree-1-proposed-map.json' }), /not allowed/);
  });
  test('a proposal cannot be applied to the wrong site (multi-tenant isolation)', () => {
    assert.match(checkGuards({ site: 1, proposalName: 'admizz-8862-phase1-config-only-map.json' }), /does not belong to site 1/);
    assert.match(checkGuards({ site: 8862, proposalName: 'zunkiree-1-proposed-map.json' }), /does not belong to site 8862/);
  });
  test('phase 2 refuses without --engine-deployed', () => {
    assert.match(checkGuards({ site: 8862, proposalName: 'admizz-8862-phase2-needs-engine-map.json', engineDeployed: false }), /engine change deployed/);
    assert.equal(checkGuards({ site: 8862, proposalName: 'admizz-8862-phase2-needs-engine-map.json', engineDeployed: true }), null);
  });
  test('phase 1 and Zunkiree are allowed without the flag', () => {
    assert.equal(checkGuards({ site: 8862, proposalName: 'admizz-8862-phase1-config-only-map.json', engineDeployed: false }), null);
    assert.equal(checkGuards({ site: 1, proposalName: 'zunkiree-1-proposed-map.json', engineDeployed: false }), null);
  });
});
