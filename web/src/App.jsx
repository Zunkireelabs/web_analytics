import { useEffect, useState, lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { api } from './api.js';
import Login from './pages/Login.jsx';
import Overview from './pages/Overview.jsx';
import Sidebar from './components/Sidebar.jsx';
import TopBar from './components/TopBar.jsx';
import { ShellContext } from './components/shellContext.js';
import { currentSiteOf } from './lib/nav.js';
import ClientAssistantPanel from './components/ClientAssistantPanel.jsx';

// Lazy-loaded: none of these are needed for first paint. The internal-only
// ones (AiGrowth/ActionCenter/ClientOnboarding) also pull in heavy libraries
// (@xyflow/react, react-simple-maps) that would otherwise ship to every
// visitor, including pre-login.
const Insights = lazy(() => import('./pages/Insights.jsx'));
const Compare = lazy(() => import('./pages/Compare.jsx'));
const Reports = lazy(() => import('./pages/Reports.jsx'));
const GrowthReport = lazy(() => import('./pages/GrowthReport.jsx'));
const AiGrowth = lazy(() => import('./pages/AiGrowth.jsx'));
const ActionCenter = lazy(() => import('./pages/ActionCenter.jsx'));
const Demand = lazy(() => import('./pages/Demand.jsx'));
const ClientOnboarding = lazy(() => import('./pages/ClientOnboarding.jsx'));
const DesignReview = lazy(() => import('./pages/DesignReview.jsx'));
const Analyst = lazy(() => import('./pages/Analyst.jsx'));
const Settings = lazy(() => import('./pages/Settings.jsx'));
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
  const [sites, setSites] = useState([]);
  const [siteId, setSiteId] = useState(null);
  const [sitesLoaded, setSitesLoaded] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [toolbarEl, setToolbarEl] = useState(null); // PageToolbar portals into this node

  const checkSession = () => api.me()
    .then((r) => { setAuthed(r.authed); setIsInternal(!!r.isInternal); setRole(r.role || null); setEmail(r.email || null); })
    .catch(() => setAuthed(false));

  // Check session on load.
  useEffect(() => { checkSession(); }, []);

  // A 401 from ANY data call (api.js) means the session is no longer valid —
  // treat it the same as an explicit logout instead of leaving it to whatever
  // page happened to make the failing call.
  useEffect(() => {
    const onUnauthorized = () => setAuthed(false);
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
    if (authed === false && !window.location.pathname.startsWith('/oauth/')) {
      navigate('/', { replace: true });
    }
  }, [authed, navigate]);

  // Load sites once authenticated.
  useEffect(() => {
    if (!authed) return;
    api.sites().then((list) => {
      setSites(list);
      if (list.length) setSiteId(list[0].id);
    }).catch(() => {}).finally(() => setSitesLoaded(true));
  }, [authed]);

  const logout = async () => {
    await api.logout().catch(() => {});
    setAuthed(false);
  };

  if (authed === null) return <div className="p-8 text-gray-400">Loading…</div>;
  if (!authed) return <Login onAuthed={checkSession} />;

  // Standalone account page (Humblytics-style): no sidebar, top bar, toolbar or
  // agent panel — the person's own settings. The in-app /settings holds the
  // workspace and project levels.
  if (location.pathname === '/account') {
    return (
      <Suspense fallback={<div className="p-8 text-faint">Loading…</div>}>
        <Account email={email} role={role} sites={sites} siteId={siteId} onLogout={logout} />
      </Suspense>
    );
  }

  // Platform Administration nav/routes (PLATFORM-ADMIN-DESIGN.md §H, §K
  // Phase 7) — gated on the role dimension directly, not isInternal, since
  // requirePlatformRole('platform_admin') on the server is what actually
  // guards every route these pages call.
  const isPlatformAdmin = role === 'platform_admin';

  // The Analyst page (/analyst) has its own staff-only Admin Assistant
  // (AnalystChatDrawer -> AdminAssistantPanel) scoped to whichever client is
  // selected there — a second floating assistant on top of that would just
  // be two chat entry points fighting for the same corner of the screen, and
  // the client-facing Assistant deliberately does not carry the admin
  // Assistant's cross-client analyst capability anyway.
  const hideAssistant = location.pathname === '/analyst';
  const agentAvailable = !hideAssistant;
  const agentOpen = assistantOpen && agentAvailable;
  const isProduct = currentSiteOf(sites, siteId)?.property_type === 'product';

  return (
    <div className="min-h-screen flex text-sm">
      <Sidebar sites={sites} siteId={siteId} isInternal={isInternal} isPlatformAdmin={isPlatformAdmin} onSite={setSiteId} onLogout={logout}
        mobileOpen={mobileNavOpen} onCloseMobile={() => setMobileNavOpen(false)}
        email={email} role={role} agentOpen={agentOpen} onAgent={setAssistantOpen} agentAvailable={agentAvailable} />
      <div className="flex-1 min-w-0 flex flex-col">
        <TopBar isInternal={isInternal} isPlatformAdmin={isPlatformAdmin} isProduct={isProduct}
          agentOpen={agentOpen} onAgent={setAssistantOpen} agentAvailable={agentAvailable}
          onOpenMenu={() => setMobileNavOpen(true)} />
        <ShellContext.Provider value={toolbarEl}>
          <div ref={setToolbarEl} className="page-toolbar flex flex-wrap items-center gap-2 px-4 md:px-6 py-2 border-b border-border-canvas" />
          <main className="flex-1 min-w-0">
        {siteId ? (
          <Suspense fallback={<div className="p-8 text-gray-400">Loading…</div>}>
            <Routes>
              {/* No standalone marketing homepage in the authenticated app — land straight on AI Growth (the agent runner console, AiGrowth.jsx). */}
              <Route path="/" element={<Navigate to="/ai-orchestration" replace />} />
              <Route path="/overview" element={<Overview siteId={siteId} />} />
              <Route path="/insights" element={<Insights siteId={siteId} />} />
              <Route path="/compare" element={<Compare siteId={siteId} />} />
              <Route path="/reports" element={<Reports siteId={siteId} />} />
              <Route path="/milestones" element={<GrowthReport isInternal={isInternal} />} />
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
              <Route path="/action-center" element={<ActionCenter />} />
              {/* Universal Product Growth mode's one new page — reachable by
                  URL for any session (server-scoped to its own siteId, same
                  as every route above), but Sidebar.jsx only links to it
                  when the session's own site has property_type 'product'. */}
              <Route path="/demand" element={<Demand siteId={siteId} />} />
              {/* Every account, not internal-only — same session's own password either way. */}
              <Route path="/settings" element={<Settings sites={sites} siteId={siteId} role={role} onSite={setSiteId} />} />
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
              {isPlatformAdmin && <Route path="/clients" element={<ClientOnboarding />} />}
              {isPlatformAdmin && <Route path="/clients/:id/design-review" element={<DesignReview />} />}
              {isPlatformAdmin && <Route path="/analyst" element={<Analyst />} />}
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
        ) : !sitesLoaded ? (
          // Distinct from the genuinely-no-site state below — on a fresh
          // page load (hard refresh, deep link, bookmark) this app-level
          // site-list fetch is still in flight for a real, if brief,
          // window; without this the "No site configured" message below
          // flashed misleadingly during that gap, on every single fresh
          // load, not just a real no-site account.
          <div className="p-8 text-gray-400">Loading…</div>
        ) : (
          <div className="max-w-7xl mx-auto px-4 py-10 text-gray-500">
            No site configured yet. Run the migration to seed your site, then ingest some data.
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
  );
}
