import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api } from '../api.js';
import Logo from './Logo.jsx';

const PURPLE = '#6C63FF';

export default function Header({ sites, siteId, onSite, onLogout }) {
  const loc = useLocation();
  const [docUrl, setDocUrl] = useState(null);
  const [dailyDocUrl, setDailyDocUrl] = useState(null);
  const [reportsOpen, setReportsOpen] = useState(false);
  const reportsRef = useRef(null);

  useEffect(() => {
    if (!siteId) return;
    api.docLink(siteId).then((r) => setDocUrl(r.url)).catch(() => setDocUrl(null));
    api.dailyDocLink(siteId).then((r) => setDailyDocUrl(r.url)).catch(() => setDailyDocUrl(null));
  }, [siteId]);

  // Close dropdown when clicking outside.
  useEffect(() => {
    function handle(e) {
      if (reportsRef.current && !reportsRef.current.contains(e.target)) {
        setReportsOpen(false);
      }
    }
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, []);

  const tab = (to, label) => {
    const active = loc.pathname === to;
    return (
      <Link to={to}
        className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
          active ? '' : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
        }`}
        style={active ? { color: PURPLE, background: 'rgba(108,99,255,0.1)' } : undefined}>
        {label}
      </Link>
    );
  };

  const hasReports = docUrl || dailyDocUrl;

  return (
    <header className="sticky top-0 z-20 bg-white/90 backdrop-blur border-b border-slate-100">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center gap-4">
        <div className="flex items-center gap-2">
          <Logo />
          <span className="font-bold tracking-tight text-slate-900">
            Zunkiree&nbsp;Labs <span style={{ color: PURPLE }}>Analytics</span>
          </span>
        </div>

        <nav className="flex gap-1 ml-3 items-center">
          {tab('/', 'Home')}
          {tab('/overview', 'Overview')}
          {tab('/insights', 'Insights')}
          {tab('/compare', 'Compare')}

          {hasReports && (
            <div className="relative" ref={reportsRef}>
              <button
                onClick={() => setReportsOpen((o) => !o)}
                className="px-3 py-1.5 rounded-lg text-sm font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 flex items-center gap-1"
              >
                Reports
                <svg className="w-3.5 h-3.5 opacity-60" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
                </svg>
              </button>

              {reportsOpen && (
                <div className="absolute left-0 top-full mt-1 w-36 bg-white border border-slate-100 rounded-xl shadow-lg py-1 z-50">
                  {dailyDocUrl && (
                    <a href={dailyDocUrl} target="_blank" rel="noreferrer"
                       onClick={() => setReportsOpen(false)}
                       className="flex items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50">
                      <span>📅</span> Daily
                    </a>
                  )}
                  {docUrl && (
                    <a href={docUrl} target="_blank" rel="noreferrer"
                       onClick={() => setReportsOpen(false)}
                       className="flex items-center gap-2 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50">
                      <span>📄</span> Weekly
                    </a>
                  )}
                </div>
              )}
            </div>
          )}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          {sites?.length > 1 && (
            <select value={siteId || ''} onChange={(e) => onSite(Number(e.target.value))}
                    className="text-sm bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-slate-700">
              {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )}
          <button onClick={onLogout} className="text-sm text-slate-500 hover:text-slate-800">Log out</button>
          <div className="w-8 h-8 rounded-full grid place-items-center text-xs font-semibold text-white"
               style={{ background: PURPLE }} title="Zunkiree Labs">ZL</div>
        </div>
      </div>
    </header>
  );
}
