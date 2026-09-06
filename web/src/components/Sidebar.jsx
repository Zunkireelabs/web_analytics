import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import Logo from './Logo.jsx';
import NotificationBell from './NotificationBell.jsx';
import {
  BarChart3,
  Search,
  TrendingUp,
  FileText,
  Sprout,
  Zap,
  Network,
  Building2,
  Settings as SettingsIcon,
  Users,
  HeartPulse,
  LineChart,
  ChevronDown
} from 'lucide-react';

const PURPLE = '#6C63FF';

const NAV = [
  { to: '/overview', label: 'Overview', icon: BarChart3 },
  { to: '/insights', label: 'Insights', icon: Search },
  { to: '/compare', label: 'Compare', icon: TrendingUp },
  { to: '/reports', label: 'Reports', icon: FileText },
  { to: '/milestones', label: 'Milestones', icon: Sprout },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
];

// Client-facing growth tooling — same page for staff and clients alike,
// each session server-scoped to its own site (req.session.siteId), never a
// staff-only cross-client view.
const GROWTH_TOOLS_NAV = [
  { to: '/action-center', label: 'Action Center', icon: Zap },
  { to: '/ai-orchestration', label: 'Orchestration', icon: Network },
];

// Staff-only pages — operate across every client's site, not just the
// session's own. Both routes' entire API surface is requirePlatformRole
// ('platform_admin')-gated server-side (server/routes/clients.js,
// dataAnalyst.js, keywords.js), so this section is shown on isPlatformAdmin,
// not isInternal — an internal-site session that's only tenant_admin/
// tenant_member has no use for a nav entry whose every real request 404s.
const INTERNAL_NAV = [
  { to: '/clients', label: 'Clients', icon: Building2 },
  { to: '/analyst', label: 'Analyst', icon: LineChart },
];

// Platform Administration (PLATFORM-ADMIN-DESIGN.md §H, §K Phase 7) —
// visually separate from Internal Console above, gated on the role
// dimension (isPlatformAdmin), not isInternal — see App.jsx's own comment
// on why those two are kept distinct even though they coincide today.
const PLATFORM_ADMIN_NAV = [
  { to: '/admin/users', label: 'Users & Tokens', icon: Users },
  { to: '/admin/system-health', label: 'Monitoring', icon: HeartPulse },
];

// Which of the three collapsible nav groups (below) each route belongs to
// — used to auto-expand a group on load/navigation so a deep link never
// lands on a page whose own sidebar entry is hidden behind a collapsed
// section.
const NAV_SECTIONS = [
  { id: 'growth', links: GROWTH_TOOLS_NAV },
  { id: 'internal', links: INTERNAL_NAV },
  { id: 'platform', links: PLATFORM_ADMIN_NAV },
];

const COLLAPSE_STORAGE_KEY = 'sidebar-collapsed-sections';

// Growth Tools starts open, Internal Console/Platform Administration start
// collapsed — matches the approved sidebar mockup. Only applies until the
// user first toggles something; from then on their saved choice wins.
const DEFAULT_COLLAPSED = { internal: true, platform: true };

function loadCollapsedSections() {
  try {
    const saved = JSON.parse(localStorage.getItem(COLLAPSE_STORAGE_KEY));
    if (saved) return saved;
  } catch {
    // fall through to default
  }
  return DEFAULT_COLLAPSED;
}

