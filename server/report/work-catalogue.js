// The STANDARD wording for the "work completed / in progress" pages of the
// client progress report. Every client reads the same sentences: one plain
// title, "We ..." (what we did) and "Why it matters", with that client's own
// counts filled in. Nothing is hand-written per client; a work type that has no
// entry here is simply left out rather than described loosely.
//
// Source of the work: the `drafts` table (Action Center). A draft's status is
// its journey (see store/drafts.js), mapped here to the four client-facing
// statuses: LIVE, WAITING (done, waiting on go-live), IN PROGRESS, PLANNED.
// A fifth, WITH GOOGLE (submitted, Google decides), can only be set by hand
// because nothing in the app records it.

export const STATUS = {
  live: { label: 'LIVE', order: 0 },
  waiting: { label: 'WAITING', order: 1 },
  google: { label: 'WITH GOOGLE', order: 2 },
  prog: { label: 'IN PROGRESS', order: 3 },
  planned: { label: 'PLANNED', order: 4 },
};

const DRAFT_STATUS_TO_STATUS = {
  implemented: 'live',
  pr_opened: 'waiting', branch_pushed: 'waiting', merged_to_stage: 'waiting', awaiting_publish: 'waiting',
  approved: 'prog', submitted_for_approval: 'prog',
};

const n = (count, one, many) => `${count} ${count === 1 ? one : many}`;

// group is one of the three standard headings on the report.
export const CATALOGUE = {
  faq: {
    group: 'Content', title: 'Added question-and-answer sections',
    did: (c) => `We added question-and-answer sections to ${n(c, 'page', 'pages')}.`,
    will: (c) => `We will add question-and-answer sections to ${n(c, 'page', 'pages')}.`,
    why: 'Google and AI can quote your answers directly instead of a competitor’s.',
  },
  schema: {
    group: 'Foundation', title: 'Added labels that explain your pages',
    did: (c) => `We added hidden labels to ${n(c, 'page', 'pages')} saying what each one is.`,
    will: (c) => `We will add hidden labels to ${n(c, 'page', 'pages')} saying what each one is.`,
    why: 'Google and AI no longer have to guess.',
  },
  'alt-text': {
    group: 'Foundation', title: 'Described your images',
    did: (c) => `We added descriptions to the images on ${n(c, 'page', 'pages')}.`,
    will: (c) => `We will add descriptions to the images on ${n(c, 'page', 'pages')}.`,
    why: 'Images can be found in search and understood by AI.',
  },
  'landing-page': {
    group: 'Content', title: 'Built pages for what customers search',
    did: (c) => `We created ${n(c, 'new page', 'new pages')} for searches you did not have a page for.`,
    will: (c) => `We will create ${n(c, 'new page', 'new pages')} for searches you do not have a page for.`,
    why: 'You can only appear for searches you have a page for.',
  },
  'blog-outline': {
    group: 'Content', title: 'Published helpful articles',
    did: (c) => `We published ${n(c, 'article', 'articles')} that answer what customers ask.`,
    will: (c) => `We will publish ${n(c, 'article', 'articles')} that answer what customers ask.`,
    why: 'Each one is another chance to appear in a search.',
  },
  'expand-content': {
    group: 'Content', title: 'Strengthened your pages',
    did: (c) => `We added missing sections to ${n(c, 'page', 'pages')}.`,
    will: (c) => `We will add missing sections to ${n(c, 'page', 'pages')}.`,
    why: 'Fuller pages answer the whole question, so they rank better.',
  },
  'internal-links': {
    group: 'Foundation', title: 'Connected your pages',
    did: (c) => `We added links between ${n(c, 'related page', 'related pages')}.`,
    will: (c) => `We will add links between ${n(c, 'related page', 'related pages')}.`,
    why: 'Links help Google and visitors find your best pages.',
  },
  'meta-title': {
    group: 'Foundation', title: 'Improved your search titles',
    did: (c) => `We rewrote the search title and description on ${n(c, 'page', 'pages')}.`,
    will: (c) => `We will rewrite the search title and description on ${n(c, 'page', 'pages')}.`,
    why: 'This is the text people read on Google before they click.',
  },
  'llms-txt': {
    group: 'Foundation', title: 'Opened your site to AI assistants',
    did: () => 'We published a guide telling AI tools what your site is about.',
    will: () => 'We will publish a guide telling AI tools what your site is about.',
    why: 'AI tools can only recommend what they can read.',
  },
  canonical: {
    group: 'Foundation', title: 'Helped Google find and list your pages',
    did: (c) => `We told Google which version of ${n(c, 'page', 'pages')} is the main one.`,
    will: (c) => `We will tell Google which version of ${n(c, 'page', 'pages')} is the main one.`,
    why: 'Google can only show pages it can find.',
  },
  'broken-link-fix': {
    group: 'Foundation', title: 'Fixed broken links',
    did: (c) => `We repaired broken links on ${n(c, 'page', 'pages')}.`,
    will: (c) => `We will repair broken links on ${n(c, 'page', 'pages')}.`,
    why: 'Visitors and AI tools no longer hit dead ends.',
  },
  translation: {
    group: 'Content', title: 'Added translated pages',
    did: (c) => `We added ${n(c, 'translated page', 'translated pages')}.`,
    will: (c) => `We will add ${n(c, 'translated page', 'translated pages')}.`,
    why: 'People can find you in their own language.',
  },
};

