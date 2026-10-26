import {
  BarChart3, Search, TrendingUp, FileText, Zap, Network, Target,
  LineChart, Building2, Sparkles, Hash, Users, PenLine, UserPlus,
} from 'lucide-react';

// Single source for the Sidebar and the TopBar breadcrumbs.
// ctx = { isProduct }
//
// One page per job, every one of them open to every client for their own project
// (the workspace switcher changes the project, so each client — and a platform
// admin switched into a client's project — sees their own Analyst, Keywords,
// Competitors and so on):
//
//   Performance — how the site is doing
//     Insights      search traffic from Google Search Console
//     AI visibility how often AI engines mention and cite the brand
//     Keywords      keyword opportunities, gaps, and the topics the site covers
//     Competitors   who ranks and gets recommended instead, backlinks, rankings
//     Compare       two periods side by side
//     Reports       the baseline report from day one, then weekly and monthly
//   Optimize — what to do about it
//     Action Center every issue and fix, with a draft to review and approve
//     Content       the blog posts, landing pages and translations the agent drafts
//     Analyst       the AI briefing, the growth outlook, and what AI found
//     Agents        the agent run console and the systems map (was "Orchestration")
//
// Milestones is gone as its own page: its baseline lives in Reports, and /milestones
// redirects there (see App.jsx).
//
// Demand is Universal Product Growth mode's one nav entry — shown only when the
// current site's own property_type is 'product', never for a 'website' site.
export const NAV_GROUPS = [
  {
    id: 'home', label: 'Home',
    items: [{ to: '/overview', label: 'Overview', icon: BarChart3 }],
    visible: () => true,
  },
  {
    // On its own, right under Home: projects, goals, people, API tokens, monitoring and settings.
    id: 'workspace', label: 'Workspace',
    items: [
      { to: '/workspace', label: 'Workspace', icon: Building2 },
      // SuperRank staff only: new sign-up requests to approve, and the people who have been approved and
      // not yet confirmed their email. (The Admin group that used to hold this was removed; without this
      // link the page is unreachable, and so are the requests waiting on it.)
      { to: '/clients', label: 'Sign-ups & clients', icon: UserPlus, visible: (ctx) => !!ctx.isPlatformAdmin },
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
    id: 'optimize', label: 'Optimize',
    items: [
      { to: '/action-center', label: 'Action Center', icon: Zap },
      { to: '/content', label: 'Content', icon: PenLine },
      { to: '/analyst', label: 'Analyst', icon: LineChart },
      { to: '/ai-orchestration', label: 'Agents', icon: Network },
      { to: '/demand', label: 'Demand', icon: Target, visible: (ctx) => !!ctx.isProduct },
    ],
    visible: () => true,
  },
];


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
