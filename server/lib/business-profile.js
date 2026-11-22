import { createHash } from 'node:crypto';

// The canonical business profile: ONE evidence-backed description of what a project's business is, shared by every agent.
// This file is pure logic (no database, no network): the schema, how a machine-detected profile is merged into an existing one
// without touching anything a person confirmed, how a person's confirmation is applied, and the per-agent projections.
// Storage is store/business-profile.js; detection is lib/business-intelligence.js; agents read it through lib/tenant-context.js.
//
// Five things are kept apart on purpose, because mixing them is what mislabelled a salon-booking SOFTWARE company as a
// wellness business: the company's OWN industry (the market it competes in), its products and services, its business model,
// the industries of its target customers, and who those customers are and what problem they have.

export const SCHEMA_VERSION = 1;

export const FIELD_KEYS = Object.freeze([
  'description',
  'ownIndustry',
  'subIndustry',
  'businessModel',
  'productsServices',
  'targetCustomerIndustries',
  'targetCustomers',
  'customerProblems',
  'geographicMarkets',
  'competitorCategories',
  'coreTopics',
  'marketplace',
]);

// Fields that must be confirmed before a profile counts as confirmed overall.
export const REQUIRED_FOR_CONFIRMED = Object.freeze(['ownIndustry', 'productsServices', 'targetCustomers']);

export const FIELD_STATUS = Object.freeze(['confirmed', 'detected', 'assumed', 'insufficient']);
export const CONFIDENCE = Object.freeze(['low', 'medium', 'high']);
export const EVIDENCE_SOURCES = Object.freeze(['page', 'search', 'capability', 'onboarding', 'competitor', 'legacy', 'human']);
export const BUSINESS_MODELS = Object.freeze(['saas', 'agency', 'professional-services', 'local-service', 'marketplace', 'ecommerce', 'publisher', 'consultancy', 'other']);

// Where a marketplace's listings come from. Decides how an agent may treat listing pages: user-generated ones are never edited by
// hand and are usually thin or near-duplicate, curated ones are the company's own content.
export const LISTING_SOURCES = Object.freeze(['user-generated', 'curated', 'imported', 'mixed']);

// What kinds of domain are never a business competitor, unless a person removes the kind from the profile.
export const DEFAULT_EXCLUDED_COMPETITOR_KINDS = Object.freeze(['government', 'embassy', 'directory', 'marketplace', 'review-site', 'social-platform', 'news-media']);

const MAX_TEXT = 600;
const MAX_ITEMS = 30;
const MAX_QUOTE = 400;

const clip = (s, n = MAX_TEXT) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

export function emptyField() {
  return { value: null, status: 'insufficient', confidence: null, evidence: [], verifiedAt: null, verifiedBy: null };
}

export function emptyProfile() {
  const fields = {};
  for (const k of FIELD_KEYS) fields[k] = emptyField();
  return { schemaVersion: SCHEMA_VERSION, fields };
}

// ── value shapes ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const cleanList = (v) => (Array.isArray(v) ? v : []).map((x) => clip(x, 120)).filter(Boolean).slice(0, MAX_ITEMS);

