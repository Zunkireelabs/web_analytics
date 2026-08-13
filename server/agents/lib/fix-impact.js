import {
  getDueImpactMeasurements, recordImpactOutcome, getPageSearchTotals, IMPACT_WINDOW_DAYS,
} from '../../store/fix-impact.js';

// Measures what a merged fix actually did to real Search Console numbers, which
// is the one thing this system has never checked about its own work. Every
// expectedImpact it produces (opportunity.js's estimatedTrafficGain,
// growth-projection.js's trajectories) is a forecast that has never been
// compared against an outcome.
//
// Sibling of fix-verification.js, answering a different question about the same
// merged draft: that module re-checks the live page 48h later to confirm the
// ISSUE is gone (correctness), this one compares 28 days of before/after search
// performance (impact). Both are due-driven sweeps over their own table rather
// than per-site loops, because due-ness is per-row.
//
// The house rule this module exists under: every number is computed in plain JS
// from real stored data, never asked of a model, and a window with no data
// reports insufficient-data rather than a fabricated zero.

// Days to skip immediately after the merge. A change needs to be crawled and
// re-indexed before its effect can appear at all, and the days either side of a
// deploy are the noisiest in the whole series — including them would measure
// the deploy, not the fix.
const SETTLE_DAYS = 3;

function isoDay(d) {
  return d.toISOString().slice(0, 10);
}

function shiftDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

// before = the WINDOW_DAYS ending the day before the merge.
// after  = the WINDOW_DAYS starting SETTLE_DAYS after the merge.
// Equal-length windows, so the comparison is not distorted by one side simply
// covering more days than the other.
export function measurementWindows(mergedAt, windowDays = IMPACT_WINDOW_DAYS) {
  const merged = new Date(mergedAt);
  const beforeEnd = shiftDays(merged, -1);
  const beforeStart = shiftDays(beforeEnd, -(windowDays - 1));
  const afterStart = shiftDays(merged, SETTLE_DAYS);
  const afterEnd = shiftDays(afterStart, windowDays - 1);
  return {
    before: { start: isoDay(beforeStart), end: isoDay(beforeEnd) },
    after: { start: isoDay(afterStart), end: isoDay(afterEnd) },
  };
}

function pctChange(before, after) {
  if (before == null || after == null || before === 0) return null;
  return Number((((after - before) / before) * 100).toFixed(1));
}

// Position is the one metric where LOWER is better, so its delta is reported as
// (before - after): a positive number means the page moved UP the results. Every
// other delta is (after - before). Getting this backwards is the classic bug in
// SEO reporting, hence the explicit naming below.
export function computeDelta(before, after) {
  return {
    clicks: after.clicks - before.clicks,
    clicksPct: pctChange(before.clicks, after.clicks),
    impressions: after.impressions - before.impressions,
    impressionsPct: pctChange(before.impressions, after.impressions),
    ctr: before.ctr == null || after.ctr == null ? null : Number((after.ctr - before.ctr).toFixed(5)),
    // Positive = improved (moved closer to position 1).
    avgPosition: before.avgPosition == null || after.avgPosition == null
      ? null
      : Number((before.avgPosition - after.avgPosition).toFixed(2)),
    basis: 'observed',
    // Carried in the stored row itself, not just in a doc comment, so anything
    // that renders this cannot present it as proof the fix caused the change.
    caveat: 'Observed change over equal before/after windows. Search performance moves for many reasons (seasonality, algorithm updates, competitors, other changes shipped in the same period) — this is correlation, not attribution.',
  };
}

export async function measureOne(row) {
  const windows = measurementWindows(row.merged_at);
  const [before, after] = await Promise.all([
    getPageSearchTotals(row.site_id, row.page_url, windows.before.start, windows.before.end),
    getPageSearchTotals(row.site_id, row.page_url, windows.after.start, windows.after.end),
  ]);

  // A page with no impressions before the fix has no baseline to compare
  // against, and one with none after may simply not have been re-crawled yet.
  // Either way there is no honest comparison to report — and reporting "+0%"
  // would read as "the fix did nothing", which is a different and unearned
  // claim.
  if (!before || !after) {
    return recordImpactOutcome(row.id, {
      status: 'insufficient-data',
      beforeWindow: before, afterWindow: after, delta: null,
    });
  }

  return recordImpactOutcome(row.id, {
    status: 'measured',
    beforeWindow: before, afterWindow: after, delta: computeDelta(before, after),
  });
}

// Due-driven sweep, mirroring fix-verification.js's runDueVerifications. One
// row's failure never stops the rest — a single page's bad read should not
// stall every other pending measurement behind it.
export async function runDueImpactMeasurements() {
  const due = await getDueImpactMeasurements();
  const results = [];
  for (const row of due) {
    try {
      const updated = await measureOne(row);
      results.push(updated);
      if (updated?.status === 'measured') {
        const d = updated.delta;
        console.log(`[fix-impact] site ${row.site_id} draft ${row.draft_id} (${row.generator_id}) ${row.page_url}: impressions ${d.impressions >= 0 ? '+' : ''}${d.impressions}, clicks ${d.clicks >= 0 ? '+' : ''}${d.clicks}, position ${d.avgPosition == null ? 'n/a' : (d.avgPosition >= 0 ? '+' : '') + d.avgPosition}`);
      }
    } catch (err) {
      console.error(`[fix-impact] could not measure draft ${row.draft_id} for site ${row.site_id}:`, err.message);
    }
  }
  if (results.length) console.log(`[fix-impact] measured ${results.filter((r) => r?.status === 'measured').length}/${due.length} due row(s)`);
  return results;
}
