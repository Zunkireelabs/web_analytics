import { useEffect, useState, lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useNavigate, useLocation } from 'react-router-dom';
import { api } from './api.js';
import Login from './pages/Login.jsx';
import Overview from './pages/Overview.jsx';
import Sidebar from './components/Sidebar.jsx';
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
const ClientOnboarding = lazy(() => import('./pages/ClientOnboarding.jsx'));
const DesignReview = lazy(() => import('./pages/DesignReview.jsx'));
const Analyst = lazy(() => import('./pages/Analyst.jsx'));
const Settings = lazy(() => import('./pages/Settings.jsx'));
const OAuthAuthorize = lazy(() => import('./pages/OAuthAuthorize.jsx'));
const UsersAndTokens = lazy(() => import('./pages/admin/UsersAndTokens.jsx'));
const Monitoring = lazy(() => import('./pages/admin/Monitoring.jsx'));

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const [authed, setAuthed] = useState(null); // null = still checking
  const [isInternal, setIsInternal] = useState(false);
  const [role, setRole] = useState(null);
  const [sites, setSites] = useState([]);
  const [siteId, setSiteId] = useState(null);
  const [sitesLoaded, setSitesLoaded] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const checkSession = () => api.me()
    .then((r) => { setAuthed(r.authed); setIsInternal(!!r.isInternal); setRole(r.role || null); })
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

  return (
    <div className="min-h-screen relative flex">
      {/* soft purple ambiance behind all pages */}
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <div className="absolute -top-32 -right-24 w-[620px] h-[620px] rounded-full blur-3xl"
          style={{ background: 'radial-gradient(circle, rgba(108,99,255,0.12), transparent 60%)' }} />
        <div className="absolute top-1/3 -left-40 w-[520px] h-[520px] rounded-full blur-3xl"
          style={{ background: 'radial-gradient(circle, rgba(139,92,246,0.10), transparent 60%)' }} />
        <div className="absolute bottom-10 right-1/4 w-[460px] h-[460px] rounded-full blur-3xl"
          style={{ background: 'radial-gradient(circle, rgba(108,99,255,0.08), transparent 60%)' }} />
      </div>
      <Sidebar sites={sites} siteId={siteId} isInternal={isInternal} isPlatformAdmin={isPlatformAdmin} onSite={setSiteId} onLogout={logout}
        mobileOpen={mobileNavOpen} onCloseMobile={() => setMobileNavOpen(false)} />
      <main className="flex-1 min-w-0 pt-14 md:pt-0">
        {/* Sidebar becomes an overlay drawer below md — this is its trigger,
            not reachable any other way on a narrow viewport. `main`'s extra
            top padding on mobile keeps page content (which assumes it owns
            the top-left corner, e.g. PageHeader) from sitting under this
            fixed button. */}
        <button type="button" onClick={() => setMobileNavOpen(true)} aria-label="Open menu"
          className="md:hidden fixed top-4 left-4 z-20 w-10 h-10 rounded-xl bg-white border border-slate-200 shadow-sm
                     grid place-items-center text-slate-600 hover:text-slate-900
                     focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#6C63FF]">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M3 6h18M3 12h18M3 18h18" />
          </svg>
        </button>
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
              {/* Every account, not internal-only — same session's own password either way. */}
              <Route path="/settings" element={<Settings />} />
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

      {/* The Growth Assistant is the primary way to interact with the
          platform — reachable from anywhere via this floating trigger, not
          tucked into one page. Client-facing only: it talks to
          server/assistant/'s tenant-isolated capability registry (onboarding
          status, pending decisions, agent activity, safe fixes), not the
          cross-client analyst capability the staff-only Admin Assistant on
          /analyst has. */}
      {!assistantOpen && !hideAssistant && (
        <button type="button" onClick={() => setAssistantOpen(true)}
          className="fixed bottom-6 right-6 z-20 w-14 h-14 rounded-full text-white text-xl shadow-lg
                     hover:scale-105 transition-transform focus-visible:outline focus-visible:outline-2
                     focus-visible:outline-offset-2 focus-visible:outline-[#6C63FF]"
          style={{ background: '#6C63FF', boxShadow: '0 8px 24px -4px rgba(108,99,255,0.5)' }}
          aria-label="Open Growth Assistant">
          ✦
        </button>
      )}
      <ClientAssistantPanel open={assistantOpen && !hideAssistant} onClose={() => setAssistantOpen(false)} />
    </div>
  );
}
