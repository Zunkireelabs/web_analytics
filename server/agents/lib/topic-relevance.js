import { callLLMForJson } from '../../llm.js';
import { groundingTerms, normalizeProfile, describeCompany } from '../../lib/business-profile.js';

// Topic relevance validation: should this blog topic or strategy exist for THIS company?
//
// Trend Radar, keyword gaps and content suggestions produce topics from outside sources (trade-news feeds, search data). Until now the
// only relevance rule was "skip anything unrelated to the site's industry", where the industry was a coarse label. A salon-booking
// software company labelled "wellness" was handed "Inclusive Fitness" and "Vitamins and Supplements"; an AI SEO company labelled
// "technology" was handed "battery technologies" and "data center technology".
//
// A topic is judged against the five things that make a topic worth writing:
//   1. relatesToProduct          it is about what the company sells, or the problem that product solves
//   2. addressesCustomerProblem  it speaks to a real problem of the company's customers
//   3. matchesAudience           the company's target customers would search for or read it
//   4. supportsGoals             writing it plausibly helps the company win or educate buyers
//   5. hasOpportunity            people plausibly search for it (advisory: recorded, never the reason for acceptance)
//
// The DECISION is made here, in code, from those answers; the model's own accept/reject word is only recorded. A topic is accepted only
// if it relates to the product AND (addresses a customer problem OR matches the audience) AND is not judged to work against the
// company's goals. Sharing a keyword with the customers' industry is never enough: a booking-software company is not interested in gym
// equipment news because gyms are among its customers.
//
// Without a model (or when its answer is unusable) the fallback is deterministic and conservative: it can reject or hold a topic for
// review, but it never accepts on keyword overlap alone. Without a usable business profile every topic is 'unknown' (held for review).

// Claude writes about 60 tokens per judged topic; 15 topics per call keeps the JSON answer well inside the output budget (a batch of 25
// was cut off mid-answer in a dry run, which would have held most of a project's topics for no reason).
const MAX_BATCH = 15;
const STOP = new Set(('a an and are as at be by for from how in into is it its of on or our that the their this to up we what when where which who why will with you your ' +
  'best top new guide tips ways about vs versus complete ultimate definitive 2024 2025 2026 2027').split(' '));

// Plural first, then gerund/past/adverb, so booking, bookings and booked meet at 'book'.
const stem = (w) => w.toLowerCase().replace(/ies$/, 'y').replace(/(es|s)$/, '').replace(/(ing|ed|ly)$/, '');
export const contentStems = (text) => [...new Set(String(text || '').toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').split(/\s+/)
  .filter((w) => w.length > 2 && !STOP.has(w)).map(stem).filter((w) => w.length > 2))];

// Anchors: the stems of what the company sells and the problems it solves (strong), and of its audience and subjects (supporting).
// The industries of its CUSTOMERS are deliberately not anchors: they are exactly the keywords that must not pass a topic by themselves.
function anchorSets(profile) {
  const f = normalizeProfile(profile).fields;
  const strong = new Map(); const supporting = new Map();
  const add = (map, text, label) => { for (const s of contentStems(text)) if (!map.has(s)) map.set(s, label); };
  (f.productsServices.value || []).forEach((x) => { add(strong, x.name, x.name); add(strong, x.description, x.name); });
  (f.customerProblems.value || []).forEach((x) => add(strong, x, x));
  add(strong, f.subIndustry.value, f.subIndustry.value);
  (f.targetCustomers.value || []).forEach((x) => { add(supporting, x.segment, x.segment); add(supporting, x.description, x.segment); });
  (f.coreTopics.value || []).forEach((x) => add(supporting, x, x));
  return { strong, supporting };
}

export function anchorHits(topic, profile) {
  const { strong, supporting } = anchorSets(profile);
  const stems = contentStems(topic);
  const s = stems.filter((x) => strong.has(x)); const p = stems.filter((x) => supporting.has(x) && !strong.has(x));
  return { strong: s, supporting: p, total: s.length + p.length, labels: [...new Set([...s.map((x) => strong.get(x)), ...p.map((x) => supporting.get(x))])].slice(0, 4) };
}

export const JUDGE_SYSTEM = `You are a strict relevance reviewer for one company's content strategy. You are given a company profile and candidate topics. For each topic answer five questions as true or false:
relatesToProduct: is the topic about what the company sells, or the problem that product solves?
addressesCustomerProblem: does it speak to a real problem the company's customers have?
matchesAudience: would the company's target customers search for or read it?
supportsGoals: would writing it plausibly help the company win or educate buyers (false if it would pull in readers who will never buy, or promote a competitor)?
hasOpportunity: do people plausibly search for this (true, false, or null if you cannot tell)?
Be strict. The company's CUSTOMERS' industries are not the company's own: a topic about gym equipment, supplements or fitness trends is NOT relevant to software that salons use to take bookings, even though gyms are customers. General technology, science or business news is NOT relevant to a company just because it is a technology company: it must connect to the product or the customer's problem. If unsure, answer false.
Return ONLY raw JSON: {"results": [{"index": number, "relatesToProduct": boolean, "addressesCustomerProblem": boolean, "matchesAudience": boolean, "supportsGoals": boolean, "hasOpportunity": boolean|null, "verdict": "accept"|"reject", "reason": "one short sentence"}]}. Give one result per topic, in order.`;

