import { safeErrorMessage } from './errors.js';
// Pure logic for the Platform request lists (Get-started requests, Approvals, Access on hold) and the Details pop-up.
// No React, no fetching: the components hand rows in and draw what comes out.

const DAY = 86400000;
const ms = (d) => (d ? new Date(d).getTime() : 0);

export const REQUEST_FILTERS = [
  { key: 'waiting', label: 'Waiting' }, { key: 'trials', label: 'Trials' }, { key: 'clients', label: 'Clients' },
  { key: 'ended', label: 'Ended' }, { key: 'rejected', label: 'Rejected' }, { key: 'all', label: 'All' },
];
const FILTER_STATE = { waiting: 'pending', trials: 'demo', clients: 'client', ended: 'ended', rejected: 'rejected' };

// ── Get-started requests ──
export function requestCounts(rows) {
  const n = { waiting: 0, trials: 0, clients: 0, ended: 0, rejected: 0, all: 0 };
  for (const r of rows || []) {
    n.all += 1;
    if (r.state === 'pending') n.waiting += 1;
    else if (r.state === 'demo') n.trials += 1;
    else if (r.state === 'client') n.clients += 1;
    else if (r.state === 'ended') n.ended += 1;
    else if (r.state === 'rejected') n.rejected += 1;
  }
  return n;
}

const when = (r) => ms(r.requestedAt) || ms(r.decidedAt) || ms(r.createdAt);
export const defaultRequestSort = (filter) => (filter === 'waiting' ? 'oldest' : 'newest');

export function filterRequests(rows, { filter = 'waiting', query = '', sort } = {}) {
  const q = String(query || '').trim().toLowerCase();
  const state = FILTER_STATE[filter];
  const out = (rows || []).filter((r) => {
    if (state && r.state !== state) return false;
    if (!q) return true;
    return [r.name, r.setup?.brand, r.owner?.email, r.owner?.name, r.websiteDomain].some((v) => v && String(v).toLowerCase().includes(q));
  });
  const dir = (sort || defaultRequestSort(filter)) === 'oldest' ? 1 : -1;
  return out.sort((a, b) => dir * (when(a) - when(b)));
}

export function daysLeft(endsAt, now = Date.now()) {
  if (!endsAt) return null;
  return Math.max(0, Math.ceil((ms(endsAt) - now) / DAY));
}

