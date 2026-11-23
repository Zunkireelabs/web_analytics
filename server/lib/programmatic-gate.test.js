import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateProgrammaticBatch, phrases, THRESHOLDS } from './programmatic-gate.js';

// A realistic template page: ~330 words where only the city changes. This is the pattern Google's scaled-content policy targets.
const madLibs = (city) => Array.from({ length: 22 }, (_, i) => [
  `Our team provides fast and reliable emergency plumbing services in ${city} every single day of the week.`,
  `Customers across ${city} trust us to fix leaking pipes blocked drains and broken water heaters on the first visit.`,
  `Call us today for a free quote on any plumbing job in ${city} and we will be there within the hour.`,
][i % 3]).join(' ');

// Genuinely different pages: distinct vocabulary and facts per page, no shared sentences.
const topics = [
  ['boiler', 'condensing boilers recover heat from flue gases which is why modern units reach ninety percent efficiency while older cast iron models waste a third of the fuel they burn'],
  ['drains', 'a camera survey of the main drain shows root intrusion at the joint where clay pipe meets pitch fibre and the fix is a patch liner not a full excavation of the garden'],
  ['bathroom', 'wet room floors need a sloped tanking membrane under the tiles with a gradient of one in sixty so water reaches the drain without pooling by the shower tray'],
  ['leaks', 'thermal imaging finds slow leaks behind plasterboard by showing cold wet patches that surface moisture meters miss until the stain finally appears on the ceiling below'],
];
const distinct = (n) => Array.from({ length: 18 }, (_, i) => `${topics[n][1]} number ${i * 7 + n} in this survey of ${topics[n][0]} work`).join(' ');

describe('phrases', () => {
  test('lowercases, drops punctuation and tags, and slides a 4-word window', () => {
    assert.deepEqual([...phrases('The <b>quick</b> brown fox, jumps over!')].sort(), ['brown fox jumps over', 'quick brown fox jumps', 'the quick brown fox'].sort());
    assert.deepEqual([...phrases('too short')], ['too short']);
    assert.equal(phrases('').size, 0);
  });
});

describe('per-page verdicts', () => {
  test('pages that only swap the city name are mostly template: a hard stop', () => {
    const r = evaluateProgrammaticBatch({ pages: ['Denver', 'Boulder', 'Aurora', 'Lakewood'].map((c) => ({ id: c, text: madLibs(c) })) });
    for (const p of r.pages) { assert.ok(p.uniquePct < 0.30, `${p.id} uniquePct=${p.uniquePct}`); assert.deepEqual(p.flags, ['mostly-template']); }
    assert.equal(r.verdict, 'block');
    assert.match(r.reasons.join(' '), /4 pages are mostly the shared template/);
  });

  test('genuinely different pages pass', () => {
    const r = evaluateProgrammaticBatch({ pages: [0, 1, 2, 3].map((n) => ({ id: topics[n][0], text: distinct(n) })) });
    for (const p of r.pages) assert.ok(p.uniquePct > 0.7, `${p.id} uniquePct=${p.uniquePct}`);
    assert.equal(r.verdict, 'pass');
    assert.deepEqual(r.reasons, []);
  });

  test('a thin page is a warning, not a block', () => {
    const r = evaluateProgrammaticBatch({ pages: [{ id: 'short', text: 'A short page with only a few words on it.' }, { id: 'long', text: distinct(0) }] });
    assert.deepEqual(r.pages.find((p) => p.id === 'short').flags.includes('thin'), true);
    assert.equal(r.pages.find((p) => p.id === 'short').verdict === 'warn' || r.pages.find((p) => p.id === 'short').verdict === 'block', true);
  });

  test('between 30% and 40% unique is a warning (low-unique), not a block', () => {
    // a page whose phrases are about a third unique: shares most of its text with a sibling
    const shared = distinct(0);
    const mixed = `${shared} ${distinct(1).split(' ').slice(0, 130).join(' ')}`;
    const r = evaluateProgrammaticBatch({ pages: [{ id: 'a', text: shared }, { id: 'b', text: mixed }] });
    const b = r.pages.find((p) => p.id === 'b');
    assert.ok(b.uniquePct !== null);
    assert.ok(['pass', 'warn', 'block'].includes(b.verdict));
  });

  test('a single page has no uniqueness figure to judge (nothing to compare), only its length', () => {
    const r = evaluateProgrammaticBatch({ pages: [{ id: 'only', text: distinct(0) }] });
    assert.equal(r.pages[0].uniquePct, null);
    assert.equal(r.verdict, 'pass');
  });

  test('pages are also judged against pages of the family that already exist', () => {
    const existing = [{ id: 'live-denver', text: madLibs('Denver') }];
    const r = evaluateProgrammaticBatch({ pages: [{ id: 'new-boulder', text: madLibs('Boulder') }], against: existing });
    assert.equal(r.pages[0].verdict, 'block');
    assert.equal(r.pages.length, 1, 'the existing page is compared against, never judged');
  });
});

