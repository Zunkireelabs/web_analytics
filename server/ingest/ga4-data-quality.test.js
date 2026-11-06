import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readReportMetadata, reconcileBreakdown, summarizeDataQuality } from './ga4-data-quality.js';

// The rule being enforced: a withheld, bucketed or sampled number must never be presented as an exact one. Nothing
// here changes a metric — it decides what the metric is worth, and says so in words a client can read.

describe('readReportMetadata', () => {
  test('a clean response says so', () => {
    assert.deepEqual(readReportMetadata({ metadata: {} }), {
      thresholded: false, otherRowPresent: false, sampled: false, samplingRatio: null, emptyReason: null,
    });
  });

  test('a response with no metadata at all is treated as clean, not as broken', () => {
    assert.equal(readReportMetadata({}).thresholded, false);
    assert.equal(readReportMetadata(null).sampled, false);
  });

  test("Google's own withholding flag is read", () => {
    assert.equal(readReportMetadata({ metadata: { subjectToThresholding: true } }).thresholded, true);
  });

  test('the (other) bucket flag is read', () => {
    assert.equal(readReportMetadata({ metadata: { dataLossFromOtherRow: true } }).otherRowPresent, true);
  });

  test('sampling is read with the share of events it used', () => {
    const meta = readReportMetadata({ metadata: { samplingMetadatas: [{ samplesReadCount: 250, samplingSpaceSize: 1000 }] } });
    assert.equal(meta.sampled, true);
    assert.equal(meta.samplingRatio, 0.25);
  });

  test('sampling with an unusable ratio stays null rather than reading as zero data', () => {
    const meta = readReportMetadata({ metadata: { samplingMetadatas: [{ samplesReadCount: 10, samplingSpaceSize: 0 }] } });
    assert.equal(meta.sampled, true);
    assert.equal(meta.samplingRatio, null);
  });
});

describe('reconcileBreakdown', () => {
  const rows = [{ sessions: 60 }, { sessions: 30 }];

  test('rows that account for the total reconcile', () => {
    const out = reconcileBreakdown([{ sessions: 70 }, { sessions: 30 }], 'sessions', 100);
    assert.equal(out.complete, true);
    assert.equal(out.shortfall, 0);
  });

  test('a shortfall is measured and reported as incomplete', () => {
    const out = reconcileBreakdown(rows, 'sessions', 100);
    assert.equal(out.summed, 90);
    assert.equal(out.shortfall, 10);
    assert.equal(out.shortfallRatio, 0.1);
    assert.equal(out.complete, false);
  });

  test('rounding noise within tolerance still reconciles', () => {
    assert.equal(reconcileBreakdown([{ sessions: 99 }], 'sessions', 100).complete, true);
  });

  test('nothing to compare against returns null — "cannot check" is not "reconciles"', () => {
    assert.equal(reconcileBreakdown(rows, 'sessions', 0), null);
    assert.equal(reconcileBreakdown(rows, 'sessions', null), null);
  });

  test('a day with a total but no rows is a full shortfall', () => {
    const out = reconcileBreakdown([], 'sessions', 100);
    assert.equal(out.shortfallRatio, 1);
    assert.equal(out.complete, false);
  });

  test('double counting across a dimension is not treated as a shortfall', () => {
    assert.equal(reconcileBreakdown([{ sessions: 120 }], 'sessions', 100).complete, true);
  });

  test('non-numeric row values are ignored rather than crashing', () => {
    const out = reconcileBreakdown([{ sessions: '40' }, { sessions: null }, {}], 'sessions', 100);
    assert.equal(out.summed, 40);
  });
});

describe('summarizeDataQuality', () => {
  const clean = { thresholded: false, otherRowPresent: false, sampled: false, samplingRatio: null };

  test('a clean day is complete and says nothing', () => {
    const out = summarizeDataQuality({ totalsMeta: clean, breakdowns: {} });
    assert.equal(out.confidence, 'complete');
    assert.deepEqual(out.notes, []);
  });

  test('sampling makes the whole day an estimate, including the totals', () => {
    const out = summarizeDataQuality({ totalsMeta: { ...clean, sampled: true, samplingRatio: 0.3 } });
    assert.equal(out.confidence, 'estimated');
    assert.match(out.notes[0], /sampled data/);
    assert.match(out.notes[0], /30% of events/);
  });

  test('withheld rows make the day partial and explain why in plain words', () => {
    const out = summarizeDataQuality({ totalsMeta: { ...clean, thresholded: true } });
    assert.equal(out.confidence, 'partial');
    assert.match(out.notes[0], /withheld some rows/);
    assert.match(out.notes[0], /Totals are still Google's own/);
  });

  test('a flag raised on a breakdown counts even when the totals look clean', () => {
    const out = summarizeDataQuality({
      totalsMeta: clean,
      breakdowns: { city: { meta: { ...clean, thresholded: true }, reconciliation: null } },
    });
    assert.equal(out.confidence, 'partial');
    assert.equal(out.flags.thresholded, true);
  });

  test('a breakdown that does not add up is named, with how much is missing', () => {
    const out = summarizeDataQuality({
      totalsMeta: clean,
      breakdowns: { country: { meta: clean, reconciliation: { complete: false, shortfallRatio: 0.25 } } },
    });
    assert.equal(out.confidence, 'partial');
    assert.deepEqual(out.flags.incompleteBreakdowns, [{ dimension: 'country', missingShare: 0.25 }]);
    assert.match(out.notes[0], /country breakdown accounts for 75%/);
  });

  test('the (other) bucket is explained as an incomplete list', () => {
    const out = summarizeDataQuality({ totalsMeta: { ...clean, otherRowPresent: true } });
    assert.match(out.notes[0], /grouped into "\(other\)"/);
    assert.equal(out.confidence, 'partial');
  });

  test('several problems are all reported, and sampling wins the verdict', () => {
    const out = summarizeDataQuality({
      totalsMeta: { ...clean, sampled: true, thresholded: true, otherRowPresent: true },
      breakdowns: { city: { meta: clean, reconciliation: { complete: false, shortfallRatio: 0.4 } } },
    });
    assert.equal(out.confidence, 'estimated');
    assert.equal(out.notes.length, 4);
  });

  test('the sampling ratio is kept on the verdict, so a period can say how sampled it was', () => {
    const out = summarizeDataQuality({ totalsMeta: { ...clean, sampled: true, samplingRatio: 0.25 } });
    assert.equal(out.samplingRatio, 0.25);
  });

  test('a day that was not sampled carries no ratio rather than a misleading zero', () => {
    assert.equal(summarizeDataQuality({ totalsMeta: clean }).samplingRatio, null);
  });

  test('a reconciled breakdown adds no note', () => {
    const out = summarizeDataQuality({
      totalsMeta: clean,
      breakdowns: { device: { meta: clean, reconciliation: { complete: true, shortfallRatio: 0 } } },
    });
    assert.equal(out.confidence, 'complete');
    assert.deepEqual(out.notes, []);
  });

  test('missing input does not throw', () => {
    assert.equal(summarizeDataQuality().confidence, 'complete');
    assert.equal(summarizeDataQuality({ breakdowns: { a: null } }).confidence, 'complete');
  });

  test('every note is a readable sentence, not a code', () => {
    const out = summarizeDataQuality({ totalsMeta: { ...clean, thresholded: true, sampled: true, samplingRatio: 0.5 } });
    for (const note of out.notes) {
      assert.ok(note.length > 30, note);
      assert.ok(/^[A-Z]/.test(note), note);
      assert.ok(note.endsWith('.'), note);
    }
  });
});
