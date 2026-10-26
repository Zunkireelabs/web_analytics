import { Router } from 'express';
import { requireAuth } from './login.js';
import { getUserById, getUserStatus } from '../store/users.js';
import { recordAuditEvent } from '../store/admin/audit-log.js';
import { createApiToken, listApiTokensForSite, revokeApiToken } from '../store/api-tokens.js';
import { gscDailyDataAsOf } from '../store/data-freshness.js';
import { getRecentAgentRunFailureCounts } from '../store/admin/system-health.js';
import { PERMISSION_LEVELS, DEFAULT_PERMISSION_LEVEL } from '../../mcp-server/permissions.js';
import { HttpError, grantProjectAccess, PROJECT_ROLES } from './lib/project-access.js';
import {
  GSC_PROPERTY_RE, listGoogleProperties, suggestGoogleProperties, listGithubRepos, connectionState,
} from './lib/project-connect.js';
import { getSiteById } from '../store/read.js';
import { getGoogleConnection, saveGoogleConnection, deleteGoogleConnection } from '../store/project-google.js';
import {
  googleConnectConfigured, redirectUriFor, newConnectNonce, buildConsentUrl, exchangeCode, GoogleConnectError,
} from '../integrations/google-connect.js';
import { encryptSecret, secretBoxConfigured } from '../lib/secret-box.js';
import { getProjectGoogleAuth, forgetProjectGoogleAuth } from '../auth/project-google.js';
import { updateSiteConnection, updateSiteRepoConfig } from '../db.js';

// Repo discovery, the config audit and the baseline sequence are loaded only
// when a connect or baseline request actually runs. They pull in the whole
// agent/ingestion graph (job.js and everything under it), and at module scope
// that made simply mounting these routes drag that graph in — which is both a
// slower cold start for every request that never connects anything, and what
// broke this router's own tests, whose store mocks cannot satisfy it. A dynamic
// import costs nothing next to the minutes of real network work that follows.
const heavy = {
  baseline: () => import('./clients.js').then((m) => m.runBaselineSequence),
  discovery: () => import('../discovery/run-discovery.js').then((m) => m.runDiscovery),
  audit: () => import('../scripts/audit-url-file-map.js').then((m) => m.auditSite),
  contentConfig: () => import('../lib/derive-repo-content-config.js').then((m) => m.persistDerivedContentConfig),
  designProfile: () => import('../job.js').then((m) => m.queueDesignAgentDerivationForSite),
};
import {
  WORKSPACE_ROLE_RANK, roleAtLeast, getAccessContext, decideSiteAccess, siteRoleFromDecision,
  getProject, getWorkspaceById, validateGoal, setProjectGoal, listGoalsForSites, summarizeProjectHealth,
  listProjectActivity, describeActivity, listProjectMembers, listPendingInvitationsForProject,
  getProjectMembershipRole, updateProjectMemberRole, removeProjectMember,
  effectiveWorkspaceRole, getMembershipRole, transferProject, isPlatformAdmin, softDeleteProject, pickLoginSite,
} from '../store/workspaces.js';

// Everything about ONE project, for the people who manage or watch it: its goal,
// health, API tokens and the people who can open it. A project admin manages just
// that project; a workspace admin or the platform admin reaches the same routes
// for any project in their workspace.
//
// The role is worked out per project from the same access decision requireAuth
// uses (workspace membership, project membership, or platform admin). A person
// with no access to the project gets a 404, so a project id they cannot open is
// never confirmed to exist.
const router = Router();

const companySiteId = () => Number(process.env.COMPANY_SITE_ID);

function requireProjectRole(minRole) {
  if (!WORKSPACE_ROLE_RANK[minRole]) throw new Error(`requireProjectRole: unknown role "${minRole}"`);
  return async function (req, res, next) {
    try {
      const siteId = Number(req.params.siteId);
      if (!Number.isInteger(siteId) || siteId <= 0) return res.status(404).json({ error: 'Not found.' });
      const ctx = await getAccessContext(req.userId, siteId);
      const role = ctx && siteRoleFromDecision(decideSiteAccess({ ...ctx, companySiteId: companySiteId() }));
      if (!role) return res.status(404).json({ error: 'Not found.' });
      if (!roleAtLeast(role, minRole)) return res.status(403).json({ error: 'You need to be a project admin to do that.' });
      const project = await getProject(siteId);
      // A deleted project is gone as far as its people are concerned: every page and action under it is a 404.
      if (!project || project.status === 'soft_deleted') return res.status(404).json({ error: 'Not found.' });
      req.projectId = siteId;
      req.projectRole = role;
      req.project = project;
      next();
    } catch (e) { next(e); }
  };
}

