import { getTopPages as realGetTopPages, isYmd } from '../store/ga4-pages.js';

// GET /ga4-pages?start&end[&compareStart&compareEnd] for the Overview's Visitors tab ("Top pages", views by page title).
// Kept out of metrics.js so the validation is testable without loading that file's whole import graph.
//
// The site comes from the session (req.siteId), never from the request. Views only: a per-day user count summed across a
// period counts a returning person once per day, so the response carries none. `pages` is empty when nothing is
// ingested yet (a normal state while a backfill runs); `current.days` / `previous.days` say how much of each window has
// data so the card can say so rather than presenting a partial window as the whole period.
export function ga4PagesHandler({ getTopPages = realGetTopPages } = {}) {
  return async (req, res, next) => {
    try {
      const { start, end, compareStart, compareEnd } = req.query;
      if (!isYmd(start) || !isYmd(end) || start > end) {
        return res.status(400).json({ error: 'start and end are required (YYYY-MM-DD), start not after end.' });
      }
      const hasCompare = compareStart != null || compareEnd != null;
      if (hasCompare && (!isYmd(compareStart) || !isYmd(compareEnd) || compareStart > compareEnd)) {
        return res.status(400).json({ error: 'compareStart and compareEnd must both be YYYY-MM-DD, compareStart not after compareEnd.' });
      }
      res.json(await getTopPages(req.siteId, { start, end, ...(hasCompare ? { compareStart, compareEnd } : {}) }));
    } catch (e) { next(e); }
  };
}
