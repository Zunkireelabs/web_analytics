import { query as dbQuery } from '../db.js';
import { classifyIndustry, INDUSTRY_KEYS } from './industry-intelligence.js';
import { classifyIndustryFromText } from './industry-capture.js';

// Detect a project's industry during the baseline, with nobody clicking anything.
//
// Three independent signals, each answering "which industry?" or "can't tell":
//   search  — the words in the site's own top Search Console queries
//   site    — what the site says about itself (its topics, and its homepage read by a model)
//   profile — an industry already recorded for the project (the clustering collector, the growth config)
//
// Rule (owner, 2026-11-06): apply an industry automatically only when TWO signals agree. Otherwise apply nothing — the core
// agents keep running, no industry page is shown, and the check repeats later. A person's own choice ('human') is never
// overwritten. A wrong industry is worse than none: it would feed a project another industry's advice and news.

export const MIN_AGREEING = 2;
export const SHOWN_SOURCES = ['detected', 'human', 'growth-config'];
export const RECHECK_DAYS = 7;

/** Pure. signals: [{ name, industry|null, subIndustry? }]. Returns { industry, subIndustry, agreeing, status, reason }. */
export function decideIndustry(signals) {
  const seen = (signals || []).filter((s) => s && s.industry);
  const tally = new Map();
  for (const s of seen) tally.set(s.industry, [...(tally.get(s.industry) || []), s]);
  const ranked = [...tally.entries()].sort((a, b) => b[1].length - a[1].length);
  if (!ranked.length) return { status: 'not-enough-data', industry: null, subIndustry: '', agreeing: [], reason: 'No signal could place the project in an industry yet.' };
  const [top, second] = ranked;
  if (second && second[1].length === top[1].length && top[1].length >= MIN_AGREEING) {
    return { status: 'disagree', industry: null, subIndustry: '', agreeing: [], reason: 'Signals disagree.' };
  }
  if (top[1].length < MIN_AGREEING) {
    const reason = ranked.length > 1 ? 'Signals disagree.' : 'Only one signal so far.';
    return { status: ranked.length > 1 ? 'disagree' : 'not-enough-data', industry: null, subIndustry: '', agreeing: [], reason };
  }
  const sub = top[1].map((s) => s.subIndustry).find(Boolean) || '';
  return { status: 'confirmed', industry: top[0], subIndustry: sub, agreeing: top[1].map((s) => s.name), reason: `${top[1].length} signals agree.` };
}

/**
 * Pure. Each search is classified on its own and the industries are counted, so one stray word ("machine learning" reads as
 * education) cannot outvote the rest. Needs a clear leader: at least 2 searches, at least 40% of the searches that matched any
 * industry, and strictly more than the runner-up.
 */
export function searchSignal(queries) {
  const tally = new Map(); const subs = new Map(); let matched = 0;
  for (const q of queries || []) {
    const c = classifyIndustry(q);
    if (!c.industry) continue;
    matched += 1; tally.set(c.industry, (tally.get(c.industry) || 0) + 1);
    if (c.subIndustry) subs.set(`${c.industry}/${c.subIndustry}`, (subs.get(`${c.industry}/${c.subIndustry}`) || 0) + 1);
  }
  const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  const [top, next] = ranked;
  if (!top || top[1] < 2 || top[1] / matched < 0.4 || (next && next[1] === top[1])) return { industry: null, subIndustry: '' };
  const sub = [...subs.entries()].filter(([k]) => k.startsWith(`${top[0]}/`)).sort((a, b) => b[1] - a[1])[0];
  return { industry: top[0], subIndustry: sub ? sub[0].split('/')[1] : '' };
}

const tryJson = (v) => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return null; } };