const sendError = (res, e, next) => (e instanceof HttpError ? res.status(e.status).json({ error: e.message }) : next(e));

// Same shape as a workspace overview with a single project in it, so the
// Monitoring screen renders either one.
router.get('/projects/:siteId/overview', requireAuth, requireProjectRole('member'), async (req, res, next) => {
  try {
    const siteId = req.projectId;
    const [goals, failures, activity, freshness] = await Promise.all([
      listGoalsForSites([siteId]),
      getRecentAgentRunFailureCounts(24),
      listProjectActivity(siteId),
      gscDailyDataAsOf(siteId).catch(() => ({ as_of: null })),
    ]);
    const failed = failures.filter((f) => f.site_id === siteId).reduce((n, f) => n + f.failure_count, 0);
    const p = req.project;
    const project = {
      id: p.id, name: p.name, domain: p.website_domain, goal: goals[p.id] || null,
      health: summarizeProjectHealth({ site: p, dataAsOf: freshness?.as_of, agentFailures24h: failed }),
    };
    res.json({
      yourRole: req.projectRole, projects: [project], needsAttention: project.health.status === 'attention' ? 1 : 0,
      activity: activity.map(describeActivity).filter(Boolean),
    });
  } catch (e) { next(e); }
});

router.put('/projects/:siteId/goal', requireAuth, requireProjectRole('admin'), async (req, res, next) => {
  try {
    const check = validateGoal(req.body);
    if (!check.ok) return res.status(400).json({ error: check.reason });
    const saved = await setProjectGoal({ siteId: req.projectId, ...check.goal, userId: req.userId });
    await recordAuditEvent(req, {
      action: 'project.goal_set', targetType: 'site', targetId: String(req.projectId), tenantSiteId: req.projectId, tenantName: req.project.name,
      metadata: { workspaceId: req.project.workspace_id, goal: check.goal.goal }, success: true,
    });
    res.json(saved);
  } catch (e) { next(e); }
});

// WHO MAY PICK FROM THE SHARED ACCOUNTS. Today both pickers list what SuperRank's
// OWN Google account and GitHub app can see — which is every client's Search
// Console property, Analytics property and repository, not just this project's.
// Offering that list to a project admin would let one client read another's
// property names and ids, attach another client's data to their project, or point
// the agent at another client's repo. So until a client connects with their OWN
// Google and GitHub sign-in (which scopes the list to what they can reach), only
// the platform admin may use them. A client still sees where their project stands.
async function canPickFromSharedAccounts(req) {
  return isPlatformAdmin(await getUserById(req.userId), companySiteId());
}
const sharedAccountsOnlyForStaff = (res) => res.status(403).json({
  error: 'SuperRank connects Google and GitHub for you for now. Your project is on the setup list and will be connected from there.',
  code: 'STAFF_CONNECT',
});

// ───────── connecting a project: Google, GitHub, then the baseline ─────────
//
// The self-serve half of what used to be staff-only (/internal/clients/:id/
// connect and /connect-repo). Same stored columns, same baseline sequence, same
// repo discovery and config audit — the difference is that a project admin can
// run it, and that both pickers LIST what the credential can really see instead
// of asking anyone to type a property string or a repo name.

const GOOGLE_ERRORS = {
  cancelled: 'You closed the Google screen before finishing. Nothing was connected.',
  expired: 'That Google sign-in took too long or did not start here. Please try again.',
  denied: 'Your account cannot connect Google for this project.',
  missing_scopes: 'Search Console and Analytics access both need to be allowed on the Google screen. Please try again and leave both ticked.',
  no_refresh_token: 'Google did not return a long-lived sign-in. Please try again and approve the screen in full.',
  exchange_failed: 'Google did not accept the sign-in. Please try again.',
  not_configured: 'Google sign-in is not set up on this server yet.',
};

const googleLists = (auth) => listGoogleProperties({ auth }).catch((err) => {
  console.error('[projects] Google property list failed:', err.message);
  return { searchConsole: { error: 'Google could not be read right now.' }, analytics: { error: 'Google could not be read right now.' } };
});

