import { useEffect, useState } from 'react';
import { Routes, Route } from 'react-router-dom';
import { api } from './api.js';
import Login from './pages/Login.jsx';
import Home from './pages/Home.jsx';
import Overview from './pages/Overview.jsx';
import Insights from './pages/Insights.jsx';
import Compare from './pages/Compare.jsx';
import AiGrowth from './pages/AiGrowth.jsx';
import ActionCenter from './pages/ActionCenter.jsx';
import Header from './components/Header.jsx';

export default function App() {
  const [authed, setAuthed] = useState(null); // null = still checking
  const [isInternal, setIsInternal] = useState(false);
  const [sites, setSites] = useState([]);
  const [siteId, setSiteId] = useState(null);

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
    <div className="min-h-screen relative">
      {/* soft purple ambiance behind all pages */}
      <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
        <div className="absolute -top-32 -right-24 w-[620px] h-[620px] rounded-full blur-3xl"
          style={{ background: 'radial-gradient(circle, rgba(108,99,255,0.12), transparent 60%)' }} />
        <div className="absolute top-1/3 -left-40 w-[520px] h-[520px] rounded-full blur-3xl"
          style={{ background: 'radial-gradient(circle, rgba(139,92,246,0.10), transparent 60%)' }} />
        <div className="absolute bottom-10 right-1/4 w-[460px] h-[460px] rounded-full blur-3xl"
          style={{ background: 'radial-gradient(circle, rgba(108,99,255,0.08), transparent 60%)' }} />
      </div>
      <Header sites={sites} siteId={siteId} isInternal={isInternal} onSite={setSiteId} onLogout={logout} />
      {siteId ? (
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/overview" element={<Overview siteId={siteId} />} />
          <Route path="/insights" element={<Insights siteId={siteId} />} />
          <Route path="/compare" element={<Compare siteId={siteId} />} />
          {isInternal && <Route path="/ai-growth" element={<AiGrowth />} />}
          {isInternal && <Route path="/action-center" element={<ActionCenter />} />}
        </Routes>
      ) : (
        <div className="max-w-7xl mx-auto px-4 py-10 text-gray-500">
          No site configured yet. Run the migration to seed your site, then ingest some data.
        </div>
      )}
    </div>
  );
}
