import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeLayoutFingerprint } from './live-design-validation.js';
import { proposeFromSurvey, pickSamples, urlsFromSitemapXml, structuralDiff } from './design-resurvey.js';
import { approveProposal, rollbackLast, addProvisional, reviewStateOf } from './design-review-store.js';

const page = (blocks) => `<html><body><main>${blocks.map((c) => `<section class="${c}"><p>t</p></section>`).join('')}</main></body></html>`;
const POST = ['post-wrap mx-auto max-w-3xl', 'post-title text-4xl font-bold', 'post-body prose prose-lg', 'author-box flex gap-4'];
const FORM = ['form-hero bg-navy py-24', 'form-grid grid gap-8 cols-2', 'form-cta bg-gold px-8'];
const PRICING = ['price-hero p1 p2 p3', 'price-table t1 t2 t3', 'price-faq f1 f2 f3'];
const pg = (path, blocks) => ({ path, fp: computeLayoutFingerprint(page(blocks)) });
const saved = () => ({ revision: 2, groups: [
  { id: 'g1', sample: '/blog/a', members: ['/blog/a', '/blog/b'] },
  // the real Zunkiree shape: one saved group mixing three different layouts
  { id: 'g2', sample: '/schedule-a-call', members: ['/schedule-a-call', '/apply', '/pricing', '/pricing/teams'] },
] });
const survey = () => [
  pg('/blog/a', POST), pg('/blog/b', POST), pg('/blog/en-1', POST), pg('/blog/en-2', POST), pg('/nl/blog/x', POST),
  pg('/schedule-a-call', FORM), pg('/apply', FORM), pg('/pricing', PRICING), pg('/pricing/teams', PRICING),
  pg('/glossary/a', ['gl-a q1 q2 q3', 'gl-b q4 q5 q6']), pg('/glossary/b', ['gl-a q1 q2 q3', 'gl-b q4 q5 q6']),
];

describe('proposeFromSurvey', () => {
  const { proposals } = proposeFromSurvey(saved(), survey());
  test('a heterogeneous saved group is SPLIT along its real layouts, each part with its own sample', () => {
    const split = proposals.find((p) => p.kind === 'split-group' && p.groupId === 'g2');
    assert.ok(split);
    const parts = split.payload.parts.map((pt) => pt.members.sort());
    assert.deepEqual(parts.sort(), [['/apply', '/schedule-a-call'], ['/pricing', '/pricing/teams']]);
  });
  test('pages the old survey never saw (English and Dutch posts) are proposed as ONE batched join to the blog group', () => {
    const joins = proposals.filter((p) => p.kind === 'join');
    assert.equal(joins.length, 1);
    assert.equal(joins[0].groupId, 'g1');
    assert.deepEqual(joins[0].payload.members.sort(), ['/blog/en-1', '/blog/en-2', '/nl/blog/x']);
  });
  test('a layout no saved group has becomes ONE new-group proposal with all its pages', () => {
    const ng = proposals.filter((p) => p.kind === 'new-group');
    assert.equal(ng.length, 1); assert.deepEqual(ng[0].payload.members.sort(), ['/glossary/a', '/glossary/b']);
  });
  test('the saved map itself is never modified', () => {
    const map = saved(); const before = JSON.stringify(map);
    proposeFromSurvey(map, survey());
    assert.equal(JSON.stringify(map), before);
  });
});

describe('representative samples (B)', () => {
  test('several samples are chosen only when the pages really vary, and never a thin page', () => {
    const variant = [...POST, 'related grid grid-cols-3 extra-a extra-b extra-c'];
    const members = [pg('/b/1', POST), pg('/b/2', POST), pg('/b/3', variant), pg('/b/thin', ['x y'])];
    const samples = pickSamples(members).map((s) => s.path);
    assert.ok(samples.includes('/b/3'), 'the variant is represented');
    assert.ok(!samples.includes('/b/thin'), 'a thin page never represents a group');
    assert.equal(pickSamples([pg('/b/1', POST), pg('/b/2', POST)]).length, 1, 'identical pages need one sample');
  });
  test('structuralDiff shows a reviewer what each sample has that the other lacks', () => {
    const d = structuralDiff(pg('/a', POST).fp, pg('/b', [...POST, 'new-band nb1']).fp);
    assert.deepEqual(d.onlyInProposed.sort(), ['nb1', 'new-band']); assert.deepEqual(d.onlyInCurrent, []);
  });
});

describe('approving resurvey proposals is reversible', () => {
  const T = new Date('2026-11-07T12:00:00Z');
  const root = () => ({ designProfile: { pages: [], layoutGroups: saved() } });
  const entry = (path) => ({ url: `https://x.test${path}`, sections: [{ role: 'content', classes: 'c' }] });
  test('split -> rollback restores the original group exactly', () => {
    const { proposals } = proposeFromSurvey(saved(), survey());
    const split = proposals.find((p) => p.kind === 'split-group');
    for (const pt of split.payload.parts) pt.entries = [entry(pt.sample)];
    const r0 = root();
    const { state, id } = addProvisional(reviewStateOf(r0), { ...split, pageUrl: null, pagePath: `group:${split.groupId}` }, { baseRevision: 2, now: T });
    const after = approveProposal({ ...r0, designReview: state }, id, { by: 'R', expectedRevision: 2, now: T });
    const groups = after.designProfile.layoutGroups.groups;
    assert.equal(groups.find((g) => g.id === 'g2'), undefined, 'the mixed group is gone');
    assert.equal(groups.filter((g) => g.splitFrom === 'g2').length, 2);
    const back = rollbackLast(after, { by: 'R', expectedRevision: 3, now: T });
    assert.deepEqual(back.designProfile.layoutGroups.groups, saved().groups);
  });
  test('a split that would orphan a page is refused', () => {
    const r0 = root();
    const bad = { kind: 'split-group', groupId: 'g2', pagePath: 'group:g2', payload: { parts: [{ members: ['/apply'], sample: '/apply' }, { members: ['/pricing'], sample: '/pricing' }] } };
    const { state, id } = addProvisional(reviewStateOf(r0), bad, { baseRevision: 2, now: T });
    assert.throws(() => approveProposal({ ...r0, designReview: state }, id, { by: 'R', expectedRevision: 2, now: T }), (e) => e.code === 'bad-split');
  });
});

test('sitemap parsing returns page and nested sitemap URLs', () => {
  assert.deepEqual(urlsFromSitemapXml('<urlset><url><loc> https://x.test/a </loc></url><url><loc>https://x.test/s2.xml</loc></url></urlset>'), ['https://x.test/a', 'https://x.test/s2.xml']);
});