const VALUE_CLEANERS = {
  description: (v) => clip(v, 1200) || null,
  ownIndustry: (v) => {
    if (!isObj(v)) return clip(v, 120) ? { label: clip(v, 120) } : null;
    const label = clip(v.label, 120);
    return label ? { label, ...(v.catalogKey ? { catalogKey: clip(v.catalogKey, 40) } : {}) } : null;
  },
  subIndustry: (v) => clip(v, 120) || null,
  businessModel: (v) => {
    if (!isObj(v)) return null;
    const model = BUSINESS_MODELS.includes(v.model) ? v.model : (v.model ? 'other' : null);
    if (!model) return null;
    // Revenue model and pricing are separate, independently verifiable claims: a pricing model is never assumed from the category.
    return { model, revenue: textOf(v.revenue) || null, pricing: textOf(v.pricing) || null };
  },
  productsServices: (v) => (Array.isArray(v) ? v : []).map((x) => (isObj(x)
    ? { name: clip(x.name, 120), description: clip(x.description, 300) }
    : { name: clip(x, 120), description: '' })).filter((x) => x.name).slice(0, MAX_ITEMS),
  targetCustomerIndustries: cleanList,
  targetCustomers: (v) => (Array.isArray(v) ? v : []).map((x) => (isObj(x)
    ? { segment: clip(x.segment, 120), description: clip(x.description, 300) }
    : { segment: clip(x, 120), description: '' })).filter((x) => x.segment).slice(0, MAX_ITEMS),
  customerProblems: cleanList,
  geographicMarkets: cleanList,
  competitorCategories: (v) => {
    if (!isObj(v)) return null;
    return { include: cleanList(v.include), exclude: cleanList(v.exclude) };
  },
  coreTopics: cleanList,
  // Only meaningful for a two-sided marketplace (businessModel.model === 'marketplace'). Kept separate from productsServices and
  // targetCustomers because a marketplace has TWO customer sides and sells neither side's goods itself.
  marketplace: (v) => {
    if (!isObj(v)) return null;
    const out = {
      supply: clip(v.supply, 300) || null,
      demand: clip(v.demand, 300) || null,
      listingTypes: cleanList(v.listingTypes),
      categories: cleanList(v.categories),
      listingSource: LISTING_SOURCES.includes(v.listingSource) ? v.listingSource : null,
      monetisation: clip(v.monetisation, 200) || null,
    };
    return isEmptyValue(out) ? null : out;
  },
};

// Free text from a model can be a string, or (for revenue and pricing) a nested object such as {value, confidence, evidence}.
function textOf(v, n = 200) {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return clip(v, n);
  if (Array.isArray(v)) return clip(v.map((x) => textOf(x, n)).filter(Boolean).join('; '), n);
  if (isObj(v)) {
    if ('value' in v) return textOf(v.value, n);
    return clip(Object.entries(v).filter(([k]) => !['confidence', 'evidence', 'quote', 'ref'].includes(k)).map(([, x]) => textOf(x, n)).filter(Boolean).join('; '), n);
  }
  return '';
}

const isEmptyValue = (v) => v == null || (Array.isArray(v) && v.length === 0) || (isObj(v) && Object.values(v).every((x) => x == null || x === '' || (Array.isArray(x) && x.length === 0)));

function cleanEvidence(list) {
  return (Array.isArray(list) ? list : []).map((e) => {
    if (!isObj(e)) return null;
    const source = EVIDENCE_SOURCES.includes(e.source) ? e.source : null;
    if (!source) return null;
    const out = { source, ref: clip(e.ref, 300), summary: clip(e.summary, 300) };
    if (e.quote) out.quote = clip(e.quote, MAX_QUOTE);
    if (e.url) out.url = clip(e.url, 300);
    return out;
  }).filter(Boolean).slice(0, 12);
}

// Coerces anything (including model output or stored JSON) into a valid profile. Never throws; unknown fields are dropped, and a field
// with a value but no evidence and no confirmation is downgraded to 'assumed' so an unsupported claim can never read as detected.
export function normalizeProfile(raw) {
  const out = emptyProfile();
  const src = isObj(raw) && isObj(raw.fields) ? raw.fields : {};
  for (const k of FIELD_KEYS) {
    const f = src[k];
    if (!isObj(f)) continue;
    const value = VALUE_CLEANERS[k](f.value);
    if (isEmptyValue(value)) continue;
    let status = FIELD_STATUS.includes(f.status) ? f.status : 'detected';
    const evidence = cleanEvidence(f.evidence);
    if (status === 'insufficient') status = 'assumed';
    if (status === 'detected' && evidence.length === 0) status = 'assumed';
    out.fields[k] = {
      value,
      status,
      confidence: CONFIDENCE.includes(f.confidence) ? f.confidence : (status === 'confirmed' ? 'high' : 'low'),
      evidence,
      verifiedAt: status === 'confirmed' ? (f.verifiedAt || null) : null,
      verifiedBy: status === 'confirmed' ? (f.verifiedBy ?? null) : null,
    };
  }
  return out;
}

