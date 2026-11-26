import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { wilsonInterval, trackRecordVerdict, loadTrackRecord, applyTrackRecord, MIN_MEASURED, TRACK_RECORD_POINTS } from './analyst-track-record.js';

const conclusion = (generatorId, score = 500) => ({ generatorId, score, scoreFactors: ['base'], subjectKey: `/${generatorId}`, direction: 'decline-risk' });
const records = (obj) => new Map(Object.entries(obj));

describe('trackRecordVerdict', () => {
  test('too few measured fixes is "none": no bonus, no penalty, and it says how many exist', () => {
    for (const measured of [0, 1, MIN_MEASURED - 1]) {
      const v = trackRecordVerdict({ measured, improved: measured });   // even a perfect record
      assert.equal(v.verdict, 'none');
      assert.equal(v.points, 0);
    }
    assert.match(trackRecordVerdict({ measured: 3, improved: 3 }).label, /only 3 measured/);
    assert.equal(trackRecordVerdict(undefined).verdict, 'none');
  });

  test('five out of five is NOT yet proven (the interval is still wide), twenty out of twenty is', () => {
    assert.equal(trackRecordVerdict({ measured: 5, improved: 5 }).verdict, 'proven');   // lower bound ~0.57 > 0.5
    assert.equal(trackRecordVerdict({ measured: 6, improved: 4 }).verdict, 'inconclusive');
    assert.equal(trackRecordVerdict({ measured: 20, improved: 18 }).verdict, 'proven');
  });

  test('a record that mostly fails is poor, once there is enough of it to be confident', () => {
    assert.equal(trackRecordVerdict({ measured: 20, improved: 3 }).verdict, 'poor');
    assert.equal(trackRecordVerdict({ measured: 20, improved: 3 }).points, -TRACK_RECORD_POINTS);
    assert.equal(trackRecordVerdict({ measured: 6, improved: 1 }).verdict, 'inconclusive');   // 1 of 6 is not yet conclusive
  });

  test('a mixed record is inconclusive and moves nothing', () => {
    const v = trackRecordVerdict({ measured: 20, improved: 10 });
    assert.deepEqual([v.verdict, v.points], ['inconclusive', 0]);
  });

  test('wilsonInterval: null with no data, ordered and within 0..1 otherwise', () => {
    assert.equal(wilsonInterval(0, 0), null);
    const { lower, upper } = wilsonInterval(8, 10);
    assert.ok(0 <= lower && lower < 0.8 && 0.8 < upper && upper <= 1);
  });
});

describe('applyTrackRecord re-ranks, one client at a time', () => {
  test('a proven lever for this client moves up, a poor one down, and the reason is recorded in the factors', () => {
    const out = applyTrackRecord(
      [conclusion('meta-title'), conclusion('expand-content'), conclusion('qa-content')],
      records({ 'meta-title': { measured: 20, improved: 18 }, 'expand-content': { measured: 20, improved: 2 }, 'qa-content': { measured: 2, improved: 2 } }),
    );
    const by = Object.fromEntries(out.map((c) => [c.generatorId, c]));
    assert.equal(by['meta-title'].score, 500 + TRACK_RECORD_POINTS);
    assert.equal(by['expand-content'].score, 500 - TRACK_RECORD_POINTS);
    assert.equal(by['qa-content'].score, 500, 'two measured fixes is not a record');
    assert.match(by['meta-title'].scoreFactors.at(-1), /improved clicks on this site in 18 of 20/);
    assert.equal(by['qa-content'].scoreFactors.length, 1, 'no factor is added when there is nothing to say');
    assert.deepEqual([by['meta-title'].trackRecord, by['expand-content'].trackRecord, by['qa-content'].trackRecord], ['proven', 'poor', 'none']);
  });

  test('a poor record only re-ranks: the conclusion is never dropped, and its verdict is untouched', () => {
    const [c] = applyTrackRecord([{ ...conclusion('expand-content'), verdict: 'act' }], records({ 'expand-content': { measured: 30, improved: 2 } }));
    assert.equal(c.verdict, 'act');
    assert.equal(typeof c.score, 'number');
  });

  test('no records at all (a new client, or a failed read) leaves every conclusion exactly as it was', () => {
    const input = [conclusion('meta-title'), { subjectKey: 'topic', direction: 'growth-opportunity', score: 7 }];
    const out = applyTrackRecord(input, new Map());
    assert.deepEqual(out.map((c) => c.score), [500, 7]);
  });

  test('it does not mutate its input', () => {
    const input = [conclusion('meta-title')];
    const copy = JSON.parse(JSON.stringify(input));
    applyTrackRecord(input, records({ 'meta-title': { measured: 20, improved: 18 } }));
    assert.deepEqual(input, copy);
  });
});

describe('loadTrackRecord', () => {
  test('reads one site and returns a per-generator map', async () => {
    let asked;
    const m = await loadTrackRecord(42, { read: async (id) => { asked = id; return [{ generator_id: 'meta-title', measured: '10', improved: '7' }]; } });
    assert.equal(asked, 42);
    assert.deepEqual(m.get('meta-title'), { measured: 10, improved: 7 });
  });

  test('a failed read never fails the run: it just means no adjustment', async () => {
    const m = await loadTrackRecord(42, { read: async () => { throw new Error('db down'); } });
    assert.equal(m.size, 0);
  });
});
