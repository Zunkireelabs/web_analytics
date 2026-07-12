import { Link, useLocation } from 'react-router-dom';
import Logo from './Logo.jsx';

const PURPLE = '#6C63FF';

export default function Header({ sites, siteId, isInternal, onSite, onLogout }) {
  const loc = useLocation();

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

  return (
    <header className="sticky top-0 z-20 bg-white/90 backdrop-blur border-b border-slate-100">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3 flex items-center gap-4">
        <div className="flex items-center gap-2">
          <Logo />
          <span className="font-bold tracking-tight text-slate-900">
            Search <span style={{ color: PURPLE }}>Analytics AI</span>
          </span>
        </div>

        <nav className="flex gap-1 ml-3 items-center">
          {tab('/', 'Home')}
          {tab('/overview', 'Overview')}
          {tab('/insights', 'Insights')}
          {tab('/compare', 'Compare')}
          {tab('/reports', 'Reports')}
          {isInternal && tab('/ai-growth', 'AI Growth')}
          {isInternal && tab('/action-center', 'Action Center')}
        </nav>

        <div className="ml-auto flex items-center gap-3">
          {sites?.length > 1 && (
            <select value={siteId || ''} onChange={(e) => onSite(Number(e.target.value))}
                    className="text-sm bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-slate-700">
              {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )}
          {sites?.[0]?.logo_data_url ? (
            <img src={sites[0].logo_data_url} alt={sites[0].name}
                 style={{ display: 'block', height: 40, width: 'auto', maxWidth: 160 }} />
          ) : (
            <Logo size={40} />
          )}
          {sites?.[0]?.name && (
            <span className="text-base font-medium text-slate-600 max-w-[160px] truncate">{sites[0].name}</span>
          )}
          <button onClick={onLogout} className="text-sm text-slate-500 hover:text-slate-800">Log out</button>
        </div>
      </div>
    </header>
  );
}