// When the connected account has exactly ONE Search Console property and ONE Analytics
// property there is nothing to choose, so they are saved without asking. With several, the
// person is asked (the one matching the website address is pre-selected). Pure, so the
// rule is tested without Google.
export function autoPickProperties(lists) {
  const sc = Array.isArray(lists?.searchConsole) ? lists.searchConsole : [];
  const ga = Array.isArray(lists?.analytics) ? lists.analytics : [];
  return {
    gscProperty: sc.length === 1 ? sc[0].property : null,
    ga4PropertyId: ga.length === 1 ? ga[0].propertyId : null,
  };
}

// Everything the connect steps need in one call: where this project stands, what the
// connected Google account can see, and (for staff) the GitHub repos. A Google outage
// must still let someone connect GitHub, so neither list can fail the request.
//
// WHICH Google properties are listed is the security-critical part. A project with its
// OWN Google connection lists only what THAT account can reach. A project without one
// lists nothing — except for the platform admin, who may opt into the shared SuperRank
// account (?shared=1) for projects set up the old way. A client therefore can never see,
// or attach, another client's property.
router.get('/projects/:siteId/connect', requireAuth, requireProjectRole('admin'), async (req, res, next) => {
  try {
    const staff = await canPickFromSharedAccounts(req);
    const own = await getGoogleConnection(req.projectId);
    const useShared = staff && !own && req.query.shared === '1';

    let google = { searchConsole: [], analytics: [] };
    if (own) google = await googleLists(await getProjectGoogleAuth(req.project));
    else if (useShared) google = await googleLists(null);

    res.json({
      project: { id: req.project.id, name: req.project.name, domain: req.project.website_domain },
      state: connectionState(req.project),
      githubRestricted: !staff,
      google: {
        ...google,
        connected: Boolean(own),
        account: own?.google_email || null,
        canConnect: googleConnectConfigured() && secretBoxConfigured(),
        sharedAvailable: staff && !own,
        usingShared: useShared,
        suggested: suggestGoogleProperties(req.project.website_domain, google),
      },
    });
  } catch (e) { next(e); }
});

// GitHub's repositories, fetched on their own when the GitHub step is reached (it calls GitHub once per
// installation, which is slow, and the Google step has no use for it). The list still comes from
// SuperRank's own app, i.e. EVERY client's repos, so it stays staff-only until a client can sign in
// with GitHub and see only their own.
router.get('/projects/:siteId/connect/github', requireAuth, requireProjectRole('admin'), async (req, res, next) => {
  try {
    if (!(await canPickFromSharedAccounts(req))) return res.json({ restricted: true, repos: [], installations: [] });
    res.json(await listGithubRepos().catch((err) => {
      console.error(`[projects] GitHub repo list failed for site ${req.projectId}:`, err.message);
      return { error: 'GitHub could not be read right now.', repos: [], installations: [] };
    }));
  } catch (e) { next(e); }
});

// Step 1 of "Connect with Google": mint a one-time nonce, remember it in THIS session
// (with who and which project), and hand back Google's consent address. Nothing is
// stored yet; the connection only exists once Google sends the person back and the
// nonce matches.
router.get('/projects/:siteId/connect/google/start', requireAuth, requireProjectRole('admin'), async (req, res, next) => {
  try {
    if (!googleConnectConfigured()) return res.status(503).json({ error: GOOGLE_ERRORS.not_configured, code: 'NOT_CONFIGURED' });
    if (!secretBoxConfigured()) return res.status(503).json({ error: 'Storing a Google sign-in safely is not set up on this server yet.', code: 'NO_ENCRYPTION_KEY' });
    const nonce = newConnectNonce();
    const redirectUri = redirectUriFor(`${req.protocol}://${req.get('host')}`);
    req.session.googleConnect = { nonce, siteId: req.projectId, userId: req.userId, redirectUri, at: Date.now() };
    res.json({ url: buildConsentUrl({ redirectUri, state: nonce }) });
  } catch (e) { next(e); }
});

