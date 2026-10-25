import {
  BarChart3, Search, TrendingUp, FileText, Sprout, Zap, Network, Target,
  Building2, LineChart, Users, HeartPulse, Settings,
} from 'lucide-react';

// Single source for the Sidebar and the TopBar breadcrumbs.
// ctx = { isPlatformAdmin, isProduct }

// Client-facing growth tooling (Action Center, Orchestration) — same page for
// staff and clients alike, each session server-scoped to its own site
// (req.session.siteId), never a staff-only cross-client view.
//
// Demand is Universal Product Growth mode's one nav entry — shown only when the
// current site's own property_type is 'product', never for a 'website' site.
//
// Admin (Clients, Analyst, Users & tokens, Monitoring) operates across every
// client's site. Every route's API surface is requirePlatformRole
// ('platform_admin')-gated server-side, so the whole group is gated on
// isPlatformAdmin, not isInternal: an internal-site session that is only
// tenant_admin/tenant_member has no use for entries whose requests all 404.
export const NAV_GROUPS = [
  {
    id: 'home', label: 'Home',
    items: [{ to: '/overview', label: 'Overview', icon: BarChart3 }],
    visible: () => true,
  },
  {
    id: 'performance', label: 'Performance',
    items: [
      { to: '/insights', label: 'Insights', icon: Search },
      { to: '/compare', label: 'Compare', icon: TrendingUp },
      { to: '/reports', label: 'Reports', icon: FileText },
      { to: '/milestones', label: 'Milestones', icon: Sprout },
    ],
    visible: () => true,
  },
  {
    id: 'optimize', label: 'Optimize',
    items: [
      { to: '/action-center', label: 'Action Center', icon: Zap },
      { to: '/ai-orchestration', label: 'Orchestration', icon: Network },
      { to: '/demand', label: 'Demand', icon: Target, visible: (ctx) => !!ctx.isProduct },
    ],
    visible: () => true,
  },
  {
    id: 'admin', label: 'Admin',
    items: [
      { to: '/clients', label: 'Clients', icon: Building2 },
      { to: '/analyst', label: 'Analyst', icon: LineChart },
      { to: '/admin/users', label: 'Users & tokens', icon: Users },
      { to: '/admin/system-health', label: 'Monitoring', icon: HeartPulse },
    ],
    visible: (ctx) => !!ctx.isPlatformAdmin,
  },
];

// Pinned in the sidebar footer.
export const SETTINGS_ITEM = { to: '/settings', label: 'Settings', icon: Settings };

// Groups (and items) the current session may see.
export function visibleGroups(ctx) {
  return NAV_GROUPS
    .filter((g) => g.visible(ctx))
    .map((g) => ({ ...g, items: g.items.filter((i) => !i.visible || i.visible(ctx)) }));
}

// property_type is the third nav-filter dimension alongside isPlatformAdmin
// (Universal Product Growth mode) — sites is server-scoped to the session's own
// site, so this is always that site, not a staff pick.
export function currentSiteOf(sites, siteId) {
  return sites?.find((s) => s.id === siteId) || sites?.[0] || null;
}

// In-app /settings holds two levels (the person's Account is its own page at
// /account): Workspace and Project, each with tabs. The open level and tab live
// in the query string (?scope=workspace|project&tab=<key>).
export const SETTINGS_TABS = {
  workspace: [{ key: 'general', label: 'General' }, { key: 'projects', label: 'Projects' }, { key: 'team', label: 'Team' }],
  project: [{ key: 'details', label: 'Details' }, { key: 'tokens', label: 'API tokens' }],
};

// → { scope, tab }; a missing/invalid scope falls back to workspace and a
// missing/invalid tab to the scope's first tab.
export function settingsLocation(search = '') {
  const params = new URLSearchParams(search);
  const scope = params.get('scope') === 'project' ? 'project' : 'workspace';
  const tabs = SETTINGS_TABS[scope];
  const tab = tabs.some((t) => t.key === params.get('tab')) ? params.get('tab') : tabs[0].key;
  return { scope, tab };
}

export function breadcrumbFor(pathname, ctx = {}, search = '') {
  if (pathname === SETTINGS_ITEM.to) {
    const { scope, tab } = settingsLocation(search);
    return ['Settings', scope === 'project' ? 'Project' : 'Workspace', SETTINGS_TABS[scope].find((t) => t.key === tab).label];
  }
  if (/^\/clients\/[^/]+\/design-review\/?$/.test(pathname)) return ['Admin', 'Clients', 'Design review'];
  for (const g of visibleGroups(ctx)) {
    const item = g.items.find((i) => i.to === pathname);
    if (item) return [g.label, item.label];
  }
  return [];
}

// Domain line under the site name: the explicit domain, else the GSC
// property with its sc-domain:/https:// prefix and trailing slash removed.
export function siteDomain(site) {
  if (!site) return '';
  if (site.website_domain) return site.website_domain;
  return (site.gsc_property || '').replace(/^sc-domain:/, '').replace(/^https?:\/\//, '').replace(/\/$/, '');
}

export function siteInitials(name) {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return (parts[0] || '?').slice(0, 2).toUpperCase();
}
