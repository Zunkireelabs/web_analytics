import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { requireAuth, requirePlatformRole } from './login.js';
import { createClientSite, updateSiteConnection, updateSiteRepoConfig, updateSiteOauthPolicy, updateSiteVisibleFaqCap, updateSiteVisibleFaqBaseline, suspendSite, reactivateSite, softDeleteSite, hardDeleteSite } from '../db.js';
import { getSiteById, listSites, getHealthScoreOnOrBefore } from '../store/read.js';
import { resolveFile } from '../implementers/lib/url-file-map.js';
import { getFileContent } from '../github/client.js';
import { baseBranch } from '../implementers/lib/github-ops.js';
import { hasVisibleFaqSignal } from '../implementers/lib/render-inspector.js';
import { PERMISSION_LEVELS } from '../../mcp-server/permissions.js';
import { getUserByEmail, createUser } from '../store/users.js';
import { listPendingSignupRequests, getSignupRequestById, markSignupRequestReviewed, setSignupRequestCreatedSite } from '../store/signup-requests.js';
import { getLatestAgentRuns } from '../store/agent-runs.js';
import { setOnboardingBaseline } from '../store/upsert.js';
import { startFullSiteAudit } from '../agents/lib/bulk-audit.js';
import { runSiteDiscoveryIfDue, runDailyIngestForSite, runDailyAgentAnalysisForSite } from '../job.js';
import { buildReviewReport } from '../agents/lib/review-report.js';
import { buildGrowthSummary } from '../agents/lib/growth-summary.js';
import { recordAuditEvent } from '../store/admin/audit-log.js';

// Client provisioning, exposed as real routes for the first time this
// session — previously only reachable via server/scripts/create-client.js /
// connect-site.js / connect-repo.js (still preserved, still work, used by
// this same underlying db.js functions). Staff-only (requirePlatformRole),
// so gated identically to every other AI Growth Platform route.
const router = Router();
router.use(requireAuth, requirePlatformRole('platform_admin'));

const GSC_PROPERTY_RE = /^(sc-domain:.+|https?:\/\/.+)$/;

// Every site, with onboarding status surfaced plainly (not hidden) so staff
// can see who's connected vs. still awaiting real GSC/GA4 access from the
// client — a real, sometimes-days-long external step, not a bug if it sits
// unconnected for a while. `connected` and `baselined` are deliberately
// separate signals — a site can have real GSC/GA4 properties saved
// (`connected`) while its baseline audit never actually completed
// (`!baselined`, e.g. Google access hadn't propagated yet on first attempt,
// or the site predates this whole flow) — see POST .../retry-baseline below.
router.get('/internal/clients', async (req, res, next) => {
  try {
    const sites = await listSites();
    res.json(sites.map((s) => ({
      id: s.id, name: s.name, websiteDomain: s.website_domain, timezone: s.timezone,
      connected: !!(s.gsc_property && s.ga4_property_id),
      baselined: !!s.onboarded_at,
      repoConnected: !!(s.repo_owner && s.repo_name),
      onboardedAt: s.onboarded_at, createdAt: s.created_at,
      oauthMaxPermissionLevel: s.oauth_max_permission_level,
      visibleFaqCap: s.visible_faq_cap,
      visibleFaqBaseline: s.visible_faq_baseline,
      status: s.status,
      deactivatedAt: s.deactivated_at,
      deletedAt: s.deleted_at,
    })));
  } catch (e) { next(e); }
});

// "All Clients" toggle on the Milestones page (web/src/pages/GrowthReport.jsx,
// staff-only) — every onboarded site's AI-projected growth trajectory in one
// request. Sites with no real baseline are skipped rather than shown broken,
// same honesty rule buildGrowthReport itself applies for a single site.
// Deliberately uses the lighter buildGrowthSummary (3 queries/site), not
// buildGrowthReport (9-10 queries/site) — this view doesn't need full
// historical series, just the current-vs-projected numbers.
router.get('/internal/clients/growth-summary', async (req, res, next) => {
  try {
    const sites = await listSites();
    const onboarded = sites.filter((s) => s.onboarded_at);
    const summaries = await Promise.all(onboarded.map(buildGrowthSummary));
    res.json(summaries);
  } catch (e) { next(e); }
});