const validJudge = (o) => !!o && Array.isArray(o.results);

async function defaultJudge(profile, topics, { siteId = null, tier = 'daily' } = {}) {
  const user = `Company profile:\n${describeCompany(profile)}\n\nCandidate topics:\n${topics.map((t, i) => `${i}. ${t}`).join('\n')}`;
  return callLLMForJson(JUDGE_SYSTEM, user, { maxTokens: 2500, tier, siteId, validate: validJudge });
}

// The decision rule, from the criteria alone.
export function decide(criteria) {
  const reasons = [];
  if (!criteria.relatesToProduct) reasons.push('not about what the company sells or the problem it solves');
  if (!criteria.addressesCustomerProblem && !criteria.matchesAudience) reasons.push('does not address a customer problem or match the target audience');
  if (criteria.supportsGoals === false) reasons.push('would not support the company\'s goals');
  return { verdict: reasons.length ? 'reject' : 'accept', reasons };
}

// Deterministic fallback: never accepts on keyword overlap alone.
function fallback(topic, profile) {
  const hits = anchorHits(topic, profile);
  if (hits.strong.length === 0 && hits.supporting.length === 0) {
    return { verdict: 'reject', source: 'deterministic', reasons: ['no word in the topic connects to what the company sells, its customers\' problems or its subjects'], anchors: [] };
  }
  return { verdict: 'unknown', source: 'deterministic', reasons: ['shares words with the company\'s business but cannot be confirmed relevant without review'], anchors: hits.labels };
}

// topics: array of strings or { topic } objects. context: the result of loadBusinessContext(siteId). Returns one verdict per topic, in order:
// { topic, verdict: 'accept'|'reject'|'unknown', criteria?, reasons, anchors, source: 'judge'|'deterministic'|'no-profile' }.
export async function validateTopics(topics, context, { judge = defaultJudge, siteId = null, tier = 'daily' } = {}) {
  const list = (Array.isArray(topics) ? topics : []).map((t) => (typeof t === 'string' ? t : t?.topic)).map((t) => String(t || '').trim());
  const profile = context?.profile;
  const usable = !!profile && ['canonical', 'partial'].includes(context?.status);
  if (!usable) {
    return list.map((topic) => ({ topic, verdict: 'unknown', reasons: ['no verified business profile yet, so relevance cannot be judged'], anchors: [], source: 'no-profile' }));
  }
  const out = list.map((topic) => ({ topic, verdict: 'unknown', reasons: [], anchors: anchorHits(topic, profile).labels, source: 'deterministic' }));
  const todo = list.map((t, i) => i).filter((i) => list[i]);
  for (let start = 0; start < todo.length; start += MAX_BATCH) {
    const idx = todo.slice(start, start + MAX_BATCH);
    let results = null;
    try {
      const raw = await judge(profile, idx.map((i) => list[i]), { siteId: siteId ?? context?.siteId ?? null, tier });
      results = Array.isArray(raw?.results) ? raw.results : null;
    } catch { results = null; }
    idx.forEach((i, k) => {
      const r = results?.find((x) => Number(x?.index) === k) || (results && results.length === idx.length ? results[k] : null);
      const bool = (v) => v === true;
      if (r && typeof r === 'object' && 'relatesToProduct' in r) {
        const criteria = {
          relatesToProduct: bool(r.relatesToProduct), addressesCustomerProblem: bool(r.addressesCustomerProblem), matchesAudience: bool(r.matchesAudience),
          supportsGoals: r.supportsGoals === false ? false : true, hasOpportunity: r.hasOpportunity === true ? true : (r.hasOpportunity === false ? false : null),
        };
        const d = decide(criteria);
        out[i] = { topic: list[i], verdict: d.verdict, criteria, reasons: d.verdict === 'accept' ? [String(r.reason || 'relevant to the product and its customers').slice(0, 200)] : [...d.reasons, ...(r.reason ? [String(r.reason).slice(0, 160)] : [])], anchors: out[i].anchors, source: 'judge' };
      } else {
        out[i] = { topic: list[i], ...fallback(list[i], profile) };
      }
    });
  }
  return out;
}

export const acceptedOnly = (verdicts) => verdicts.filter((v) => v.verdict === 'accept');
