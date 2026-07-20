import { getAgentRunHistory } from '../../store/agent-runs.js';

// Many finding types' whyItMatters text never names the page it's about
// (e.g. technical-seo's Core Web Vitals/index-status/duplicate-title
// findings say "for this page" without saying which) — evidence.page (or
// the first of evidence.pages/sourcePages, for findings keyed to more than
// one URL) is the only reliable source of that, so the timeline carries it
// as its own field instead of relying on every whyItMatters string to
// happen to embed a URL. Domain/query/country-level findings genuinely have
// no page (returns null) — that's a normal, expected case, not a gap.
function pageFromEvidence(evidence) {
  if (!evidence) return { page: null, extraCount: 0 };
  if (evidence.page) return { page: evidence.page, extraCount: 0 };
  const list = Array.isArray(evidence.pages) ? evidence.pages : Array.isArray(evidence.sourcePages) ? evidence.sourcePages : null;
  if (!list?.length) return { page: null, extraCount: 0 };
  return { page: list[0], extraCount: list.length - 1 };
}

// Diffs the latest persisted run against the previous one, per agent — "new
// this round" vs "resolved since last time." finding.id is already stable/
// namespaced (see agents/types.js Finding), so a plain set difference works.
// Shared by the Command Center's Recent Changes section and the
// notification detector (server/notifications/detect.js) — one diff
// implementation, not two.
export async function getFindingsDiff(siteId, agentIds, limit = 10) {
  const perAgent = await Promise.all(agentIds.map(async (agentId) => {
    const history = await getAgentRunHistory(siteId, agentId, 2); // newest first
    const [current, previous] = history;
    if (!current || current.status !== 'ok' || !previous || previous.status !== 'ok') return [];

    const currentFindings = current.facts?.findings || [];
    const previousFindings = previous.facts?.findings || [];
    const currentIds = new Set(currentFindings.map((f) => f.id));
    const previousById = new Map(previousFindings.map((f) => [f.id, f]));

    const changes = [];
    for (const f of currentFindings) {
      if (!previousById.has(f.id)) {
        changes.push({ type: 'new', agentId, findingId: f.id, priority: f.priority, text: f.whyItMatters, at: current.created_at, ...pageFromEvidence(f.evidence) });
      }
    }
    for (const [id, f] of previousById) {
      if (!currentIds.has(id)) {
        changes.push({ type: 'resolved', agentId, findingId: id, priority: f.priority, text: f.whyItMatters, at: current.created_at, ...pageFromEvidence(f.evidence) });
      }
    }
    return changes;
  }));
  return perAgent.flat().sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, limit);
}

// A pure week-over-week health delta, not a finding diff — its own
// `type: 'health'` so a timeline can render it distinctly (a trend arrow,
// not a new/resolved marker).
export function healthChangeEntry(trendWeek, generatedAt) {
  if (trendWeek == null || trendWeek === 0) return null;
  const sign = trendWeek > 0 ? '+' : '';
  return { type: 'health', agentId: null, text: `Website Health ${sign}${trendWeek} this week`, at: generatedAt, positive: trendWeek > 0 };
}
