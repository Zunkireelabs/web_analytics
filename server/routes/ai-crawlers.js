import crypto from 'node:crypto';
import express, { Router } from 'express';
import { findActiveCrawlerToken, touchCrawlerToken, saveCrawlerBatch, pruneCrawlerData, getCrawlerRows, getCrawlerSiteStatus, listCrawlerSiteStatuses } from '../store/ai-crawlers.js';
import { requireAuth } from './login.js';
import { query } from '../db.js';
import { summarize, periodBounds } from '../ai-crawlers/summarize.js';
import { BOTS } from '../ai-crawlers/bots.js';
import { getSiteById } from '../store/read.js';
import { aggregateLines, DEFAULT_MAX_PATHS_PER_DAY } from '../ai-crawlers/aggregate.js';
import { getRanges } from '../ai-crawlers/ranges-cache.js';

// POST /api/ai-crawlers/ingest: the hourly log-shipping script (deploy/ai-crawler-shipper/) posts a project's recent
// access-log lines here as plain text. Public (no session) and authenticated by a bearer token, exactly like
// routes/crm-webhook.js, so it must be mounted before any blanket-requireAuth router (see server/index.js).
//
// THE PROJECT COMES FROM THE TOKEN, NEVER FROM THE REQUEST. findActiveCrawlerToken() returns the site_id stored with the
// token; nothing in the URL, query string, headers or body can name a different project, and a test posts exactly those
// attempts. That is the whole multi-tenant guarantee for uploads.
//
// What is kept: daily counts (store/ai-crawlers.js). The lines themselves, visitor addresses and user agents are used to
// work out the counts and then dropped with the request; nothing here logs them.

export const MAX_BODY_BYTES = 5 * 1024 * 1024;
export const MAX_LINES = 100_000;
const PRUNE_EVERY_MS = 24 * 3600 * 1000;

let lastPruneAt = 0;

export function createCrawlerIngestRouter({ getRangesFn = getRanges, maxPathsPerDay = DEFAULT_MAX_PATHS_PER_DAY } = {}) {
  const router = Router();

  router.post(
    '/ai-crawlers/ingest',
    // Any content type is read as text: the script sends text/plain, but a client that forgets the header must not get a
    // confusing empty body. 5 MB is about 15,000 real log lines; the script splits larger windows into several uploads.
    express.text({ type: () => true, limit: MAX_BODY_BYTES }),
    async (req, res, next) => {
      try {
        const header = req.headers.authorization || '';
        const raw = header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : null;
        const token = raw ? await findActiveCrawlerToken(raw) : null;
        if (!token) return res.status(401).json({ error: 'Invalid or missing upload token.' });

        const siteId = token.site_id;
        const site = await getSiteById(siteId);
        if (!site || (site.status && site.status !== 'active')) {
          return res.status(403).json({ error: 'This project is not active.' });
        }
        // Even an empty upload counts as a sign of life ("the script is running"), which the dashboard shows.
        await touchCrawlerToken(token.id);

        const body = typeof req.body === 'string' ? req.body : '';
        if (!body.trim()) return res.json({ ok: true, duplicate: false, visits: 0, note: 'empty upload' });

        const lines = body.split('\n');
        if (lines.length > MAX_LINES) {
          return res.status(413).json({ error: `Too many lines in one upload (max ${MAX_LINES}). Send smaller batches.` });
        }

        const ranges = await getRangesFn();
        const { rows, stats } = aggregateLines(lines, { ranges, maxPathsPerDay });
        const batchHash = crypto.createHash('sha256').update(body).digest('hex');
        const saved = await saveCrawlerBatch(siteId, { batchHash, rows, visits: stats.botVisits, maxPathsPerDay });

        maybePrune();
        // Counts only: nothing derived from an address or a line goes back in the response.
        res.json({
          ok: true,
          duplicate: saved.duplicate,
          visits: saved.duplicate ? 0 : stats.botVisits,
          byVerification: saved.duplicate ? undefined : stats.byVerification,
          skipped: { unreadable: stats.unparseable, notAiCrawler: stats.notBot, ownAgents: stats.ownExcluded },
        });
      } catch (err) { next(err); }
    },
    // body-parser's own errors (too large, bad encoding) get a plain JSON answer instead of an HTML error page.
    (err, req, res, next) => {
      if (err?.type === 'entity.too.large') return res.status(413).json({ error: `Upload larger than ${MAX_BODY_BYTES / 1024 / 1024} MB. Send smaller batches.` });
      return next(err);
    }
  );
  return router;
}

// 13-month retention and the 14-day batch memory: run opportunistically, at most once a day per process, never blocking an upload.
function maybePrune() {
  if (Date.now() - lastPruneAt < PRUNE_EVERY_MS) return;
  lastPruneAt = Date.now();
  pruneCrawlerData().catch((err) => console.warn('[ai-crawlers] prune failed:', err.message));
}

const AI_BOT_COUNT = BOTS.filter((b) => b.ai !== false).length;
const periodDays = (q) => ([7, 28, 90].includes(Number(q)) ? Number(q) : 28);

/** One project's summary. Exported so the staff comparison and the tests use the exact same numbers the client sees. */
export async function loadSiteSummary(siteId, days) {
  const b = periodBounds(days);
  const [rows, inv, status] = await Promise.all([
    getCrawlerRows(siteId, b.prevFrom, b.to),
    query(`SELECT page FROM page_inventory WHERE site_id = $1 AND orphaned = false LIMIT 2000`, [siteId]).then((r) => r.rows.map((x) => x.page)).catch(() => []),
    getCrawlerSiteStatus(siteId),
  ]);
  const s = summarize(rows, { days, inventory: inv });
  s.totals.crawlersWatched = AI_BOT_COUNT;
  s.status = { connected: status.active_tokens > 0, lastUploadAt: status.last_upload_at, trackingSince: status.first_day };
  return s;
}

/**
 * Dashboard routes. Everything here is scoped to req.siteId (the project in the person's session, which the existing
 * session/switch logic already checks against their access), never to an id from the URL or query string.
 */
export function createCrawlerDashboardRouter() {
  const router = Router();
  router.get('/ai-crawlers/summary', requireAuth, async (req, res, next) => {
    try {
      if (!req.siteId) return res.status(400).json({ error: 'No project selected.' });
      res.json(await loadSiteSummary(req.siteId, periodDays(req.query.days)));
    } catch (e) { next(e); }
  });
  return router;
}

/** Staff comparison: the same summary for every project, in one list. The platform route wraps this in its admin check. */
export async function loadClientComparison(days) {
  const sites = await listCrawlerSiteStatuses();
  const out = [];
  for (const s of sites) {
    const sum = await loadSiteSummary(s.id, days);
    out.push({
      siteId: s.id, name: s.name, domain: s.domain, connected: s.active_tokens > 0, lastUploadAt: s.last_upload_at, trackingSince: s.first_day,
      visits: sum.totals.visits, change: sum.totals.change, crawlersSeen: sum.totals.crawlersSeen,
      pagesReached: sum.totals.pagesReached, pagesTotal: sum.totals.pagesTotal, errors: sum.totals.errors,
      byCrawler: sum.crawlers.filter((c) => c.ai).map((c) => ({ id: c.id, label: c.label, visits: c.visits })),
    });
  }
  return { period: periodBounds(days), clients: out };
}

export { periodDays };
export const crawlerDashboardRouter = createCrawlerDashboardRouter();
export default createCrawlerIngestRouter();
