// Turns "where people stopped" into something a person can act on — or into nothing at all.
//
// The rule that shapes every line here: a drop-off is NOT a defect by itself. Every site has a last step. The home page
// is where a lot of visits end because it is where a lot of visits start; a "thank you" page is where a visit SHOULD
// end. A system that flagged the top row of the list every week would train a client to ignore it, and the one time it
// mattered it would be wallpaper. So a step only becomes a recommendation when ALL of these hold:
//
//   1. enough days were measured to say anything (a bad Tuesday is not a pattern)
//   2. enough visits ended there for the number to mean something
//   3. it is a large enough share of ALL visits to be where the visit usually dies, not one of many ordinary exits
//   4. it is not a step that looks like success (a confirmation page, a completed signup, the client's own goal event)
//
// What it deliberately does NOT claim: WHY people stopped. PostHog records where, not why; a price, a broken button, a
// slow page and a perfectly good answer all look identical here. The recommendation says so and asks for a look,
// instead of inventing a cause and then dispatching a generator to "fix" a problem nobody has confirmed.

export const THRESHOLDS = Object.freeze({
  minMeasuredDays: 14,   // two weeks, so a weekday pattern cannot masquerade as a trend
  minVisits: 30,         // visits ending at the step over the period
  minShare: 0.10,        // of all measured visits
  highShare: 0.25,
  mediumShare: 0.15,
  maxFindings: 3,        // the top few; a long list of "look here" is a list nobody reads
});

// Names that mean the visit ended because it worked. Matched on words, not substrings of other words, so
// "checkout_started" (a drop-off) is NOT mistaken for "checkout" completion.
const SUCCESS_WORDS = new Set([
  'thanks', 'thank', 'thankyou', 'confirmation', 'confirmed', 'success', 'successful', 'complete', 'completed',
  'purchased', 'purchase', 'ordered', 'order', 'booked', 'booking', 'subscribed', 'registered', 'submitted', 'received',
]);
// "…_started", "…_viewed", "…_clicked", "…_opened" describe an intermediate step even when they contain a success word
// ("booking_started"), so a past-tense completion verb is required, not just the noun.
const INTERMEDIATE_SUFFIX = /(started|viewed|clicked|opened|loaded|selected|added|began|begin|start)$/i;

export function looksLikeSuccess(step, { conversionEvents = [] } = {}) {
  const raw = String(step ?? '').trim();
  if (!raw) return false;
  const lowered = raw.toLowerCase();
  // The client's own declared goal event is the strongest signal there is.
  if (conversionEvents.some((c) => c && lowered === String(c).toLowerCase())) return true;

  const words = lowered.replace(/^page:\s*/, '').split(/[^a-z0-9]+/).filter(Boolean);
  if (!words.length) return false;
  if (INTERMEDIATE_SUFFIX.test(words[words.length - 1])) return false;
  return words.some((w) => SUCCESS_WORDS.has(w));
}

/**
 * Decide which drop-off steps deserve a recommendation.
 *
 * `summary` is store/project-posthog.js getPosthogSummary's shape. Returns
 * { status: 'ok'|'insufficient-data', reason?, candidates: [...], considered }.
 *
 * `insufficient-data` is a real answer with a real reason, so a quiet agent can be explained rather than looking
 * broken — and so a project with two days of data is told it needs more, not that it has no problems.
 */
export function analyzeDropOffs(summary, { conversionEvents = [], thresholds = THRESHOLDS } = {}) {
  if (!summary || !summary.days) return { status: 'insufficient-data', reason: 'no_posthog_data', candidates: [], considered: 0 };
  if ((summary.measured_days ?? 0) < thresholds.minMeasuredDays) {
    return {
      status: 'insufficient-data', reason: 'too_few_days', candidates: [], considered: 0,
      measuredDays: summary.measured_days ?? 0, needDays: thresholds.minMeasuredDays,
    };
  }
  const total = Number(summary.sessions) || 0;
  if (total <= 0) return { status: 'insufficient-data', reason: 'no_sessions', candidates: [], considered: 0 };

  const steps = (summary.topDropOffs || []).filter((d) => d?.event);
  const candidates = [];
  for (const step of steps) {
    const visits = Number(step.sessions_ending_here) || 0;
    const share = visits / total;
    if (visits < thresholds.minVisits || share < thresholds.minShare) continue;
    if (looksLikeSuccess(step.event, { conversionEvents })) continue;
    candidates.push({
      step: step.event,
      visits,
      share: Number(share.toFixed(4)),
      priority: share >= thresholds.highShare ? 'high' : share >= thresholds.mediumShare ? 'medium' : 'low',
    });
  }
  candidates.sort((a, b) => b.visits - a.visits);
  return { status: 'ok', candidates: candidates.slice(0, thresholds.maxFindings), considered: steps.length, totalSessions: total };
}

/** The sentence a person reads. Says what is known and, in the same breath, what is not. */
export function describeDropOff(candidate, { totalSessions, days }) {
  const pct = Math.round(candidate.share * 100);
  const where = /^page:\s*/.test(candidate.step)
    ? `the ${candidate.step.replace(/^page:\s*/, '')} page`
    : `the "${String(candidate.step).replace(/[_-]+/g, ' ')}" step`;
  return `${pct}% of visits over the last ${days} days (${candidate.visits.toLocaleString()} of ${Number(totalSessions).toLocaleString()}) `
    + `ended at ${where}. PostHog shows where people stopped but not why, so this is a place to look rather than a confirmed fault: `
    + 'check whether the step asks too much, loads slowly, or leaves the next move unclear.';
}
