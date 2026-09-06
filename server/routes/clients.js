import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { requireAuth, requirePlatformRole } from './login.js';

import { createClientSite, updateSiteConnection, updateSiteRepoConfig, updateSiteOauthPolicy, updateSiteVisibleFaqCap, updateSiteLearnedRepair, updateSiteVisibleFaqBaseline, updateSiteAuthorProfile, updateSiteAutoRemediation, updateSiteDesignReview, suspendSite, reactivateSite, softDeleteSite, hardDeleteSite } from '../db.js';
import {
  getDesignProfile, siteHasUsableDesignProfile, designReviewFingerprint,
  verifyProfileRoles, checkTypographyRole, TYPOGRAPHY_ROLE_SOURCE, observedClassesByRole,
} from '../implementers/lib/design-drift.js';
import { projectAllComponentTemplates } from '../design-agent/lib/design-profile.js';

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
import { safeMessage } from '../lib/errors.js';
import { startFullSiteAudit } from '../agents/lib/bulk-audit.js';
import { runSiteDiscoveryIfDue, runDailyIngestForSite, runDailyAgentAnalysisForSite, queueDesignAgentDerivationForSite, queueDesignProfileDerivationForOnboarding } from '../job.js';
import { buildReviewReport } from '../agents/lib/review-report.js';
import { buildDesignReviewReport } from '../agents/lib/design-review.js';
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
// Names test suites insert as throwaway `sites` fixtures (see e.g.
// server/design-agent/worker.test.js). Each of those tests cleans up after
// itself in an `after()` hook, but a hard-killed run (a dev restart or
// aborted CI job) skips that hook and leaves the row behind permanently —
// filtered here so staff-facing client lists don't accumulate that debris.
const TEST_FIXTURE_SITE_NAMES = new Set(['design-agent-worker.test.js fixture']);

