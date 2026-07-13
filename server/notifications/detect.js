import { getFindingsDiff } from '../agents/lib/changes.js';
import { RECOMMENDATION_AGENT_IDS } from '../agents/lib/insights.js';

// "Notify users only when something meaningful changes." These thresholds
// are the whole significance filter — deliberately simple and inspectable,
// not a black box: 3+ new high-priority findings in one run collapse into
// one grouped notification (grouping "where appropriate," per spec) instead
// of flooding the feed; anything under that gets its own notification, capped.
const GROUP_THRESHOLD = 3;
const MAX_INDIVIDUAL = 3;
const MAX_OPPORTUNITIES = 2;
const HEALTH_DROP_THRESHOLD = 5; // health score points, week-over-week

const GROWTH_AGENT_IDS = ['opportunity', 'country-intelligence'];

// Real events only, derived from the same findings diff the Command Center's
// Recent Changes section already shows — detection never invents a change
// that didn't actually happen. `trendWeek` (health score delta) is passed
// in by the caller since it's already computed as part of the daily run.
export async function detectNotificationEvents(siteId, { trendWeek } = {}) {
  const changes = await getFindingsDiff(siteId, RECOMMENDATION_AGENT_IDS, 200); // wide window — detection, not display
  const newFindings = changes.filter((c) => c.type === 'new');
  const newHighPriority = newFindings.filter((c) => c.priority === 'high');
  const newOpportunities = newFindings.filter((c) => c.priority !== 'high' && GROWTH_AGENT_IDS.includes(c.agentId));

  const events = [];

  if (newHighPriority.length >= GROUP_THRESHOLD) {
    events.push({
      type: 'critical-issues-group', severity: 'high',
      title: `${newHighPriority.length} new critical issues found`,
      body: newHighPriority.slice(0, 3).map((c) => c.text).join(' '),
      findingIds: newHighPriority.map((c) => c.findingId),
    });
  } else {
    for (const c of newHighPriority.slice(0, MAX_INDIVIDUAL)) {
      events.push({ type: 'critical-issue', severity: 'high', title: 'New critical issue detected', body: c.text, findingIds: [c.findingId] });
    }
  }

  for (const c of newOpportunities.slice(0, MAX_OPPORTUNITIES)) {
    events.push({ type: 'opportunity', severity: 'medium', title: 'New growth opportunity found', body: c.text, findingIds: [c.findingId] });
  }

  if (trendWeek != null && trendWeek <= -HEALTH_DROP_THRESHOLD) {
    events.push({
      type: 'health-drop', severity: 'high',
      title: `Website Health dropped ${Math.abs(trendWeek)} points this week`,
      body: `Health score fell by ${Math.abs(trendWeek)} points compared to last week — check Critical Issues for what changed.`,
      findingIds: [],
    });
  }

  return events;
}