// Step 2: Google sends the browser back here. This is a plain page navigation, not an
// API call, so every outcome ends in a redirect to the Workspace page (which reopens the
// New project popup on the Google step), never a JSON error the person would stare at.
router.get('/google/callback', async (req, res) => {
  const back = (params) => res.redirect(`/workspace?${new URLSearchParams(params)}`);
  const pending = req.session?.googleConnect;
  if (req.session) delete req.session.googleConnect; // single use, whatever happens next
  try {
    if (!req.session?.userId) return res.redirect('/');
    if (req.query.error) return back({ finish: pending?.siteId ?? '', gerror: 'cancelled' });
    // The nonce was minted for this session, this user and this project, and is good for
    // ten minutes: a link copied to someone else, replayed, or left open for a day is refused.
    const fresh = pending && Date.now() - pending.at < 10 * 60 * 1000;
    if (!fresh || !req.query.state || req.query.state !== pending.nonce || pending.userId !== req.session.userId) {
      return back({ gerror: 'expired' });
    }

    if ((await getUserStatus(req.session.userId)) !== 'active') return back({ gerror: 'denied' });
    const ctx = await getAccessContext(req.session.userId, pending.siteId);
    const role = ctx && siteRoleFromDecision(decideSiteAccess({ ...ctx, companySiteId: companySiteId() }));
    if (!role || !roleAtLeast(role, 'admin')) return back({ gerror: 'denied' });
    const project = await getProject(pending.siteId);
    if (!project) return back({ gerror: 'denied' });

    const { refreshToken, email, scopes } = await exchangeCode({ code: String(req.query.code || ''), redirectUri: pending.redirectUri });
    await saveGoogleConnection({
      siteId: project.id, email, refreshTokenEnc: encryptSecret(refreshToken), scopes, connectedBy: req.session.userId,
    });
    forgetProjectGoogleAuth(project.id);
    import('../ingest/ga4.js').then((m) => m.forgetGa4Client(project.id)).catch(() => {});

    const audit = (action, metadata) => recordAuditEvent({ ...req, userId: req.session.userId, siteId: req.session.siteId ?? null }, {
      action, targetType: 'site', targetId: String(project.id), tenantSiteId: project.id, tenantName: project.name,
      metadata: { workspaceId: project.workspace_id, ...metadata }, success: true,
    });
    await audit('project.google_connected', { googleAccount: email });

    // Exactly one Search Console property and one Analytics property on this account:
    // nothing to choose, so save them now and say so. Otherwise leave the choice to the
    // person (the popup reopens with their account's list and the best match selected).
    let saved = false;
    try {
      const picked = autoPickProperties(await googleLists(await getProjectGoogleAuth(project)));
      if (picked.gscProperty && picked.ga4PropertyId) {
        await updateSiteConnection({ siteId: project.id, gscProperty: picked.gscProperty, ga4PropertyId: picked.ga4PropertyId });
        await audit('tenant.connected', { gscProperty: picked.gscProperty, ga4PropertyId: picked.ga4PropertyId, selfServe: true, ownGoogle: true, automatic: true });
        saved = true;
      }
    } catch (err) {
      // e.g. another project already holds this pair (unique) — fall through to asking.
      console.error(`[projects] automatic property save skipped for site ${project.id}:`, err.message);
    }
    return back({ ws: project.workspace_id ?? '', finish: project.id, google: saved ? 'saved' : 'connected' });
  } catch (err) {
    const code = err instanceof GoogleConnectError ? err.code : 'exchange_failed';
    if (!(err instanceof GoogleConnectError)) console.error('[projects] Google callback failed:', err.message);
    return back({ finish: pending?.siteId ?? '', gerror: code });
  }
});

// Stop reading with this person's Google account. The property ids stay on the project
// (they are not secret and the project is still the same site); only the access goes.
router.delete('/projects/:siteId/connect/google', requireAuth, requireProjectRole('admin'), async (req, res, next) => {
  try {
    const removed = await deleteGoogleConnection(req.projectId);
    forgetProjectGoogleAuth(req.projectId);
    import('../ingest/ga4.js').then((m) => m.forgetGa4Client(req.projectId)).catch(() => {});
    if (removed) {
      await recordAuditEvent(req, {
        action: 'project.google_disconnected', targetType: 'site', targetId: String(req.projectId), tenantSiteId: req.projectId, tenantName: req.project.name,
        metadata: { workspaceId: req.project.workspace_id }, success: true,
      });
    }
    res.json({ disconnected: removed });
  } catch (e) { next(e); }
});

