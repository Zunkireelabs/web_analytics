// GA4 data quality: what Google withheld, sampled or bucketed, captured per report instead of ignored.
//
// GA4 does three things that quietly make a number smaller than reality, and none of them is an error we can fix —
// only one we can REPORT. Showing a withheld figure as if it were complete is how a dashboard ends up disagreeing
// with a client's own GA4 screen and losing their trust in every other number on the page.
//
//   1. THRESHOLDING. When a report could identify an individual (small audiences, or demographics/signals enabled),
//      Google withholds rows. The API says so in `metadata.subjectToThresholding`.
//   2. THE (other) ROW. Past a cardinality limit, GA4 collapses the tail into one `(other)` bucket, so a breakdown is
//      no longer a complete list. The API flags this as `metadata.dataLossFromOtherRow`.
//   3. SAMPLING. Large or complex reports may be estimated from a sample, reported in `metadata.samplingMetadatas`.
//
// Plus one check the API cannot do for us: a dimensioned report's rows should account for the undimensioned total.
// When they do not, something was withheld even if no flag was set — the same reconciliation discipline gsc.js
// already applies to its query rows.
//
// Nothing here changes a metric. It only records what the number is worth.

/** Google's own quality flags for one runReport response. */
export function readReportMetadata(response) {
  const meta = response?.metadata || {};
  const sampling = Array.isArray(meta.samplingMetadatas) ? meta.samplingMetadatas : [];
  return {
    // `subjectToThresholding` true means at least one row was withheld for privacy.
    thresholded: meta.subjectToThresholding === true,
    // `dataLossFromOtherRow` true means the tail was collapsed into (other), so a breakdown is incomplete.
    otherRowPresent: meta.dataLossFromOtherRow === true,
    sampled: sampling.length > 0,
    // The share of events the sample was drawn from, when sampled. Null when Google reported no sampling: an absent
    // ratio must not read as 0% of data used.
    samplingRatio: sampling.length ? samplingRatioOf(sampling[0]) : null,
    emptyReason: meta.emptyReason || null,
  };
}

function samplingRatioOf(entry) {
  const read = Number(entry?.samplesReadCount);
  const total = Number(entry?.samplingSpaceSize);
  if (!Number.isFinite(read) || !Number.isFinite(total) || total <= 0) return null;
  return Number(Math.min(read / total, 1).toFixed(4));
}

/**
 * Does a breakdown account for its own total?
 *
 * `rows` are the dimensioned rows, `metricKey` the field to add up, and `total` the same metric from the undimensioned
 * report. A shortfall means rows are missing — withheld, or swallowed by (other) — whether or not a flag said so.
 *
 * Returns null when there is nothing to compare (no total, or a zero total), because "we cannot check" is not the same
 * as "it reconciles".
 */
export function reconcileBreakdown(rows, metricKey, total, { tolerance = 0.02 } = {}) {
  if (!Number.isFinite(total) || total <= 0) return null;
  const summed = (rows || []).reduce((acc, r) => acc + (Number(r?.[metricKey]) || 0), 0);
  const shortfall = total - summed;
  const shortfallRatio = Number((shortfall / total).toFixed(4));
  return {
    total,
    summed,
    shortfall: Number(shortfall.toFixed(3)),
    shortfallRatio,
    // Above the tolerance the breakdown is genuinely incomplete and must not be presented as the whole picture.
    // A small negative is possible (a row can double-count across a dimension) and is not a shortfall.
    complete: shortfallRatio <= tolerance,
  };
}

/**
 * One honest verdict for a day's GA4 fetch, from Google's flags plus the reconciliation.
 *
 * `confidence`:
 *   'complete'    nothing withheld, nothing sampled, breakdowns account for their totals
 *   'partial'     something was withheld, bucketed or did not reconcile — the totals are still GA4's own numbers,
 *                 but a breakdown is not the full list
 *   'estimated'   the report was sampled, so even the totals are an estimate
 * `notes` are plain sentences a client can read, never jargon.
 */
export function summarizeDataQuality({ totalsMeta, breakdowns = {} } = {}) {
  const notes = [];
  const flags = {
    thresholded: !!totalsMeta?.thresholded,
    sampled: !!totalsMeta?.sampled,
    otherRowPresent: !!totalsMeta?.otherRowPresent,
    incompleteBreakdowns: [],
  };

  for (const [name, result] of Object.entries(breakdowns)) {
    if (!result) continue;
    if (result.meta?.thresholded) flags.thresholded = true;
    if (result.meta?.sampled) flags.sampled = true;
    if (result.meta?.otherRowPresent) flags.otherRowPresent = true;
    if (result.reconciliation && !result.reconciliation.complete) {
      flags.incompleteBreakdowns.push({
        dimension: name,
        missingShare: result.reconciliation.shortfallRatio,
      });
    }
  }

  if (flags.sampled) {
    const pct = totalsMeta?.samplingRatio != null ? ` (based on ${Math.round(totalsMeta.samplingRatio * 100)}% of events)` : '';
    notes.push(`Google returned sampled data for this day${pct}, so these figures are estimates rather than exact counts.`);
  }
  if (flags.thresholded) {
    notes.push('Google withheld some rows for this day to protect individual privacy, which happens when traffic is low or when demographics and signals are enabled. Totals are still Google\'s own; some breakdown rows are missing.');
  }
  if (flags.otherRowPresent) {
    notes.push('Some breakdown rows were grouped into "(other)" by Google because the dimension had too many distinct values, so that list is not complete.');
  }
  for (const b of flags.incompleteBreakdowns) {
    notes.push(`The ${b.dimension} breakdown accounts for ${Math.round((1 - b.missingShare) * 100)}% of the day's total; the rest was not returned by Google.`);
  }

  const confidence = flags.sampled
    ? 'estimated'
    : (flags.thresholded || flags.otherRowPresent || flags.incompleteBreakdowns.length ? 'partial' : 'complete');

  // The ratio travels with the verdict so a later reader can say HOW sampled a day was, not just that it was. Null
  // when nothing was sampled: an absent ratio must not read as "0% of events used".
  return { confidence, flags, notes, samplingRatio: flags.sampled ? (totalsMeta?.samplingRatio ?? null) : null };
}
