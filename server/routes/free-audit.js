import { Router } from 'express';
import { runAudit } from '../free-audit/runAudit.js';
import { AuditError, normalizeUrl, guardUrl } from '../free-audit/fetchPage.js';
import { scanSite } from '../free-audit/siteScan.js';
import { createRateLimiter } from '../free-audit/rateLimit.js';
import { buildTeaser, buildFullReport } from '../free-audit/teaser.js';
import { saveReport, getReport, addLead } from '../store/free-audit.js';
import { sendFreeAuditReportEmail } from '../report/email.js';

// Public free website audit (no session, no tenant): the landing page's "Get my
// free audit" opens /free-audit on this app, which calls these routes. The audit
// fetches arbitrary third-party sites, so the guards live here: SSRF checks in
// free-audit/urlGuard.js, per-IP rate limits and concurrency caps below.
// Mounted before every blanket-requireAuth router in index.js.
const router = Router();

const REQUEST_TIMEOUT_MS = 10000;
const RENDER_REQUEST_TIMEOUT_MS = 20000;
const WINDOW_MS = 10 * 60 * 1000;
const takeAudit = createRateLimiter({ windowMs: WINDOW_MS, max: Number(process.env.FREE_AUDIT_RATE_MAX) || 10 });
const takeRenderAudit = createRateLimiter({ windowMs: WINDOW_MS, max: 3 });
const takeUnlock = createRateLimiter({ windowMs: WINDOW_MS, max: 5 });
// The Page Fixer audits up to ~12 pages per request, so it gets its own, stricter per-IP limit and cap.
const takeScan = createRateLimiter({ windowMs: WINDOW_MS, max: Number(process.env.PAGE_FIXER_RATE_MAX) || 3 });
const MAX_CONCURRENT_SCANS = 2;
let activeScans = 0;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_CONCURRENT_AUDITS = 8;
const MAX_CONCURRENT_RENDERS = 2;
let activeAudits = 0;
let activeRenders = 0;

const SCAN_REQUEST_TIMEOUT_MS = 70000;
const STATUS_BY_CODE = { invalid_url: 400, not_html: 422, fetch_failed: 502, timeout: 504 };

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new AuditError('timeout', 'The audit took too long to complete.')), ms);
    }),
  ]);
}

// Runs the audit. The page always asks for a teaser: the full report is saved
// server-side and the locked issues are withheld until an email unlocks them.
router.post('/free-audit', async (req, res, next) => {
  try {
    const { url, renderMode } = req.body || {};
    const mode = renderMode === 'js' ? 'js' : 'raw';

    const retryAfter = takeAudit(req.ip) || (mode === 'js' ? takeRenderAudit(req.ip) : 0);
    if (retryAfter) {
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'rate_limited', message: 'Too many audits from your network. Please try again in a few minutes.' });
    }
    if (activeAudits >= MAX_CONCURRENT_AUDITS || (mode === 'js' && activeRenders >= MAX_CONCURRENT_RENDERS)) {
      res.set('Retry-After', '30');
      return res.status(503).json({ error: 'busy', message: 'The audit tool is busy right now. Please try again in a moment.' });
    }
    activeAudits += 1;
    if (mode === 'js') activeRenders += 1;
    try {
      const report = await withTimeout(runAudit(url, { renderMode: mode }), mode === 'js' ? RENDER_REQUEST_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
      res.json(buildTeaser(report, await saveReport(report)));
    } catch (err) {
      if (err instanceof AuditError) {
        return res.status(STATUS_BY_CODE[err.code] || 500).json({ error: err.code, message: err.message });
      }
      throw err;
    } finally {
      activeAudits -= 1;
      if (mode === 'js') activeRenders -= 1;
    }
  } catch (e) { next(e); }
});

