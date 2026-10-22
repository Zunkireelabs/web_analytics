import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ChevronDown, ChevronsUpDown, LogOut, Settings as SettingsIcon } from 'lucide-react';
import Logo from './Logo.jsx';
import Avatar from './Avatar.jsx';
import Button from './Button.jsx';
import SegmentedTabs from './SegmentedTabs.jsx';
import { ROLE_LABELS } from './RoleBadge.jsx';
import { visibleGroups, SETTINGS_ITEM, currentSiteOf, siteDomain, siteInitials } from '../lib/nav.js';

const COLLAPSE_STORAGE_KEY = 'sidebar-collapsed-sections';

// Every group starts open. Only applies until the user first toggles
// something; from then on their saved choice wins.
const DEFAULT_COLLAPSED = {};

function loadCollapsedSections() {
  try {
    const saved = JSON.parse(localStorage.getItem(COLLAPSE_STORAGE_KEY));
    if (saved) return saved;
  } catch {
    // fall through to default
  }
  return DEFAULT_COLLAPSED;
}

// Initials from an email, same rule as Avatar.jsx (this app has no display name).
function emailInitials(email) {
  if (!email) return '?';
  const local = email.split('@')[0] || '';
  const parts = local.split(/[.\-_+]/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return local.slice(0, 2).toUpperCase() || '?';
}

export default function Sidebar({
  sites, siteId, isInternal, isPlatformAdmin, onSite, onLogout, mobileOpen, onCloseMobile,
  email, role, agentOpen, onAgent, agentAvailable,
}) {
  const loc = useLocation();
  const isActive = (to) => loc.pathname === to;
  const [collapsed, setCollapsed] = useState(loadCollapsedSections);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef(null);

  const currentSite = currentSiteOf(sites, siteId);
  const groups = visibleGroups({ isPlatformAdmin, isProduct: currentSite?.property_type === 'product' });

  const toggleSection = (id) => {
    setCollapsed((prev) => {
      const next = { ...prev, [id]: !prev[id] };
      localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  };

  useEffect(() => { onCloseMobile?.(); setMenuOpen(false); }, [loc.pathname]);

  // User menu: closes on outside mousedown and Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e) => { if (!menuRef.current?.contains(e.target)) setMenuOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [menuOpen]);

  // Auto-expand the group containing the current route so a deep link never
  // lands on a page whose own sidebar entry is hidden behind a collapsed group.
  useEffect(() => {
    const active = groups.find((g) => g.items.some((n) => n.to === loc.pathname));
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
        <div className="fixed inset-0 bg-neutral-900/40 z-40 md:hidden animate-fade-in" onClick={onCloseMobile} aria-hidden="true" />
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
          the full 256px×100vh area even while the inner drawer is slid
          off-screen, and without this it would permanently block clicks to
          whatever sits behind that area (the TopBar's Menu button
          included, at every screen this renders on) whether the drawer is
          open or not. The inner element re-enables pointer events for
          itself, which is all that should ever actually catch a click, and
          since a translated element's hit-testing moves with its paint
          position, that's correctly only wherever the drawer currently is
          on screen. */}
      <aside className="fixed md:sticky top-0 left-0 w-60 shrink-0 h-screen z-40 pointer-events-none">
        <div
          className={`h-full w-full flex flex-col bg-canvas border-r border-border-canvas md:border-r-0 pointer-events-auto
                      transition-transform duration-200 md:translate-x-0
                      ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}
        >
          <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-2">
            <Logo wordmark size={20} className="text-[17px]" />
            <Button variant="ghost" size="sm" icon aria-label="Close menu" className="md:hidden" onClick={onCloseMobile}>
              <span aria-hidden className="text-base leading-none">×</span>
            </Button>
          </div>

          <div className="relative mx-3 mb-2 rounded-[10px] bg-white px-2 py-1.5 flex items-center gap-2.5"
            style={{ boxShadow: 'var(--ring)' }}>
            {currentSite?.logo_data_url ? (
              <img src={currentSite.logo_data_url} alt="" className="w-6 h-6 rounded-[7px] object-contain shrink-0" />
            ) : (
              <span className="w-6 h-6 rounded-[7px] bg-primary text-white text-[10px] font-medium grid place-items-center shrink-0">
                {siteInitials(currentSite?.name)}
              </span>
            )}
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-fg truncate">{currentSite?.name || 'No site'}</div>
              <div className="text-xs text-faint truncate">{siteDomain(currentSite)}</div>
            </div>
            {sites?.length > 1 && (
              <>
                <ChevronsUpDown size={14} className="text-faint shrink-0" aria-hidden />
                <select value={siteId || ''} onChange={(e) => onSite(Number(e.target.value))} aria-label="Switch site"
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer">
                  {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </>
            )}
          </div>

          {agentAvailable && (
            <div className="mx-3 mb-1.5">
              <SegmentedTabs
                className="w-full [&>button]:flex-1"
                options={[{ value: 'browse', label: 'Browse' }, { value: 'agent', label: 'Agent' }]}
                value={agentOpen ? 'agent' : 'browse'}
                onChange={(v) => onAgent(v === 'agent')}
              />
            </div>
          )}

          <nav className="flex-1 overflow-y-auto px-3 py-1.5 custom-scrollbar">
            {groups.map((g, i) => (
              <SidebarGroup key={g.id} group={g} first={i === 0} isActive={isActive}
                open={!collapsed[g.id]} onToggle={toggleSection} />
            ))}
          </nav>

          <div className="border-t border-border-canvas px-3 pt-2 pb-3">
            <SidebarLink {...SETTINGS_ITEM} active={isActive(SETTINGS_ITEM.to)} />
            <div className="relative" ref={menuRef}>
              {menuOpen && (
                <div role="menu" className="absolute left-0 right-0 bottom-full mb-1.5 z-50 bg-white rounded-card overflow-hidden text-sm"
                  style={{ boxShadow: '0 0 0 1px rgba(0,0,0,.06), 0 20px 40px -12px rgba(0,0,0,.18)' }}>
                  <div className="flex items-center gap-2.5 px-3 py-3">
                    <span className="w-8 h-8 rounded-control bg-primary text-white text-xs font-medium grid place-items-center shrink-0">
                      {emailInitials(email)}
                    </span>
                    <div className="min-w-0">
                      <div className="font-medium truncate">{email || 'Signed in'}</div>
                      <div className="text-xs text-faint truncate">{ROLE_LABELS[role] || role || ''}</div>
                    </div>
                  </div>
                  <div className="border-t border-border p-1">
                    <Link to="/account" role="menuitem" onClick={() => { setMenuOpen(false); onCloseMobile?.(); }}
                      className="flex items-center gap-2.5 h-[34px] px-2.5 rounded-control hover:bg-muted">
                      <SettingsIcon size={15} className="text-[#7a7a7a]" /> Account settings
                    </Link>
                  </div>
                  <div className="border-t border-border p-1">
                    <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onLogout(); }}
                      className="w-full flex items-center gap-2.5 h-[34px] px-2.5 rounded-control hover:bg-muted text-[#b42318] text-left">
                      <LogOut size={15} /> Sign out
                    </button>
                  </div>
                </div>
              )}
              <button type="button" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}
                className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-control hover:bg-black/[.03] text-left">
                <Avatar email={email} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium text-fg truncate">{email || 'Signed in'}</div>
                  <div className="text-xs text-faint truncate">{ROLE_LABELS[role] || role || ''}</div>
                </div>
                <ChevronsUpDown size={14} className="text-faint shrink-0" aria-hidden />
              </button>
            </div>
          </div>
        </div>
      </aside>
    </>
  );
}

function SidebarGroup({ group, first, isActive, open, onToggle }) {
  return (
    <div>
      <button
        type="button"
        onClick={() => onToggle(group.id)}
        aria-expanded={open}
        className={`w-full flex items-center gap-1.5 px-2.5 ${first ? 'pt-2' : 'pt-3.5'} pb-1 text-[11px] font-medium tracking-[.08em] uppercase text-faint cursor-pointer`}
      >
        <span>{group.label}</span>
        <ChevronDown size={10} className={`transition-transform duration-200 ${open ? '' : '-rotate-90'}`} />
      </button>
      {open && group.items.map((n) => <SidebarLink key={n.to} {...n} active={isActive(n.to)} />)}
    </div>
  );
}

function SidebarLink({ to, label, icon: Icon, active }) {
  return (
    <Link to={to} aria-current={active ? 'page' : undefined}
      className={`flex items-center gap-2 h-[30px] px-2.5 rounded-control text-sm ${
        active ? 'bg-white text-fg font-medium' : 'text-[#262626] font-medium hover:bg-black/[.03]'
      }`}
      style={active ? { boxShadow: 'var(--ring)' } : undefined}
    >
      <Icon size={15} strokeWidth={1.75} className={active ? 'text-primary' : 'text-[#5c5c5c]'} />
      {label}
    </Link>
  );
}