async function gatherSignals(site, { query, callJson, fetchText }) {
  const siteId = site.id;
  const out = [];

  // search: the words people actually searched to reach this site
  const { rows: qs } = await query(
    `SELECT query FROM gsc_query_page WHERE site_id = $1 AND date >= CURRENT_DATE - 90
      GROUP BY query ORDER BY SUM(impressions) DESC NULLS LAST LIMIT 60`, [siteId]);
  const search = searchSignal(qs.map((r) => r.query));
  out.push({ name: 'search', industry: search.industry, subIndustry: search.subIndustry, basis: qs.length ? `${qs.length} top searches` : 'no search data yet' });

  // profile + site topics
  const { rows: prof } = await query(
    `SELECT industry, industry_source, main_topics_json FROM site_profiles WHERE site_id = $1`, [siteId]);
  const p = prof[0] || null;
  const topics = (() => { let t = tryJson(p?.main_topics_json); if (t && !Array.isArray(t)) t = Object.keys(t); return Array.isArray(t) ? t.filter((x) => typeof x === 'string') : []; })();
  const profile = p?.industry && p.industry_source !== 'unmapped' && p.industry_source !== 'detected' ? classifyIndustry(p.industry, topics) : { industry: null, subIndustry: '' };
  out.push({ name: 'profile', industry: profile.industry, subIndustry: profile.subIndustry, basis: p?.industry ? `recorded as "${p.industry}"` : 'nothing recorded' });

  // site: the homepage, read by a model, validated against the catalog (an off-list answer is dropped, never guessed)
  let siteSig = { industry: null, subIndustry: '' }; let basis = 'homepage not read';
  const domain = site.website_domain || null;
  if (domain && callJson && fetchText) {
    const text = await fetchText(domain).catch(() => null);
    if (text) {
      const label = await classifyIndustryFromText(text, { callJson });
      if (label) { const c = classifyIndustry(label, [text.slice(0, 1500)]); siteSig = { industry: c.industry || label, subIndustry: c.subIndustry }; }
      basis = 'homepage read';
    }
  }
  if (!siteSig.industry && topics.length) { const c = classifyIndustry('', topics); siteSig = c; basis = `${topics.length} site topics`; }
  out.push({ name: 'site', industry: siteSig.industry, subIndustry: siteSig.subIndustry, basis });
  return out;
}

/**
 * Detects and records the industry for one project. Never throws into the baseline: returns { applied, ... }.
 * `deps` lets tests run without a database or network.
 */
export async function detectIndustryForSite(site, { deps = {}, now = new Date() } = {}) {
  const query = deps.query || dbQuery;
  const siteId = site.id;
  const { rows: cur } = await query('SELECT industry, industry_source FROM site_profiles WHERE site_id = $1', [siteId]);
  const existing = cur[0] || null;

  if (existing?.industry_source === 'human' || existing?.industry_source === 'growth-config') {
    return { applied: false, kept: true, reason: 'An industry was set by a person or the growth config, so it is kept.', industry: existing.industry };
  }

  const signals = await gatherSignals(site, { query, callJson: deps.callJson, fetchText: deps.fetchText });
  const decision = decideIndustry(signals);
  const record = { checkedAt: now.toISOString(), status: decision.status, reason: decision.reason, signals: signals.map(({ name, industry, subIndustry, basis }) => ({ name, industry, subIndustry, basis })) };

  if (decision.status !== 'confirmed') {
    // Record the attempt only; leave any earlier detection alone so a thin re-check cannot erase a confirmed industry.
    await query(
      `INSERT INTO site_profiles (site_id, industry_signals, industry_checked_at) VALUES ($1, $2::jsonb, now())
       ON CONFLICT (site_id) DO UPDATE SET industry_signals = EXCLUDED.industry_signals, industry_checked_at = now()`,
      [siteId, JSON.stringify(record)]);
    return { applied: false, ...decision, signals: record.signals };
  }

  // Keep the project's own wording when it already means this industry ("Study abroad and overseas education consultancy" is richer
  // than "education", and the trend and content agents read that text). Write the catalog key only when there was nothing usable.
  const own = (existing?.industry && classifyIndustry(existing.industry).industry === decision.industry) ? existing.industry : decision.industry;
  const saved = { ...record, confirmed: { industry: decision.industry, subIndustry: decision.subIndustry }, agreeing: decision.agreeing };
  await query(
    `INSERT INTO site_profiles (site_id, industry, industry_source, industry_confidence, industry_signals, industry_checked_at)
     VALUES ($1, $2, 'detected', 'medium', $3::jsonb, now())
     ON CONFLICT (site_id) DO UPDATE SET industry = EXCLUDED.industry, industry_source = 'detected', industry_confidence = 'medium',
       industry_signals = EXCLUDED.industry_signals, industry_checked_at = now()`,
    [siteId, own, JSON.stringify(saved)]);
  return { applied: true, industry: decision.industry, subIndustry: decision.subIndustry, agreeing: decision.agreeing, signals: record.signals };
}

