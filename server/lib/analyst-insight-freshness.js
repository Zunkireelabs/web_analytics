// Which Data Analyst insights are fresh enough to become recommendations.
//
// The nightly analyst sync used to turn EVERY insight the Python service returned into a recommendation, whatever its age. When the
// Python pipeline stopped producing (it failed every night from September 2026), the same September findings were re-created as
// recommendations night after night, each later superseded and then re-created again: stale findings, used silently.
//
// An insight becomes a recommendation only while it is younger than the window (default 3 days, by when Python generated it). An
// insight with no generation time is treated as stale: we cannot show it is fresh.
export const DEFAULT_MAX_AGE_DAYS = 3;

export function maxInsightAgeDays(env = process.env) {
  const n = Number(env.ANALYST_INSIGHT_MAX_AGE_DAYS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_AGE_DAYS;
}

export function splitByFreshness(insights, { maxAgeDays = DEFAULT_MAX_AGE_DAYS, now = new Date() } = {}) {
  const cutoff = now.getTime() - maxAgeDays * 864e5;
  const fresh = []; const stale = [];
  for (const i of insights || []) {
    const t = Date.parse(i?.generated_at ?? '');
    (Number.isFinite(t) && t >= cutoff ? fresh : stale).push(i);
  }
  return { fresh, stale };
}
