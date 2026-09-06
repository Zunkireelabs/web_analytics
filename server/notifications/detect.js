import { getFindingsDiff, getAiRecommendationMetricChange } from '../agents/lib/changes.js';
import { RECOMMENDATION_AGENT_IDS, OPPORTUNITY_AGENT_IDS } from '../agents/lib/insights.js';
import { hasRecentNotification } from '../store/notifications.js';

// "Notify users only when something meaningful changes." These thresholds
// are the whole significance filter — deliberately simple and inspectable,
// not a black box: 3+ new high-priority findings in one run collapse into
// one grouped notification (grouping "where appropriate," per spec) instead
// of flooding the feed; anything under that gets its own notification.
const GROUP_THRESHOLD = 3;
const MAX_OPPORTUNITIES = 2;
const HEALTH_DROP_THRESHOLD = 5; // health score points, week-over-week
const HEALTH_DROP_COOLDOWN_DAYS = 7; // matches the metric's own weekly comparison window
export const AI_VISIBILITY_DROP_THRESHOLD = 15; // ai-recommendation's aiVisibilityPct points, run-over-run
export const CITATION_GAP_WIDEN_THRESHOLD = 10; // ai-recommendation's competitorCitationGapPct points, run-over-run
const AI_RECOMMENDATION_COOLDOWN_DAYS = 7; // same reasoning as HEALTH_DROP_COOLDOWN_DAYS — avoid re-notifying every run within a short window regardless of how often this agent actually runs (monthly by default, optionally weekly)

// Pure threshold checks, exported purely for direct unit test coverage
// (server/notifications/detect.test.js) without a live DB — the cooldown
// check itself (hasRecentNotification) stays a real query, correctly so,
// since "was this already notified recently" is inherently a DB fact.
export function isVisibilityDrop(visibilityDelta) {
  return visibilityDelta != null && visibilityDelta <= -AI_VISIBILITY_DROP_THRESHOLD;
}
export function isCitationGapWidened(gapDelta) {
  return gapDelta != null && gapDelta >= CITATION_GAP_WIDEN_THRESHOLD;
}

// Real events only, derived from the same findings diff the Command Center's
// Recent Changes section already shows — detection never invents a change
// that didn't actually happen. `trendWeek` (health score delta) is passed
// in by the caller since it's already computed as part of the daily run.
export async function detectNotificationEvents(siteId, { trendWeek } = {}) {
  const changes = await getFindingsDiff(siteId, RECOMMENDATION_AGENT_IDS, 200); // wide window — detection, not display
  const newFindings = changes.filter((c) => c.type === 'new');
  const newHighPriority = newFindings.filter((c) => c.priority === 'high');
  // Reuses the same OPPORTUNITY_AGENT_IDS the Command Center's Growth
  // Opportunities section and stat tile already filter by — a hand-copied
  // local list here would silently drift the moment a new opportunity
  // agent is added there.
  const newOpportunities = newFindings.filter((c) => c.priority !== 'high' && OPPORTUNITY_AGENT_IDS.includes(c.agentId));
  // competitor-intelligence runs weekly (see job.js's DAILY_AGENT_IDS
  // exclusion), so this only ever has something to report right after that
  // weekly run — real newly-identified competitors or newly-lost keyword
  // rankings, never a fabricated "competitor activity" ping.
  const newCompetitorFindings = newFindings.filter((c) => c.agentId === 'competitor-intelligence');

  const events = [];

  if (newHighPriority.length >= GROUP_THRESHOLD) {
    events.push({
      type: 'critical-issues-group', severity: 'high',
      title: `${newHighPriority.length} new critical issues found`,
      body: newHighPriority.slice(0, 3).map((c) => c.text).join(' '),
      findingIds: newHighPriority.map((c) => c.findingId),
    });
  } else {
    // Below GROUP_THRESHOLD means at most 2 items here, so every one of
    // them gets its own notification — no separate cap needed under 3.
    for (const c of newHighPriority) {
      events.push({ type: 'critical-issue', severity: 'high', title: 'New critical issue detected', body: c.text, findingIds: [c.findingId] });
    }
  }

  for (const c of newOpportunities.slice(0, MAX_OPPORTUNITIES)) {
    events.push({ type: 'opportunity', severity: 'medium', title: 'New growth opportunity found', body: c.text, findingIds: [c.findingId] });
  }

  if (newCompetitorFindings.length) {
    events.push({
      type: 'competitor-change', severity: 'medium',
      title: `${newCompetitorFindings.length} new competitor finding${newCompetitorFindings.length === 1 ? '' : 's'}`,
      body: newCompetitorFindings.slice(0, 2).map((c) => c.text).join(' '),
      findingIds: newCompetitorFindings.map((c) => c.findingId),
    });
  }

  if (trendWeek != null && trendWeek <= -HEALTH_DROP_THRESHOLD) {
    const alreadyNotified = await hasRecentNotification(siteId, 'health-drop', HEALTH_DROP_COOLDOWN_DAYS);
    if (!alreadyNotified) {
      events.push({
        type: 'health-drop', severity: 'high',
        title: `Website Health dropped ${Math.abs(trendWeek)} points this week`,
        body: `Health score fell by ${Math.abs(trendWeek)} points compared to last week — check Critical Issues for what changed.`,
        findingIds: [],
      });
    }
  }

  // Metric-level alerts for ai-recommendation's own real percentages —
  // distinct from the finding-level newHighPriority/newOpportunities above
  // (which already fire generically for this agent via RECOMMENDATION_AGENT_IDS/
  // OPPORTUNITY_AGENT_IDS): a percentage moving is itself the significant
  // event here, whether or not it produced a brand-new finding this run.
  // Returns null (no event) with no valid prior 'ok' run to compare against.
  const aiRecMetricChange = await getAiRecommendationMetricChange(siteId);
  if (aiRecMetricChange) {
    if (isVisibilityDrop(aiRecMetricChange.visibilityDelta)) {
      const alreadyNotified = await hasRecentNotification(siteId, 'citation-rate-drop', AI_RECOMMENDATION_COOLDOWN_DAYS);
      if (!alreadyNotified) {
        events.push({
          type: 'citation-rate-drop', severity: 'high',
          title: `AI citation rate dropped ${Math.abs(aiRecMetricChange.visibilityDelta)} points`,
          body: `This company's real AI-citation rate fell by ${Math.abs(aiRecMetricChange.visibilityDelta)} percentage points since the last check.`,
          findingIds: [],
        });
      }
    }
    if (isCitationGapWidened(aiRecMetricChange.gapDelta)) {
      const alreadyNotified = await hasRecentNotification(siteId, 'citation-gap-widened', AI_RECOMMENDATION_COOLDOWN_DAYS);
      if (!alreadyNotified) {
        events.push({
          type: 'citation-gap-widened', severity: 'medium',
          title: `Competitor AI-citation gap widened ${aiRecMetricChange.gapDelta} points`,
          body: `A competitor's AI-citation lead grew by ${aiRecMetricChange.gapDelta} percentage points since the last check.`,
          findingIds: [],
        });
      }
    }
  }

  return events;
}
