import { query as dbQuery } from '../db.js';
import { getSetting, setSetting, listChanges } from './platform-settings.js';
import { FEED_CATALOG_KEYS } from '../agents/lib/trend-feeds.js';

// An INDUSTRY SET is what the platform knows about one industry up front: the stages a business there grows through, the
// typical dates when interest rises, the extra agents worth running, and a short brief. It is written by us, editable by a
// platform admin, and shown to clients as "typical for this industry" — never as something measured from their data.
//
// Stored in platform_settings under `industry_set:<industry>` so every edit gets a history row for free. A stored set REPLACES
// the built-in default for that industry; deleting it (reset) brings the default back.

export const INDUSTRY_KEYS = FEED_CATALOG_KEYS;
const KEY = (industry) => `industry_set:${industry}`;

const STAGES = {
  found: { key: 'found', title: 'Be found', description: 'Your pages show up when people search for what you offer.' },
  trusted: { key: 'trusted', title: 'Be trusted', description: 'Proof of who stands behind you: credentials, reviews, dated sources.' },
  convert: { key: 'convert', title: 'Convert', description: 'Visitors enquire, book or buy.' },
  expand: { key: 'expand', title: 'Expand', description: 'New places, services and audiences.' },
};
const stages = (over = {}) => ['found', 'trusted', 'convert', 'expand'].map((k) => ({ ...STAGES[k], ...(over[k] || {}) }));

export const DEFAULT_SETS = {
  education: {
    label: 'Education',
    stages: stages({
      found: { description: 'Your pages show up when students search for countries, courses and fees.' },
      trusted: { description: 'Proof of who stands behind you: accreditation, student stories, dated sources.' },
      convert: { description: 'Visitors apply, enquire or book a call.' },
      expand: { description: 'New countries, languages and audiences.' },
    }),
    keyDates: [
      { month: 1, title: 'Spring intake deadlines', advice: 'Show intake dates on country and course pages by mid December.' },
      { month: 2, title: 'Scholarship applications open', advice: 'Publish scholarship pages before the window opens, not after.' },
      { month: 3, title: 'Visa season for the autumn intake', advice: 'Add a visa timeline page before search interest starts rising.' },
      { month: 8, title: 'Autumn semester starts', advice: 'Refresh fees and arrival guidance for new students.' },
    ],
    agents: ['country-intelligence', 'comparison-opportunity', 'trend-radar', 'ai-recommendation', 'trust-compliance', 'cta-analysis'],
    brief: {
      audience: ['Prospective students', 'Parents'],
      focus: ['Fees and costs', 'Deadlines and intakes', 'Visa steps', 'Accreditation'],
      avoid: ['Guaranteed admission or visa claims'],
    },
  },
  healthcare: {
    label: 'Healthcare',
    stages: stages({
      found: { description: 'Your services show up when patients search for a treatment near them.' },
      trusted: { description: 'Who wrote or reviewed the advice, credentials, and patient reviews.' },
      convert: { description: 'Patients book an appointment or call.' },
      expand: { description: 'New treatments, locations and patient groups.' },
    }),
    keyDates: [
      { month: 1, title: 'New Year health resolutions', advice: 'Publish check-up and prevention pages in December.' },
      { month: 9, title: 'Flu and vaccination season', advice: 'Update vaccination pages and opening hours before September.' },
      { month: 11, title: 'Year-end insurance and benefits use', advice: 'Remind patients to book before benefits expire.' },
    ],
    agents: ['trust-compliance', 'ai-recommendation', 'cta-analysis', 'trend-radar'],
    brief: {
      audience: ['Patients', 'Carers'],
      focus: ['Treatments and what to expect', 'Opening hours and location', 'Reviewed health information'],
      avoid: ['Medical claims without a named source', 'Promising outcomes'],
    },
  },
  'real-estate': {
    label: 'Real estate',
    stages: stages({
      found: { description: 'Your areas and listings show up when people search for where to buy or rent.' },
      trusted: { description: 'Agent credentials, reviews and honest local facts.' },
      convert: { description: 'Visitors request a viewing or a valuation.' },
      expand: { description: 'New areas and property types.' },
    }),
    keyDates: [
      { month: 3, title: 'Spring selling season starts', advice: 'Publish local market and valuation pages in February.' },
      { month: 6, title: 'Peak moving season', advice: 'Refresh area guides and moving checklists before June.' },
      { month: 9, title: 'Back-to-school moves', advice: 'Add school and commute information to area pages.' },
    ],
    agents: ['comparison-opportunity', 'country-intelligence', 'trend-radar', 'cta-analysis'],
    brief: {
      audience: ['Buyers', 'Sellers', 'Renters'],
      focus: ['Area guides', 'Valuation and viewing requests', 'Local facts'],
      avoid: ['Price predictions presented as fact'],
    },
  },
  wellness: {
    label: 'Wellness',
    stages: stages({
      found: { description: 'Your services show up when people search for a treatment or class nearby.' },
      trusted: { description: 'Practitioner credentials, reviews and clear pricing.' },
      convert: { description: 'Visitors book a session.' },
      expand: { description: 'New services, locations and memberships.' },
    }),
    keyDates: [
      { month: 1, title: 'New Year wellness rush', advice: 'Publish service and pricing pages by mid December.' },
      { month: 5, title: 'Summer preparation', advice: 'Promote seasonal services in April.' },
      { month: 10, title: 'Stress and sleep season', advice: 'Refresh relaxation and sleep content before autumn.' },
    ],
    agents: ['trust-compliance', 'ai-recommendation', 'cta-analysis', 'trend-radar'],
    brief: {
      audience: ['Clients', 'First-time visitors'],
      focus: ['Services, duration and price', 'Booking', 'Practitioner credentials'],
      avoid: ['Health claims without a named source'],
    },
  },
  technology: {
    label: 'Technology',
    stages: stages({
      found: { description: 'Your product shows up when buyers search for the problem it solves.' },
      trusted: { description: 'Documentation, security pages, customer proof and named sources.' },
      convert: { description: 'Visitors start a trial or request a demo.' },
      expand: { description: 'New use cases, integrations and markets.' },
    }),
    keyDates: [
      { month: 1, title: 'Annual budgets open', advice: 'Publish pricing and comparison pages before buyers plan spend.' },
      { month: 9, title: 'Q4 buying push', advice: 'Refresh case studies and security pages in August.' },
    ],
    agents: ['comparison-opportunity', 'ai-recommendation', 'trend-radar', 'cta-analysis'],
    brief: {
      audience: ['Evaluators', 'Technical buyers'],
      focus: ['What the product does, in plain text', 'Pricing', 'Integrations', 'Security'],
      avoid: ['Unproven performance claims'],
    },
  },
};

