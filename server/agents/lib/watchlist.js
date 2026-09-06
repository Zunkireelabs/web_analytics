import { OPPORTUNITY_AGENT_IDS } from './insights.js';
import { getAgent } from '../registry.js';
import { upsertWatchlistItem, closeWatchlistItems, getOpenItems } from '../../store/watchlist.js';
import { hasDraftSince } from '../../store/drafts.js';

// "High-value" per the spec — medium/high only, so the Watchlist stays a
// curated queue of what's actually worth tracking, not a mirror of every
// growth-opportunity finding regardless of size.
const QUALIFYING_PRIORITIES = new Set(['high', 'medium']);

// The Opportunity Watchlist's one sync entry point, called after every FRESH
// analysis run (daily cron and manual "Refresh analysis") — never from a
// cached read, so this never re-evaluates on a page load that didn't
// actually produce new data. `allFindings` is the flat, agentId-tagged
// findings list a fresh orchestration run just produced; `groundedById` is
// buildRecommendations()'s already-grounded params (see
// command-center.js's shapeFinding for why an ungrounded recommendedAction
// must never reach a "Fix" button).
//
// opportunity_type stays 'growth' for every item added here — this is
// deliberately the ONLY source wired in today. A future seasonal-
// opportunity agent (needs a year of history the platform doesn't have
// yet) would extend OPPORTUNITY_AGENT_IDS in insights.js and pass
// opportunityType: 'seasonal' per item; nothing else about this sync
// function, the schema, or the frontend would need to change.
export async function syncWatchlist(siteId, allFindings, groundedById = new Map()) {
  const opportunityFindings = allFindings.filter((f) => OPPORTUNITY_AGENT_IDS.includes(f.agentId));
  const presentIds = new Set(opportunityFindings.map((f) => f.id));

  const qualifying = opportunityFindings.filter((f) => QUALIFYING_PRIORITIES.has(f.priority));
  let added = 0;
  for (const f of qualifying) {
    const grounded = f.recommendedAction?.generatorId ? groundedById.get(f.id) : null;
    const recommendedAction = f.recommendedAction?.generatorId
      ? (grounded ? { ...f.recommendedAction, params: grounded.params } : null)
      : f.recommendedAction;
    const agent = await getAgent(f.agentId);
    const { status } = await upsertWatchlistItem(siteId, {
      opportunityType: 'growth',
      findingId: f.id,
      agentId: f.agentId,
      title: recommendedAction?.label || agent?.meta?.name || f.agentId,
      reason: f.whyItMatters,
      priority: f.priority,
      expectedImpact: f.expectedImpact,
      confidence: f.evidence?.confidence ?? null,
      evidence: f.evidence,
      recommendedAction,
    });
    if (status === 'new') added++;
  }

  // Anything still open that didn't reappear this run fell out of the
  // findings entirely (not merely deprioritized — a priority drop alone
  // doesn't close an item, it just refreshes to a lower tier above).
  const openItems = await getOpenItems(siteId);
  const vanished = openItems.filter((item) => !presentIds.has(item.finding_id));

  const resolutions = {};
  for (const item of vanished) {
    const generatorId = item.recommended_action?.generatorId;
    const actedOn = generatorId && await hasDraftSince(siteId, item.agent_id, generatorId, item.discovered_at);
    resolutions[item.finding_id] = actedOn ? 'completed' : 'no_longer_applicable';
  }
  const closed = await closeWatchlistItems(siteId, resolutions);

  return { added, closed, qualifying: qualifying.length };
}