export default function Sidebar({ sites, siteId, isInternal, isPlatformAdmin, onSite, onLogout, mobileOpen, onCloseMobile }) {
  const loc = useLocation();
  const isActive = (to) => loc.pathname === to;
  const [collapsed, setCollapsed] = useState(loadCollapsedSections);

  const toggleSection = (id) => {
    setCollapsed((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  };

  useEffect(() => { onCloseMobile?.(); }, [loc.pathname]);

  useEffect(() => {
    const active = NAV_SECTIONS.find((s) => s.links.some((n) => n.to === loc.pathname));
    if (!active) return;
    setCollapsed((prev) => {
      if (!prev[active.id]) return prev;
      const next = { ...prev, [active.id]: false };
      localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, [loc.pathname]);

  // Locks background scroll while the mobile drawer is open — otherwise a
  // scroll/swipe gesture that starts on the backdrop or overscrolls past the
  // drawer's own nav can chain through to the page behind it. Locks both
  // <html> and <body>: which one is actually the page's scrolling element
  // is browser/doctype-dependent (confirmed here — Chrome delegates scroll
  // to document.documentElement, not body, so locking body alone did
  // nothing), so both get the same treatment rather than guessing.
  useEffect(() => {
    if (!mobileOpen) return;
    const html = document.documentElement;
    const prevHtmlOverflow = html.style.overflow;
    const prevBodyOverflow = document.body.style.overflow;
    html.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';
    return () => {
      html.style.overflow = prevHtmlOverflow;
      document.body.style.overflow = prevBodyOverflow;
    };
  }, [mobileOpen]);

  return (
    <>
      {mobileOpen && (
        <div className="fixed inset-0 bg-slate-900/40 z-40 md:hidden animate-fade-in" onClick={onCloseMobile} aria-hidden="true" />
      )}
      {/* `position: fixed` and the slide-in/out `transform` are deliberately
          on two different elements, not one. Combining them on the same
          element is a known WebKit/mobile-Safari bug: a `transform`
          (needed here for the slide animation) pushes the element into its
          own compositing layer, and that layer can desync from the true
          viewport during/after a scroll of the page behind it — the drawer
          then visually renders as if it scrolled along with the page,
          instead of staying pinned. This outer element only ever
          establishes the fixed/sticky position and never gets a transform;
          the inner one carries the transform and all the visible content.
          The outer element is `pointer-events-none` — its box always spans
          the full 240px×100vh area even while the inner drawer is slid
          off-screen, and without this it would permanently block clicks to
          whatever sits behind that area (the mobile hamburger button
          included, at every screen this renders on) whether the drawer is
          open or not. The inner element re-enables pointer events for
          itself, which is all that should ever actually catch a click, and
          since a translated element's hit-testing moves with its paint
          position, that's correctly only wherever the drawer currently is
          on screen. */}
      <aside className="fixed md:sticky top-0 left-0 w-60 shrink-0 h-screen z-40 pointer-events-none">
        <div
          className={`h-full w-full flex flex-col bg-white/70 backdrop-blur-md border-r border-slate-200/50 pointer-events-auto
                      transition-transform duration-200 md:translate-x-0
                      ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}
        >
          <div className="flex items-center gap-2 px-5 py-5 border-b border-slate-100/50">
            <Logo size={28} />
            <span className="font-extrabold tracking-tight text-slate-950 text-[13px] leading-tight flex-1 min-w-0 truncate">
              Search <span style={{ color: PURPLE }}>Analytics AI</span>
            </span>
            {isInternal && <NotificationBell />}
            <button onClick={onCloseMobile} aria-label="Close menu"
              className="md:hidden w-10 h-10 rounded-lg grid place-items-center text-lg text-slate-400 hover:bg-slate-150 hover:text-slate-700 transition shrink-0">
              ×
            </button>
          </div>

          <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto custom-scrollbar">
            {NAV.map((n) => <SidebarLink key={n.to} {...n} active={isActive(n.to)} />)}

            <SidebarSection id="growth" label="Growth Tools" tint="text-[#6C63FF] hover:text-[#6C63FF]/80"
              links={GROWTH_TOOLS_NAV} isActive={isActive} open={!collapsed.growth} onToggle={toggleSection} />

            {isPlatformAdmin && (
              <SidebarSection id="internal" label="Internal Console" tint="text-[#6C63FF] hover:text-[#6C63FF]/80"
                links={INTERNAL_NAV} isActive={isActive} open={!collapsed.internal} onToggle={toggleSection} />
            )}

            {isPlatformAdmin && (
              <SidebarSection id="platform" label="Platform Administration" tint="text-[#6C63FF] hover:text-[#6C63FF]/80"
                links={PLATFORM_ADMIN_NAV} isActive={isActive} open={!collapsed.platform} onToggle={toggleSection} />
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
        </div>
      </aside>
    </>
  );
}

function SidebarSection({ id, label, tint, links, isActive, open, onToggle }) {
  return (
    <div>
      <button
        type="button"
        onClick={() => onToggle(id)}
        aria-expanded={open}
        className={`w-full flex items-center justify-between gap-2 px-3 pt-6 pb-2 text-[9px] font-black uppercase tracking-widest transition-colors cursor-pointer ${tint}`}
      >
        <span>{label}</span>
        <ChevronDown size={12} strokeWidth={2.5} className={`transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && links.map((n) => <SidebarLink key={n.to} {...n} active={isActive(n.to)} />)}
    </div>
  );
}

function SidebarLink({ to, label, icon: Icon, active }) {
  return (
    <Link to={to}
      className={`group flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-xs font-bold transition-all duration-200 ${
        active
          ? 'text-indigo-600 bg-indigo-500/10 active-pill-shadow'
          : 'text-slate-500 hover:text-slate-900 hover:bg-slate-100/60'
      }`}
    >
      <Icon size={15} strokeWidth={active ? 2.5 : 2} className={active ? 'text-indigo-600' : 'text-slate-400 group-hover:text-slate-600 transition-colors'} />
      {label}
    </Link>
  );
}