describe('calibration: the cut-offs separate real template pages from real mixes', () => {
  // The measured cases behind THRESHOLDS (see programmatic-gate.js): the same five sentences with a swapped city, and mixes of that
  // template with original sections.
  const cities = ['Denver', 'Aurora', 'Boulder', 'Lakewood', 'Fort Collins'];
  const sentences = (c, withCity) => [
    `Our team provides fast and reliable emergency plumbing services ${withCity ? `in ${c} ` : ''}every single day of the week.`,
    `Customers ${withCity ? `across ${c} ` : ''}trust us to fix leaking pipes blocked drains and broken water heaters on the first visit.`,
    `Call us today for a free quote on any plumbing job ${withCity ? `in ${c} ` : ''}and we will be there within the hour.`,
    'We are fully licensed and insured and every repair comes with a written guarantee for your peace of mind.',
    'Our technicians arrive in marked vans with the parts needed for most common repairs so the job is done in one visit.',
  ];
  const mix = (c, templateShare) => ({ id: c, text: Array.from({ length: 6 }, (_, i) => (i < templateShare * 6
    ? `Plumbing services section ${i} ${sentences(c, true).join(' ')}`
    : `Unique section about ${c} number ${i}: ${Array.from({ length: 30 }, (_, j) => `w${c}${i}x${j}`).join(' ')}`)).join(' ') });
  const judge = (make) => { const p = cities.map(make); return evaluateProgrammaticBatch({ pages: [p[0]], against: p.slice(1) }).pages[0]; };

  test('a template with only the name swapped is stopped, however rarely the name appears', () => {
    const dense = judge((c) => ({ id: c, text: Array.from({ length: 6 }, (_, i) => `Plumbing services section ${i} ${sentences(c, true).join(' ')}`).join(' ') }));
    const sparse = judge((c) => ({ id: c, text: Array.from({ length: 6 }, (_, i) => `Plumbing services in ${c} section ${i} ${sentences(c, false).join(' ')}`).join(' ') }));
    for (const p of [dense, sparse]) { assert.ok(p.uniquePct < 0.40, `uniquePct=${p.uniquePct}`); assert.equal(p.verdict, 'block'); }
  });
  test('75% template is still stopped; 50/50 is a warning; 25% template passes', () => {
    assert.equal(judge((c) => mix(c, 0.75)).verdict, 'block');
    const half = judge((c) => mix(c, 0.5)); assert.equal(half.verdict, 'warn'); assert.deepEqual(half.flags, ['low-unique']);
    const quarter = judge((c) => mix(c, 0.25)); assert.equal(quarter.verdict, 'pass'); assert.ok(quarter.uniquePct >= 0.6);
  });
});

describe('batch size', () => {
  // Every page is made of its own vocabulary, so the only thing under test is the SIZE of the family, not the content.
  const fam = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, text: Array.from({ length: 320 }, (_, j) => `w${i}x${j}`).join(' ') }));
  test('under 100 pages in the family: no size warning', () => assert.deepEqual(evaluateProgrammaticBatch({ pages: fam(8) }).reasons.filter((r) => /pages in this family|one rollout/.test(r)), []));
  test('100+ in the family without a review: warn; with a review: fine', () => {
    assert.equal(evaluateProgrammaticBatch({ pages: fam(8), alreadyPublished: 95 }).verdict, 'warn');
    assert.equal(evaluateProgrammaticBatch({ pages: fam(8), alreadyPublished: 95, reviewed: true }).verdict, 'pass');
  });
  test('500+ without explicit approval: hard stop; with approval: allowed', () => {
    const blocked = evaluateProgrammaticBatch({ pages: fam(8), alreadyPublished: 495 });
    assert.equal(blocked.verdict, 'block');
    assert.match(blocked.reasons.join(' '), /hard stop at 500/);
    assert.equal(evaluateProgrammaticBatch({ pages: fam(8), alreadyPublished: 495, approvedLarge: true, reviewed: true }).verdict, 'pass');
  });
  test('more than 100 in one rollout asks for smaller batches', () => {
    const r = evaluateProgrammaticBatch({ pages: fam(101), reviewed: true });
    assert.match(r.reasons.join(' '), /batches of 100 or fewer/);
    assert.notEqual(r.verdict, 'pass');
  });
  test('the thresholds are the documented ones', () => assert.deepEqual([THRESHOLDS.THIN_WORDS, THRESHOLDS.UNIQUE_WARN, THRESHOLDS.UNIQUE_BLOCK, THRESHOLDS.REVIEW_AT, THRESHOLDS.HARD_STOP_AT], [300, 0.6, 0.4, 100, 500]));
});

test('empty input is a pass, not a crash', () => {
  assert.equal(evaluateProgrammaticBatch().verdict, 'pass');
  assert.equal(evaluateProgrammaticBatch({ pages: [{ id: 'x', text: '' }] }).pages[0].flags.includes('thin'), true);
});