// Step 1 — create the site + its first login. GSC/GA4 intentionally left
// unconnected (same as createClientSite always has) — this is a real,
// separate step (below) since it depends on the client granting access,
// which doesn't happen at the same moment as deciding to onboard them.
router.post('/internal/clients', async (req, res, next) => {
  try {
    const { name, websiteDomain, timezone, email, password } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required.' });
    if (!email || !password) return res.status(400).json({ error: 'email and password are required for the client\'s first login.' });
    if (String(password).length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

    const normalizedEmail = String(email).trim().toLowerCase();
    const existing = await getUserByEmail(normalizedEmail);
    if (existing) return res.status(409).json({ error: `A user with email "${normalizedEmail}" already exists.` });

    const site = await createClientSite({ name: String(name).trim(), websiteDomain, timezone });
    try {
      const passwordHash = await bcrypt.hash(password, 10);
      await createUser({ siteId: site.id, email: normalizedEmail, passwordHash });
    } catch (err) {
      // Site is left in place (harmless — nothing ingests against it until
      // connected below) — same recovery shape create-client.js documents.
      return res.status(500).json({ error: `Site #${site.id} was created, but the login failed: ${err.message}`, siteId: site.id });
    }

    await recordAuditEvent(req, {
      action: 'tenant.created',
      targetType: 'site',
      targetId: String(site.id),
      tenantSiteId: site.id,
      tenantName: site.name,
      metadata: { name: site.name, websiteDomain: site.website_domain, email: normalizedEmail },
      success: true,
    });

    res.status(201).json({ id: site.id, name: site.name, websiteDomain: site.website_domain, timezone: site.timezone, connected: false });
  } catch (e) { next(e); }
});

// Real, pending prospective-client submissions from the public
// POST /signup-requests route (server/routes/login.js) — never a real
// account until approved below.
router.get('/internal/signup-requests', async (req, res, next) => {
  try {
    const requests = await listPendingSignupRequests();
    res.json(requests.map((r) => ({
      id: r.id, companyName: r.company_name, websiteDomain: r.website_domain,
      contactEmail: r.contact_email, message: r.message, createdAt: r.created_at,
    })));
  } catch (e) { next(e); }
});

// Approve — runs the exact same createClientSite + createUser sequence as
// POST /internal/clients above, sourced from the stored request instead of
// a staff-typed form. Uses the request's already-real bcrypt hash directly
// (never re-hashed, never re-typed by staff) since the prospective client
// set their own password at request time. Re-checks email uniqueness since
// a request can sit pending long enough for the email to be taken another
// way in the meantime.
router.post('/internal/signup-requests/:id/approve', async (req, res, next) => {
  try {
    const requestId = Number(req.params.id);
    const request = await getSignupRequestById(requestId);
    if (!request) return res.status(404).json({ error: `No signup request found with id ${requestId}.` });

    const existing = await getUserByEmail(request.contact_email);
    if (existing) return res.status(409).json({ error: `A user with email "${request.contact_email}" already exists.` });

    // Atomic claim BEFORE creating anything — closes the real race where two
    // staff approving the same request within milliseconds of each other
    // could otherwise both pass a read-only status check and each create a
    // full duplicate site (see markSignupRequestReviewed's guard).
    const claimed = await markSignupRequestReviewed(requestId, 'approved');
    if (!claimed) {
      const current = await getSignupRequestById(requestId);
      return res.status(409).json({ error: `This request was already ${current?.status}.` });
    }

    const site = await createClientSite({ name: request.company_name, websiteDomain: request.website_domain, timezone: undefined });
    try {
      await createUser({ siteId: site.id, email: request.contact_email, passwordHash: request.password_hash });
    } catch (err) {
      // Site created but login failed — same orphaned-but-harmless recovery
      // shape as POST /internal/clients above (siteId is returned so staff
      // can finish it via `npm run create-client -- <email> <password>
      // --site-id <id>`). The request is already claimed 'approved' above
      // and can't be re-approved — that's the race guard working as intended.
      return res.status(500).json({ error: `Site #${site.id} was created, but the login failed: ${err.message}`, siteId: site.id });
    }

    await setSignupRequestCreatedSite(requestId, site.id);

    await recordAuditEvent(req, {
      action: 'signup_request.approved',
      targetType: 'signup_request',
      targetId: String(requestId),
      tenantSiteId: site.id,
      tenantName: site.name,
      metadata: { signupRequestId: requestId, companyName: request.company_name, contactEmail: request.contact_email },
      success: true,
    });

    res.status(201).json({ id: site.id, name: site.name, websiteDomain: site.website_domain, timezone: site.timezone, connected: false });
  } catch (e) { next(e); }
});

router.post('/internal/signup-requests/:id/reject', async (req, res, next) => {
  try {
    const requestId = Number(req.params.id);
    const request = await getSignupRequestById(requestId);
    if (!request) return res.status(404).json({ error: `No signup request found with id ${requestId}.` });

    const reviewed = await markSignupRequestReviewed(requestId, 'rejected');
    if (!reviewed) {
      const current = await getSignupRequestById(requestId);
      return res.status(409).json({ error: `This request was already ${current?.status}.` });
    }

    await recordAuditEvent(req, {
      action: 'signup_request.rejected',
      targetType: 'signup_request',
      targetId: String(requestId),
      tenantName: request.company_name,
      metadata: { signupRequestId: requestId, companyName: request.company_name, contactEmail: request.contact_email },
      success: true,
    });

    res.json({ ok: true });
  } catch (e) { next(e); }
});

// Shared by /connect and /retry-baseline below — real site discovery + real
// data ingestion + one real baseline agent analysis, then stamps
// onboarded_at/baseline_run_id from that real run. Every number returned
// here is real — a sparse brand-new property will honestly show low/
// insufficient-data findings, never a placeholder while something is
// secretly still pending. Returns `{error, discovery}` (no throw) on a real
// ingestion failure so the caller can decide the HTTP status.
async function runBaselineSequence(siteId, site) {
  // Real site structure first — independent of GSC/GA4 having any data
  // yet, works off the live site itself (sitemap + crawl).
  const discovery = await runSiteDiscoveryIfDue(site).catch((err) => {
    console.error(`[clients] site ${siteId} baseline discovery failed:`, err.message);
    return null;
  });

  // Real historical GSC/GA4 data — if the platform's Google account
  // hasn't actually been granted access yet, this fails honestly here
  // rather than silently proceeding to a baseline with no real data.
  let ingestion;
  try {
    ingestion = await runDailyIngestForSite(site);
  } catch (err) {
    return {
      error: `Couldn't fetch real GSC/GA4 data: ${err.message}. Confirm the platform's Google account has been granted access to this exact property, then retry — nothing was fabricated in place of this.`,
      discovery,
    };
  }

  const analysis = await runDailyAgentAnalysisForSite(site);
  const [execRun] = await getLatestAgentRuns(siteId, ['executive-report']);
  if (execRun) await setOnboardingBaseline(siteId, execRun.id);

  // Real "where you stand today" findings for Milestones — fire-and-forget
  // like the manual /site-audit trigger: resolves once the audit_runs row
  // exists, the actual crawl+audit keeps running well past this request's
  // response. Best-effort — a failed audit start shouldn't fail onboarding
  // itself, same as the discovery step above.
  startFullSiteAudit(siteId, { triggeredBy: 'onboarding' }).catch((err) => {
    console.error(`[clients] site ${siteId} onboarding site audit failed to start:`, err.message);
  });

  const today = new Date().toISOString().slice(0, 10);
  const healthScore = await getHealthScoreOnOrBefore(siteId, today);
  const finalSite = await getSiteById(siteId);

  return {
    site: { id: finalSite.id, name: finalSite.name, onboardedAt: finalSite.onboarded_at, baselineRunId: finalSite.baseline_run_id },
    discovery, ingestion, analysis, healthScore,
  };
}

// Step 2 — connect real GSC/GA4 properties, then immediately (not "next
// week's cron") run the real baseline sequence above.
router.post('/internal/clients/:id/connect', async (req, res, next) => {
  try {
    const siteId = Number(req.params.id);
    const { gscProperty: rawGscProperty, ga4PropertyId: rawGa4PropertyId, reportEmailTo } = req.body || {};
    const gscProperty = String(rawGscProperty || '').trim();
    const ga4PropertyId = String(rawGa4PropertyId || '').trim();

    if (!gscProperty || !GSC_PROPERTY_RE.test(gscProperty)) {
      return res.status(400).json({ error: 'gscProperty must be the exact string from Search Console → Settings → Property (e.g. "sc-domain:example.com" or a full URL).' });
    }
    if (!ga4PropertyId || !/^\d+$/.test(ga4PropertyId)) {
      return res.status(400).json({ error: 'ga4PropertyId must be the numeric GA4 property ID (GA4 Admin → Property Settings).' });
    }

    const existing = await getSiteById(siteId);
    if (!existing) return res.status(404).json({ error: `No site found with id ${siteId}.` });

    let site;
    try {
      site = await updateSiteConnection({ siteId, gscProperty, ga4PropertyId, reportEmailTo });
    } catch (err) {
      if (err.code === '23505') {
        return res.status(409).json({ error: 'Another site is already connected to this exact GSC + GA4 property pair.' });
      }
      throw err;
    }

    await recordAuditEvent(req, {
      action: 'tenant.connected',
      targetType: 'site',
      targetId: String(siteId),
      tenantSiteId: siteId,
      tenantName: site.name,
      metadata: { gscProperty, ga4PropertyId, reportEmailTo: reportEmailTo || null },
      success: true,
    });

    const result = await runBaselineSequence(siteId, site);
    if (result.error) return res.status(422).json({ ...result, site });
    res.json(result);
  } catch (e) { next(e); }
});

// Retry — for a site whose GSC/GA4 properties are already saved but the
// baseline never actually completed: `connected: true, baselined: false` in
// the client list above. Real, observed causes: the client's Google access
// hadn't propagated yet on the first /connect attempt (a real 422 above), or
// the site was provisioned via the old CLI scripts before this flow existed.
// Re-runs the exact same real sequence, using the already-saved properties —
// no re-validation/re-save of GSC/GA4 needed.
router.post('/internal/clients/:id/retry-baseline', async (req, res, next) => {
  try {
    const siteId = Number(req.params.id);
    const site = await getSiteById(siteId);
    if (!site) return res.status(404).json({ error: `No site found with id ${siteId}.` });
    if (!site.gsc_property || !site.ga4_property_id) {
      return res.status(400).json({ error: 'This site has no GSC/GA4 properties connected yet — use Connect first, not Retry.' });
    }

    const result = await runBaselineSequence(siteId, site);

    await recordAuditEvent(req, {
      action: 'tenant.baseline_retried',
      targetType: 'site',
      targetId: String(siteId),
      tenantSiteId: siteId,
      tenantName: site.name,
      metadata: { baselineSucceeded: !result.error },
      success: true,
    });

    if (result.error) return res.status(422).json({ ...result, site });
    res.json(result);
  } catch (e) { next(e); }
});

// Optional step 3 — GitHub repo config for the Action Center's PR-apply
// flow. Genuinely optional (many clients won't need it on day one) —
// separate from the required GSC/GA4 connect step above.
router.post('/internal/clients/:id/connect-repo', async (req, res, next) => {
  try {
    const siteId = Number(req.params.id);
    const existing = await getSiteById(siteId);
    if (!existing) return res.status(404).json({ error: `No site found with id ${siteId}.` });

    const { repoOwner, repoName, repoUrl, repoDefaultBranch, techStack, githubPatEnvVar, urlFileMap } = req.body || {};
    if (!repoOwner || !repoName) return res.status(400).json({ error: 'repoOwner and repoName are required.' });

    // A real HTTP surface (not a trusted local CLI operator) — validate the
    // hand-authored mapping actually parses before it's saved, same
    // "never silently accept something malformed" discipline as the
    // GSC/GA4 format checks above. Accepts either an already-parsed object
    // (the UI's own JSON.parse) or a raw string, so this route is safe to
    // call either way.
    let parsedUrlFileMap;
    if (urlFileMap === undefined || urlFileMap === null || urlFileMap === '') {
      parsedUrlFileMap = undefined;
    } else if (typeof urlFileMap === 'object') {
      parsedUrlFileMap = urlFileMap;
    } else {
      try {
        parsedUrlFileMap = JSON.parse(urlFileMap);
      } catch {
        return res.status(400).json({ error: 'urlFileMap is not valid JSON — check for a trailing comma or unmatched bracket.' });
      }
    }

    const site = await updateSiteRepoConfig({ siteId, repoOwner, repoName, repoUrl, repoDefaultBranch, techStack, githubPatEnvVar, urlFileMap: parsedUrlFileMap });

    await recordAuditEvent(req, {
      action: 'tenant.repo_connected',
      targetType: 'site',
      targetId: String(siteId),
      tenantSiteId: siteId,
      tenantName: site.name,
      metadata: { repoOwner, repoName, repoDefaultBranch: repoDefaultBranch || null, techStack: techStack || null },
      success: true,
    });

    res.json({ id: site.id, repoOwner: site.repo_owner, repoName: site.repo_name });
  } catch (e) { next(e); }
});

// OAuth ceiling for this client's "Connect" flow (server/routes/oauth.js,
// server/routes/oauth-consent.js) — the one and only place this value is
// ever written. Deliberately excludes 'admin' from the accepted values (the
// DB CHECK constraint from migration 061 would reject it anyway, but
// failing here gives a clearer error than a raw constraint-violation would).
// See mcp-server/oauth-provider.js's computeEffectivePermissionLevel for how
// this is actually applied to an OAuth grant.
const OAUTH_POLICY_LEVELS = PERMISSION_LEVELS.filter((level) => level !== 'admin');

router.post('/internal/clients/:id/oauth-policy', async (req, res, next) => {
  try {
    const siteId = Number(req.params.id);
    const existing = await getSiteById(siteId);
    if (!existing) return res.status(404).json({ error: `No site found with id ${siteId}.` });

    const { oauthMaxPermissionLevel } = req.body || {};
    if (!OAUTH_POLICY_LEVELS.includes(oauthMaxPermissionLevel)) {
      return res.status(400).json({ error: `oauthMaxPermissionLevel must be one of: ${OAUTH_POLICY_LEVELS.join(', ')}.` });
    }

    const site = await updateSiteOauthPolicy({ siteId, oauthMaxPermissionLevel });

    await recordAuditEvent(req, {
      action: 'tenant.oauth_policy_updated',
      targetType: 'site',
      targetId: String(siteId),
      tenantSiteId: siteId,
      tenantName: site.name,
      metadata: { oauthMaxPermissionLevel },
      success: true,
    });

    res.json({ id: site.id, oauthMaxPermissionLevel: site.oauth_max_permission_level });
  } catch (e) { next(e); }
});

// Sitewide ceiling on how many pages may get a visible on-page FAQ block
// (migration 071) — read by render-inspector.js's inspectRenderMode via
// countVisibleFaqPages (tool-injected count + visible_faq_baseline below) to
// keep visible FAQs selective across a site rather than appearing on every
// eligible page.
router.post('/internal/clients/:id/visible-faq-cap', async (req, res, next) => {
  try {
    const siteId = Number(req.params.id);
    const existing = await getSiteById(siteId);
    if (!existing) return res.status(404).json({ error: `No site found with id ${siteId}.` });

    const { visibleFaqCap } = req.body || {};
    if (!Number.isInteger(visibleFaqCap) || visibleFaqCap < 0) {
      return res.status(400).json({ error: 'visibleFaqCap must be a non-negative integer.' });
    }

    const site = await updateSiteVisibleFaqCap({ siteId, visibleFaqCap });

    await recordAuditEvent(req, {
      action: 'tenant.visible_faq_cap_updated',
      targetType: 'site',
      targetId: String(siteId),
      tenantSiteId: siteId,
      tenantName: site.name,
      metadata: { visibleFaqCap },
      success: true,
    });

    res.json({ id: site.id, visibleFaqCap: site.visible_faq_cap });
  } catch (e) { next(e); }
});

// Scans every page the site has a concrete file mapping for (url_file_map.
// pages — patterns[] template routes aren't enumerable, so aren't included)
// and counts how many already have a genuinely visible, organic FAQ block
// (hasVisibleFaqSignal, render-inspector.js) — i.e. ones this tool never
// touched. Stored as sites.visible_faq_baseline (migration 074) so the
// visible-FAQ cap (above) is checked against the site's TRUE total, not just
// FAQs the tool itself injected. Deliberately staff-triggered, not run on
// every apply — a site's real pages only change outside this tool
// occasionally, so a one-time/on-demand scan here is the right cost/
// freshness tradeoff (see migration 074's comment).
router.post('/internal/clients/:id/recalculate-faq-baseline', async (req, res, next) => {
  try {
    const siteId = Number(req.params.id);
    const site = await getSiteById(siteId);
    if (!site) return res.status(404).json({ error: `No site found with id ${siteId}.` });
    if (!site.repo_owner || !site.repo_name) {
      return res.status(400).json({ error: 'This site has no repo connected yet — connect it via `npm run connect-repo` before recalculating the FAQ baseline.' });
    }

    const pageUrls = Object.keys(site.url_file_map?.pages || {});
    const branch = baseBranch(site);
    const seenFiles = new Set();
    const pagesWithFaq = [];
    let pagesScanned = 0;

    for (const pageUrl of pageUrls) {
      const filePath = resolveFile(site, pageUrl);
      if (!filePath || seenFiles.has(filePath)) continue;
      seenFiles.add(filePath);
      const file = await getFileContent(site, filePath, branch);
      if (!file) continue;
      pagesScanned++;
      if (hasVisibleFaqSignal(file.content)) pagesWithFaq.push(pageUrl);
    }

    const updated = await updateSiteVisibleFaqBaseline({ siteId, visibleFaqBaseline: pagesWithFaq.length });

    await recordAuditEvent(req, {
      action: 'tenant.visible_faq_baseline_recalculated',
      targetType: 'site',
      targetId: String(siteId),
      tenantSiteId: siteId,
      tenantName: site.name,
      metadata: { pagesScanned, visibleFaqBaseline: pagesWithFaq.length, pagesWithFaq },
      success: true,
    });

    res.json({ id: updated.id, visibleFaqBaseline: updated.visible_faq_baseline, pagesScanned, pagesWithFaq });
  } catch (e) { next(e); }
});

// Staff-facing Review Report — real data only (health-score trend, Watchlist
// progress, Fix Verification outcomes, per-agent run activity) since the
// site's real onboarding anchor, synthesized into one narrative. See
// agents/lib/review-report.js for the honest-fallback handling when
// onboarded_at was never set (sites that predate the connect flow above).
router.get('/internal/clients/:id/review', async (req, res, next) => {
  try {
    const siteId = Number(req.params.id);
    const existing = await getSiteById(siteId);
    if (!existing) return res.status(404).json({ error: `No site found with id ${siteId}.` });

    const review = await buildReviewReport(siteId);
    res.json(review);
  } catch (e) { next(e); }
});

// Tenant lifecycle (PLATFORM-ADMIN-DESIGN.md §D, §G.2, §K Phase 3). Path is
// /internal/tenants/..., not /internal/clients/... like every route above —
// deliberate per the design doc's naming, even though this file still
// "extends clients.js" by living here. Hard-delete is Phase 3.5, not here.
//
// Every route below carries its own inline requirePlatformRole('platform_
// admin') on top of this router's own router-level floor (line 22, same
// value today) — so these specific destructive routes don't silently
// inherit whatever the router-level floor becomes if it's ever loosened
// (§G.1).
const companySiteId = Number(process.env.COMPANY_SITE_ID);

// Unconditional, server-side — not a UI-only restriction. Accidentally
// suspending/deleting the company's own tenant would lock out every
// platform staff member simultaneously, with no in-app path to undo it,
// since the undo action itself requires an active platform session (§D).
function rejectCompanySiteTarget(siteId, res) {
  if (companySiteId && siteId === companySiteId) {
    res.status(400).json({ error: 'The company site cannot be suspended or deleted.' });
    return true;
  }
  return false;
}

router.post('/internal/tenants/:id/suspend', requirePlatformRole('platform_admin'), async (req, res, next) => {
  try {
    const siteId = Number(req.params.id);
    if (rejectCompanySiteTarget(siteId, res)) return;

    const existing = await getSiteById(siteId);
    if (!existing) return res.status(404).json({ error: `No site found with id ${siteId}.` });

    const site = await suspendSite(siteId);
    if (!site) return res.status(409).json({ error: `Site is not currently active (status: ${existing.status}).` });

    await recordAuditEvent(req, {
      action: 'tenant.suspended',
      targetType: 'site',
      targetId: String(siteId),
      tenantSiteId: siteId,
      tenantName: site.name,
      success: true,
    });

    res.json({ id: site.id, status: site.status, deactivatedAt: site.deactivated_at });
  } catch (e) { next(e); }
});

router.post('/internal/tenants/:id/reactivate', requirePlatformRole('platform_admin'), async (req, res, next) => {
  try {
    const siteId = Number(req.params.id);
    if (rejectCompanySiteTarget(siteId, res)) return;

    const existing = await getSiteById(siteId);
    if (!existing) return res.status(404).json({ error: `No site found with id ${siteId}.` });

    const site = await reactivateSite(siteId);
    if (!site) return res.status(409).json({ error: `Site is not currently suspended or soft-deleted (status: ${existing.status}).` });

    await recordAuditEvent(req, {
      action: 'tenant.reactivated',
      targetType: 'site',
      targetId: String(siteId),
      tenantSiteId: siteId,
      tenantName: site.name,
      metadata: { previousStatus: existing.status },
      success: true,
    });

    res.json({ id: site.id, status: site.status });
  } catch (e) { next(e); }
});

// Requires 'suspended' as the current state (§D's diagram: ACTIVE ->
// SUSPENDED -> SOFT-DELETED) — a deliberate two-step path, not a shortcut
// straight from active. Data is retained; reversible via /reactivate above
// within a retention window whose exact length is an open design decision
// (PLATFORM-ADMIN-DESIGN.md, "Remaining design decisions") — not enforced
// here, since it hasn't been decided yet.
router.post('/internal/tenants/:id/soft-delete', requirePlatformRole('platform_admin'), async (req, res, next) => {
  try {
    const siteId = Number(req.params.id);
    if (rejectCompanySiteTarget(siteId, res)) return;

    const existing = await getSiteById(siteId);
    if (!existing) return res.status(404).json({ error: `No site found with id ${siteId}.` });

    const site = await softDeleteSite(siteId);
    if (!site) return res.status(409).json({ error: `Site must be suspended before it can be soft-deleted (status: ${existing.status}).` });

    await recordAuditEvent(req, {
      action: 'tenant.soft_deleted',
      targetType: 'site',
      targetId: String(siteId),
      tenantSiteId: siteId,
      tenantName: site.name,
      success: true,
    });

    res.json({ id: site.id, status: site.status, deletedAt: site.deleted_at });
  } catch (e) { next(e); }
});

// Phase 3.5 — deliberately its own route, its own sign-off (PLATFORM-ADMIN-
// DESIGN.md §D, §K): the single highest-blast-radius action in this whole
// design. Irreversible. Only reachable from 'soft_deleted' — never directly
// from 'active' or 'suspended' — and only ever from platform_admin: the
// router-level floor and this route's own inline check are both hardcoded
// to 'platform_admin', not parameterized, so loosening the floor elsewhere
// can't silently widen this specific route.
//
// v1 confirmation bar, explicitly decided (not left ambiguous): typed
// tenant-name re-entry, matching the GitHub/Vercel destructive-action
// pattern. No mandatory reason field, no second-admin approval in v1 — see
// the design doc's "Remaining design decisions" for why that's a stated
// default, not an oversight.
router.post('/internal/tenants/:id/hard-delete', requirePlatformRole('platform_admin'), async (req, res, next) => {
  try {
    const siteId = Number(req.params.id);
    if (rejectCompanySiteTarget(siteId, res)) return;

    const existing = await getSiteById(siteId);
    if (!existing) return res.status(404).json({ error: `No site found with id ${siteId}.` });
    if (existing.status !== 'soft_deleted') {
      return res.status(409).json({ error: `Site must be soft-deleted before it can be hard-deleted (status: ${existing.status}).` });
    }

    const { confirmName } = req.body || {};
    if (typeof confirmName !== 'string' || confirmName.trim() !== existing.name) {
      return res.status(400).json({ error: `Confirmation name does not match. Type the tenant's exact name ("${existing.name}") to confirm.` });
    }

    // Written BEFORE the irreversible DELETE, per §D — so the attempt is on
    // record even if the DELETE below fails partway through. tenantSiteId
    // still points at a real row here; migration 065's SET NULL FK (never
    // CASCADE) is exactly what lets this specific row survive the DELETE
    // that's about to happen.
    await recordAuditEvent(req, {
      action: 'tenant.hard_delete_attempted',
      targetType: 'site',
      targetId: String(siteId),
      tenantSiteId: siteId,
      tenantName: existing.name,
      success: true,
    });

    const deleted = await hardDeleteSite(siteId);
    if (!deleted) {
      // Status changed out from under this request between the read above
      // and the DELETE itself (e.g. reactivated in the meantime) — fail
      // closed rather than guessing at what happened.
      return res.status(409).json({ error: 'Site status changed before the delete could complete — refresh and try again.' });
    }

    // tenantSiteId is deliberately null here, not siteId — that row no
    // longer exists, so referencing it would violate audit_log's own FK.
    await recordAuditEvent(req, {
      action: 'tenant.hard_delete_completed',
      targetType: 'site',
      targetId: String(siteId),
      tenantSiteId: null,
      tenantName: existing.name,
      success: true,
    });

    res.json({ id: siteId, deleted: true });
  } catch (e) { next(e); }
});

export default router;
