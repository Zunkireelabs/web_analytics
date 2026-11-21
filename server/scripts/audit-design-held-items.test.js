import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeReclassification, formatReclassification } from './audit-design-held-items.js';

const LAYOUT = 'This content breaks the page\'s layout at a real device width: 1 new undersized tap target(s) at 1440px (desktop).';
const SCHEMA = 'No malformed or duplicate structured data was found on this page.';
const SAMPLE = 'faq is held: this page\'s current design could not be confirmed against the live site (group-sample-unreachable). A stale design is not used; it will be retried automatically.';
const UNRELATED = 'Something nobody has seen before';
const OLD_RULE = 'pr_closed_without_merge';

const rows = [
  { site_id: 1, abandoned_reason: LAYOUT }, { site_id: 1, abandoned_reason: LAYOUT }, { site_id: 1, abandoned_reason: SCHEMA },
  { site_id: 2, abandoned_reason: SAMPLE }, { site_id: 2, abandoned_reason: UNRELATED }, { site_id: 2, apply_error: OLD_RULE },
];

test('counts every stored failure, and separates the ones whose meaning changes from the ones that do not', () => {
  const s = summarizeReclassification(rows);
  assert.equal(s.total, 6);
  assert.equal(s.changed, 4);
  assert.equal(s.unchanged, 2);
});

test('each change is reported as a before -> after transition with its count', () => {
  const s = summarizeReclassification(rows);
  const find = (to) => s.transitions.find((t) => t.to === to);
  assert.equal(find('needs_human').count, 2);
  assert.equal(find('needs_human').from, 'item_defect');
  assert.equal(find('already_resolved').count, 1);
  assert.equal(find('retry').count, 1);
});

test('every transition says what it meant before and what it means now, in plain words', () => {
  const t = summarizeReclassification(rows).transitions.find((x) => x.to === 'needs_human');
  assert.match(t.before, /counts toward retiring/);
  assert.match(t.after, /shown to a person/);
});

test('reasons are listed with counts and an example of the stored text', () => {
  const t = summarizeReclassification(rows).transitions.find((x) => x.to === 'needs_human');
  assert.equal(t.reasons[0].count, 2);
  assert.match(t.reasons[0].example, /undersized tap target/);
});

test('per-site totals say how many stop counting toward retiring the item', () => {
  const s = summarizeReclassification(rows);
  assert.deepEqual(s.bySite[1], { total: 3, changed: 3, noLongerCounted: 3 });
  assert.equal(s.bySite[2].changed, 1);
});

test('an unknown reason that stays an item defect, and a rule that already existed, are reported as UNCHANGED', () => {
  const s = summarizeReclassification([{ site_id: 1, abandoned_reason: UNRELATED }, { site_id: 1, apply_error: OLD_RULE }]);
  assert.equal(s.changed, 0);
  assert.equal(s.unchanged, 2);
  assert.deepEqual(s.transitions, []);
});

test('the printed report names the counts, transitions and sites', () => {
  const text = formatReclassification(summarizeReclassification(rows), { days: 30 });
  assert.match(text, /failed or held in the last 30 day\(s\): 6/);
  assert.match(text, /item_defect -> needs_human\s+x2/);
  assert.match(text, /site 1: 3\/3 changed, 3 no longer count/);
});

test('an empty or missing set is an empty summary, never a throw', () => {
  for (const input of [[], null, undefined]) {
    const s = summarizeReclassification(input);
    assert.equal(s.total, 0);
    assert.deepEqual(s.transitions, []);
  }
});