// ── evidence grounding ───────────────────────────────────────────────────────────────────────────────────────────────────
const norm = (s) => String(s || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();

// For checking a model's quote against the page text: the same WORDS in the same ORDER, ignoring punctuation, separators (a model may
// write commas where the page has ' | '), quote style, case, spacing and a trailing ellipsis. A paraphrase or an invented sentence
// still fails, because the words themselves must appear contiguously.
export const quoteForm = (s) => String(s || '').toLowerCase()
  .replace(/(\.\.\.|…)\s*$/, '')
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// A model's quote counts as evidence only if it actually appears in the text that was fetched (the same rule capability discovery uses).
//  - a quoted claim whose quotes are NOT in the text is dropped entirely (a fabricated quote is worse than no evidence);
//  - a claim the model gave with no quote at all is kept, but only as 'assumed', so it can never read as detected;
//  - evidence from other sources (capability, onboarding, human...) is not text-checked here.
// How much of a quote is really in the text. Returns { score, verbatim }: score is 1 when the quote appears as written, or when every
// piece of it does (models often join a headline and a sentence from elsewhere on the page into one "quote"), between 0 and 1 when only
// some pieces do, and 0 when it is invented. Pieces are the quote split at sentence ends, bars, semicolons and commas; only pieces of
// 3+ words count.
export function quoteSupport(quote, haystackForm) {
  const whole = quoteForm(quote);
  if (whole.length >= 8 && haystackForm.includes(whole)) return { score: 1, verbatim: true };
  const parts = String(quote || '').split(/[.!?;|\n]+|,\s+/).map(quoteForm).filter((f) => f.split(' ').filter(Boolean).length >= 3);
  if (parts.length < 2) return { score: 0, verbatim: false };
  let found = 0; let total = 0;
  for (const f of parts) { const w = f.split(' ').length; total += w; if (haystackForm.includes(f)) found += w; }
  return { score: total ? found / total : 0, verbatim: false };
}
const PARTIAL_SUPPORT = 0.5;

// A model's quote counts as evidence only against the text that was actually fetched (the same idea capability discovery uses):
//  - a quote verbatim, or whose every piece is real text -> 'detected' (confidence capped at medium unless it is verbatim);
//  - a quote only partly in the text                     -> kept as 'assumed', low confidence, marked "partly quoted";
//  - quotes that are not in the text at all              -> the claim is dropped (a fabricated quote is worse than no evidence);
//  - a claim given with no quote                         -> kept, only ever as 'assumed';
//  - evidence from other sources (capability, onboarding, human...) is not text-checked here.
export function groundEvidence(profile, texts) {
  const haystack = quoteForm(Array.isArray(texts) ? texts.join(' \n ') : texts);
  const out = normalizeProfile(profile);
  const quotable = (e) => e.source === 'page' || e.source === 'search';
  for (const k of FIELD_KEYS) {
    const f = out.fields[k];
    if (f.status === 'confirmed' || f.value == null) continue;
    const claimed = f.evidence.filter(quotable);
    const scored = claimed.map((e) => ({ e, ...(e.quote ? quoteSupport(e.quote, haystack) : { score: 0, verbatim: false }) }));
    const full = scored.filter((x) => x.score === 1);
    const partial = scored.filter((x) => x.score >= PARTIAL_SUPPORT && x.score < 1).map((x) => ({ ...x.e, summary: `${x.e.summary || 'Website text'} (partly quoted)` }));
    const others = f.evidence.filter((e) => !quotable(e));
    if (claimed.length > 0 && full.length === 0 && partial.length === 0 && others.length === 0) { out.fields[k] = emptyField(); continue; }
    const kept = [...full.map((x) => x.e), ...partial, ...others];
    const grounded = full.length > 0 || (others.length > 0 && f.status === 'detected');
    const status = grounded ? (f.status === 'assumed' ? 'assumed' : 'detected') : 'assumed';
    let confidence = f.confidence;
    if (!grounded && claimed.length > 0) confidence = 'low';
    else if (grounded && full.length > 0 && full.every((x) => !x.verbatim) && confidence === 'high') confidence = 'medium';
    out.fields[k] = { ...f, evidence: kept, status, confidence };
  }
  return out;
}

// ── comparison ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const canon = (v) => {
  if (Array.isArray(v)) return v.map(canon).map((x) => JSON.stringify(x)).sort();
  if (isObj(v)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  return typeof v === 'string' ? norm(v) : v;
};
export const sameValue = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

export function diffProfiles(before, after) {
  const a = normalizeProfile(before); const b = normalizeProfile(after);
  const changes = [];
  for (const k of FIELD_KEYS) {
    const x = a.fields[k]; const y = b.fields[k];
    if (!sameValue(x.value, y.value) || x.status !== y.status) changes.push({ field: k, from: x.value, to: y.value, fromStatus: x.status, toStatus: y.status });
  }
  return changes;
}

export function contentHash(profile) {
  return createHash('sha256').update(JSON.stringify(canon(normalizeProfile(profile)))).digest('hex');
}

// ── merging machine detection into the current profile ──────────────────────────────────────────────────────────────────
// The protection rule. A field a person confirmed is NEVER changed by detection: a differing detected value is returned as a pending
// change (with its evidence) for a person to review. A thin re-check (nothing detected) never erases what is already known.
export function mergeDetected(current, detected, { now = new Date() } = {}) {
  const cur = normalizeProfile(current);
  const det = normalizeProfile(detected);
  const merged = emptyProfile();
  const pending = [];
  const changed = [];
  for (const k of FIELD_KEYS) {
    const c = cur.fields[k]; const d = det.fields[k];
    const detectedHasValue = d.status !== 'insufficient' && d.value != null;
    if (c.status === 'confirmed') {
      merged.fields[k] = c;
      if (detectedHasValue && !sameValue(c.value, d.value)) pending.push({ field: k, proposed: d.value, confidence: d.confidence, evidence: d.evidence, current: c.value, detectedAt: new Date(now).toISOString() });
      continue;
    }
    if (!detectedHasValue) { merged.fields[k] = c; continue; }
    merged.fields[k] = d;
    if (!sameValue(c.value, d.value) || c.status !== d.status) changed.push(k);
  }
  return { profile: merged, pending, changed };
}

// ── a person's review ────────────────────────────────────────────────────────────────────────────────────────────────────
// edits: [{ field, accept: true, value? }]. accept without a value confirms what is already there; a value replaces it (a person's own
// wording), recorded as human evidence. Returns the new profile; unknown fields and empty values are ignored.
export function applyReview(current, edits, { userId = null, now = new Date() } = {}) {
  const out = normalizeProfile(current);
  const stamp = new Date(now).toISOString();
  const applied = [];
  for (const e of Array.isArray(edits) ? edits : []) {
    if (!FIELD_KEYS.includes(e?.field)) continue;
    const f = out.fields[e.field];
    if (e.accept === false) {
      out.fields[e.field] = emptyField();
      applied.push({ field: e.field, action: 'rejected' });
      continue;
    }
    let value = f.value;
    let evidence = f.evidence;
    if (e.value !== undefined) {
      value = VALUE_CLEANERS[e.field](e.value);
      evidence = [{ source: 'human', ref: userId == null ? 'reviewer' : `user:${userId}`, summary: 'Entered or corrected by a person.' }];
    }
    if (isEmptyValue(value)) continue;
    out.fields[e.field] = { value, status: 'confirmed', confidence: 'high', evidence, verifiedAt: stamp, verifiedBy: userId };
    applied.push({ field: e.field, action: e.value !== undefined ? 'edited' : 'confirmed' });
  }
  return { profile: out, applied };
}

// ── overall state ────────────────────────────────────────────────────────────────────────────────────────────────────────
export function profileState(profile) {
  const p = normalizeProfile(profile);
  const f = p.fields;
  const filled = FIELD_KEYS.filter((k) => f[k].value != null);
  if (filled.length === 0) return 'insufficient';
  if (REQUIRED_FOR_CONFIRMED.every((k) => f[k].status === 'confirmed')) return 'confirmed';
  if (filled.some((k) => f[k].status === 'confirmed')) return 'partially-confirmed';
  return f.ownIndustry.value != null && f.ownIndustry.status === 'detected' ? 'detected' : 'unverified';
}

// A profile an agent may rely on: it names the company's own industry on evidence or confirmation, and says what it sells or who buys.
export function isUsable(profile) {
  const f = normalizeProfile(profile).fields;
  const industryOk = f.ownIndustry.value != null && (f.ownIndustry.status === 'confirmed' || (f.ownIndustry.status === 'detected' && f.ownIndustry.confidence !== 'low'));
  const knowsOffer = f.productsServices.value != null || f.targetCustomers.value != null;
  return industryOk && knowsOffer;
}

export function lastVerifiedAt(profile) {
  const stamps = FIELD_KEYS.map((k) => normalizeProfile(profile).fields[k].verifiedAt).filter(Boolean).sort();
  return stamps.length ? stamps[stamps.length - 1] : null;
}

// ── reading the profile ──────────────────────────────────────────────────────────────────────────────────────────────────
export const valueOf = (profile, key) => normalizeProfile(profile).fields[key]?.value ?? null;

export function ownIndustryLabel(profile) {
  const v = valueOf(profile, 'ownIndustry');
  return v?.label || null;
}

// The old free-text `site_profiles.industry` value, derived (never the other way round).
export const toLegacyIndustry = ownIndustryLabel;

export function groundingTerms(profile) {
  const p = normalizeProfile(profile).fields;
  const terms = [];
  const push = (s) => { const t = clip(s, 120); if (t) terms.push(t); };
  (p.productsServices.value || []).forEach((x) => { push(x.name); push(x.description); });
  (p.targetCustomers.value || []).forEach((x) => { push(x.segment); push(x.description); });
  (p.customerProblems.value || []).forEach(push);
  (p.coreTopics.value || []).forEach(push);
  (p.targetCustomerIndustries.value || []).forEach(push);
  push(p.subIndustry.value);
  return [...new Set(terms)];
}

// How a marketplace works, in one or two sentences, so an agent never treats a two-sided marketplace as a company that sells its own
// goods. Empty when the profile holds no marketplace detail.
export function marketplaceLine(m) {
  if (!m) return '';
  const parts = [];
  if (m.supply || m.demand) parts.push(`Two-sided marketplace${m.supply ? `: supply side is ${m.supply}` : ''}${m.demand ? `${m.supply ? '; ' : ': '}demand side is ${m.demand}` : ''}.`);
  if (m.listingTypes?.length) parts.push(`What is listed: ${m.listingTypes.join('; ')}.`);
  if (m.categories?.length) parts.push(`Categories: ${m.categories.join(', ')}.`);
  if (m.listingSource) parts.push(`Listings are ${m.listingSource}${m.listingSource === 'user-generated' ? ' (never write or edit individual listings; they are not the company\'s own copy)' : ''}.`);
  if (m.monetisation) parts.push(`It earns by: ${m.monetisation}.`);
  return parts.join(' ');
}

// One sentence that keeps the five concepts apart. This is the text prompts should receive in place of a bare industry label.
export function describeCompany(profile) {
  const f = normalizeProfile(profile).fields;
  const parts = [];
  const own = ownIndustryLabel(profile);
  const model = f.businessModel.value?.model;
  if (own) parts.push(`The company's own industry: ${own}${f.subIndustry.value ? ` (${f.subIndustry.value})` : ''}${model ? `; business model: ${model}` : ''}.`);
  const offers = (f.productsServices.value || []).map((x) => x.name).slice(0, 8);
  if (offers.length) parts.push(`It sells: ${offers.join('; ')}.`);
  const buyers = (f.targetCustomers.value || []).map((x) => x.segment).slice(0, 6);
  if (buyers.length) parts.push(`Its customers are: ${buyers.join('; ')}.`);
  const verticals = f.targetCustomerIndustries.value || [];
  if (verticals.length) parts.push(`Industries it sells to (these are its customers' industries, NOT its own): ${verticals.join(', ')}.`);
  const problems = (f.customerProblems.value || []).slice(0, 6);
  if (problems.length) parts.push(`Problems it solves for them: ${problems.join('; ')}.`);
  const markets = f.geographicMarkets.value || [];
  if (markets.length) parts.push(`Markets: ${markets.join(', ')}.`);
  const mp = marketplaceLine(f.marketplace.value);
  if (mp) parts.push(mp);
  return parts.join(' ');
}

// Per-agent slices. An agent gets what it needs, nothing it should not weigh, so no agent re-derives the business on its own.
export const AGENT_SLICES = Object.freeze({
  'trend-radar': ['ownIndustry', 'subIndustry', 'businessModel', 'productsServices', 'targetCustomerIndustries', 'customerProblems', 'coreTopics'],
  content: ['description', 'ownIndustry', 'productsServices', 'targetCustomers', 'targetCustomerIndustries', 'customerProblems', 'coreTopics', 'geographicMarkets', 'marketplace'],
  competitor: ['description', 'ownIndustry', 'subIndustry', 'businessModel', 'productsServices', 'targetCustomers', 'geographicMarkets', 'competitorCategories', 'marketplace'],
  keyword: ['ownIndustry', 'productsServices', 'targetCustomers', 'customerProblems', 'coreTopics', 'geographicMarkets', 'marketplace'],
  seo: ['description', 'ownIndustry', 'productsServices', 'targetCustomers', 'customerProblems', 'geographicMarkets', 'coreTopics', 'marketplace'],
  geo: ['description', 'ownIndustry', 'productsServices', 'targetCustomers', 'customerProblems', 'geographicMarkets'],
  aeo: ['description', 'ownIndustry', 'productsServices', 'targetCustomers', 'customerProblems', 'geographicMarkets'],
  analytics: ['description', 'ownIndustry', 'businessModel', 'targetCustomers', 'geographicMarkets', 'marketplace'],
  growth: ['description', 'ownIndustry', 'businessModel', 'productsServices', 'targetCustomers', 'customerProblems', 'geographicMarkets', 'competitorCategories', 'marketplace'],
  all: FIELD_KEYS,
});

export function projectForAgent(profile, agent = 'all') {
  const keys = AGENT_SLICES[agent] || AGENT_SLICES.all;
  const p = normalizeProfile(profile);
  const out = {};
  for (const k of keys) {
    const f = p.fields[k];
    if (f.value != null) out[k] = { value: f.value, status: f.status, confidence: f.confidence };
  }
  return out;
}

// ── resolution: the one rule every agent gets its business context through ────────────────────────────────────────────────
// Precedence (lib/tenant-context.js loadBusinessContext applies it):
//   1. a usable canonical profile (confirmed, or detected with evidence)  -> status 'canonical'. Nothing else may override it.
//   2. a canonical profile that is not yet usable                          -> status 'partial'. Legacy values only FILL fields the
//      profile leaves empty; they never replace a field the profile holds.
//   3. no canonical profile, only the old coarse labels                    -> status 'legacy-unverified' (every value 'assumed').
//   4. nothing at all                                                      -> status 'insufficient'. Callers say so; they never guess.
// A value a person set directly on the old industry field (industry_source 'human') is respected as confirmed.

const parseJsonish = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const x = JSON.parse(v); return Array.isArray(x) ? x : []; } catch { return []; } }
  if (isObj(v)) return Object.keys(v);
  return [];
};

