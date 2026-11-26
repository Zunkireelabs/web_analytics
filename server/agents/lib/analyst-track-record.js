// THIS CLIENT'S OWN TRACK RECORD decides how a fix kind is ranked, not a global assumption.
//
// Stage 5 sends every measured fix back to the Data Analyst; the same measurements already sit here, on analyst_evidence.outcome
// (analyst-outcome.js: clicks before vs after, 31 days post-merge). analyst-outcome.js said "nothing here changes scoring yet": this
// is that step. For one site, per generator (meta-title, expand-content, ...): how often did that kind of fix really improve clicks?
//
//   enough measured fixes AND we are confident it mostly works here  -> a small bonus   (a proven lever for THIS client)
//   enough measured fixes AND we are confident it mostly does not    -> a small penalty (stop leading with what has not worked here)
//   too few measured fixes, or the evidence is mixed                 -> nothing: "no track record yet" is not a verdict
//
// "Confident" means the 95% Wilson interval sits wholly on one side of 50%, so three lucky results never read as a record. It only
// RE-RANKS conclusions that already cleared the corroboration bar: whether to act is still decided by evidence, never by this, so a
// poor record cannot suppress a corroborated problem and a good one cannot manufacture work. Read per site, never across clients.
import { getGeneratorTrackRecord } from '../../store/analyst-evidence.js';

export const MIN_MEASURED = 5;
export const TRACK_RECORD_POINTS = 60;   // same order as productRelevance in analyst-scoring.js: a nudge, not an override
const Z = 1.96;

// 95% Wilson interval for a success rate: { lower, upper }, null when nothing was measured.
export function wilsonInterval(successes, n) {
  if (!(n > 0)) return null;
  const p = successes / n;
  const denom = 1 + (Z * Z) / n;
  const centre = p + (Z * Z) / (2 * n);
  const margin = Z * Math.sqrt((p * (1 - p) + (Z * Z) / (4 * n)) / n);
  return { lower: Math.max(0, (centre - margin) / denom), upper: Math.min(1, (centre + margin) / denom) };
}

// { measured, improved } -> { verdict: 'proven'|'poor'|'inconclusive'|'none', points, label }
export function trackRecordVerdict(record) {
  const n = Number(record?.measured) || 0;
  const improved = Number(record?.improved) || 0;
  if (n < MIN_MEASURED) {
    return { verdict: 'none', points: 0, label: n ? `only ${n} measured fix(es) of this kind on this site so far (needs ${MIN_MEASURED})` : 'no measured fixes of this kind on this site yet' };
  }
  const { lower, upper } = wilsonInterval(improved, n);
  if (lower > 0.5) return { verdict: 'proven', points: TRACK_RECORD_POINTS, label: `this kind of fix improved clicks on this site in ${improved} of ${n} measured cases (+${TRACK_RECORD_POINTS})` };
  if (upper < 0.5) return { verdict: 'poor', points: -TRACK_RECORD_POINTS, label: `this kind of fix improved clicks on this site in only ${improved} of ${n} measured cases (-${TRACK_RECORD_POINTS})` };
  return { verdict: 'inconclusive', points: 0, label: `${improved} of ${n} measured fixes of this kind improved clicks on this site: not conclusive either way` };
}

// Reads one site's per-generator record into a Map. Never throws: a failed read means no adjustment, never a failed run.
export async function loadTrackRecord(siteId, { read = getGeneratorTrackRecord } = {}) {
  try {
    const rows = await read(siteId);
    return new Map((rows || []).map((r) => [r.generator_id, { measured: Number(r.measured), improved: Number(r.improved) }]));
  } catch {
    return new Map();
  }
}

// Adds each conclusion's track-record points to its score and says why in scoreFactors. Pure; returns new objects, same order.
export function applyTrackRecord(conclusions, records) {
  return (conclusions || []).map((c) => {
    if (!c.generatorId) return c;
    const v = trackRecordVerdict(records?.get(c.generatorId));
    if (v.verdict === 'none' || v.verdict === 'inconclusive') {
      return { ...c, trackRecord: v.verdict };
    }
    return { ...c, score: c.score + v.points, scoreFactors: [...(c.scoreFactors || []), v.label], trackRecord: v.verdict };
  });
}