const clean = (s, max = 200) => (typeof s === 'string' ? s.trim().slice(0, max) : '');
const list = (a, max, len = 120) => (Array.isArray(a) ? a.map((x) => clean(x, len)).filter(Boolean).slice(0, max) : []);

/** Pure. Returns { ok, set } or { ok:false, error }. Only known fields survive; text is trimmed and length-capped. */
export function validateSet(industry, input, { knownAgents = null } = {}) {
  if (!INDUSTRY_KEYS.includes(industry)) return { ok: false, error: `Unknown industry "${industry}".` };
  if (!input || typeof input !== 'object') return { ok: false, error: 'A set is required.' };
  const base = DEFAULT_SETS[industry];
  const stg = Array.isArray(input.stages) ? input.stages : base.stages;
  if (stg.length !== 4) return { ok: false, error: 'A set has exactly four stages.' };
  const stagesOut = stg.map((s, i) => ({ key: base.stages[i].key, title: clean(s.title, 40) || base.stages[i].title, description: clean(s.description, 200) || base.stages[i].description }));
  const keyDates = [];
  for (const d of Array.isArray(input.keyDates) ? input.keyDates : []) {
    const month = Number(d.month);
    if (!Number.isInteger(month) || month < 1 || month > 12) return { ok: false, error: 'A key date needs a month from 1 to 12.' };
    const title = clean(d.title, 80);
    if (!title) return { ok: false, error: 'A key date needs a title.' };
    keyDates.push({ month, title, advice: clean(d.advice, 200) });
  }
  if (keyDates.length > 12) return { ok: false, error: 'At most 12 key dates.' };
  keyDates.sort((a, b) => a.month - b.month);
  const agents = list(input.agents, 20, 60);
  if (knownAgents) {
    const bad = agents.find((a) => !knownAgents.includes(a));
    if (bad) return { ok: false, error: `Unknown agent "${bad}".` };
  }
  const brief = input.brief || {};
  return { ok: true, set: { label: base.label, stages: stagesOut, keyDates, agents, brief: { audience: list(brief.audience, 8), focus: list(brief.focus, 12), avoid: list(brief.avoid, 8) } } };
}

/** The set in force for an industry: the saved one if there is one, otherwise the built-in default. Null for an unknown industry. */
export async function getIndustrySet(industry, { query = dbQuery } = {}) {
  if (!INDUSTRY_KEYS.includes(industry)) return null;
  const stored = await getSetting(KEY(industry), { query }).catch(() => null);
  if (stored?.value && typeof stored.value === 'object') return { industry, ...stored.value, custom: true, updatedAt: stored.updatedAt, updatedBy: stored.updatedBy };
  return { industry, ...(DEFAULT_SETS[industry] || {}), custom: false };
}

export async function listIndustrySets({ query = dbQuery } = {}) {
  return Promise.all(INDUSTRY_KEYS.filter((k) => DEFAULT_SETS[k]).map((k) => getIndustrySet(k, { query })));
}

export async function saveIndustrySet(industry, input, { by = null, email = null, knownAgents = null, query = dbQuery } = {}) {
  const v = validateSet(industry, input, { knownAgents });
  if (!v.ok) return v;
  await setSetting(KEY(industry), v.set, { by, email, query });
  return { ok: true, set: await getIndustrySet(industry, { query }) };
}

/** Back to the built-in default. Recorded as a change (to: null). */
export async function resetIndustrySet(industry, { by = null, email = null, query = dbQuery } = {}) {
  if (!INDUSTRY_KEYS.includes(industry)) return { ok: false, error: `Unknown industry "${industry}".` };
  const { recordChange } = await import('./platform-settings.js');
  const before = await getSetting(KEY(industry), { query });
  await query('DELETE FROM platform_settings WHERE key = $1', [KEY(industry)]);
  if (before) await recordChange(KEY(industry), before.value, null, { by, email, query });
  return { ok: true, set: await getIndustrySet(industry, { query }) };
}

export const industrySetHistory = (industry, opts = {}) => listChanges(KEY(industry), opts);
