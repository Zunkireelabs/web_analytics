import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';
import Logo from './Logo.jsx';
import NotificationBell from './NotificationBell.jsx';

const PURPLE = '#6C63FF';

const NAV = [
  { to: '/overview', label: 'Overview', icon: '📊' },
  { to: '/insights', label: 'Insights', icon: '🔍' },
  { to: '/compare', label: 'Compare', icon: '📈' },
  { to: '/reports', label: 'Reports', icon: '🗒️' },
];

const INTERNAL_NAV = [
  { to: '/ai-growth', label: 'AI Growth', icon: '🤖' },
  { to: '/action-center', label: 'Action Center', icon: '⚡' },
];

// `mobileOpen`/`onCloseMobile` drive a slide-in drawer below the `md`
// breakpoint (~768px) — below that width there's no room to reserve 240px
// permanently, so the sidebar becomes an overlay instead of persistent
// in-flow content. At `md:` and above it behaves exactly as before
// (persistent, sticky, always visible) — nothing changes for desktop.
export default function Sidebar({ sites, siteId, isInternal, onSite, onLogout, mobileOpen, onCloseMobile }) {
  const loc = useLocation();
  const isActive = (to) => loc.pathname === to || loc.pathname.startsWith(`${to}/`);

  // Close the drawer automatically on navigation — a user tapping a nav
  // link expects the menu to get out of the way, not stay open over the
  // page they just chose.
  useEffect(() => { onCloseMobile?.(); }, [loc.pathname]);

  return (
    <>
      {mobileOpen && (
        <div className="fixed inset-0 bg-slate-900/40 z-30 md:hidden" onClick={onCloseMobile} aria-hidden="true" />
      )}
      <aside
        className={`fixed md:sticky top-0 left-0 w-60 shrink-0 h-screen flex flex-col bg-white border-r border-slate-100 z-40
                    transition-transform duration-200 md:translate-x-0
                    ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}
      >
      <div className="flex items-center gap-2 px-5 py-5">
        <Logo />
        <span className="font-bold tracking-tight text-slate-900 text-sm leading-tight flex-1">
          Search <span style={{ color: PURPLE }}>Analytics AI</span>
        </span>
        {isInternal && <NotificationBell />}
        <button onClick={onCloseMobile} aria-label="Close menu"
          className="md:hidden w-7 h-7 rounded-lg grid place-items-center text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition">
          ×
        </button>
      </div>

      <nav className="flex-1 px-3 space-y-0.5 overflow-y-auto">
        {NAV.map((n) => <SidebarLink key={n.to} {...n} active={isActive(n.to)} />)}

        {isInternal && (
          <>
            <div className="px-3 pt-5 pb-1.5 text-[10px] font-bold uppercase tracking-wider text-slate-400">Internal</div>
            {INTERNAL_NAV.map((n) => <SidebarLink key={n.to} {...n} active={isActive(n.to)} />)}
          </>
        )}
      </nav>

      <div className="px-3 py-4 border-t border-slate-100 space-y-3">
        {sites?.length > 1 && (
          <select value={siteId || ''} onChange={(e) => onSite(Number(e.target.value))}
            className="w-full text-sm bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-slate-700">
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}

        <div className="flex items-center gap-2.5 px-2">
          {sites?.[0]?.logo_data_url ? (
            <img src={sites[0].logo_data_url} alt={sites[0].name}
              style={{ display: 'block', height: 28, width: 'auto', maxWidth: 100 }} />
          ) : (
            <Logo size={28} />
          )}
          {sites?.[0]?.name && (
            <span className="text-sm font-medium text-slate-600 truncate">{sites[0].name}</span>
          )}
        </div>

        <button onClick={onLogout}
          className="w-full text-left text-sm text-slate-500 hover:text-slate-800 hover:bg-slate-50 px-2 py-1.5 rounded-lg transition-colors">
          Log out
        </button>
      </div>
      </aside>
    </>
  );
}

function SidebarLink({ to, label, icon, active }) {
  return (
    <Link to={to}
      className={`flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
        active ? '' : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
      }`}
      style={active ? { color: PURPLE, background: 'rgba(108,99,255,0.1)' } : undefined}>
      <span>{icon}</span>{label}
    </Link>
  );
}