export function legacyProfile({ siteProfile = null, seoPolicy = null, growthConfig = null } = {}) {
  const fields = {};
  const ev = (ref, summary) => [{ source: 'legacy', ref, summary }];
  const industry = siteProfile?.industry ? String(siteProfile.industry).trim() : '';
  if (industry) {
    const human = siteProfile.industry_source === 'human';
    fields.ownIndustry = human
      ? { value: { label: industry }, status: 'confirmed', confidence: 'high', evidence: [{ source: 'human', ref: 'site_profiles', summary: 'Industry set by a person.' }] }
      : { value: { label: industry }, status: 'assumed', confidence: 'low', evidence: ev('site_profiles', 'Stored industry label, not verified against the business.') };
  }
  const topics = parseJsonish(siteProfile?.main_topics ?? siteProfile?.main_topics_json).filter((t) => typeof t === 'string');
  if (topics.length) fields.coreTopics = { value: topics, status: 'assumed', confidence: 'low', evidence: ev('site_profiles', 'Topics inferred from search queries.') };
  // The SEO policy's target industries and the growth config's industries list WHO THE TENANT SELLS TO, so they are customer industries.
  const sellsTo = (seoPolicy?.target_industries?.length ? seoPolicy.target_industries : null) || (growthConfig?.industries?.length ? growthConfig.industries : null);
  if (sellsTo) fields.targetCustomerIndustries = { value: sellsTo, status: 'assumed', confidence: 'low', evidence: ev(seoPolicy?.target_industries?.length ? 'site_seo_policy' : 'product_growth_config', 'Configured list of industries the tenant sells to.') };
  if (growthConfig?.markets?.length) fields.geographicMarkets = { value: growthConfig.markets, status: 'assumed', confidence: 'low', evidence: ev('product_growth_config', 'Configured target markets.') };
  return normalizeProfile({ fields });
}