/** Whether a project has a confirmed industry the client may see. */
export async function confirmedIndustry(siteId, { query = dbQuery } = {}) {
  const { rows } = await query(
    `SELECT industry, industry_source, industry_confidence, industry_signals FROM site_profiles WHERE site_id = $1`, [siteId]);
  const p = rows[0];
  // 'inferred' (one collector) and 'llm-classified' alone are single signals: not enough to show a client an industry page.
  if (!p?.industry || !SHOWN_SOURCES.includes(p.industry_source)) return null;
  // The stored value is normally a catalog key ('real-estate'); the catalog's text matcher is for free text ('Senior relocation').
  const sig = tryJson(p.industry_signals) || {};
  const cls = sig.confirmed?.industry ? { industry: sig.confirmed.industry, subIndustry: sig.confirmed.subIndustry || '' }
    : INDUSTRY_KEYS.includes(p.industry) ? { industry: p.industry, subIndustry: '' } : classifyIndustry(p.industry);
  if (!cls.industry) return null;
  return { industry: cls.industry, subIndustry: cls.subIndustry || '', source: p.industry_source, confidence: p.industry_confidence, agreeing: sig.agreeing || [], signals: sig.signals || [] };
}

// ── wiring ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Homepage text for the classifier: the project's own domain, https only, short timeout, scripts and tags stripped. */
export async function fetchHomepageText(domain, { fetchImpl = fetch, timeoutMs = 8000 } = {}) {
  const host = String(domain || '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').trim();
  if (!host || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) return null;
  const res = await fetchImpl(`https://${host}/`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow', headers: { 'user-agent': 'SuperRankBot/1.0' } });
  if (!res.ok) return null;
  const html = (await res.text()).slice(0, 400_000);
  const text = html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
  return text.length > 80 ? text.slice(0, 3500) : null;
}

/** The baseline's industry step. Best-effort: it must never fail onboarding. */
export async function runIndustryDetection(site, { deps = {} } = {}) {
  try {
    const { callLLMForJson } = await import('../llm.js');
    return await detectIndustryForSite(site, { deps: {
      callJson: (system, user) => callLLMForJson(system, user, { maxTokens: 200, siteId: site.id }),
      fetchText: fetchHomepageText,
      ...deps,
    } });
  } catch (err) {
    console.error(`[industry] site ${site.id} detection failed:`, err.message);
    return { applied: false, status: 'error', reason: err.message };
  }
}

/** Re-check every project that has no confirmed industry (or was last checked more than RECHECK_DAYS ago and is not set by a person). */
export async function recheckIndustries({ deps = {}, now = new Date() } = {}) {
  const query = deps.query || dbQuery;
  const { rows } = await query(
    `SELECT s.id, s.website_domain FROM sites s LEFT JOIN site_profiles p ON p.site_id = s.id
      WHERE s.deleted_at IS NULL AND COALESCE(p.industry_source, '') NOT IN ('human', 'growth-config', 'detected')
        AND (p.industry_checked_at IS NULL OR p.industry_checked_at < now() - ($1 || ' days')::interval)
      ORDER BY s.id LIMIT 50`, [String(RECHECK_DAYS)]);
  const results = [];
  for (const site of rows) results.push({ siteId: site.id, ...(await (deps.run || runIndustryDetection)(site, { deps })) });
  return { checked: results.length, applied: results.filter((r) => r.applied).length, results };
}