router.get('/internal/clients', async (req, res, next) => {
  try {
    const sites = (await listSites()).filter((s) => !TEST_FIXTURE_SITE_NAMES.has(s.name));
    res.json(sites.map((s) => ({
      id: s.id, name: s.name, websiteDomain: s.website_domain, timezone: s.timezone,
      connected: !!(s.gsc_property && s.ga4_property_id),
      baselined: !!s.onboarded_at,
      repoConnected: !!(s.repo_owner && s.repo_name),
      repoOwner: s.repo_owner,
      repoName: s.repo_name,
      githubPatEnvVar: s.github_pat_env_var,
      githubAppInstallationId: s.github_app_installation_id,
      onboardedAt: s.onboarded_at, createdAt: s.created_at,
      oauthMaxPermissionLevel: s.oauth_max_permission_level,
      visibleFaqCap: s.visible_faq_cap,
      visibleFaqBaseline: s.visible_faq_baseline,
      authorName: s.author_name,
      authorRole: s.author_role,
      authorUrl: s.author_url,
      requireVisibleByline: s.require_visible_byline,
      autoRemediationEnabled: s.auto_remediation_enabled,
      autoRemediationDailyLimit: s.auto_remediation_daily_limit,
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
      const { message } = safeMessage('clients.createClient', err, 'the login could not be created');
      return res.status(500).json({ error: `Site #${site.id} was created, but ${message} — finish it via \`npm run create-client -- <email> <password> --site-id ${site.id}\`.`, siteId: site.id });
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
      const { message } = safeMessage('clients.approveSignupRequest', err, 'the login could not be created');
      return res.status(500).json({ error: `Site #${site.id} was created, but ${message} — finish it via \`npm run create-client -- <email> <password> --site-id ${site.id}\`.`, siteId: site.id });
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
  // Design-integrity-gate proposal, change 01: the design read LEADS
  // onboarding, queued before anything else, so the browser capture runs
  // while discovery/ingestion/the site audit below are still working — by
  // the time the rest of this sequence finishes, the profile is usually
  // ready for staff to review. Fire-and-forget like startFullSiteAudit
  // further down: a queue-insert failure must never fail onboarding itself,
  // and needs only a reachable live URL — no repo, no auto-remediation
  // grant (queueDesignProfileDerivationForOnboarding is deliberately
  // repo-independent; see its own comment in job.js for why gating it on
  // either would deadlock the whole design-review gate on itself).
  queueDesignProfileDerivationForOnboarding(site).catch((err) => {
    console.error(`[clients] site ${siteId} onboarding design-profile derivation failed to queue:`, err.message);
  });

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
    const { message } = safeMessage('clients.runBaselineSequence', err, 'GSC/GA4 data could not be fetched right now');
    return {
      error: `Couldn't fetch real GSC/GA4 data — ${message}. Confirm the platform's Google account has been granted access to this exact property, then retry — nothing was fabricated in place of this.`,
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
// separate from the required GSC/GA4 connect step above. On a genuinely
// first-time connection, this is also the single moment a tenant enters full
// autonomy: see the auto_remediation_enabled block below.
router.post('/internal/clients/:id/connect-repo', async (req, res, next) => {
  try {
    const siteId = Number(req.params.id);
    const existing = await getSiteById(siteId);
    if (!existing) return res.status(404).json({ error: `No site found with id ${siteId}.` });

    const { repoOwner, repoName, repoUrl, repoDefaultBranch, techStack, githubPatEnvVar, githubAppInstallationId, urlFileMap } = req.body || {};
    if (!repoOwner || !repoName) return res.status(400).json({ error: 'repoOwner and repoName are required.' });

    // Mirrors connect-repo.js's own validation: an integer id, or null/'none'
    // to move the site back onto its PAT. Left undefined, the existing value
    // (often auto-populated by the GitHub App installation webhook, see
    // webhooks.js) is untouched.
    let parsedGithubAppInstallationId;
    if (githubAppInstallationId === undefined) {
      parsedGithubAppInstallationId = undefined;
    } else if (githubAppInstallationId === null || githubAppInstallationId === '' || githubAppInstallationId === 'none') {
      parsedGithubAppInstallationId = null;
    } else {
      parsedGithubAppInstallationId = Number(githubAppInstallationId);
      if (!Number.isInteger(parsedGithubAppInstallationId)) {
        return res.status(400).json({ error: 'githubAppInstallationId must be an integer (or null/"none" to clear it).' });
      }
    }

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

    let site = await updateSiteRepoConfig({ siteId, repoOwner, repoName, repoUrl, repoDefaultBranch, techStack, githubPatEnvVar, githubAppInstallationId: parsedGithubAppInstallationId, urlFileMap: parsedUrlFileMap });

    // Full onboarding autonomy: a genuinely first-time repo connection
    // automatically grants the same consent the platform_admin-only
    // /auto-remediation route below exists to collect by hand — no separate
    // manual click, no per-tenant setup, so every newly onboarded client
    // enters the self-healing/auto-remediation pipeline the moment its repo
    // is connected. See shouldAutoEnableOnConnect's own comment for why this
    // is scoped to first connections only.
    if (shouldAutoEnableOnConnect({ existing, site })) {
      site = await updateSiteAutoRemediation({ siteId, enabled: true, dailyLimit: site.auto_remediation_daily_limit });
      await recordAuditEvent(req, {
        action: 'tenant.auto_remediation_enabled',
        targetType: 'site',
        targetId: String(siteId),
        tenantSiteId: siteId,
        tenantName: site.name,
        metadata: { enabled: true, dailyLimit: site.auto_remediation_daily_limit, autoEnabledAtOnboarding: true },
        success: true,
      });
    }

    // Best-effort: a repo connect must succeed even if this queue-insert
    // fails, since the 06:00 daily sweep (job.js) picks up any site still
    // missing a profile as a fallback. This just removes the wait for sites
    // connected mid-day.
    queueDesignAgentDerivationForSite(site).catch((err) =>
      console.error(`[clients] could not queue design-profile derivation for site ${site.id}:`, err.message)
    );

    await recordAuditEvent(req, {
      action: 'tenant.repo_connected',
      targetType: 'site',
      targetId: String(siteId),
      tenantSiteId: siteId,
      tenantName: site.name,
      metadata: { repoOwner, repoName, repoDefaultBranch: repoDefaultBranch || null, techStack: techStack || null, githubAppInstallationId: site.github_app_installation_id },
      success: true,
    });

    res.json({
      id: site.id, repoOwner: site.repo_owner, repoName: site.repo_name,
      githubAppInstallationId: site.github_app_installation_id,
      autoRemediationEnabled: site.auto_remediation_enabled,
      autoRemediationDailyLimit: site.auto_remediation_daily_limit,
    });
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


// Consent for cross-client learned repair (migration 099): may this site be
// fixed automatically using a repair whose evidence comes from a DIFFERENT
// client's site.
//
// platform_admin only, inherited from this router's own
// requirePlatformRole('platform_admin') — not re-declared, same as every
// route in this file. That gate is the point here rather than an
// implementation detail: the blast radius is a real pull request against this
// client's repository, justified by something that happened on someone
// else's.
//
// Enabling is refused unless auto_remediation_enabled is already on. The two
// are separate consents and interceptWithLearnedRepairs requires both, so
// allowing this one alone would produce a setting that reads as enabled and
// can never do anything — the silent-inert failure this feature is most prone
// to. Disabling is always allowed.
router.post('/internal/clients/:id/learned-repair', async (req, res, next) => {
  try {
    const siteId = Number(req.params.id);
    const existing = await getSiteById(siteId);
    if (!existing) return res.status(404).json({ error: `No site found with id ${siteId}.` });

    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be true or false.' });
    if (enabled && !existing.auto_remediation_enabled) {
      return res.status(400).json({
        error: 'Autonomous fixes are off for this site, so learned cross-client repairs could never run. Enable autonomous fixes first.',
      });
    }

    const site = await updateSiteLearnedRepair({ siteId, enabled });

    await recordAuditEvent(req, {
      action: enabled ? 'tenant.learned_repair_enabled' : 'tenant.learned_repair_disabled',
      targetType: 'site',
      targetId: String(siteId),
      tenantSiteId: siteId,
      tenantName: site.name,
      metadata: { enabled },
      success: true,
    });

    res.json({ id: site.id, learnedRepairEnabled: site.learned_repair_enabled });
  } catch (e) { next(e); }
});

// The switch for the unattended auto-remediation loop
// (agents/lib/auto-remediation.js): draft -> approve -> push branch -> open
// PR, every morning, with no human in the loop until the PR review itself.
//
// platform_admin only — inherited from this router's own
// requirePlatformRole('platform_admin') at the top of the file, not
// re-declared here, same as every other route in this file. That is
// deliberate for this one: the blast radius is real pull requests against a
// customer's own repository, so it is not a tenant-level self-service
// setting.
//
// Enabling is REFUSED when the site has no repo wired. Without that guard
// the switch would appear to work and then do nothing every morning —
// auto-remediation would run, reach approveAndPublishDraft, and fail per
// item with a GitHub error, burning the daily budget on a misconfiguration
// rather than saying so once, here, at the moment someone asks for it.
// (Live at the time of writing: 3 of 4 real client sites had no
// repo_owner/repo_name at all.)
// Exported and pure so the rules that decide whether a site may run
// unattended are unit-testable without an HTTP layer (this repo has no
// supertest convention). Returns null when the request is acceptable, or the
// customer-facing reason it isn't.
// Whether a connect-repo request (routes/clients.js's own /connect-repo
// route, above) should ALSO auto-grant the same auto_remediation_enabled
// consent the admin-only route just below normally collects by hand. Pure
// and exported, same reasoning as validateAutoRemediationRequest's own
// comment (no supertest convention in this repo — decision logic has to be
// testable on its own).
//
// `existing` is the site row from BEFORE this connect-repo request ran;
// `site` is the row AFTER updateSiteRepoConfig already saved the new repo
// config. Scoped to a genuinely FIRST connection (existing had no
// repo_owner/repo_name at all) — re-saving an already-connected site's repo
// config (a different owner/name, a refreshed url_file_map) must never
// silently re-flip this back on. There is no separate "an admin explicitly
// disabled this" flag in the schema, so this is the only way to avoid
// overwriting that decision: a site that already had a repo could only have
// auto_remediation_enabled=false because either nobody has enabled it yet
// (correct to grant now, but that already happened on ITS first connection)
// or a human turned it off on purpose (must never be silently reversed by a
// routine config edit). Reuses validateAutoRemediationRequest itself rather
// than duplicating its rules, so the two paths can never drift apart.
export function shouldAutoEnableOnConnect({ existing, site }) {
  const isFirstRepoConnection = !existing?.repo_owner && !existing?.repo_name;
  if (!isFirstRepoConnection || site?.auto_remediation_enabled) return false;
  const invalid = validateAutoRemediationRequest({
    enabled: true, dailyLimit: site?.auto_remediation_daily_limit, site,
  });
  return !invalid;
}

// The design-review-approve mirror of shouldAutoEnableOnConnect above.
// validateAutoRemediationRequest no longer requires a design review at all
// (see its own comment — that gate is now automated per-draft at ship time,
// not a whole-site precondition), so shouldAutoEnableOnConnect above already
// auto-grants on a first repo connection in the common case. This stays as a
// second, harmless auto-grant path for a site that connected its repo before
// a passing check existed, or was manually left disabled, and then has its
// design reviewed by a human choosing to use the optional review screen.
//
// `existing` is the site row from BEFORE this approval saved (`site` is the
// row after updateSiteDesignReview saved it) — scoped to a genuinely FIRST
// design-review approval for this site (existing.design_review_at was null)
// for the identical reason shouldAutoEnableOnConnect scopes to a first repo
// connection: a RE-approval (after a stale rescan) must never silently
// re-flip a switch a human may have deliberately turned off in between.
export function shouldAutoEnableOnDesignReviewApproval({ existing, site }) {
  const isFirstApproval = !existing?.design_review_at;
  if (!isFirstApproval || site?.auto_remediation_enabled) return false;
  const invalid = validateAutoRemediationRequest({
    enabled: true, dailyLimit: site?.auto_remediation_daily_limit, site,
  });
  return !invalid;
}

export function validateAutoRemediationRequest({ enabled, dailyLimit, site }) {
  if (typeof enabled !== 'boolean') return 'enabled must be true or false.';
  // Matches migration 101's own CHECK (>= 0) rather than inventing a second,
  // stricter bound the DB wouldn't enforce.
  if (!Number.isInteger(dailyLimit) || dailyLimit < 0) return 'dailyLimit must be a non-negative integer.';
  // Only blocks ENABLING. Disabling a site that somehow lost its repo config
  // must always be allowed — refusing to turn autonomy off would be the
  // wrong way round.
  if (enabled && !(site?.repo_owner && site?.repo_name)) {
    return 'This site has no GitHub repository connected, so autonomous fixes would have nowhere to open a pull request. Connect a repo first, then enable autonomy.';
  }
  // Human design sign-off is no longer a prerequisite here — a confirmed
  // role-mismatch (design-drift.js's verifyProfileRoles, the same check that
  // catches the zunkireelabs.com incident class) is now validated
  // automatically, per draft, at ship time (checkDesignIntegrityGate in
  // backend.js/frontend.js), not as a whole-site precondition to enabling
  // autonomy at all. A staff review screen still exists (design-review.js) for
  // a human who wants to look, but approving it is optional, not required.
  return null;
}

router.post('/internal/clients/:id/auto-remediation', async (req, res, next) => {
  try {
    const siteId = Number(req.params.id);
    const existing = await getSiteById(siteId);
    if (!existing) return res.status(404).json({ error: `No site found with id ${siteId}.` });

    const { enabled, dailyLimit } = req.body || {};
    const invalid = validateAutoRemediationRequest({ enabled, dailyLimit, site: existing });
    if (invalid) return res.status(400).json({ error: invalid });

    const site = await updateSiteAutoRemediation({ siteId, enabled, dailyLimit });

    await recordAuditEvent(req, {
      action: enabled ? 'tenant.auto_remediation_enabled' : 'tenant.auto_remediation_disabled',
      targetType: 'site',
      targetId: String(siteId),
      tenantSiteId: siteId,
      tenantName: site.name,
      metadata: { enabled, dailyLimit, repo: `${site.repo_owner}/${site.repo_name}` },
      success: true,
    });

    res.json({
      id: site.id,
      autoRemediationEnabled: site.auto_remediation_enabled,
      autoRemediationDailyLimit: site.auto_remediation_daily_limit,
    });

  } catch (e) { next(e); }
});

// The site's real author/byline identity (migration 090) — a human,
// staff-confirmed fact, never inferred. Once set, schema.js and
// expand-content.js's author-byline focus draft the real thing instead of a
// "[Author Name]" placeholder, which is what lets geo-signals.js's "missing
// author signal" finding (already routed to expand-content, already
// 'safe'-tier) get fully auto-remediated instead of staying a permanent
// recommendation nothing could ever act on.
router.post('/internal/clients/:id/author-profile', async (req, res, next) => {
  try {
    const siteId = Number(req.params.id);
    const existing = await getSiteById(siteId);
    if (!existing) return res.status(404).json({ error: `No site found with id ${siteId}.` });

    const { authorName, authorRole, authorUrl, requireVisibleByline } = req.body || {};
    if (authorUrl) {
      try { new URL(authorUrl); } catch { return res.status(400).json({ error: 'authorUrl must be a valid URL.' }); }
    }

    const site = await updateSiteAuthorProfile({ siteId, authorName, authorRole, authorUrl, requireVisibleByline });

    await recordAuditEvent(req, {
      action: 'tenant.author_profile_updated',
      targetType: 'site',
      targetId: String(siteId),
      tenantSiteId: siteId,
      tenantName: site.name,
      metadata: { authorName: site.author_name, authorRole: site.author_role, requireVisibleByline: site.require_visible_byline },
      success: true,
    });

    res.json({
      id: site.id, authorName: site.author_name, authorRole: site.author_role,
      authorUrl: site.author_url, requireVisibleByline: site.require_visible_byline,
    });
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

// The design-integrity gate's review screen (design-integrity-gate
// proposal, change 03): every section the design agent found on this site's
// real pages, every template it would write in the site's style, and the
// role-verification verdict + real example behind each — see
// agents/lib/design-review.js's buildDesignReviewReport for the full
// contract. Read-only; GETs never require anything be reviewed already.
router.get('/internal/clients/:id/design-review', async (req, res, next) => {
  try {
    const siteId = Number(req.params.id);
    const site = await getSiteById(siteId);
    if (!site) return res.status(404).json({ error: `No site found with id ${siteId}.` });

    res.json(buildDesignReviewReport(site));
  } catch (e) { next(e); }
});

// Staff sign-off. Pins design_review_fingerprint to the profile AS IT
// EXISTS RIGHT NOW — never a value the client sent — so an approval can only
// ever mean "I looked at what this route is showing me at this moment",
// never "I looked at something, trust me". Refuses when there is no usable
// profile to approve at all (nothing to sign off on) — a site in that state
// stays 'unreviewed', the correct honest default (migration 132).
router.post('/internal/clients/:id/design-review/approve', async (req, res, next) => {
  try {
    const siteId = Number(req.params.id);
    const existing = await getSiteById(siteId);
    if (!existing) return res.status(404).json({ error: `No site found with id ${siteId}.` });

    const before = buildDesignReviewReport(existing);
    if (!before.hasProfile || !before.currentFingerprint) {
      return res.status(400).json({ error: 'This site has no design profile yet — nothing to approve. Wait for the design analysis to finish, or trigger a re-derivation first.' });
    }

    let site = await updateSiteDesignReview({ siteId, reviewedBy: req.userId, fingerprint: before.currentFingerprint });

    await recordAuditEvent(req, {
      action: 'tenant.design_review_approved',
      targetType: 'site',
      targetId: String(siteId),
      tenantSiteId: siteId,
      tenantName: site.name,
      metadata: { fingerprint: before.currentFingerprint, templateVerdicts: Object.fromEntries(before.templates.map((t) => [t.actionType, t.ok])) },
      success: true,
    });

    // Same "one combined setup action" auto-grant shouldAutoEnableOnConnect
    // already does for a first repo connection — see
    // shouldAutoEnableOnDesignReviewApproval's own comment for why this is
    // the necessary mirror of it, not a duplicate.
    if (shouldAutoEnableOnDesignReviewApproval({ existing, site })) {
      site = await updateSiteAutoRemediation({ siteId, enabled: true, dailyLimit: site.auto_remediation_daily_limit });
      await recordAuditEvent(req, {
        action: 'tenant.auto_remediation_enabled',
        targetType: 'site',
        targetId: String(siteId),
        tenantSiteId: siteId,
        tenantName: site.name,
        metadata: { enabled: true, dailyLimit: site.auto_remediation_daily_limit, autoEnabledAtDesignReview: true },
        success: true,
      });
    }

    res.json(buildDesignReviewReport(site));
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
