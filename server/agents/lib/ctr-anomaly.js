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

// Two-proportion z-test on clicks/impressions: is `a`'s CTR genuinely
// different from `b`'s, or is the gap what 2 extra clicks would do? Returns 0
// when there is nothing to test (no impressions on a side, or a pooled CTR of
// exactly 0 or 1).
export function twoProportionZ(clicksA, impressionsA, clicksB, impressionsB) {
  if (!(impressionsA > 0) || !(impressionsB > 0)) return 0;
  const pooled = (clicksA + clicksB) / (impressionsA + impressionsB);
  if (pooled <= 0 || pooled >= 1) return 0;
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / impressionsA + 1 / impressionsB));
  return se === 0 ? 0 : (clicksA / impressionsA - clicksB / impressionsB) / se;
}

// |z| a CTR gap must reach before it is called a deficit (~95% two-sided).
export const MIN_CTR_Z = 2;
// A CTR gap between rows ranking this many places apart is confounded by
// position — CTR falls steeply with rank, so "mobile CTR is low" can just be
// "mobile ranks lower". Site 8862 was called a 'confirmed defect' with mobile
// at position 28.9 vs 11.2 on desktop.
export const MAX_COMPARABLE_POSITION_GAP = 5;

/**
 * Significance- and position-aware replacement for flagLowCtr, for rows that
 * carry real `clicks` + `impressions` (+ optional `avgPosition`). Each row is
 * compared with the impression-weighted CTR of ALL THE OTHER rows (never an
 * unweighted mean of rows, which gives a 40-impression row the same say as a
 * 40,000-impression one), and is flagged only when
 *   - it is thresholdPct+ below that pooled baseline,
 *   - the gap clears a two-proportion z-test (|z| >= MIN_CTR_Z), and
 *   - the row ranks no more than MAX_COMPARABLE_POSITION_GAP places worse than the baseline
 *     (impression-weighted position of the others) — otherwise the deficit is
 *     confounded by ranking and the row is ABSTAINED on, returned in
 *     `confounded` so the caller can say so instead of asserting a defect.
 * Returns { flagged, confounded }; `flagged` rows keep the same
 * ctrDeviationPct shape flagLowCtr produced.
 */
export function flagLowCtrSignificant(rows, { thresholdPct = 20, minImpressions = MIN_IMPRESSIONS_FOR_CTR, minZ = MIN_CTR_Z, maxPositionGap = MAX_COMPARABLE_POSITION_GAP } = {}) {
  const usable = rows.filter((r) => Number(r.impressions || 0) >= minImpressions && r.clicks != null);
  const flagged = [];
  const confounded = [];
  if (usable.length < 2) return { flagged, confounded };
  for (const row of usable) {
    const others = usable.filter((o) => o !== row);
    const oClicks = others.reduce((s, o) => s + Number(o.clicks), 0);
    const oImpr = others.reduce((s, o) => s + Number(o.impressions), 0);
    if (oImpr <= 0 || oClicks <= 0) continue;
    const baseline = oClicks / oImpr;
    const ctr = Number(row.clicks) / Number(row.impressions);
    const deviationPct = Math.round(((ctr - baseline) / baseline) * 1000) / 10;
    if (deviationPct > -thresholdPct) continue;
    const z = twoProportionZ(Number(row.clicks), Number(row.impressions), oClicks, oImpr);
    if (Math.abs(z) < minZ) continue;
    const out = { ...row, ctr, ctrDeviationPct: deviationPct, ctrZ: Math.round(z * 100) / 100, baselineCtr: baseline };
    const posRows = others.filter((o) => o.avgPosition != null);
    const posImpr = posRows.reduce((s, o) => s + Number(o.impressions), 0);
    if (row.avgPosition != null && posImpr > 0) {
      const baselinePosition = posRows.reduce((s, o) => s + Number(o.avgPosition) * Number(o.impressions), 0) / posImpr;
      out.baselinePosition = Math.round(baselinePosition * 10) / 10;
      // Only a WORSE rank explains a lower CTR; a row ranking better yet
      // converting worse is not confounded by position.
      if (Number(row.avgPosition) - baselinePosition > maxPositionGap) { confounded.push(out); continue; }
    }
    flagged.push(out);
  }
  flagged.sort((a, b) => a.ctrDeviationPct - b.ctrDeviationPct);
  return { flagged, confounded };
}
