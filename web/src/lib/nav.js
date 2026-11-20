import {
  BarChart3, Search, TrendingUp, FileText, Zap, Network, Target,
  LineChart, Building2, Sparkles, Hash, Users, PenLine,
} from 'lucide-react';

// Single source for the Sidebar and the TopBar breadcrumbs.
// ctx = { isProduct }
//
// Ordered by what a client needs first: what is waiting on them, then their workspace, then how the site is doing,
// then the rest. One page per job, every one of them open to every client for their own project (the workspace
// switcher changes the project, so each client sees their own Analyst, Keywords, Competitors and so on):
//
//   Home          Overview
//   Needs you     what is waiting on the client's decision
//     Action Center every issue and fix, with a draft to review and approve
//     Content       the blog posts, landing pages and translations the agent drafts
//   Workspace     projects, goals, people, API tokens, monitoring and settings
//   Performance   how the site is doing: Insights, AI visibility, Keywords, Competitors, Compare, Reports
//   More          Analyst (the AI briefing and growth outlook), Demand (product sites only)
//
// Agents (/ai-orchestration, the run console) is no longer a Browse link: the sidebar's Agent toggle shows the agents
// live instead. It stays registered here with `sidebar: false` so the page and its breadcrumb keep working.
//
// Milestones is gone as its own page: its baseline lives in Reports, and /milestones redirects there (see App.jsx).
// Demand is Universal Product Growth mode's one nav entry, shown only when the current site's property_type is 'product'.
export const NAV_GROUPS = [
  {
    id: 'home', label: 'Home',
    items: [{ to: '/overview', label: 'Overview', icon: BarChart3 }],
    visible: () => true,
  },
  {
    id: 'needs-you', label: 'Needs you',
    items: [
      { to: '/action-center', label: 'Action Center', icon: Zap },
      { to: '/content', label: 'Content', icon: PenLine },
    ],
    visible: () => true,
  },
  {
    id: 'workspace', label: 'Workspace',
    items: [
      { to: '/workspace', label: 'Workspace', icon: Building2 },
    ],
    visible: () => true,
  },
  {
    id: 'performance', label: 'Performance',
    items: [
      { to: '/insights', label: 'Insights', icon: Search },
      { to: '/ai-visibility', label: 'AI visibility', icon: Sparkles },
      { to: '/keywords', label: 'Keywords', icon: Hash },
      { to: '/competitors', label: 'Competitors', icon: Users },
      { to: '/compare', label: 'Compare', icon: TrendingUp },
      { to: '/reports', label: 'Reports', icon: FileText },
    ],
    visible: () => true,
  },
  {
    id: 'more', label: 'More',
    items: [
      { to: '/analyst', label: 'Analyst', icon: LineChart },
      { to: '/demand', label: 'Demand', icon: Target, visible: (ctx) => !!ctx.isProduct },
      { to: '/ai-orchestration', label: 'Agents', icon: Network, sidebar: false },
    ],
    visible: () => true,
  },
];

// The groups as the Browse list shows them: items marked `sidebar: false` are left out, and a group left empty is dropped.
export function sidebarGroups(ctx) {
  return visibleGroups(ctx)
    .map((g) => ({ ...g, items: g.items.filter((i) => i.sidebar !== false) }))
    .filter((g) => g.items.length > 0);
}

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

export function breadcrumbFor(pathname, ctx = {}, search = '') {
  if (/^\/clients\/[^/]+\/design-review\/?$/.test(pathname)) return ['Admin', 'Clients', 'Design review'];
  for (const g of visibleGroups(ctx)) {
    const item = g.items.find((i) => i.to === pathname);
    if (item) return g.label === item.label ? [item.label] : [g.label, item.label];
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
