import { useEffect, useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { api } from './api.js';
import Login from './pages/Login.jsx';
import Overview from './pages/Overview.jsx';
import Insights from './pages/Insights.jsx';
import Compare from './pages/Compare.jsx';
import Reports from './pages/Reports.jsx';
import CommandCenter from './pages/CommandCenter.jsx';
import AiGrowth from './pages/AiGrowth.jsx';
import ActionCenter from './pages/ActionCenter.jsx';
import Sidebar from './components/Sidebar.jsx';
import CopilotPanel from './components/CopilotPanel.jsx';

export default function App() {
  const [authed, setAuthed] = useState(null); // null = still checking
  const [isInternal, setIsInternal] = useState(false);
  const [sites, setSites] = useState([]);
  const [siteId, setSiteId] = useState(null);
  const [copilotOpen, setCopilotOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  const checkSession = () => api.me()
    .then((r) => { setAuthed(r.authed); setIsInternal(!!r.isInternal); })
    .catch(() => setAuthed(false));

  // Check session on load.
  useEffect(() => { checkSession(); }, []);

  // Load sites once authenticated.
  useEffect(() => {
    if (!authed) return;
    api.sites().then((list) => {
      setSites(list);
      if (list.length) setSiteId(list[0].id);
    }).catch(() => {});
  }, [authed]);

  const logout = async () => {
    await api.logout().catch(() => {});
    setAuthed(false);
  };

  if (authed === null) return <div className="p-8 text-gray-400">Loading…</div>;
  if (!authed) return <Login onAuthed={checkSession} />;

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
      <Sidebar sites={sites} siteId={siteId} isInternal={isInternal} onSite={setSiteId} onLogout={logout}
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
          <Routes>
            {/* No standalone marketing homepage in the authenticated app — land straight on Overview. */}
            <Route path="/" element={<Navigate to="/overview" replace />} />
            <Route path="/overview" element={<Overview siteId={siteId} />} />
            <Route path="/insights" element={<Insights siteId={siteId} />} />
            <Route path="/compare" element={<Compare siteId={siteId} />} />
            <Route path="/reports" element={<Reports siteId={siteId} />} />
            {/* AI Command Center is now the default /ai-growth landing experience;
                the original 7-agent grid moves to /ai-growth/advanced — kept,
                not removed, for anyone who wants to run or inspect one agent. */}
            {isInternal && <Route path="/ai-growth" element={<CommandCenter />} />}
            {isInternal && <Route path="/ai-growth/advanced" element={<AiGrowth />} />}
            {isInternal && <Route path="/action-center" element={<ActionCenter />} />}
          </Routes>
        ) : (
          <div className="max-w-7xl mx-auto px-4 py-10 text-gray-500">
            No site configured yet. Run the migration to seed your site, then ingest some data.
          </div>
        )}
      </main>

      {/* The AI Copilot is the primary way to interact with the platform —
          reachable from anywhere via this floating trigger, not tucked into
          one page. Internal-only, same gate as AI Growth/Action Center. */}
      {isInternal && !copilotOpen && (
        <button type="button" onClick={() => setCopilotOpen(true)}
          className="fixed bottom-6 right-6 z-30 w-14 h-14 rounded-full text-white text-xl shadow-lg
                     hover:scale-105 transition-transform focus-visible:outline focus-visible:outline-2
                     focus-visible:outline-offset-2 focus-visible:outline-[#6C63FF]"
          style={{ background: '#6C63FF', boxShadow: '0 8px 24px -4px rgba(108,99,255,0.5)' }}
          aria-label="Open AI Copilot">
          ✦
        </button>
      )}
      {isInternal && <CopilotPanel open={copilotOpen} onClose={() => setCopilotOpen(false)} />}
    </div>
  );
}
