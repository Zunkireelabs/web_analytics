import { Router } from 'express';
import { requireAuth, requirePlatformRole } from './login.js';
import { fetchDomainSummary } from '../providers/backlinks/commoncrawl.js';
import { hasCompletedGraphRelease } from '../store/commoncrawl-backlinks.js';
import { getLatestAuthoritySnapshot } from '../store/authority.js';

// Exposes a real referring-domain summary for this site's own domain,
// preferring the already-paid-for DataForSEO backlink data that
// authority.js's monthly Authority Score run already fetched and stored in
// authority_snapshots (migration 035) — no extra paid API call needed here,
// just a read of what that agent already computed. Common Crawl (server/
// providers/backlinks/commoncrawl.js, populated by server/scripts/
// refresh-commoncrawl-graph.js) is now only a fallback for a site where
// DataForSEO isn't configured, or hasn't produced a snapshot yet — it used
// to be the only source this route would ever use, which meant a
// DataForSEO-paying tenant still saw this card sit empty while their own
// Authority Score (same underlying data) worked fine.
const router = Router();
router.use(requireAuth, requirePlatformRole('platform_admin'));

// GET /commoncrawl-backlinks/summary?domain=example.com
// Always 200 with a structured `status` — 'ok' when this domain has real
// data (DataForSEO via authority_snapshots, or Common Crawl), 'insufficient-
// data' otherwise (missing/unknown domain, or the Common Crawl ETL never
// having completed a release yet) — never a fabricated summary and never a
// 404/500 for "no data", consistent with the agent framework's own
// status:'insufficient-data' convention (see server/agents/types.js).
router.get('/commoncrawl-backlinks/summary', async (req, res, next) => {
  try {
    const domain = String(req.query.domain || '').trim();
    if (!domain) return res.status(400).json({ error: 'domain query parameter is required' });

    if (req.siteId) {
      const snapshot = await getLatestAuthoritySnapshot(req.siteId);
      if (snapshot?.data_source === 'dataforseo' && snapshot.referring_domains != null) {
        return res.json({
          status: 'ok',
          source: 'dataforseo',
          domain,
          referringDomains: snapshot.referring_domains,
          graphRank: null,
          graphRelease: null,
          updatedAt: snapshot.snapshot_date,
        });
      }
    }

    const summary = await fetchDomainSummary(domain);
    if (summary) {
      return res.json({
        status: 'ok',
        source: 'commoncrawl',
        domain: summary.domain,
        referringDomains: summary.referringDomains,
        graphRank: summary.graphRank,
        graphRelease: summary.graphRelease,
        updatedAt: summary.updatedAt,
      });
    }

    const importHasRun = await hasCompletedGraphRelease();
    return res.json({
      status: 'insufficient-data',
      source: 'commoncrawl',
      domain,
      referringDomains: null,
      graphRank: null,
      graphRelease: null,
      updatedAt: null,
      message: importHasRun
        ? `No Common Crawl backlink data found for "${domain}" yet — it may not be a tracked site/competitor domain, or wasn't matched in the latest graph release.`
        : 'The Common Crawl backlink import has not run yet — no data is available for any domain.',
    });
  } catch (e) { next(e); }
});

export default router;
