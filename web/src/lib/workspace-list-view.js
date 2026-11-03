// The Platform "All workspaces" list: what to show, in what order, and the counts above it. Pure functions over the
// rows from GET /api/platform/workspaces, so they can be tested without a browser.
//
// A project's `access.state` is one of 'client' | 'demo' | 'ended' | 'pending' | 'rejected' | 'new'.
// `connections` is { searchConsole, analytics, github, baseline } (booleans); `missing` is the names still to connect.

export const CONNECTIONS = [
  { key: 'searchConsole', label: 'Search Console' },
  { key: 'analytics', label: 'Analytics' },
  { key: 'github', label: 'GitHub' },
  { key: 'baseline', label: 'Baseline' },
];

// Waiting for a decision, ended or turned down: the staff has something to do about it.
const STAFF_STATES = ['pending', 'ended', 'rejected'];

export const connectedCount = (p) => CONNECTIONS.filter((c) => p.connections?.[c.key]).length;
export const projectState = (p) => p.access?.state || 'client';
// A project needs attention when something is not connected, or it is waiting on / past a decision.
export const projectNeedsAttention = (p) => (p.missing?.length || 0) > 0 || STAFF_STATES.includes(projectState(p));
export const workspaceNeedsAttention = (w) => w.projects.some(projectNeedsAttention);

// How many projects of each kind: client / trial / ended / new (new and waiting for approval) / rejected.
export function stateMix(w) {
  const mix = { client: 0, trial: 0, ended: 0, fresh: 0, rejected: 0 };
  for (const p of w.projects) {
    const s = projectState(p);
    if (s === 'client') mix.client += 1;
    else if (s === 'demo') mix.trial += 1;
    else if (s === 'ended') mix.ended += 1;
    else if (s === 'rejected') mix.rejected += 1;
    else mix.fresh += 1;
  }
  return mix;
}

// 0..100: connected pieces out of everything every project could have. A workspace with no projects is 100.
export function setupPercent(w) {
  if (!w.projects.length) return 100;
  const done = w.projects.reduce((n, p) => n + connectedCount(p), 0);
  return Math.round((done / (w.projects.length * CONNECTIONS.length)) * 100);
}

export function summarize(workspaces) {
  const projects = workspaces.flatMap((w) => w.projects);
  return {
    workspaces: workspaces.length,
    projects: projects.length,
    people: workspaces.reduce((n, w) => n + (w.memberCount || 0), 0),
    clients: projects.filter((p) => projectState(p) === 'client').length,
    trials: projects.filter((p) => projectState(p) === 'demo').length,
    attention: workspaces.filter(workspaceNeedsAttention).length,
  };
}

export const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'attention', label: 'Needs attention' },
  { key: 'trials', label: 'Trials' },
  { key: 'ended', label: 'Ended' },
  { key: 'clients', label: 'Clients' },
];

const projectMatchesFilter = (p, f) => {
  if (f === 'attention') return projectNeedsAttention(p);
  if (f === 'trials') return projectState(p) === 'demo';
  if (f === 'ended') return projectState(p) === 'ended';
  if (f === 'clients') return projectState(p) === 'client';
  return true;
};
// A workspace is in a filter when any of its projects is (a workspace with no projects only shows under All).
export const workspaceMatchesFilter = (w, f) => (f === 'all' ? true : w.projects.some((p) => projectMatchesFilter(p, f)));

const norm = (s) => String(s || '').toLowerCase();
const projectMatchesQuery = (p, q) => norm(p.name).includes(q) || norm(p.domain).includes(q);
const workspaceOwnMatch = (w, q) => norm(w.name).includes(q) || (w.owners || []).some((o) => norm(o).includes(q));

// The projects of a workspace to list under it for this search: all of them when the workspace itself (or its owner)
// matches, otherwise only the matching ones.
export function visibleProjects(w, query) {
  const q = norm(query).trim();
  if (!q || workspaceOwnMatch(w, q)) return w.projects;
  return w.projects.filter((p) => projectMatchesQuery(p, q));
}
const workspaceMatchesQuery = (w, query) => {
  const q = norm(query).trim();
  return !q || workspaceOwnMatch(w, q) || w.projects.some((p) => projectMatchesQuery(p, q));
};

export const SORTS = [
  { key: 'attention', label: 'Needs attention first' },
  { key: 'name', label: 'Name A to Z' },
  { key: 'newest', label: 'Newest first' },
  { key: 'projects', label: 'Most projects' },
];

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
const SORT_FNS = {
  // Most still to set up first, then those waiting on a decision, then by name.
  attention: (a, b) => (workspaceNeedsAttention(b) - workspaceNeedsAttention(a)) || (toSetUp(b) - toSetUp(a)) || byName(a, b),
  name: byName,
  newest: (a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0) || byName(a, b),
  projects: (a, b) => (b.projects.length - a.projects.length) || byName(a, b),
};
export const toSetUp = (w) => w.projects.filter((p) => (p.missing?.length || 0) > 0).length;

export function filterWorkspaces(workspaces, { filter = 'all', query = '', sort = 'attention' } = {}) {
  return workspaces.filter((w) => workspaceMatchesFilter(w, filter) && workspaceMatchesQuery(w, query)).sort(SORT_FNS[sort] || SORT_FNS.attention);
}

// Counts on the filter pills (workspaces, with the search applied).
export function filterCounts(workspaces, query = '') {
  const inSearch = workspaces.filter((w) => workspaceMatchesQuery(w, query));
  return Object.fromEntries(FILTERS.map((f) => [f.key, inSearch.filter((w) => workspaceMatchesFilter(w, f.key)).length]));
}

// The flat "All projects" table: one row per project, with its workspace and owner. The filter applies to projects.
export function flattenProjects(workspaces, { filter = 'all', query = '', sort = 'attention' } = {}) {
  const q = norm(query).trim();
  const rows = [];
  for (const w of workspaces) {
    const own = q && workspaceOwnMatch(w, q);
    for (const p of w.projects) {
      if (!projectMatchesFilter(p, filter)) continue;
      if (q && !own && !projectMatchesQuery(p, q)) continue;
      rows.push({ project: p, workspace: { id: w.id, name: w.name, createdAt: w.createdAt }, owner: (w.owners || [])[0] || null });
    }
  }
  const cmp = {
    attention: (a, b) => (projectNeedsAttention(b.project) - projectNeedsAttention(a.project)) || (b.project.missing.length - a.project.missing.length) || byName(a.project, b.project),
    name: (a, b) => byName(a.project, b.project),
    newest: (a, b) => (Date.parse(b.workspace.createdAt) || 0) - (Date.parse(a.workspace.createdAt) || 0) || byName(a.project, b.project),
    projects: (a, b) => byName(a.workspace, b.workspace) || byName(a.project, b.project),
  }[sort] || null;
  return cmp ? rows.sort(cmp) : rows;
}

// Per-project counts for the pills in the All projects view.
export function projectFilterCounts(workspaces, query = '') {
  const all = flattenProjects(workspaces, { query });
  return Object.fromEntries(FILTERS.map((f) => [f.key, all.filter((r) => projectMatchesFilter(r.project, f.key)).length]));
}