const hasValue = (profile) => FIELD_KEYS.some((k) => normalizeProfile(profile).fields[k].value != null);

export function resolveBusinessContext({ current = null, siteProfile = null, seoPolicy = null, growthConfig = null } = {}) {
  const stored = current?.profile ? normalizeProfile(current.profile) : null;
  const pending = current?.pending || [];
  const version = current?.version ?? null;
  if (stored && isUsable(stored)) {
    return { status: 'canonical', source: 'business-profile', usable: true, legacy: false, version, state: profileState(stored), profile: stored, pending };
  }
  const legacy = legacyProfile({ siteProfile, seoPolicy, growthConfig });
  if (stored && hasValue(stored)) {
    const merged = normalizeProfile(stored);
    for (const k of FIELD_KEYS) if (merged.fields[k].value == null && legacy.fields[k].value != null) merged.fields[k] = legacy.fields[k];
    return { status: 'partial', source: 'business-profile', usable: false, legacy: false, version, state: profileState(stored), profile: merged, pending };
  }
  if (hasValue(legacy)) return { status: 'legacy-unverified', source: 'legacy', usable: false, legacy: true, version: null, state: 'unverified', profile: legacy, pending: [] };
  return { status: 'insufficient', source: 'none', usable: false, legacy: false, version: null, state: 'insufficient', profile: emptyProfile(), pending: [] };
}