// Page Fixer: POST /api/page-fixer { url }. Finds the site's pages, audits a sample, and returns the five
// pages with the most issues and three fixes for each (see free-audit/siteScan.js). The response is
// newline-delimited JSON so the page can show progress: {type:'finding'}, {type:'pages',total},
// {type:'audit',done,total,url,ok}, then {type:'done',result} (or {type:'error',error,message}).
// Send { stream: false } to get just the final JSON instead.
router.post('/page-fixer', async (req, res, next) => {
  try {
    const { url, stream } = req.body || {};

    // Refuse bad or private addresses up front, as plain JSON errors, before any streaming starts.
    try {
      await guardUrl(normalizeUrl(url));
    } catch (err) {
      if (err instanceof AuditError) return res.status(STATUS_BY_CODE[err.code] || 400).json({ error: err.code, message: err.message });
      throw err;
    }

    const retryAfter = takeScan(req.ip);
    if (retryAfter) {
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'rate_limited', message: 'Too many scans from your network. Please try again in a few minutes.' });
    }
    if (activeScans >= MAX_CONCURRENT_SCANS) {
      res.set('Retry-After', '30');
      return res.status(503).json({ error: 'busy', message: 'The Page Fixer is busy right now. Please try again in a moment.' });
    }

    activeScans += 1;
    const streaming = stream !== false;
    let gone = false;
    res.on('close', () => { if (!res.writableEnded) gone = true; });
    const send = (event) => { if (streaming && !gone) res.write(`${JSON.stringify(event)}\n`); };
    if (streaming) {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      res.flushHeaders?.();
    }

    try {
      const { entryReport, ...result } = await withTimeout(
        scanSite(url, { onProgress: send, shouldStop: () => gone }),
        SCAN_REQUEST_TIMEOUT_MS,
      );
      if (gone) return;
      // The free report behind the email unlock is the entered page's full audit.
      result.id = await saveReport(entryReport).catch(() => null);
      if (streaming) { send({ type: 'done', result }); res.end(); } else res.json(result);
    } catch (err) {
      const known = err instanceof AuditError;
      const status = known ? (STATUS_BY_CODE[err.code] || 500) : 500;
      const message = known ? err.message : 'Something went wrong. Please try again.';
      if (!known) console.error('[page-fixer] scan failed:', err.message);
      if (streaming && res.headersSent) { send({ type: 'error', error: known ? err.code : 'failed', message }); if (!res.writableEnded) res.end(); }
      else res.status(status).json({ error: known ? err.code : 'failed', message });
    } finally {
      activeScans -= 1;
    }
  } catch (e) { next(e); }
});

// Email capture: stores the lead, unlocks the saved report and returns its private link.
router.post('/free-audit/unlock', async (req, res, next) => {
  try {
    const { id, email } = req.body || {};
    const report = await getReport(id);
    if (!report) return res.status(404).json({ error: 'not_found', message: 'That audit has expired. Please run it again.' });
    if (typeof email !== 'string' || !EMAIL_RE.test(email.trim()) || email.length > 254) {
      return res.status(400).json({ error: 'invalid_email', message: 'Enter a valid email address.' });
    }
    const retryAfter = takeUnlock(req.ip);
    if (retryAfter) {
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'rate_limited', message: 'Too many requests. Please try again in a few minutes.' });
    }
    const clean = email.trim().toLowerCase();
    await addLead({ email: clean, siteUrl: report.finalUrl, reportId: id, scores: report.overall });
    const path = `/free-audit/report?id=${id}`;
    const base = (process.env.FREE_AUDIT_BASE_URL || 'https://app.superrank.si').replace(/\/$/, '');
    // Best-effort, like the contact-lead email: a mail hiccup never fails the unlock.
    const emailed = await sendFreeAuditReportEmail({ to: clean, host: new URL(report.finalUrl).hostname, reportUrl: `${base}${path}` }).catch((err) => {
      console.error('[free-audit] report email failed:', err.message);
      return false;
    });
    res.json({ reportUrl: path, emailed });
  } catch (e) { next(e); }
});

// The full report, reachable only with its unguessable id.
router.get('/free-audit/report/:id', async (req, res, next) => {
  try {
    const report = await getReport(req.params.id);
    res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' });
    if (!report) return res.status(404).json({ error: 'not_found', message: 'This report has expired or does not exist.' });
    res.json(buildFullReport(report));
  } catch (e) { next(e); }
});

export default router;
