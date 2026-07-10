// Flags rows whose CTR is significantly below the group's own mean CTR — a
// relative comparison across this site's real data, never an external/
// invented industry benchmark. Shared by Country Intelligence (countries)
// and Device Intelligence (devices), same shape either way: rows with a
// numeric `ctr` field, returned with the low ones sorted worst-first.
export function flagLowCtr(rows, { thresholdPct = 20 } = {}) {
  const withCtr = rows.filter((r) => r.ctr != null);
  if (!withCtr.length) return [];
  const meanCtr = withCtr.reduce((s, r) => s + r.ctr, 0) / withCtr.length;
  if (meanCtr <= 0) return [];
  return withCtr
    .map((r) => ({ ...r, ctrDeviationPct: Math.round(((r.ctr - meanCtr) / meanCtr) * 1000) / 10 }))
    .filter((r) => r.ctrDeviationPct <= -thresholdPct)
    .sort((a, b) => a.ctrDeviationPct - b.ctrDeviationPct);
}
