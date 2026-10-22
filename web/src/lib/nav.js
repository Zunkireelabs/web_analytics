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

export function breadcrumbFor(pathname, ctx = {}) {
  if (pathname === SETTINGS_ITEM.to) return ['Settings'];
  if (/^\/clients\/[^/]+\/design-review\/?$/.test(pathname)) return ['Admin', 'Clients', 'Design review'];
  for (const g of visibleGroups(ctx)) {
    const item = g.items.find((i) => i.to === pathname);
    if (item) return [g.label, item.label];
  }
  return [];
}
