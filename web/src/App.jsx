import { useEffect, useState, lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { api, setReadOnlyAccess } from './api.js';
import { AccessProvider } from './lib/access.jsx';
import SuperRankLogin from './pages/SuperRankLogin.jsx';
import SuperRankSignup from './pages/SuperRankSignup.jsx';
import VerifyEmail from './pages/VerifyEmail.jsx';
import Sidebar from './components/Sidebar.jsx';
import TopBar from './components/TopBar.jsx';
import NameWorkspace from './components/workspace/NameWorkspace.jsx';
import NoProjectGate from './components/workspace/NoProjectGate.jsx';
import SetupBanner, { setupGap } from './components/workspace/SetupBanner.jsx';
import { ShellContext } from './components/shellContext.js';
import { currentSiteOf } from './lib/nav.js';
import ClientAssistantPanel from './components/ClientAssistantPanel.jsx';

// Lazy-loaded: none of these are needed for first paint. The internal-only
// ones (AiGrowth/ActionCenter) also pull in heavy libraries
// (@xyflow/react, react-simple-maps) that would otherwise ship to every
// visitor, including pre-login.
const Overview = lazy(() => import('./pages/Overview.jsx'));
const Insights = lazy(() => import('./pages/Insights.jsx'));
const Compare = lazy(() => import('./pages/Compare.jsx'));
const Reports = lazy(() => import('./pages/Reports.jsx'));
const AiGrowth = lazy(() => import('./pages/AiGrowth.jsx'));
const ActionCenter = lazy(() => import('./pages/ActionCenter.jsx'));
const Demand = lazy(() => import('./pages/Demand.jsx'));
const Analyst = lazy(() => import('./pages/Analyst.jsx'));
const Keywords = lazy(() => import('./pages/Keywords.jsx'));
const Competitors = lazy(() => import('./pages/Competitors.jsx'));
const AiVisibility = lazy(() => import('./pages/AiVisibility.jsx'));
const Content = lazy(() => import('./pages/Content.jsx'));
const Workspace = lazy(() => import('./pages/Workspace.jsx'));
const OAuthAuthorize = lazy(() => import('./pages/OAuthAuthorize.jsx'));
const Account = lazy(() => import('./pages/Account.jsx'));
const UsersAndTokens = lazy(() => import('./pages/admin/UsersAndTokens.jsx'));
const Monitoring = lazy(() => import('./pages/admin/Monitoring.jsx'));

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const [authed, setAuthed] = useState(null); // null = still checking
  const [isInternal, setIsInternal] = useState(false);
  const [role, setRole] = useState(null);
  const [email, setEmail] = useState(null);
  const [suggestedName, setSuggestedName] = useState(null); // the company they signed up with, offered as the workspace name
  const [sites, setSites] = useState([]);
  const [siteId, setSiteId] = useState(null);
  const [sitesError, setSitesError] = useState(null); // why the project could not be loaded (suspended, removed, no access)
  const [sitesLoaded, setSitesLoaded] = useState(false);
  const [readOnly, setReadOnly] = useState(false); // read-only member of the active project
  const [noProject, setNoProject] = useState(false); // signed in, but no project yet (a newly approved account)
  const [hasWorkspace, setHasWorkspace] = useState(null); // for a project-less account: null = still checking
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [toolbarEl, setToolbarEl] = useState(null); // PageToolbar portals into this node

  const checkSession = () => api.me()
    .then((r) => { setReadOnly(!!r.readOnly); setReadOnlyAccess(!!r.readOnly); setAuthed(r.authed); setIsInternal(!!r.isInternal); setRole(r.role || null); setEmail(r.email || null); setNoProject(!!r.noProject); setSuggestedName(r.suggestedWorkspaceName || null); })
    .catch(() => setAuthed(false));

  // Check session on load.
  useEffect(() => { checkSession(); }, []);

  // A 401 from ANY data call (api.js) means the session is no longer valid —
  // treat it the same as an explicit logout instead of leaving it to whatever
  // page happened to make the failing call.
  useEffect(() => {
    const onUnauthorized = () => { setReadOnlyAccess(false); setAuthed(false); };
    window.addEventListener('api:unauthorized', onUnauthorized);
    return () => window.removeEventListener('api:unauthorized', onUnauthorized);
  }, []);

  // The authed/unauthed swap below (`if (!authed) return <Login/>`) happens
  // outside <Routes>, so React Router never gets a chance to reconcile the
  // URL on its own — without this, the address bar keeps showing whatever
  // protected path (e.g. /action-center) was last loaded even after the
  // rendered content becomes the logged-out Login page. Whenever we're not
  // authed, force the URL back to '/' so it always matches what's on screen —
  // covers explicit logout, a mid-session expiry caught above, and a stale
  // session landing on a protected URL from a fresh load/hard refresh alike.
  //
  // Exception: an OAuth "Connect" flow (mcp-server/oauth-provider.js redirects
  // an unauthenticated browser here, to /oauth/authorize-consent, carrying
  // client_id/redirect_uri/code_challenge/state/scope in the query string).
  // Rewriting that away to '/' would lose those params before the user even
  // reaches the login form below, so after logging in they'd land on '/'
  // instead of back on the consent screen. Preserving the URL here is what
  // lets <Login> (rendered unconditionally, regardless of path) hand off to
  // <Routes> at the same /oauth/authorize-consent URL once authed flips true.
  useEffect(() => {
    if (authed === false && !window.location.pathname.startsWith('/oauth/') && window.location.pathname !== '/login' && window.location.pathname !== '/signup' && window.location.pathname !== '/verify-email' && window.location.pathname !== '/reset-password') {
      navigate('/', { replace: true });
    }
  }, [authed, navigate]);

  // Load sites once authenticated.
  useEffect(() => {
    if (!authed) return;
    // A project-less account has no sites to load (the server would refuse the
    // call); it only needs the Workspace page, so there is nothing to wait for.
    if (noProject) { setSitesLoaded(true); return; }
    api.sites().then((list) => {
      setSites(list);
      setSitesError(null);
      if (list.length) setSiteId(list[0].id);
    }).catch((e) => setSitesError({ status: e.status || null, message: e.message || '' })).finally(() => setSitesLoaded(true));
  }, [authed, noProject]);

  // The setup banner reads the project's own connection columns, which change in the Add project
  // popup (on the Workspace page) without this list knowing. While a project is unfinished, look
  // again whenever the person moves to another page, so the banner goes the moment it is done.
  useEffect(() => {
    if (!authed || noProject || !siteId || !setupGap(currentSiteOf(sites, siteId))) return;
    api.sites().then(setSites).catch(() => {});
  }, [location.pathname]);

  // A project-less account only gets the full app (sidebar and all) once it has a workspace;
  // before that it sees the guided first screen. The Workspace page announces a new workspace.
  useEffect(() => {
    if (!authed || !noProject) return undefined;
    const check = () => api.workspaces().then((r) => setHasWorkspace((r.workspaces || []).length > 0)).catch(() => setHasWorkspace(false));
    check();
    window.addEventListener('workspaces:changed', check);
    return () => window.removeEventListener('workspaces:changed', check);
  }, [authed, noProject]);

  // Switch the active project. The server verifies the user's workspace
  // membership before changing its session; only then do we reload the site
  // and let the routes below remount (key={siteId}) so every page refetches
  // for the new project instead of showing the previous one's data.
  const switchProject = async (id) => {
    await api.switchProject(id);
    const list = await api.sites();
    setSites(list);
    setSiteId(list[0]?.id ?? id);
    setNoProject(false); // they have a project now: the full app takes over
  };

  const logout = async () => {
    await api.logout().catch(() => {});
    // Signing out lands on the app's own sign-in (app.superrank.si), not the marketing
    // site. Clear what belongs to the session; the effect above puts the URL back at '/'.
    setSites([]); setSiteId(null); setRole(null); setEmail(null); setIsInternal(false); setSitesLoaded(false); setNoProject(false); setHasWorkspace(null);
    setAssistantOpen(false); setMobileNavOpen(false);
    setAuthed(false);
  };

  if (authed === null) return <div className="p-8 text-gray-400">Loading…</div>;
  // The approval email's Sign in button (/login?token=…) wins over a session that is already open: someone
  // still signed in as another account must reach their own "Your account is approved" page, not be sent
  // into the old account's dashboard with the link left unused.
  if (authed && location.pathname === '/login' && new URLSearchParams(location.search).get('token')) {
    return <SuperRankLogin onAuthed={checkSession} />;
  }
  // Signed-out visitors, at /login or the bare app address, get the SuperRank login.
  if (!authed) {
    if (location.pathname === '/signup') return <SuperRankSignup />;
    if (location.pathname === '/verify-email') return <VerifyEmail />;
    return <SuperRankLogin onAuthed={checkSession} />;
  }

  // Standalone account page (Humblytics-style): no sidebar, top bar, toolbar or
  // agent panel — the person's own account settings (profile, sign-in, plan).
  // Workspace things live on the in-app /workspace page.
  if (location.pathname === '/account') {
    return (
      <Suspense fallback={<div className="p-8 text-faint">Loading…</div>}>
        <Account email={email} role={role} sites={sites} siteId={siteId} onLogout={logout} onSwitchProject={switchProject} />
      </Suspense>
    );
  }

  // A newly approved account has a login and nothing else: ask for the workspace name first,
  // on a screen of its own, instead of a sidebar of views that all need a project. Once there is a workspace they get the full app below, whose project pages
  // ask them to add their first project (NoProjectGate).
  if (noProject && hasWorkspace === null) return <div className="p-8 text-gray-400">Loading…</div>;
  if (noProject && !hasWorkspace) return <NameWorkspace suggested={suggestedName} email={email} onLogout={logout} />;

  // Platform Administration nav/routes (PLATFORM-ADMIN-DESIGN.md §H, §K
  // Phase 7) — gated on the role dimension directly, not isInternal, since
  // requirePlatformRole('platform_admin') on the server is what actually
  // guards every route these pages call.
  const isPlatformAdmin = role === 'platform_admin';

  // A platform admin on /analyst has the staff Admin Assistant there (AnalystChatDrawer), so the app-wide
  // Agent panel is hidden on that page for them: two floating assistants would fight for the same corner.
  // Clients have no admin assistant, so they keep the Agent panel on every page, Analyst included.
  const hideAssistant = (isPlatformAdmin && location.pathname === '/analyst') || noProject; // no project, nothing to ask the Agent about
  const agentAvailable = !hideAssistant;
  const agentOpen = assistantOpen && agentAvailable;
  const isProduct = currentSiteOf(sites, siteId)?.property_type === 'product';

  return (
    <AccessProvider value={{ readOnly }}>
    <div className="min-h-screen flex text-sm">
      <Sidebar sites={sites} siteId={siteId} isInternal={isInternal} isPlatformAdmin={isPlatformAdmin} onSwitchProject={switchProject} onLogout={logout}
        mobileOpen={mobileNavOpen} onCloseMobile={() => setMobileNavOpen(false)}
        email={email} role={role} agentOpen={agentOpen} onAgent={setAssistantOpen} agentAvailable={agentAvailable} />
      <div className="flex-1 min-w-0 flex flex-col bg-white md:my-2 md:mr-2 md:rounded-[14px] md:shadow-[0_0_0_1px_var(--panel-ring)] md:overflow-clip md:min-h-[calc(100vh-16px)]">
        <TopBar isInternal={isInternal} isPlatformAdmin={isPlatformAdmin} isProduct={isProduct}
          agentOpen={agentOpen} onAgent={setAssistantOpen} agentAvailable={agentAvailable}
          onOpenMenu={() => setMobileNavOpen(true)} />
        <ShellContext.Provider value={toolbarEl}>
          <div ref={setToolbarEl} className="page-toolbar flex flex-wrap items-center gap-2 px-4 md:px-6 py-2 bg-white border-b border-border-canvas" />
          <main className="flex-1 min-w-0">
        {readOnly && siteId && (
          <div className="mx-4 md:mx-6 mt-4 rounded-card bg-muted px-4 py-2 text-xs text-text" role="status">
            You have read-only access to this project. You can look around, but not change anything.
          </div>
        )}
        {siteId && !readOnly && location.pathname !== '/workspace' && <SetupBanner site={currentSiteOf(sites, siteId)} />}
        {siteId ? (
          <Suspense fallback={<div className="p-8 text-gray-400">Loading…</div>}>
            <Routes key={siteId}>
              {/* No standalone marketing homepage in the authenticated app — signing in lands on Overview, the first item in the sidebar. */}
              <Route path="/" element={<Navigate to="/overview" replace />} />
              <Route path="/login" element={<Navigate to="/" replace />} />
              <Route path="/overview" element={<Overview siteId={siteId} />} />
              <Route path="/insights" element={<Insights siteId={siteId} />} />
              <Route path="/compare" element={<Compare siteId={siteId} />} />
              {/* Reports opens on the Baseline tab (the old Milestones page, folded in), then weekly and monthly. */}
              <Route path="/reports" element={<Reports siteId={siteId} isInternal={isInternal} />} />
              <Route path="/milestones" element={<Navigate to="/reports?tab=baseline" replace />} />
              {/* One page per job, for every client's own project (see lib/nav.js). */}
              <Route path="/ai-visibility" element={<AiVisibility />} />
              <Route path="/keywords" element={<Keywords isProduct={isProduct} />} />
              <Route path="/competitors" element={<Competitors />} />
              <Route path="/content" element={<Content />} />
              <Route path="/content/drafts" element={<ActionCenter scope="content" />} />
              <Route path="/analyst" element={<Analyst siteId={siteId} isPlatformAdmin={isPlatformAdmin} />} />
              {/* /ai-orchestration is Orchestration — the agent runner console
                  and the orchestration diagram showing how the 10 specialist
                  agents actually connect (AiGrowth.jsx), plus (for isInternal
                  sessions) the staff-only Platform Operations section. The
                  standalone "AI Growth" nav item/page was removed — its
                  unique content (competitor overview, executive summary,
                  per-category detail cards, operations history, and the
                  admin agent taskforce/execution timeline/model status) was
                  migrated into this page instead of duplicating it. */}
              <Route path="/ai-orchestration" element={<AiGrowth isInternal={isInternal} />} />
              {/* The fixes side of the drafts board; the writing is on /content. */}
              <Route path="/action-center" element={<ActionCenter scope="fixes" />} />
              {/* Universal Product Growth mode's one new page — reachable by
                  URL for any session (server-scoped to its own siteId, same
                  as every route above), but Sidebar.jsx only links to it
                  when the session's own site has property_type 'product'. */}
              <Route path="/demand" element={<Demand siteId={siteId} />} />
              {/* Workspace: projects, goals, people, API tokens, monitoring, settings. */}
              <Route path="/workspace" element={<Workspace siteId={siteId} onSwitchProject={switchProject} />} />
              {/* The old Settings page is now the Workspace page. */}
              <Route path="/settings" element={<Navigate to="/workspace" replace />} />
              {/* Staff-only — operates across every client's site, not just this
                  session's own. Gated on isPlatformAdmin, NOT isInternal:
                  both routes' entire API surface is requirePlatformRole
                  ('platform_admin')-gated server-side (server/routes/
                  clients.js, dataAnalyst.js, keywords.js all 404 anyone
                  below that role), so an isInternal session that is only
                  tenant_admin/tenant_member on the internal site could reach
                  a page whose every real request 404s — reachable, but
                  useless, and visible in the sidebar for a role that can't
                  use it. Today isInternal and isPlatformAdmin coincide for
                  every account on the internal site (both existing accounts
                  are platform_admin), which is exactly why this went
                  unnoticed; it stops coinciding the moment a non-admin
                  teammate is added. */}
              {/* OAuth "Connect" consent screen — reached via a 302 from
                  mcp-server/oauth-provider.js's authorize(), scoped to this
                  session's own siteId server-side, same as every route above. */}
              <Route path="/oauth/authorize-consent" element={<OAuthAuthorize />} />
              {/* Platform Administration — cross-tenant, platform_admin only.
                  Each page's own API calls are independently guarded by
                  requirePlatformRole('platform_admin') server-side; this
                  gate is routing/UX, not the real access-control boundary. */}
              {isPlatformAdmin && <Route path="/admin/users" element={<UsersAndTokens />} />}
              {isPlatformAdmin && <Route path="/admin/mcp" element={<Navigate to="/admin/users" replace />} />}
              {isPlatformAdmin && <Route path="/admin/system-health" element={<Monitoring />} />}
              {isPlatformAdmin && <Route path="/admin/audit-log" element={<Navigate to="/admin/system-health" replace />} />}
            </Routes>
          </Suspense>
        ) : noProject ? (
          <Suspense fallback={<div className="p-8 text-gray-400">Loading…</div>}>
            <Routes>
              <Route path="/workspace" element={<Workspace siteId={null} onSwitchProject={switchProject} />} />
              <Route path="*" element={<NoProjectGate onOpenProject={async (p) => { await switchProject(p.id); navigate('/overview'); }} />} />
            </Routes>
          </Suspense>
        ) : !sitesLoaded ? (
          // Distinct from the genuinely-no-site state below — on a fresh
          // page load (hard refresh, deep link, bookmark) this app-level
          // site-list fetch is still in flight for a real, if brief,
          // window; without this the "No site configured" message below
          // flashed misleadingly during that gap, on every single fresh
          // load, not just a real no-site account.
          <div className="p-8 text-gray-400">Loading…</div>
        ) : (
          <div className="max-w-7xl mx-auto px-4 py-10 text-gray-500" role="status">
            {sitesError?.status === 403 || sitesError?.status === 404
              ? (/suspend/i.test(sitesError.message)
                ? 'This project is suspended, so it is not available right now. Pick another project from the switcher, or contact SuperRank.'
                : 'This project is no longer available to you: it may have been removed, or your access to it was taken away. Pick another project from the switcher.')
              : sitesError
                ? 'We could not load this project just now. Check your connection and refresh the page.'
                : 'This account has no project yet. Create one from the Workspace page.'}
          </div>
        )}
          </main>
        </ShellContext.Provider>
      </div>

      {/* The Growth Assistant is the primary way to interact with the
          platform — reachable from anywhere via the sidebar's Browse/Agent
          toggle and the top bar's Agent button, not tucked into one page.
          Client-facing only: it talks to server/assistant/'s tenant-isolated
          capability registry (onboarding status, pending decisions, agent
          activity, safe fixes), not the cross-client analyst capability the
          staff-only Admin Assistant on /analyst has. */}
      <ClientAssistantPanel open={agentOpen} onClose={() => setAssistantOpen(false)} />
    </div>
    </AccessProvider>
  );
}