router.post('/projects/:siteId/connect/google', requireAuth, requireProjectRole('admin'), async (req, res, next) => {
  try {
    const staff = await canPickFromSharedAccounts(req);
    const own = await getGoogleConnection(req.projectId);
    if (!own && !staff) return res.status(403).json({ error: 'Connect your Google account first.', code: 'GOOGLE_NOT_CONNECTED' });

    const gscProperty = String(req.body?.gscProperty || '').trim();
    const ga4PropertyId = String(req.body?.ga4PropertyId || '').trim();
    if (!gscProperty || !GSC_PROPERTY_RE.test(gscProperty)) {
      return res.status(400).json({ error: 'Choose a Search Console property from the list.' });
    }
    if (!/^\d+$/.test(ga4PropertyId)) {
      return res.status(400).json({ error: 'Choose a Google Analytics property from the list.' });
    }

    // With the project's own connection, both values must be ones THAT account can reach,
    // checked against Google here rather than trusted from the request: naming another
    // client's property by hand cannot work, because this account cannot see it.
    if (own) {
      const lists = await googleLists(await getProjectGoogleAuth(req.project));
      const sc = Array.isArray(lists.searchConsole) && lists.searchConsole.some((r) => r.property === gscProperty);
      const ga = Array.isArray(lists.analytics) && lists.analytics.some((r) => r.propertyId === ga4PropertyId);
      if (!sc || !ga) return res.status(400).json({ error: 'That property is not one your Google account can access.' });
    }

    let site;
    try {
      site = await updateSiteConnection({ siteId: req.projectId, gscProperty, ga4PropertyId });
    } catch (err) {
      // Same guard the staff route has: two projects pointing at one property
      // pair would make every number ambiguous.
      if (err.code === '23505') return res.status(409).json({ error: 'Another project is already connected to this Search Console and Analytics pair.' });
      throw err;
    }
    await recordAuditEvent(req, {
      action: 'tenant.connected', targetType: 'site', targetId: String(req.projectId), tenantSiteId: req.projectId, tenantName: site.name,
      metadata: { workspaceId: req.project.workspace_id, gscProperty, ga4PropertyId, selfServe: true, ownGoogle: Boolean(own) }, success: true,
    });
    res.json({ state: connectionState(site) });
  } catch (e) { next(e); }
});