// "5 days ago", "19 hours ago", "just now".
export function ago(iso, now = Date.now()) {
  if (!iso) return '';
  const mins = Math.round((now - ms(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} ${mins === 1 ? 'minute' : 'minutes'} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} ${hrs === 1 ? 'hour' : 'hours'} ago`;
  const days = Math.round(hrs / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

export const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || `${one}s`)}`;

// The "what they set up" chips: only counts that exist.
export function setupChips(setup) {
  const s = setup || {};
  const goals = (s.goals || []).length;
  const countries = (s.markets || []).length;
  const prompts = Number(s.prompts) || 0;
  const out = [];
  if (goals) out.push(plural(goals, 'goal'));
  if (countries) out.push(plural(countries, 'market'));
  if (prompts) out.push(plural(prompts, 'prompt'));
  return out;
}

// Status cell: { tone, text } for a request row.
export function requestStatus(r, now = Date.now()) {
  if (r.state === 'pending') return { tone: 'warn', text: `Waiting ${ago(r.requestedAt, now)}`.trim() };
  if (r.state === 'demo') { const d = daysLeft(r.endsAt, now); return { tone: 'trial', text: d === null ? 'Trial' : `Trial, ${plural(d, 'day')} left` }; }
  if (r.state === 'ended') return { tone: 'ended', text: 'Trial ended' };
  if (r.state === 'client') return { tone: 'client', text: 'Real client' };
  return { tone: 'rejected', text: 'Rejected' };
}

// Bulk: run `fn(row)` one after another; one note at the end: "3 approved, 1 failed: Atlas Travel (reason)".
export async function runBulk(rows, fn, verb = 'approved') {
  let ok = 0;
  const failed = [];
  for (const r of rows) {
    try { await fn(r); ok += 1; } catch (e) { const why = safeErrorMessage(e?.message, ''); failed.push(`${r.name || r.siteId}${why ? ` (${why})` : ''}`); }
  }
  return bulkNote(ok, failed, verb);
}
export function bulkNote(ok, failed, verb = 'approved') {
  const parts = [];
  if (ok) parts.push(`${ok} ${verb}`);
  if (failed.length) parts.push(`${failed.length} failed: ${failed.join(', ')}`);
  return { text: parts.join(', ') || 'Nothing to do.', bad: failed.length > 0 && ok === 0 };
}

// ── Approvals ──
export const APPROVAL_FILTERS = [{ key: 'waiting', label: 'Waiting' }, { key: 'unconfirmed', label: 'Not confirmed' }, { key: 'expired', label: 'Link expired' }, { key: 'all', label: 'All' }];

// One list from the two server lists: new requests (waiting) and approved people who have not confirmed (unconfirmed / expired).
export function approvalRows(requests, awaiting) {
  const a = (requests || []).map((r) => ({
    key: `r${r.id}`, id: r.id, kind: 'request', status: 'waiting', company: r.companyName, person: r.fullName || '', email: r.contactEmail, website: r.websiteDomain || '',
    role: r.role || '', heardFrom: r.heardFrom || '', at: r.createdAt,
  }));
  const b = (awaiting || []).map((r) => ({
    key: `a${r.id}`, id: r.id, kind: 'awaiting', status: r.expired ? 'expired' : 'unconfirmed', company: r.companyName, person: '', email: r.contactEmail, website: '',
    role: '', heardFrom: '', at: r.approvedAt,
  }));
  return [...a, ...b];
}
export function approvalCounts(rows) {
  const n = { waiting: 0, unconfirmed: 0, expired: 0, all: 0 };
  for (const r of rows) { n.all += 1; n[r.status] += 1; }
  return n;
}
export function filterApprovals(rows, { filter = 'waiting', query = '', sort = 'oldest' } = {}) {
  const q = String(query || '').trim().toLowerCase();
  const out = rows.filter((r) => (filter === 'all' || r.status === filter) && (!q || [r.company, r.person, r.email, r.website].some((v) => v && v.toLowerCase().includes(q))));
  const dir = sort === 'oldest' ? 1 : -1;
  return out.sort((a, b) => dir * (ms(a.at) - ms(b.at)));
}
export const approvalStatus = (s) => ({
  waiting: { tone: 'warn', text: 'Waiting for approval' },
  unconfirmed: { tone: 'trial', text: 'Email not confirmed' },
  expired: { tone: 'ended', text: 'Link expired' },
}[s]);

// ── Access on hold ──
export const HOLD_FILTERS = [{ key: 'pending', label: 'Waiting' }, { key: 'approved', label: 'Approved' }, { key: 'all', label: 'All' }];
export function holdCounts(list) {
  const l = list || [];
  const projects = l.reduce((s, x) => s + (x.removed || []).reduce((t, w) => t + (w.projects || []).length, 0), 0);
  return { pending: l.filter((x) => x.status === 'pending').length, approved: l.filter((x) => x.status === 'approved').length, all: l.length, projects };
}
export function filterHold(list, { filter = 'pending', query = '', sort = 'newest' } = {}) {
  const q = String(query || '').trim().toLowerCase();
  const out = (list || []).filter((x) => {
    if (filter !== 'all' && x.status !== filter) return false;
    if (!q) return true;
    return [x.email, x.name, x.lastProject, ...(x.removed || []).flatMap((w) => [w.workspace, ...(w.projects || [])])].some((v) => v && String(v).toLowerCase().includes(q));
  });
  const dir = sort === 'oldest' ? 1 : -1;
  return out.sort((a, b) => dir * (ms(a.requestedAt) - ms(b.requestedAt)));
}
// Where the first N projects end and "Show all" begins.
export const visibleProjects = (projects, expanded, n = 4) => (expanded ? projects : projects.slice(0, n));

// ── Details pop-up ──
// The six goals on the website's Get Started page (superrank-web get-started.astro), in its own words.
export const GOAL_INFO = {
  seo: { title: 'Rank higher on Google', text: 'Fix the technical and on-page gaps that hold rankings back, with a fix for each.' },
  aeo: { title: 'Get quoted in AI answers', text: 'Make pages answer-ready with FAQs, structured data and clear facts engines can quote.' },
  geo: { title: 'Show up in ChatGPT, Perplexity and Gemini', text: 'Track how AI engines describe your brand, who they cite instead, and close the gap.' },
  agentic: { title: 'Make your site agent-ready', text: 'Crawlable pages, llms.txt and clean markup so AI agents can read and use your site.' },
  content: { title: 'Publish content that ranks', text: 'Drafts written for the questions your buyers actually ask.' },
  clients: { title: 'Report to clients', text: 'Weekly reports and real changes across every client site.' },
};
export const LEVELS = [['continent', 'Continents'], ['country', 'Countries'], ['state', 'States'], ['city', 'Cities'], ['neighborhood', 'Neighborhoods']];
const niceItem = (v) => (String(v).includes('|') ? `${v.slice(v.indexOf('|') + 1)}, ${v.slice(0, v.indexOf('|'))}` : String(v));

// Markets grouped by level, only the levels that have something. Falls back to the flat `items` list.
export function marketGroups(markets) {
  const lv = markets?.levels || {};
  const groups = LEVELS.map(([k, label]) => ({ key: k, label, items: (lv[k] || []).map(niceItem) })).filter((g) => g.items.length);
  if (!groups.length && (markets?.items || []).length) return [{ key: 'items', label: 'Markets', items: markets.items.map(niceItem) }];
  return groups;
}

export function detailCounts(setup) {
  const s = setup || {};
  const countries = (s.markets?.levels?.country || []).length || (s.markets?.levels ? 0 : (s.markets?.items || []).length);
  return { goals: (s.goals || []).length, countries, topics: (s.topics || []).length, prompts: (s.prompts || []).length, competitors: (s.profile?.competitors || []).length };
}

// Prompts: filter by search, intent and topic; counts for each pill are computed against the other filters, as the mockup shows.
export function promptView(prompts, { q = '', intent = 'all', topic = 'all' } = {}) {
  const all = prompts || [];
  const needle = String(q || '').trim().toLowerCase();
  const bySearch = all.filter((p) => !needle || p.text.toLowerCase().includes(needle));
  const intents = {};
  const topics = {};
  for (const p of bySearch) {
    if (topic === 'all' || p.topic === topic) intents[p.intent || 'other'] = (intents[p.intent || 'other'] || 0) + 1;
    if (intent === 'all' || (p.intent || 'other') === intent) topics[p.topic || 'Other'] = (topics[p.topic || 'Other'] || 0) + 1;
  }
  const shown = bySearch.filter((p) => (intent === 'all' || (p.intent || 'other') === intent) && (topic === 'all' || (p.topic || 'Other') === topic));
  const groups = [];
  for (const p of shown) {
    const t = p.topic || 'Other';
    let g = groups.find((x) => x.topic === t);
    if (!g) { g = { topic: t, prompts: [] }; groups.push(g); }
    g.prompts.push(p);
  }
  return {
    shown: shown.length, total: all.length, groups,
    intents: Object.entries(intents).map(([key, count]) => ({ key, count })),
    topics: Object.entries(topics).map(([key, count]) => ({ key, count })),
    allIntentCount: Object.values(intents).reduce((a, b) => a + b, 0), allTopicCount: Object.values(topics).reduce((a, b) => a + b, 0),
  };
}