// Action types that mean the same thing to a client share one entry.
const ALIASES = { 'schema-repair': 'schema' };
const canonicalType = (t) => ALIASES[t] || t;

export const GROUP_ORDER = ['Foundation', 'Content', 'Trust'];

// drafts: [{ action_type, status }]   openRecs: [{ recommendation_type, priority }]
// manual: optional hand-entered items for work the app cannot see (for example
// a developer's own pull request): { group, status, title, did, why, next }.
export function buildWorkItems({ drafts = [], openRecs = [], manual = [], maxPlanned = 2 } = {}) {
  const buckets = new Map(); // `${type}|${status}` -> count
  for (const d of drafts) {
    const status = DRAFT_STATUS_TO_STATUS[d.status];
    const type = canonicalType(d.action_type);
    if (!status || !CATALOGUE[type]) continue;
    const key = `${type}|${status}`;
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }

  const items = [];
  for (const [key, count] of buckets) {
    const [type, status] = key.split('|');
    const c = CATALOGUE[type];
    items.push({
      group: c.group, status, title: c.title, did: c.did(count), why: c.why, next: status === 'waiting' ? 'The final go-live.' : null, count, type,
    });
  }

  // Planned = the biggest open recommendations of a type we have wording for,
  // excluding types already shown as live or in progress.
  const shown = new Set(items.map((i) => i.type));
  const plannedCounts = new Map();
  for (const r of openRecs) {
    const type = canonicalType(r.recommendation_type);
    if (!CATALOGUE[type] || shown.has(type)) continue;
    plannedCounts.set(type, (plannedCounts.get(type) || 0) + 1);
  }
  [...plannedCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, maxPlanned).forEach(([type, count]) => {
    const c = CATALOGUE[type];
    items.push({ group: c.group, status: 'planned', title: c.title, did: c.will(count), why: c.why, next: null, count, type });
  });

  for (const m of manual) {
    if (!STATUS[m.status]) continue;
    items.push({ group: GROUP_ORDER.includes(m.group) ? m.group : 'Content', status: m.status, title: m.title, did: m.did, why: m.why, next: m.next || null, count: null, type: 'manual' });
  }

  return items.sort((a, b) => STATUS[a.status].order - STATUS[b.status].order
    || GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group));
}

export function tallyWork(items) {
  const t = { live: 0, waiting: 0, google: 0, prog: 0, planned: 0 };
  for (const i of items) t[i.status] += 1;
  return t;
}
