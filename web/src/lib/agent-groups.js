import { agentState } from './sidebar-agents.js';

// The six agent groups the client sees. The ~38 specialist agents belong to one each (by their `category`); the sidebar's Agent view
// and the Agents page both show these six, never the whole list. A category not named here falls into SEO, the largest group.
export const AGENT_GROUPS = [
  { id: 'seo', label: 'SEO', blurb: 'How your pages show up in Google: titles, links, speed, duplicates, search queries.', categories: ['seo', 'technical', 'on-page'] },
  { id: 'geo', label: 'AI and GEO', blurb: 'Whether AI engines know you, name you and describe you correctly.', categories: ['geo'] },
  { id: 'content', label: 'Content', blurb: 'Gaps, ideas, images, news and quality across your blog and pages.', categories: ['content'] },
  { id: 'executive', label: 'Executive', blurb: 'The summary of everything the other agents found, in plain words.', categories: ['meta'] },
  { id: 'accessibility', label: 'Accessibility', blurb: 'Whether everyone, including screen readers, can use your site.', categories: ['accessibility'] },
  { id: 'security', label: 'Security', blurb: 'Security headers, trust and compliance pages.', categories: ['security', 'compliance'] },
];

const BY_CATEGORY = new Map(AGENT_GROUPS.flatMap((g) => g.categories.map((c) => [c, g.id])));
export const groupIdFor = (category) => BY_CATEGORY.get(category) || 'seo';
export const groupById = (id) => AGENT_GROUPS.find((g) => g.id === id) || null;

// agents: GET /agents/status rows. running: Map(agentId -> start ms) from the live stream.
// Each group: its agents (with state), how many are running now, failed on their last run, how many findings the last runs
// produced, and when any of them last ran. A group is 'running' if any agent is, else 'attention' if any failed, else 'ok'.
export function buildGroups(agents, running) {
  const list = (agents || []).map((a) => ({ ...a, state: agentState(a, running), since: running?.get(a.id) ?? null }));
  return AGENT_GROUPS.map((g) => {
    const members = list.filter((a) => groupIdFor(a.category) === g.id);
    const runningCount = members.filter((a) => a.state === 'running').length;
    const failedCount = members.filter((a) => a.state === 'failed').length;
    const times = members.map((a) => (a.lastRunAt ? new Date(a.lastRunAt).getTime() : 0)).filter(Boolean);
    return {
      ...g, agents: members, total: members.length, runningCount, failedCount,
      findings: members.reduce((n, a) => n + (a.lastRunFindings || 0), 0),
      lastRunAt: times.length ? new Date(Math.max(...times)).toISOString() : null,
      state: runningCount ? 'running' : failedCount ? 'attention' : 'ok',
    };
  }).filter((g) => g.total > 0);
}

// The page to go back to when the client switches from the Agent view to Browse: the page they were on before, else Overview.
export const AGENT_PATH = '/ai-orchestration';
export const isAgentPath = (pathname) => pathname === AGENT_PATH || pathname.startsWith(`${AGENT_PATH}/`);
export const browseTarget = (remembered) => (remembered && !isAgentPath(remembered) ? remembered : '/overview');

