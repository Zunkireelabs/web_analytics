import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import Logo from './Logo.jsx';
import NotificationBell from './NotificationBell.jsx';
import { 
  BarChart3, 
  Search, 
  TrendingUp, 
  FileText, 
  Sprout, 
  Bot, 
  Zap, 
  Network, 
  Building2 
} from 'lucide-react';

const PURPLE = '#6C63FF';

const NAV = [
  { to: '/overview', label: 'Overview', icon: BarChart3 },
  { to: '/insights', label: 'Insights', icon: Search },
  { to: '/compare', label: 'Compare', icon: TrendingUp },
  { to: '/reports', label: 'Reports', icon: FileText },
  { to: '/growth', label: 'Milestones', icon: Sprout },
];

const INTERNAL_NAV = [
  { to: '/ai-growth', label: 'AI Growth', icon: Bot },
  { to: '/action-center', label: 'Action Center', icon: Zap },
  { to: '/ai-orchestration', label: 'Orchestration', icon: Network },
  { to: '/clients', label: 'Clients', icon: Building2 },
];

export default function Sidebar({ sites, siteId, isInternal, onSite, onLogout, mobileOpen, onCloseMobile }) {
  const loc = useLocation();
  const isActive = (to) => loc.pathname === to;

  useEffect(() => { onCloseMobile?.(); }, [loc.pathname]);

  return (
    <>
      {mobileOpen && (
        <div className="fixed inset-0 bg-slate-900/40 z-30 md:hidden animate-fade-in" onClick={onCloseMobile} aria-hidden="true" />
      )}
      <aside
        className={`fixed md:sticky top-0 left-0 w-60 shrink-0 h-screen flex flex-col bg-white/70 backdrop-blur-md border-r border-slate-200/50 z-40
                    transition-transform duration-200 md:translate-x-0
                    ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}
      >
      <div className="flex items-center gap-2 px-5 py-5 border-b border-slate-100/50">
        <Logo size={28} />
        <span className="font-extrabold tracking-tight text-slate-950 text-[13px] leading-tight flex-1">
          Search <span style={{ color: PURPLE }}>Analytics AI</span>
        </span>
        {isInternal && <NotificationBell />}
        <button onClick={onCloseMobile} aria-label="Close menu"
          className="md:hidden w-7 h-7 rounded-lg grid place-items-center text-slate-400 hover:bg-slate-150 hover:text-slate-700 transition">
          ×
        </button>
      </div>

      <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto custom-scrollbar">
        {NAV.map((n) => <SidebarLink key={n.to} {...n} active={isActive(n.to)} />)}

        {isInternal && (
          <>
            <div className="px-3 pt-6 pb-2 text-[9px] font-black uppercase tracking-widest text-slate-400">Internal Console</div>
            {INTERNAL_NAV.map((n) => <SidebarLink key={n.to} {...n} active={isActive(n.to)} />)}
          </>
        )}
      </nav>

      <div className="px-3 py-4 border-t border-slate-200/50 space-y-3">
        {sites?.length > 1 && (
          <select value={siteId || ''} onChange={(e) => onSite(Number(e.target.value))}
            className="w-full text-xs font-bold bg-white border border-slate-200/80 rounded-xl px-2.5 py-2 text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/10 shadow-sm transition">
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}

        <div className="flex items-center gap-2.5 px-2">
          {sites?.[0]?.logo_data_url ? (
            <img src={sites[0].logo_data_url} alt={sites[0].name}
              style={{ display: 'block', height: 26, width: 'auto', maxWidth: 100 }} className="rounded-lg shadow-sm border border-slate-100" />
          ) : (
            <Logo size={26} />
          )}
          {sites?.[0]?.name && (
            <span className="text-xs font-bold text-slate-600 truncate">{sites[0].name}</span>
          )}
        </div>

        <button onClick={onLogout}
          className="w-full text-left text-xs font-bold text-slate-500 hover:text-slate-800 hover:bg-slate-100/50 px-2.5 py-2 rounded-xl transition">
          Log out
        </button>
      </div>
      </aside>
    </>
  );
}

function SidebarLink({ to, label, icon: Icon, active }) {
  return (
    <Link to={to}
      className={`flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-bold transition-all duration-200 ${
        active 
          ? 'text-indigo-600 bg-indigo-500/10 active-pill-shadow' 
          : 'text-slate-500 hover:text-slate-900 hover:bg-slate-100/60'
      }`}
    >
      <Icon size={15} strokeWidth={active ? 2.5 : 2} className={active ? 'text-indigo-600' : 'text-slate-400 group-hover:text-slate-750 transition-colors'} />
      {label}
    </Link>
  );
}