// Connecting a repo also runs the two things that decide whether the agent can
// ever open a real PR against it: discovery (its framework and URL-to-file map)
// and the config-completeness audit. Both are best-effort — a connect that
// saved the repo must not fail because discovery had a bad minute — and the
// audit's own result is what Integration Health reads back.
router.post('/projects/:siteId/connect/github', requireAuth, requireProjectRole('admin'), async (req, res, next) => {
  try {
    if (!(await canPickFromSharedAccounts(req))) return sharedAccountsOnlyForStaff(res);
    const owner = String(req.body?.repoOwner || '').trim();
    const name = String(req.body?.repoName || '').trim();
    if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(name)) {
      return res.status(400).json({ error: 'Choose a repository from the list.' });
    }

    // The installation id is taken from GitHub's own list, never from the
    // request: a caller-supplied id would let one project mint a token for an
    // installation it was never granted (github/credentials.js treats a stored
    // installation id as authoritative).
    const listing = await listGithubRepos();
    const match = (listing.repos || []).find((r) => r.owner.toLowerCase() === owner.toLowerCase() && r.name.toLowerCase() === name.toLowerCase());
    if (!match) {
      return res.status(400).json({
        error: 'The SuperRank GitHub app cannot reach that repository. Install it on the repository, or add the repository to the existing installation, then try again.',
        installUrl: listing.installUrl || null,
      });
    }

    const branch = String(req.body?.repoDefaultBranch || match.defaultBranch || 'main').trim();

    // Optional stage branch: work is still cut from `branch` (production), but
    // the day's PR is opened into this one. Verified to exist BEFORE anything is
    // saved — a typo here would otherwise fail every PR the agent ever opens,
    // days later, with a GitHub error nobody connects to this field.
    const stageRaw = String(req.body?.prTargetBranch || '').trim();
    const prTargetBranch = stageRaw && stageRaw !== branch ? stageRaw : null;
    if (prTargetBranch) {
      if (!/^[\w./-]+$/.test(prTargetBranch)) return res.status(400).json({ error: 'That branch name has characters a branch cannot have.' });
      try {
        const { getBranchSha } = await import('../github/client.js');
        await getBranchSha({
          repo_owner: match.owner, repo_name: match.name, repo_default_branch: branch,
          github_app_installation_id: Number(match.installationId),
        }, prTargetBranch);
      } catch {
        return res.status(400).json({ error: `There is no "${prTargetBranch}" branch in ${match.fullName}. Create it on GitHub first, or leave this empty to open pull requests into ${branch}.` });
      }
    }

    let site = await updateSiteRepoConfig({
      siteId: req.projectId,
      repoOwner: match.owner,
      repoName: match.name,
      repoUrl: `https://github.com/${match.fullName}`,
      repoDefaultBranch: branch,
      prTargetBranch,
      githubAppInstallationId: Number(match.installationId),
    });

    await recordAuditEvent(req, {
      action: 'tenant.repo_connected', targetType: 'site', targetId: String(req.projectId), tenantSiteId: req.projectId, tenantName: site.name,
      metadata: { workspaceId: req.project.workspace_id, repo: match.fullName, repoDefaultBranch: branch, prTargetBranch, installationId: match.installationId, selfServe: true }, success: true,
    });

    heavy.designProfile()
      .then((queue) => queue(site))
      .catch((err) => console.error(`[projects] could not queue design-profile derivation for site ${req.projectId}:`, err.message));

    let discovery = null;
    try {
      const runDiscovery = await heavy.discovery();
      discovery = await runDiscovery(site);
      if (discovery?.ok) site = (await getSiteById(req.projectId)) || site;
    } catch (err) {
      console.error(`[projects] repo discovery failed for site ${req.projectId}:`, err.message);
    }
    if (discovery?.ok) {
      try {
        const persistDerivedContentConfig = await heavy.contentConfig();
        const content = await persistDerivedContentConfig(site, discovery);
        if (content.applied) site = content.site || site;
      } catch (err) {
        console.error(`[projects] content-config derivation failed for site ${req.projectId}:`, err.message);
      }
    }
    // auditSite reports to the console and persists its gap count onto the site
    // row (db.js's recordActionCenterConfigCheck, migration 088) rather than
    // returning it, so the count is read back from there — the same number
    // Integration Health reads, never a second tally that could disagree.
    try {
      const auditSite = await heavy.audit();
      await auditSite(req.projectId);
      site = (await getSiteById(req.projectId)) || site;
    } catch (err) {
      console.error(`[projects] config-completeness check failed for site ${req.projectId}:`, err.message);
    }

    res.json({
      state: connectionState(site),
      techStack: site.tech_stack || null,
      // What the agent still needs, if anything: a gap count of 0 is a repo the
      // agent can actually apply work to. null means the check could not run,
      // which is NOT the same as clean and is shown as unknown.
      checks: {
        gaps: site.action_center_config_gap_count ?? null,
        checkedAt: site.action_center_config_checked_at || null,
      },
    });
  } catch (e) { next(e); }
});

// The baseline, run by the person who just connected the project — no staff
// step. Refuses before Google is connected rather than producing a baseline
// with no real data behind it.
router.post('/projects/:siteId/baseline', requireAuth, requireProjectRole('admin'), async (req, res, next) => {
  try {
    const site = (await getSiteById(req.projectId)) || req.project;
    const state = connectionState(site);
    // The first baseline is part of setting a project up, so the person who set it
    // up may run it. Running it AGAIN re-runs every analysis agent, which costs
    // real money per click, so that stays with staff.
    if (state.baseline.done && !(await canPickFromSharedAccounts(req))) {
      return res.status(403).json({ error: 'This project already has its baseline. SuperRank re-runs it when it is needed.', code: 'STAFF_CONNECT' });
    }
    if (!state.google.connected) {
      return res.status(409).json({ error: 'Connect Google Search Console and Analytics first — the baseline is built from their real data.' });
    }
    await recordAuditEvent(req, {
      action: 'tenant.baseline_started', targetType: 'site', targetId: String(req.projectId), tenantSiteId: req.projectId, tenantName: site.name,
      metadata: { workspaceId: req.project.workspace_id, selfServe: true }, success: true,
    });
    const runBaselineSequence = await heavy.baseline();
    const result = await runBaselineSequence(req.projectId, site);
    const after = (await getSiteById(req.projectId)) || site;
    if (result.error) return res.status(422).json({ ...result, state: connectionState(after) });
    res.json({ ...result, state: connectionState(after) });
  } catch (e) { next(e); }
});

// ───────── API tokens of this project ─────────

