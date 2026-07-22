// Flags rows whose given numeric field is significantly below the group's
// own mean for that field — a relative comparison across this site's real
// data, never an external/invented benchmark. Generalized from the original
// CTR-only version (flagLowCtr below, kept for its two existing callers)
// so internal-linking.js can apply the exact same "relative to this site's
// own average" philosophy to internalLinkCount instead of reimplementing it.
export function flagBelowAverage(rows, field, { thresholdPct = 20 } = {}) {
  const withField = rows.filter((r) => r[field] != null);
  if (!withField.length) return [];
  const mean = withField.reduce((s, r) => s + r[field], 0) / withField.length;
  if (mean <= 0) return [];
  const deviationKey = `${field}DeviationPct`;
  return withField
    .map((r) => ({ ...r, [deviationKey]: Math.round(((r[field] - mean) / mean) * 1000) / 10 }))
    .filter((r) => r[deviationKey] <= -thresholdPct)
    .sort((a, b) => a[deviationKey] - b[deviationKey]);
}

// Shared by Country Intelligence (countries) and Device Intelligence
// (devices), same shape either way: rows with a numeric `ctr` field,
// returned with the low ones sorted worst-first.
export function flagLowCtr(rows, opts) {
  return flagBelowAverage(rows, 'ctr', opts);
}
