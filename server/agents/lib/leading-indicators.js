// Early warning from signals that already exist — not a forecast engine.
//
// What "predict problems before they appear" can honestly mean here. The
// Python pipeline's `forecast_risk` insight exists only for pages with
// Search Console history, so for a product tenant with no GSC there is
// literally nothing to forecast from, and no amount of prompt work changes
// that. Promising prediction anyway would mean generating guesses and
// calling them forecasts.
//
// What IS available is a set of measured patterns that reliably precede a
// visible decline, and several of them come from the public-web agents a
// product tenant already runs. Each one below is a real comparison between
// two real windows of data this platform already collects. None of them
// involves a model.
//
// Every indicator is PURE: it takes already-loaded rows and returns signals
// in the exact shape familiesForDecliningPage produces, so analyst-fusion's
// existing corroboration counting, scoring, narrative and shipping path
// consume them with no special case. MIN_CORROBORATION_TO_ACT still applies,
// and that is deliberately the brake: a single leading indicator is a
// suspicion, and only agreement between independent families is grounds to
// act. Without that rule this would be a guess generator.

// CTR decay before rank loss. Impressions rising while clicks stay flat
// means the page is being shown MORE and chosen LESS — the search result
// itself is losing its appeal, which shows up in clicks weeks before it
// shows up in position. The most useful indicator here, because by the time
// position moves the loss is already realised.
export const MIN_IMPRESSIONS_FOR_CTR_DECAY = 200;
export const CTR_DECAY_IMPRESSION_GROWTH = 0.2;  // impressions up at least 20%
export const CTR_DECAY_CLICK_TOLERANCE = 0.05;   // while clicks moved less than ±5%

export function ctrDecaySignal({ before, after } = {}) {
  if (!before || !after) return null;
  const impBefore = Number(before.impressions || 0);
  const impAfter = Number(after.impressions || 0);
  // A low-impression page's ratios are noise. The floor applies to the LATER
  // window, because that is the one making the claim.
  if (impAfter < MIN_IMPRESSIONS_FOR_CTR_DECAY || impBefore <= 0) return null;

  const impGrowth = (impAfter - impBefore) / impBefore;
  if (impGrowth < CTR_DECAY_IMPRESSION_GROWTH) return null;

  const clicksBefore = Number(before.clicks || 0);
  const clicksAfter = Number(after.clicks || 0);
  // Zero clicks in both windows is not decay, it is a page that never
  // converted impressions at all — a different problem, and claiming decay
  // would be wrong.
  if (clicksBefore <= 0) return null;
  const clickGrowth = (clicksAfter - clicksBefore) / clicksBefore;
  if (clickGrowth > CTR_DECAY_IMPRESSION_GROWTH * 0.5) return null;      // clicks kept up well enough
  if (clickGrowth > CTR_DECAY_CLICK_TOLERANCE && impGrowth < 0.5) return null;

  const ctrBefore = clicksBefore / impBefore;
  const ctrAfter = clicksAfter / impAfter;
  return {
    family: 'ctr-decay-leading',
    source: 'gsc_query_page',
    detail: `impressions +${Math.round(impGrowth * 100)}% while clicks ${clickGrowth >= 0 ? '+' : ''}${Math.round(clickGrowth * 100)}% — CTR ${(ctrBefore * 100).toFixed(1)}% → ${(ctrAfter * 100).toFixed(1)}%`,
    leading: true,
  };
}

// Position drift INSIDE page one. A page sliding from 3.1 to 7.4 has lost
// most of its clicks already and has not crossed any threshold that the
// existing decline detector watches — it is still "ranking on page one".
// This is the drift that gets noticed a quarter late.
export const PAGE_ONE_CEILING = 10;
export const MIN_POSITION_DRIFT = 2;

export function positionDriftSignal({ before, after } = {}) {
  const pBefore = Number(before?.avgPosition);
  const pAfter = Number(after?.avgPosition);
  if (!Number.isFinite(pBefore) || !Number.isFinite(pAfter)) return null;
  // Only within page one. Past it, the existing position-erosion family
  // already fires and this would double-count the same movement as a second
  // independent family — which would inflate corroboration and let a single
  // phenomenon clear the act bar on its own.
  if (pBefore > PAGE_ONE_CEILING || pAfter > PAGE_ONE_CEILING) return null;
  const drift = pAfter - pBefore;
  if (drift < MIN_POSITION_DRIFT) return null;

  return {
    family: 'position-drift-leading',
    source: 'gsc_query_page',
    detail: `average position drifted ${pBefore.toFixed(1)} → ${pAfter.toFixed(1)} while still on page one`,
    leading: true,
  };
}

