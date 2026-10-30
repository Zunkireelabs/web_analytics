import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkItems, tallyWork, CATALOGUE, STATUS } from './work-catalogue.js';

describe('buildWorkItems', () => {
  test('maps draft statuses to the four client-facing statuses and counts per type', () => {
    const items = buildWorkItems({
      drafts: [
        { action_type: 'faq', status: 'implemented' }, { action_type: 'faq', status: 'implemented' },
        { action_type: 'schema', status: 'pr_opened' },
        { action_type: 'alt-text', status: 'approved' },
      ],
    });
    const faq = items.find((i) => i.type === 'faq');
    assert.equal(faq.status, 'live');
    assert.equal(faq.count, 2);
    assert.equal(faq.did, 'We added question-and-answer sections to 2 pages.');
    assert.equal(items.find((i) => i.type === 'schema').status, 'waiting');
    assert.equal(items.find((i) => i.type === 'alt-text').status, 'prog');
  });

  test('uses singular wording for one page', () => {
    const [i] = buildWorkItems({ drafts: [{ action_type: 'meta-title', status: 'implemented' }] });
    assert.equal(i.did, 'We rewrote the search title and description on 1 page.');
  });

  test('leaves out work types with no standard wording and unmapped statuses', () => {
    const items = buildWorkItems({ drafts: [
      { action_type: 'mystery-type', status: 'implemented' },
      { action_type: 'faq', status: 'draft' },
      { action_type: 'faq', status: 'abandoned' },
    ] });
    assert.deepEqual(items, []);
  });

  test('schema-repair is reported as the same work as schema', () => {
    const items = buildWorkItems({ drafts: [
      { action_type: 'schema', status: 'implemented' }, { action_type: 'schema-repair', status: 'implemented' },
    ] });
    assert.equal(items.length, 1);
    assert.equal(items[0].count, 2);
  });

  test('planned comes from open recommendations, skips types already shown, and is capped', () => {
    const items = buildWorkItems({
      drafts: [{ action_type: 'faq', status: 'implemented' }],
      openRecs: [
        { recommendation_type: 'faq' }, { recommendation_type: 'alt-text' }, { recommendation_type: 'alt-text' },
        { recommendation_type: 'schema' }, { recommendation_type: 'landing-page' }, { recommendation_type: 'unknown' },
      ],
      maxPlanned: 2,
    });
    const planned = items.filter((i) => i.status === 'planned');
    assert.equal(planned.length, 2);
    assert.ok(!planned.some((p) => p.type === 'faq'));
    assert.equal(planned[0].type, 'alt-text');
    assert.match(planned[0].did, /^We will /);
  });

  test('manual items are included only with a valid status, and sorted after live ones correctly', () => {
    const items = buildWorkItems({
      drafts: [{ action_type: 'faq', status: 'implemented' }],
      manual: [
        { group: 'Trust', status: 'google', title: 'Clearing out your previous website', did: 'We submitted the removal.', why: 'x', next: 'Google decides.' },
        { group: 'Trust', status: 'nonsense', title: 'ignored', did: 'x', why: 'x' },
      ],
    });
    assert.equal(items.length, 2);
    assert.equal(items[0].status, 'live');
    assert.equal(items[1].status, 'google');
  });

  test('every catalogue entry has complete wording', () => {
    for (const [type, c] of Object.entries(CATALOGUE)) {
      assert.ok(c.group && c.title && c.why, type);
      assert.match(c.did(3), /^We /, type);
      assert.match(c.will(3), /^We will /, type);
    }
  });
});

describe('tallyWork', () => {
  test('counts each status', () => {
    const t = tallyWork([{ status: 'live' }, { status: 'live' }, { status: 'planned' }]);
    assert.deepEqual(t, { live: 2, waiting: 0, google: 0, prog: 0, planned: 1 });
    assert.ok(STATUS.google.label === 'WITH GOOGLE');
  });
});
