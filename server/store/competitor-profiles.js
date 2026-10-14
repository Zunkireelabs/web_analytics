import { query } from '../db.js';

// LLM-discovered competitor profiles (migration 025) — separate from
// competitor_rankings (migration 018, real keyword-level SERP data), which
// stays optional/provider-dependent. This table is the always-available
// baseline the competitor-intelligence agent's MVP pipeline writes to.

// `runAt` is one JS Date captured once per competitor-intelligence run()
// call (not SQL now(), which would give every upsert in the same run a
// microseconds-apart-but-not-identical timestamp) — every domain from the
// same run gets the exact same value, so listCompetitorProfiles below can
// select "this run" by exact equality instead of guessing a time window.
//
// `excludedReason` (migration 133) is null for a real, active competitor —
// the default, and what every pre-migration row already means — or a short
// tag (e.g. 'platform') when the caller has already determined this domain
// isn't a genuine business rival (see competitor-analysis.js's
// isKnownPlatformDomain). Never computed here: this function only persists
// what the caller decided.
export async function upsertCompetitorProfile(siteId, domain, comparison, runAt, excludedReason = null) {
  const { rows } = await query(
    `INSERT INTO competitor_profiles (site_id, domain, last_analyzed_at, comparison, excluded_reason)
     VALUES ($1, $2, $4, $3, $5)
     ON CONFLICT (site_id, domain) DO UPDATE SET
       last_analyzed_at = $4, comparison = EXCLUDED.comparison, excluded_reason = EXCLUDED.excluded_reason
     RETURNING *`,
    [siteId, domain, JSON.stringify(comparison), runAt, excludedReason]
  );
  return rows[0];
}

// Only the most recent discovery run's competitors, not every domain ever
// guessed across every past weekly run — each upsert only touches domains
// the CURRENT run identified, so a domain dropped from this week's list
// (no longer a real match, or the LLM simply named someone else this time)
// would otherwise sit on the leaderboard forever with a stale score.
// Exact-equality on last_analyzed_at (not a time-window heuristic) — every
// row from one run shares the identical runAt timestamp (see
// upsertCompetitorProfile), so this can never blend two real runs even if
// they happen to land within minutes of each other.
export async function listCompetitorProfiles(siteId) {
  const { rows } = await query(
    `SELECT * FROM competitor_profiles
     WHERE site_id = $1
       AND last_analyzed_at = (
         SELECT MAX(last_analyzed_at) FROM competitor_profiles WHERE site_id = $1
       )
     ORDER BY domain`,
    [siteId]
  );
  return rows;
}

// Every domain ever discovered for a site, across EVERY run, not just the
// most recent one — deliberately different scope from listCompetitorProfiles
// above. That function exists for a leaderboard-style display ("this week's
// competitors"), where a domain the latest LLM recall didn't happen to name
// again should drop off. This function backs the competitor-domain SAFETY
// policy (server/agents/lib/competitor-policy.js) instead: a domain
// genuinely discovered as a competitor last month is still a real business
// competitor today even if this week's non-deterministic LLM recall (capped
// at MAX_COMPETITORS, see competitor-analysis.js) happened to name a
// different 3-5 companies instead. Missing a real competitor because it
// simply wasn't re-named this week is the wrong failure mode for a guard
// whose whole purpose is to catch every configured competitor; a false
// negative here is worse than a domain staying "active" a little longer
// than a display-only leaderboard would show it.
export async function listAllCompetitorDomains(siteId) {
  const { rows } = await query(
    `SELECT DISTINCT ON (domain) domain, excluded_reason FROM competitor_profiles
      WHERE site_id = $1
      ORDER BY domain, last_analyzed_at DESC NULLS LAST`,
    [siteId]
  );
  return rows;
}

// Real, insert-only history (migration 034) — see that migration's comment
// for why this is separate from the overwrite-per-domain table above.
// Called alongside upsertCompetitorProfile from the same run(), same runAt.
export async function insertCompetitorStructuralSnapshot(siteId, domain, competitorScore, ownScore, snapshotAt) {
  await query(
    `INSERT INTO competitor_structural_snapshots (site_id, domain, competitor_score, own_score, snapshot_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (site_id, domain, snapshot_at) DO NOTHING`,
    [siteId, domain, competitorScore, ownScore ?? null, snapshotAt]
  );
}

// Real snapshot history for one domain since a date, oldest first — the
// actual trend a chart draws. Honestly sparse/empty for a domain that
// hasn't recurred across runs (see getMostTrackedCompetitorDomain below for
// how to pick a domain worth charting in the first place).
export async function getCompetitorStructuralTrend(siteId, domain, since) {
  const { rows } = await query(
    `SELECT domain, competitor_score, own_score, snapshot_at FROM competitor_structural_snapshots
      WHERE site_id = $1 AND domain = $2 AND snapshot_at >= $3
      ORDER BY snapshot_at ASC`,
    [siteId, domain, since]
  );
  return rows;
}

// The site's own structural score, deduped across the (usually several)
// competitor rows written in the same run (own_score is repeated once per
// competitor row per run — see migration 034) — the read path for external
// monthly-cadence consumers (Data Analyst Agent MCP tool) that want one
// site-level value per real run, not one per competitor.
export async function getOwnStructuralScoreSeries(siteId, start, end) {
  const { rows } = await query(
    `SELECT DISTINCT to_char(snapshot_at, 'YYYY-MM-DD') AS snapshot_date, own_score
       FROM competitor_structural_snapshots
      WHERE site_id = $1 AND snapshot_at BETWEEN $2 AND $3 AND own_score IS NOT NULL
      ORDER BY snapshot_date ASC`,
    [siteId, start, end]
  );
  return rows;
}

// The most recent real structural score for each domain a site has ever
// been compared against — one row per domain, not one per run — for a
// client-facing "how do they actually rank against you" line that needs a
// real number, not the free-text `comparison` prose on competitor_profiles.
// DISTINCT ON picks the latest snapshot_at per domain in one query, same
// pattern as listCompetitorProfiles' "latest run" selection above but keyed
// per-domain instead of per-run, since a domain's own_score/competitor_score
// pair can legitimately come from different runs than another domain's.
export async function getLatestCompetitorScores(siteId) {
  const { rows } = await query(
    `SELECT DISTINCT ON (domain) domain, own_score, competitor_score, snapshot_at
       FROM competitor_structural_snapshots
      WHERE site_id = $1
      ORDER BY domain, snapshot_at DESC`,
    [siteId]
  );
  return rows;
}

// Competitor identity isn't stable run to run (see migration 034's
// comment) — this picks whichever domain actually has the most real
// snapshots for a site (ties broken by most recent), so Growth/Review
// reports chart a domain that genuinely has history instead of an
// arbitrary one-off. Returns null when no domain has ever been snapshotted.
export async function getMostTrackedCompetitorDomain(siteId) {
  const { rows } = await query(
    `SELECT domain, COUNT(*)::int AS snapshot_count, MAX(snapshot_at) AS last_snapshot_at
       FROM competitor_structural_snapshots
      WHERE site_id = $1
      GROUP BY domain
      ORDER BY snapshot_count DESC, last_snapshot_at DESC
      LIMIT 1`,
    [siteId]
  );
  return rows[0] || null;
}