// Coverage-verdict churn. A page whose coverage verdict keeps changing is a
// page whose topic the site keeps half-addressing — the precursor to
// cannibalisation, and visible in migration 179's own verdict history
// before any traffic moves.
export const MIN_COVERAGE_FLIPS = 2;

export function coverageChurnSignal({ verdictHistory } = {}) {
  const history = Array.isArray(verdictHistory) ? verdictHistory.filter(Boolean) : [];
  if (history.length < 2) return null;
  let flips = 0;
  for (let i = 1; i < history.length; i++) if (history[i] !== history[i - 1]) flips++;
  if (flips < MIN_COVERAGE_FLIPS) return null;

  return {
    family: 'coverage-churn-leading',
    source: 'keyword_gaps',
    detail: `coverage verdict changed ${flips} times (${history.join(' → ')}) — the site keeps half-addressing this topic`,
    leading: true,
  };
}

// Repeated template or capability gaps on one surface. A section the
// generators keep failing to write into is a section that will keep
// receiving nothing — this is predictive of ABSENCE of work, which no
// traffic metric can show, because the page never changes.
export const MIN_CAPABILITY_GAP_REPEATS = 2;

export function capabilityGapSignal({ blockedAttempts = 0, generatorIds = [] } = {}) {
  if (blockedAttempts < MIN_CAPABILITY_GAP_REPEATS) return null;
  return {
    family: 'capability-gap-leading',
    source: 'drafts',
    detail: `${blockedAttempts} generation attempt(s) blocked here${generatorIds.length ? ` (${[...new Set(generatorIds)].join(', ')})` : ''} — this surface cannot receive work until the gap is closed`,
    leading: true,
  };
}

// Design-profile staleness. A profile whose classes no longer exist in the
// live CSS is worse than no profile, because it ships confidently wrong
// markup — and it degrades silently, with nothing failing until a reviewer
// notices the page looks wrong.
export const PROFILE_STALE_DAYS = 90;

export function profileStalenessSignal({ profileDerivedAt, now = new Date() } = {}) {
  if (!profileDerivedAt) return null;
  const ageDays = (now.getTime() - new Date(profileDerivedAt).getTime()) / 86_400_000;
  if (!Number.isFinite(ageDays) || ageDays < PROFILE_STALE_DAYS) return null;
  return {
    family: 'design-staleness-leading',
    source: 'design_profile',
    detail: `the design profile was derived ${Math.round(ageDays)} days ago — classes it records may no longer exist in the live CSS`,
    leading: true,
  };
}

export const LEADING_INDICATORS = Object.freeze([
  { id: 'ctr-decay', run: ctrDecaySignal },
  { id: 'position-drift', run: positionDriftSignal },
  { id: 'coverage-churn', run: coverageChurnSignal },
  { id: 'capability-gap', run: capabilityGapSignal },
  { id: 'design-staleness', run: profileStalenessSignal },
]);

/**
 * Run every indicator over one page's already-loaded evidence.
 *
 * Returns { families, signals } in familiesForDecliningPage's exact shape,
 * so analyst-fusion consumes it with no special case.
 *
 * `families` is a Set, and each indicator contributes its OWN family name —
 * which is what makes corroboration meaningful: two indicators agreeing is
 * two independent families, and MIN_CORROBORATION_TO_ACT then requires that
 * agreement before anything ships. A single indicator produces exactly one
 * family and therefore can never clear the bar alone. That is the design,
 * not a limitation.
 */
export function leadingIndicatorsFor(evidence = {}) {
  const signals = [];
  const families = new Set();
  for (const indicator of LEADING_INDICATORS) {
    let signal;
    try {
      signal = indicator.run(evidence);
    } catch {
      // A malformed row must not break the sweep for the rest of the page.
      signal = null;
    }
    if (!signal) continue;
    signals.push(signal);
    families.add(signal.family);
  }
  return { families, signals };
}

export function isLeadingIndicatorsEnabled(env = process.env) {
  return env.LEADING_INDICATORS_ENABLED === 'true';
}