// One line that points a content prompt at the company's own buyers and problems, in place of the old "write for readers in the
// business's own industries (software, CRM, booking...)" steer, which was the same wording for every tenant. Names the company's
// customers' industries only as who it writes for, never as the company's own, and tells the model not to drift into general topics
// about those industries.
export function contentFocusLine(profile) {
  const f = normalizeProfile(profile).fields;
  const buyers = (f.targetCustomers.value || []).map((x) => x.segment).slice(0, 4);
  const sells = (f.productsServices.value || []).map((x) => x.name).slice(0, 5);
  const problems = (f.customerProblems.value || []).slice(0, 4);
  const mp = f.marketplace.value;
  // A two-sided marketplace has two audiences and sells neither side's goods: write for both, about doing the job well, never about
  // individual listings, sellers or reviews (those are the application's data, and inventing them is fabrication).
  if (mp && (mp.supply || mp.demand)) {
    const sides = [mp.supply && `${mp.supply} (who list)`, mp.demand && `${mp.demand} (who buy or book)`].filter(Boolean).join(' and ');
    const cats = (mp.categories || []).slice(0, 8);
    return `Write for ${sides}: practical guides that help sellers list well and buyers choose well${cats.length ? `, within these categories: ${cats.join(', ')}` : ''}. ` +
      'Never write about, name or invent individual listings, sellers, prices or reviews, and do not suggest general topics unrelated to how this marketplace works.';
  }
  if (!buyers.length && !sells.length && !problems.length) return '';
  const parts = [];
  if (buyers.length) parts.push(`Write for ${buyers.join('; ')}`);
  if (sells.length) parts.push(`about topics connected to ${sells.join('; ')}`);
  if (problems.length) parts.push(`and the problems they face (${problems.join('; ')})`);
  return `${parts.join(' ')}. Do not suggest general topics about the customers' own industries or general technology news unless they directly relate to what this company sells.`;
}
