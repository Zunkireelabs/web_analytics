import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { requireAuth, requireInternalSite } from './login.js';
import { createClientSite, updateSiteConnection, updateSiteRepoConfig } from '../db.js';
import { getSiteById, listSites, getHealthScoreOnOrBefore } from '../store/read.js';
import { getUserByEmail, createUser } from '../store/users.js';
import { listPendingSignupRequests, getSignupRequestById, markSignupRequestReviewed, setSignupRequestCreatedSite } from '../store/signup-requests.js';
import { getLatestAgentRuns } from '../store/agent-runs.js';
import { setOnboardingBaseline } from '../store/upsert.js';
import { startFullSiteAudit } from '../agents/lib/bulk-audit.js';
import { runSiteDiscoveryIfDue, runDailyIngestForSite, runDailyAgentAnalysisForSite } from '../job.js';
import { buildReviewReport } from '../agents/lib/review-report.js';
import { buildGrowthSummary } from '../agents/lib/growth-summary.js';

// Client provisioning, exposed as real routes for the first time this
// session — previously only reachable via server/scripts/create-client.js /
// connect-site.js / connect-repo.js (still preserved, still work, used by
// this same underlying db.js functions). Staff-only (requireInternalSite),
// so gated identically to every other AI Growth Platform route.
const router = Router();
router.use(requireAuth, requireInternalSite);

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
    res.json({ id: site.id, repoOwner: site.repo_owner, repoName: site.repo_name });
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

export default router;
