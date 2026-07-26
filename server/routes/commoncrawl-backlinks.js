import { Router } from 'express';
import { requireAuth, requirePlatformRole } from './login.js';
import { fetchDomainSummary } from '../providers/backlinks/commoncrawl.js';
import { hasCompletedGraphRelease } from '../store/commoncrawl-backlinks.js';

// Exposes Common Crawl backlink summaries (server/providers/backlinks/
// commoncrawl.js, populated by server/scripts/refresh-commoncrawl-graph.js)
// over the API. Internal-only, same gate as Command Center/Site Audit — this
// is company-side backlink/authority-adjacent infra, not a client-facing
// feature yet. Deliberately its own router, importing only the Common Crawl
// provider — never server/ingest/dataforseo-backlinks.js or authority.js —
// so this stays independent of DataForSEO and the Authority Score both in
// behavior and in what happens if either is unconfigured or down.
const router = Router();
router.use(requireAuth, requirePlatformRole('platform_admin'));

// GET /commoncrawl-backlinks/summary?domain=example.com
// Always 200 with a structured `status` — 'ok' when this domain has real
// imported data, 'insufficient-data' otherwise (missing/unknown domain, or
// the ETL never having completed a release yet) — never a fabricated
// summary and never a 404/500 for "no data", consistent with the agent
// framework's own status:'insufficient-data' convention (see
// server/agents/types.js).
router.get('/commoncrawl-backlinks/summary', async (req, res, next) => {
  try {
    const domain = String(req.query.domain || '').trim();
    if (!domain) return res.status(400).json({ error: 'domain query parameter is required' });

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
