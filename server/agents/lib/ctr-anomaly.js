// Flags rows whose given numeric field is significantly below the group's
// own mean for that field — a relative comparison across this site's real
// data, never an external/invented benchmark. Generalized from the original
// CTR-only version (flagLowCtr below, kept for its two existing callers)
// so internal-linking.js can apply the exact same "relative to this site's
// own average" philosophy to internalLinkCount instead of reimplementing it.
//
// `volumeField`/`minVolume` are the real-volume floor (off by default, since
// internal-linking.js's internalLinkCount rows have no volume dimension of
// their own and that caller already guards the baseline with its own
// MIN_PAGES_FOR_AVERAGE). When set, low-volume rows are dropped BEFORE the
// mean is taken, not just from the flagged output: a 3-impression row with a
// freak 100% CTR would otherwise pull the average up and push every real row
// "below average" — the noise has to be kept out of the baseline as well as
// out of the findings.
export function flagBelowAverage(rows, field, { thresholdPct = 20, volumeField = null, minVolume = 0 } = {}) {
  const withField = rows.filter((r) => r[field] != null
    && (!volumeField || Number(r[volumeField] || 0) >= minVolume));
  if (!withField.length) return [];
  const mean = withField.reduce((s, r) => s + r[field], 0) / withField.length;
  if (mean <= 0) return [];
  const deviationKey = `${field}DeviationPct`;
  return withField
    .map((r) => ({ ...r, [deviationKey]: Math.round(((r[field] - mean) / mean) * 1000) / 10 }))
    .filter((r) => r[deviationKey] <= -thresholdPct)
    .sort((a, b) => a[deviationKey] - b[deviationKey]);
}

// Real-search-demand floor for a CTR comparison. Without it this flagged any
// row more than thresholdPct below the mean with no volume qualification at
// all, and a device/country breakdown only ever has 2-3 rows — one of them is
// nearly always below the mean by arithmetic alone, so a small tenant got a
// "high priority" CTR finding driven entirely by 3-clicks-out-of-5 noise
// (2 clicks either way swings such a row's CTR by tens of percent). 100
// impressions is the point at which a 20% relative CTR gap is a property of
// the row rather than of one or two extra clicks landing on it. Same
// MIN_IMPRESSIONS convention opportunity.js / competitor-intelligence.js /
// llms-txt.js already use to keep a low-volume metric from driving a
// customer-facing claim — a country with 12 impressions is abstained on, not
// asserted about.
export const MIN_IMPRESSIONS_FOR_CTR = 100;

// Shared by Country Intelligence (countries) and Device Intelligence
// (devices), same shape either way: rows with a numeric `ctr` field and the
// real `impressions` behind it, returned with the low ones sorted worst-first.
export function flagLowCtr(rows, opts) {
  return flagBelowAverage(rows, 'ctr', {
    volumeField: 'impressions', minVolume: MIN_IMPRESSIONS_FOR_CTR, ...opts,
  });
}