router.get('/projects/:siteId/tokens', requireAuth, requireProjectRole('admin'), async (req, res, next) => {
  try {
    const rows = await listApiTokensForSite(req.projectId);
    res.json(rows.map((t) => ({ ...t, site_id: req.projectId, site_name: req.project.name })));
  } catch (e) { next(e); }
});

router.post('/projects/:siteId/tokens', requireAuth, requireProjectRole('admin'), async (req, res, next) => {
  try {
    const { label, permissionLevel } = req.body || {};
    const level = permissionLevel || DEFAULT_PERMISSION_LEVEL;
    if (!PERMISSION_LEVELS.includes(level)) return res.status(400).json({ error: `Invalid permission level "${level}".` });
    const created = await createApiToken(req.projectId, {
      label: label ? String(label).trim().slice(0, 120) : null, createdBy: req.userId, permissionLevel: level,
    });
    await recordAuditEvent(req, {
      action: 'mcp_token.created', targetType: 'api_token', targetId: String(created.id), tenantSiteId: req.projectId, tenantName: req.project.name,
      metadata: { workspaceId: req.project.workspace_id, label: created.label, permissionLevel: level }, success: true,
    });
    res.status(201).json(created); // includes `token` (raw value), shown once
  } catch (e) { next(e); }
});

router.delete('/projects/:siteId/tokens/:tokenId', requireAuth, requireProjectRole('admin'), async (req, res, next) => {
  try {
    const tokenId = Number(req.params.tokenId);
    const ok = Number.isInteger(tokenId) && (await revokeApiToken(req.projectId, tokenId));
    if (!ok) return res.status(404).json({ error: 'Token not found.' });
    await recordAuditEvent(req, {
      action: 'mcp_token.revoked', targetType: 'api_token', targetId: String(tokenId), tenantSiteId: req.projectId, tenantName: req.project.name,
      metadata: { workspaceId: req.project.workspace_id, tokenId }, success: true,
    });
    res.json({ revoked: true });
  } catch (e) { next(e); }
});

// ───────── who can open this project ─────────

router.get('/projects/:siteId/members', requireAuth, requireProjectRole('member'), async (req, res, next) => {
  try {
    const [members, invitations] = await Promise.all([listProjectMembers(req.projectId), listPendingInvitationsForProject(req.projectId)]);
    // Only the people with access to THIS project. Workspace-wide members are not
    // listed here, so a project-only person never learns who runs the workspace.
    res.json({ project: { id: req.project.id, name: req.project.name }, yourRole: req.projectRole, members, invitations });
  } catch (e) { next(e); }
});

router.post('/projects/:siteId/members', requireAuth, requireProjectRole('admin'), async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const workspace = req.project.workspace_id ? await getWorkspaceById(req.project.workspace_id) : null;
    if (!workspace) return res.status(400).json({ error: 'This project is not in a workspace yet.' });
    const result = await grantProjectAccess(req, workspace, email, req.body?.role || 'member', [req.projectId]);
    res.status(201).json(result);
  } catch (e) { sendError(res, e, next); }
});

router.patch('/projects/:siteId/members/:userId', requireAuth, requireProjectRole('admin'), async (req, res, next) => {
  try {
    const targetId = Number(req.params.userId);
    const role = req.body?.role;
    if (!PROJECT_ROLES.includes(role)) return res.status(400).json({ error: 'role must be admin or member.' });
    // Only project-level access is changed here; a workspace member's role is changed in the workspace.
    if (!(await getProjectMembershipRole(targetId, req.projectId))) return res.status(404).json({ error: 'Member not found.' });
    await updateProjectMemberRole(req.projectId, targetId, role);
    await recordAuditEvent(req, {
      action: 'project.member_role_changed', targetType: 'user', targetId: String(targetId), tenantSiteId: req.projectId, tenantName: req.project.name,
      metadata: { workspaceId: req.project.workspace_id, newRole: role }, success: true,
    });
    res.json({ userId: targetId, role });
  } catch (e) { next(e); }
});

router.delete('/projects/:siteId/members/:userId', requireAuth, requireProjectRole('admin'), async (req, res, next) => {
  try {
    const targetId = Number(req.params.userId);
    if (!(await getProjectMembershipRole(targetId, req.projectId))) return res.status(404).json({ error: 'Member not found.' });
    await removeProjectMember(req.projectId, targetId);
    await recordAuditEvent(req, {
      action: 'project.member_removed', targetType: 'user', targetId: String(targetId), tenantSiteId: req.projectId, tenantName: req.project.name,
      metadata: { workspaceId: req.project.workspace_id }, success: true,
    });
    res.json({ userId: targetId, removed: true });
  } catch (e) { next(e); }
});