// What each of the six agents "looks after", in plain words. The ~38 specialist agents sit underneath, one or more per area, and are
// never shown to the client by name: an area is running while any of its specialists is, and its result is what they found on their
// last run. Every real agent id belongs to exactly one area (the test checks this against the registry list).
export const AGENT_AREAS = {
  seo: [
    { name: 'Titles, speed and phones', what: 'Checks pages have a clear title and load fast on a phone', agents: ['technical-seo', 'mobile-usability', 'device-intelligence', 'cta-analysis'] },
    { name: 'Links between your pages', what: 'Finds pages that nothing links to', agents: ['internal-linking'] },
    { name: 'Duplicates and redirects', what: 'Finds the same page under several addresses, and broken paths', agents: ['duplicate-content', 'templated-duplicates', 'query-param-duplicates', 'url-variant-duplicates', 'redirect-chain', 'soft-404'] },
    { name: 'What buyers search', what: 'Reads the searches that bring people to you', agents: ['query-intelligence', 'opportunity', 'keyword-narrative', 'visitor-behaviour', 'prospect-discovery', 'seo-sxo'] },
    { name: 'Sitemap and indexing', what: 'Checks Google can find every page', agents: ['sitemap', 'sitemap-conflict', 'gsc-url-audit', 'seo-drift', 'indexnow'] },
    { name: 'Trust and competitors', what: 'Looks at who links to you and who ranks instead of you', agents: ['authority', 'competitor-intelligence'] },
  ],
  geo: [
    { name: 'Are you the answer?', what: 'Asks AI engines buyer questions and checks who they name', agents: ['ai-visibility'] },
    { name: 'Facts AI can read about you', what: 'Checks what AI can learn from your own pages', agents: ['geo-signals'] },
    { name: 'Where you are found', what: 'Shows the countries your visitors come from', agents: ['country-intelligence'] },
    { name: 'Questions worth answering', what: 'Finds questions buyers ask that you do not answer', agents: ['growth-queries'] },
  ],
  content: [
    { name: 'Gaps and ideas', what: 'Finds topics buyers ask about that you do not cover', agents: ['content-gap', 'comparison-opportunity', 'ai-recommendation'] },
    { name: 'Images and looks', what: 'Finds missing or reused pictures and pages that look off', agents: ['blog-image', 'visual-quality'] },
    { name: 'Quality and consistency', what: 'Checks pages say what they claim and look the same', agents: ['content-integrity', 'font-consistency'] },
    { name: 'Rising topics and news', what: 'Watches what is gaining interest in your market', agents: ['trend-radar', 'news-posts'] },
  ],
  executive: [{ name: 'Your summary', what: 'Reads what the other agents found and writes it in plain words', agents: ['executive-report'] }],
  accessibility: [{ name: 'Labels, headings and language', what: 'Checks everyone, including screen readers, can use your pages', agents: ['accessibility'] }],
  security: [
    { name: 'Security headers', what: 'Checks the protections your server sends to browsers', agents: ['security-headers'] },
    { name: 'Cookie, privacy and terms pages', what: 'Checks the pages visitors and regulators expect', agents: ['trust-compliance'] },
  ],
};

// One agent's areas with their live state. `g` comes from buildGroups (each of its specialists has a state); `queued` is the set of
// specialist ids this page has asked to run and that have not finished yet.
//   running = a specialist is working now · waiting = queued, not started · done = ran before · never = never ran
export function buildAreas(g, queued = new Set()) {
  const byId = new Map((g?.agents || []).map((a) => [a.id, a]));
  return (AGENT_AREAS[g?.id] || []).map((area) => {
    const members = area.agents.map((id) => byId.get(id)).filter(Boolean);
    const state = members.some((a) => a.state === 'running') ? 'running' : members.some((a) => queued.has(a.id)) ? 'waiting'
      : members.some((a) => a.lastRunAt) ? 'done' : 'never';
    const times = members.map((a) => (a.lastRunAt ? new Date(a.lastRunAt).getTime() : 0)).filter(Boolean);
    return { ...area, state, found: members.reduce((n, a) => n + (a.lastRunFindings || 0), 0), failed: members.filter((a) => a.state === 'failed').length,
      lastRunAt: times.length ? new Date(Math.max(...times)).toISOString() : null, count: members.length };
  });
}

// "x of n" for a run started from the page: how many areas are finished. null when nothing was queued from here.
export function runProgress(areas, queued) {
  if (!queued || queued.size === 0) return null;
  const n = areas.length, done = areas.filter((a) => a.state !== 'running' && a.state !== 'waiting').length;
  return { done, n };
}
export const currentArea = (areas) => areas.find((a) => a.state === 'running') || areas.find((a) => a.state === 'waiting') || null;