// ───────── transfer this project to another workspace ─────────

// Only an owner of the workspace holding the project (or the platform admin) can move
// it, and only into a workspace where they are at least an admin. The target is a 404
// otherwise, so a workspace they cannot touch is never confirmed to exist. With
// keepAccess (the default) everyone who can open it now keeps access to this project.
router.post('/projects/:siteId/transfer', requireAuth, requireProjectRole('owner'), async (req, res, next) => {
  try {
    const toWorkspaceId = Number(req.body?.toWorkspaceId);
    if (!Number.isInteger(toWorkspaceId) || toWorkspaceId <= 0) return res.status(400).json({ error: 'toWorkspaceId is required.' });
    const [target, user, membershipRole] = await Promise.all([getWorkspaceById(toWorkspaceId), getUserById(req.userId), getMembershipRole(req.userId, toWorkspaceId)]);
    const targetRole = target && effectiveWorkspaceRole({ user, membershipRole, companySiteId: companySiteId() });
    if (!targetRole || !roleAtLeast(targetRole, 'admin')) return res.status(404).json({ error: 'Not found.' });
    if (req.project.workspace_id === toWorkspaceId) return res.status(400).json({ error: `${req.project.name} is already in ${target.name}.` });

    const plan = await transferProject({ siteId: req.projectId, toWorkspaceId, keepAccess: req.body?.keepAccess !== false, createdBy: req.userId });
    if (!plan.ok) return res.status(400).json({ error: plan.problems[0] });
    await recordAuditEvent(req, {
      action: 'project.transferred', targetType: 'site', targetId: String(req.projectId), tenantSiteId: req.projectId, tenantName: req.project.name,
      metadata: { workspaceId: toWorkspaceId, fromWorkspaceId: req.project.workspace_id, keptAccess: plan.grants.length }, success: true,
    });
    res.json({ project: { id: req.projectId, name: req.project.name }, workspace: { id: target.id, name: target.name }, keptAccess: plan.grants.map((g) => g.email) });
  } catch (e) { next(e); }
});

// ───────── delete this project ─────────
//
// Owner of the workspace holding the project (or the platform admin) only, and the exact project name has to
// be typed back, the same re-typing the admin screen asks for. It is a soft delete (see softDeleteProject):
// the project leaves every list and the agent stops, but nothing is destroyed, so it can be restored.
// The company's own project can never be deleted from here.
router.delete('/projects/:siteId', requireAuth, requireProjectRole('owner'), async (req, res, next) => {
  try {
    if (req.projectId === companySiteId()) return res.status(400).json({ error: "SuperRank's own project cannot be deleted." });
    if (req.project.status === 'soft_deleted') return res.status(404).json({ error: 'Not found.' });
    const confirmName = String(req.body?.confirmName ?? '').trim();
    if (confirmName !== req.project.name) return res.status(400).json({ error: `Type the project's exact name ("${req.project.name}") to confirm.` });

    if (!(await softDeleteProject(req.projectId))) return res.status(409).json({ error: 'This project could not be deleted right now. Refresh and try again.' });

    // Its stored Google sign-in goes now, not later: a deleted project must not keep a working credential.
    await deleteGoogleConnection(req.projectId);
    forgetProjectGoogleAuth(req.projectId);
    import('../ingest/ga4.js').then((m) => m.forgetGa4Client(req.projectId)).catch(() => {});

    await recordAuditEvent(req, {
      action: 'project.deleted', targetType: 'site', targetId: String(req.projectId), tenantSiteId: req.projectId, tenantName: req.project.name,
      metadata: { workspaceId: req.project.workspace_id, softDelete: true }, success: true,
    });

    // If this was the project they are looking at, move the session to another one they can open (or to none),
    // so their next request is not a 403 against a deleted project.
    let activeSiteId = req.session?.siteId ?? null;
    if (activeSiteId === req.projectId) {
      activeSiteId = await pickLoginSite(await getUserById(req.userId), { companySiteId: companySiteId() });
      req.session.siteId = activeSiteId || null;
    }
    res.json({ deleted: true, activeSiteId });
  } catch (e) { next(e); }
});

export default router;
