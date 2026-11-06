// INDUSTRY INTELLIGENCE (Phase 3): knowledge that belongs to an industry, not to a tenant.
//
// Three jobs, kept separate:
//   1. classify    - which industry (and sub-industry) is a project in? Reuses the trend-feed catalog's vocabulary and
//                    the industry already captured at onboarding (site_profiles.industry + source + confidence); it does
//                    not invent a second taxonomy that could disagree with the first.
//   2. learn       - turn many projects' MEASURED outcomes into industry-level patterns, and promote one only when it is
//                    backed by enough distinct projects (each project counts as its own client). Aggregate counts only.
//   3. retrieve    - give a project the knowledge for ITS industry, each item labelled with how well it is supported.
//
// Privacy is structural, not a filter bolted on afterwards: the only inputs to a stored row are catalog labels, a
// validated slug and counts (see `assertShareable`). There is no code path that copies a URL, domain, query, draft body or
// client name into the shared table, so there is nothing for a bug to leak. Tests plant tenant strings and check they never
// appear.
//
// Everything learned is an OBSERVED ASSOCIATION between a change and later search results, never a proven cause, and the
// claim text says so.

import { onUnlessDisabled } from './feature-flags.js';
import { FEED_CATALOG, FEED_CATALOG_KEYS } from '../agents/lib/trend-feeds.js';

export const INDUSTRY_KEYS = FEED_CATALOG_KEYS;

// ── thresholds (exported so tests and the CLI read the same numbers) ────────────────────────────────────────────────
export const MIN_SITES = 2;          // distinct projects that voted (owner decision 2026-11-06: 2, down from 3; 'high' confidence still needs ESTABLISHED_SITES)
export const MIN_WORKSPACES = 1;     // a PROJECT is its own client (owner decision 2026-11-06): which workspace it sits in, or who created it, does not matter. Still recorded in the evidence, no longer required.
export const MIN_MEASURED = 5;       // measured outcomes behind those votes
export const AGREEMENT = 0.7;        // share of voting projects that must point the same way
export const CONTRADICTION = 0.3;    // if the minority side is at least this share, the pattern is contradicted
export const CONFOUND_WINDOW_DAYS = 28; // another change merged on the SAME page this close to a measured fix muddies which one moved the numbers
export const VALID_DAYS = 180;       // validated learned knowledge stops being served after this unless re-confirmed
export const ESTABLISHED_SITES = 8;  // evidence label: 'high' confidence needs at least this many projects

const MS_DAY = 24 * 60 * 60 * 1000;
const SLUG = /^[a-z0-9][a-z0-9._-]*$/;

// ── 1. classification ───────────────────────────────────────────────────────────────────────────────────────────────

// Sub-industries are a small, explicit list per industry. A project gets one only when its own industry text or topics
// clearly say so; otherwise sub_industry stays '' (the whole industry), never a guess.
const SUB_INDUSTRIES = {
  education: [
    { key: 'study-abroad', match: /\b(abroad|overseas|international students?|admission\w*|visa)\b/i },
    { key: 'higher-education', match: /\b(universit\w*|college\w*|higher ed\w*|academic\w*)\b/i },
    { key: 'edtech', match: /\b(edtech|e-?learning|online learning|learning platform)\b/i },
  ],
  healthcare: [
    { key: 'dental', match: /\b(dental|dentist\w*|orthodont\w*)\b/i },
    { key: 'clinic', match: /\b(clinic\w*|physician\w*|general practice)\b/i },
  ],
  'real-estate': [
    { key: 'residential', match: /\b(residential|housing|home\w*|apartment\w*)\b/i },
    { key: 'relocation', match: /\b(relocat\w*|downsiz\w*|senior (living|housing|move\w*)|move management)\b/i },
  ],
};

// industry: the free-text industry string (or array) recorded for the project; topics: optional extra words.
// Returns { industry, subIndustry } or { industry: null } when the catalog cannot place it. 'technology' is horizontal
// (it matches almost anything software-adjacent), so a more specific industry wins when both match.
export function classifyIndustry(industry, topics = []) {
  const text = Array.isArray(industry) ? industry.join(' | ') : String(industry || '');
  if (!text.trim()) return { industry: null, subIndustry: '' };
  const matches = FEED_CATALOG.filter((e) => e.match(text));
  if (!matches.length) return { industry: null, subIndustry: '' };
  const specific = matches.find((e) => !e.horizontal);
  const chosen = (specific || matches[0]).key;
  const haystack = `${text} ${(Array.isArray(topics) ? topics : []).filter((t) => typeof t === 'string').join(' ')}`;
  const sub = (SUB_INDUSTRIES[chosen] || []).find((s) => s.match.test(haystack));
  return { industry: chosen, subIndustry: sub ? sub.key : '' };
}

// Whether a project's recorded industry is trustworthy enough to CONTRIBUTE to shared knowledge. An 'unmapped' source or a
// low-confidence guess (an LLM reading a homepage) must not decide what a whole industry "learns".
export function canContribute(profile) {
  if (!profile) return { ok: false, reason: 'no-profile' };
  if (profile.share_industry_learning === false) return { ok: false, reason: 'opted-out' };
  if (!profile.industry) return { ok: false, reason: 'no-industry' };
  if (profile.industry_source === 'unmapped') return { ok: false, reason: 'industry-unmapped' };
  if (profile.industry_confidence === 'low' || !profile.industry_confidence) return { ok: false, reason: 'industry-low-confidence' };
  if (!classifyIndustry(profile.industry).industry) return { ok: false, reason: 'industry-unmapped' };
  return { ok: true };
}

// ── 2. learning ─────────────────────────────────────────────────────────────────────────────────────────────────────

// One project's measured outcomes for one generator become ONE vote, so a project with forty pages cannot outweigh a
// project with three. Inconclusive and pre-verdict ("legacy") results are not votes: they say the data did not settle it.
export function siteVote({ positive = 0, negative = 0 }) {
  if (positive === 0 && negative === 0) return null;
  if (positive > negative) return 'positive';
  if (negative > positive) return 'negative';
  return 'mixed';
}

// rows: [{ siteId, workspaceId, industry, subIndustry?, generatorId, positive, negative, inconclusive }], already restricted
// to contributing projects. Returns one group per (industry, subIndustry, generator) with COUNTS ONLY - no ids survive.
// A project contributes to its whole industry AND, if it has one, its sub-industry, so a sub-industry pattern is never
// built from fewer projects than it claims.
export function aggregateGroups(rows) {
  const buckets = new Map();
  const add = (industry, subIndustry, r) => {
    const key = `${industry}\u0000${subIndustry}\u0000${r.generatorId}`;
    if (!buckets.has(key)) {
      buckets.set(key, { industry, subIndustry, generatorId: r.generatorId, sites: new Set(), workspaces: new Set(), votes: { positive: 0, negative: 0, mixed: 0 }, measured: 0, inconclusive: 0, confounded: 0 });
    }
    const b = buckets.get(key);
    const vote = siteVote(r);
    b.measured += (r.positive || 0) + (r.negative || 0);
    b.inconclusive += r.inconclusive || 0;
    b.confounded += r.confounded || 0;
    if (!vote) return;
    // The same project must not vote twice for one group (input is already per project, this is a guard).
    if (b.sites.has(r.siteId)) return;
    b.sites.add(r.siteId);
    b.workspaces.add(r.workspaceId ?? `site:${r.siteId}`);
    b.votes[vote] += 1;
  };
  for (const r of rows) {
    if (!r.industry || !r.generatorId || !SLUG.test(String(r.generatorId))) continue;
    add(r.industry, '', r);
    if (r.subIndustry) add(r.industry, r.subIndustry, r);
  }
  return [...buckets.values()].map((b) => ({
    industry: b.industry,
    subIndustry: b.subIndustry,
    generatorId: b.generatorId,
    evidence: {
      sites: b.sites.size,
      workspaces: b.workspaces.size,
      measured: b.measured,
      inconclusive: b.inconclusive,
      confounded: b.confounded,
      positiveSites: b.votes.positive,
      negativeSites: b.votes.negative,
      mixedSites: b.votes.mixed,
    },
  }));
}

// Decide what a group's evidence supports. Pure.
export function evaluateGroup(evidence) {
  const voting = evidence.positiveSites + evidence.negativeSites + evidence.mixedSites;
  const enough = evidence.sites >= MIN_SITES && evidence.workspaces >= MIN_WORKSPACES && evidence.measured >= MIN_MEASURED;
  if (!enough || voting === 0) {
    return { status: 'candidate', polarity: 'mixed', confidence: 'low', reason: 'not-enough-evidence' };
  }
  const pos = evidence.positiveSites / voting;
  const neg = evidence.negativeSites / voting;
  if (pos >= AGREEMENT) {
    return { status: 'validated', polarity: 'works', confidence: evidence.sites >= ESTABLISHED_SITES ? 'high' : 'medium', reason: 'projects-agree-positive' };
  }
  if (neg >= AGREEMENT) {
    return { status: 'validated', polarity: 'does-not-work', confidence: evidence.sites >= ESTABLISHED_SITES ? 'high' : 'medium', reason: 'projects-agree-negative' };
  }
  // No side reached agreement. If both sides are real, the projects contradict each other, which is information in itself.
  if (pos >= CONTRADICTION && neg >= CONTRADICTION) {
    return { status: 'contradicted', polarity: 'mixed', confidence: 'low', reason: 'projects-disagree' };
  }
  return { status: 'candidate', polarity: 'mixed', confidence: 'low', reason: 'no-clear-pattern' };
}

const LABEL = (s) => String(s).replace(/[-_.]/g, ' ');

// The claim is built ONLY from catalog labels, a validated slug and counts.
export function claimFor({ industry, subIndustry, generatorId, evidence, polarity }) {
  const where = subIndustry ? `${LABEL(industry)} (${LABEL(subIndustry)})` : LABEL(industry);
  const n = evidence.sites;
  if (polarity === 'works') {
    return `In ${where} projects, "${LABEL(generatorId)}" changes were followed by better search results in ${evidence.positiveSites} of ${n} projects (observed association, not proven cause).`;
  }
  if (polarity === 'does-not-work') {
    return `In ${where} projects, "${LABEL(generatorId)}" changes were followed by worse search results in ${evidence.negativeSites} of ${n} projects (observed association, not proven cause).`;
  }
  return `In ${where} projects, results after "${LABEL(generatorId)}" changes are ${polarity === 'mixed' ? 'not yet consistent' : polarity} (${n} projects so far).`;
}

// Last line of defence before anything is written to the shared table. Throws rather than silently cleaning, so a bug
// shows up in tests instead of leaking quietly.
export function assertShareable(item) {
  const bad = [];
  if (!INDUSTRY_KEYS.includes(item.industry)) bad.push('industry not in catalog');
  if (item.subIndustry && !SLUG.test(item.subIndustry)) bad.push('sub-industry not a slug');
  if (!SLUG.test(String(item.subject))) bad.push('subject not a slug');
  const allowedEvidence = new Set(['sites', 'workspaces', 'measured', 'inconclusive', 'confounded', 'positiveSites', 'negativeSites', 'mixedSites', 'basis', 'window']);
  for (const [k, v] of Object.entries(item.evidence || {})) {
    if (!allowedEvidence.has(k)) bad.push(`evidence key "${k}" not allowed`);
    if (typeof v !== 'number' && typeof v !== 'string') bad.push(`evidence "${k}" not a scalar`);
  }
  if (/https?:\/\/|www\.|@[a-z0-9]|\.(com|np|org|net|io)\b/i.test(String(item.claim))) bad.push('claim contains a url, domain or address');
  if (bad.length) throw new Error(`Refusing to store unshareable industry knowledge: ${bad.join('; ')}`);
  return item;
}

// Turn aggregated groups into the rows to store. Pure.
export function buildKnowledgeRows(groups, { now = new Date() } = {}) {
  return groups.map((g) => {
    const verdict = evaluateGroup(g.evidence);
    const row = {
      industry: g.industry,
      subIndustry: g.subIndustry,
      kind: 'generator-outcome',
      subject: g.generatorId,
      surface: 'general',
      polarity: verdict.polarity,
      claim: claimFor({ ...g, polarity: verdict.polarity }),
      evidence: g.evidence,
      confidence: verdict.confidence,
      status: verdict.status,
      source: 'cross-project',
      expiresAt: verdict.status === 'validated' ? new Date(now.getTime() + VALID_DAYS * MS_DAY) : null,
      reason: verdict.reason,
    };
    return assertShareable(row);
  });
}

// ── curated starting points ─────────────────────────────────────────────────────────────────────────────────────────
// General, widely documented practice for each industry. They are guidance to start from, NOT findings: source 'curated',
// confidence 'low', status 'candidate', and the claim says so. Each is about structure or content that a project either has
// or lacks, so it is checkable. Nothing here is a ranking promise.
const NOT_PROVEN = 'General starting point from industry convention; not yet confirmed by outcomes on our own projects.';
export const CURATED_PRACTICES = [
  { industry: 'education', subject: 'org-structured-data', surface: 'seo', claim: `Mark up the institution or service with EducationalOrganization (or CollegeOrUniversity) structured data and keep name, address and contact consistent across the site. ${NOT_PROVEN}` },
  { industry: 'education', subject: 'admissions-faq', surface: 'aeo', claim: `Answer the questions students ask before applying (requirements, fees, deadlines, intakes) as short question-and-answer sections, so AI answers and quick answers can quote them. ${NOT_PROVEN}` },
  { industry: 'education', subIndustry: 'study-abroad', subject: 'destination-pages', surface: 'geo', claim: `Give each destination country or university its own page with specific, checkable facts (courses, costs, visa steps) so an AI assistant has something concrete to cite. ${NOT_PROVEN}` },
  { industry: 'healthcare', subject: 'local-business-structured-data', surface: 'seo', claim: `Use MedicalClinic or Physician (or LocalBusiness) structured data with accurate opening hours and address, and keep it identical to listings elsewhere. ${NOT_PROVEN}` },
  { industry: 'healthcare', subject: 'reviewed-health-content', surface: 'geo', claim: `Show who wrote or reviewed health information and cite recognised sources; health content is held to a higher standard by search engines and AI assistants. ${NOT_PROVEN}` },
  { industry: 'real-estate', subject: 'location-pages', surface: 'seo', claim: `Create specific pages for each area served, with local facts a buyer or seller would search for, rather than one generic page listing every place. ${NOT_PROVEN}` },
  { industry: 'real-estate', subject: 'agent-structured-data', surface: 'seo', claim: `Use RealEstateAgent or LocalBusiness structured data and keep the business details identical across directory listings. ${NOT_PROVEN}` },
  { industry: 'wellness', subject: 'service-and-pricing-pages', surface: 'aeo', claim: `Give each service its own page with what it involves, how long it takes and what it costs, so the common questions can be answered directly. ${NOT_PROVEN}` },
  { industry: 'wellness', subject: 'local-business-structured-data', surface: 'seo', claim: `Use LocalBusiness structured data with hours, address and a booking link, and keep it identical to the business listings. ${NOT_PROVEN}` },
  { industry: 'technology', subject: 'software-structured-data', surface: 'seo', claim: `Use SoftwareApplication (or Product) structured data on product pages and keep a clear, crawlable documentation section. ${NOT_PROVEN}` },
  { industry: 'technology', subject: 'plain-language-product-answers', surface: 'geo', claim: `State plainly what the product does, who it is for and what it costs, in text rather than images, so AI assistants can describe it accurately. ${NOT_PROVEN}` },
];

export function curatedRows() {
  return CURATED_PRACTICES.map((p) => assertShareable({
    industry: p.industry,
    subIndustry: p.subIndustry || '',
    kind: 'practice',
    subject: p.subject,
    surface: p.surface,
    polarity: 'guidance',
    claim: p.claim,
    evidence: { basis: 'curated', sites: 0 },
    confidence: 'low',
    status: 'candidate',
    source: 'curated',
    expiresAt: null,
    reason: 'curated-starting-point',
  }));
}

// ── 3. retrieval ────────────────────────────────────────────────────────────────────────────────────────────────────

// How to describe a stored row to a reader, so a candidate never reads like a validated finding.
export function describeItem(row, { now = new Date() } = {}) {
  const expired = row.status === 'validated' && row.expires_at && new Date(row.expires_at) < now;
  const label = expired ? 'stale'
    : row.status === 'validated' ? 'validated'
      : row.status === 'contradicted' ? 'contradicted'
        : row.source === 'curated' ? 'starting-point'
          : 'not-enough-evidence';
  return {
    industry: row.industry,
    subIndustry: row.sub_industry,
    kind: row.kind,
    subject: row.subject,
    surface: row.surface,
    polarity: row.polarity,
    claim: row.claim,
    status: expired ? 'stale' : row.status,
    label,
    confidence: row.confidence,
    source: row.source,
    evidence: row.evidence,
    asOf: row.last_evaluated_at,
    expiresAt: row.expires_at,
  };
}

// Pure: choose which stored rows apply to a project in (industry, subIndustry).
export function selectForProject(rows, { industry, subIndustry = '' }, { now = new Date() } = {}) {
  const items = rows
    .filter((r) => r.industry === industry && (r.sub_industry === '' || r.sub_industry === subIndustry) && r.status !== 'retired')
    .map((r) => describeItem(r, { now }));
  const by = (label) => items.filter((i) => i.label === label);
  return {
    validated: by('validated'),
    startingPoints: by('starting-point'),
    contradicted: by('contradicted'),
    stale: by('stale'),
    emerging: by('not-enough-evidence'),
  };
}

// What a project may be told about its industry. Reads the project's own industry from site_profiles and nothing else about
// the project; reads only the shared table. `deps` lets tests run without a database.
export async function getIndustryIntelligence(siteId, { deps = {}, now = new Date() } = {}) {
  const q = deps.query || (await import('../db.js')).query;
  const { rows: prof } = await q(
    `SELECT industry, industry_source, industry_confidence, main_topics_json
       FROM site_profiles WHERE site_id = $1`,
    [siteId]
  );
  const profile = prof[0] || null;
  if (!profile || !profile.industry) {
    return { siteId, classified: false, reason: 'No industry recorded for this project, so no industry knowledge is assumed.', ...selectForProject([], { industry: null }) };
  }
  let topics = profile.main_topics_json;
  if (typeof topics === 'string') { try { topics = JSON.parse(topics); } catch { topics = []; } }
  if (topics && !Array.isArray(topics)) topics = Object.keys(topics);
  const cls = classifyIndustry(profile.industry, topics || []);
  if (!cls.industry) {
    return { siteId, classified: false, reason: `"${profile.industry}" is not an industry the platform has knowledge for yet.`, ...selectForProject([], { industry: null }) };
  }
  const { rows } = await q(
    `SELECT * FROM industry_knowledge WHERE industry = $1 AND status <> 'retired' AND review_state IN ('auto', 'approved') ORDER BY kind, subject`,
    [cls.industry]
  );
  return {
    siteId,
    classified: true,
    industry: cls.industry,
    subIndustry: cls.subIndustry,
    classification: { source: profile.industry_source || null, confidence: profile.industry_confidence || null },
    ...selectForProject(rows, cls, { now }),
  };
}

// ── refresh (the only writer) ───────────────────────────────────────────────────────────────────────────────────────

// Reads measured outcomes of contributing projects, recomputes every group, upserts, and retires learned rows that are no
// longer produced (a project opted out, the data aged out). Curated rows are upserted but never overwritten with learned
// status. Returns a plain summary.
export async function refreshIndustryKnowledge({ deps = {}, now = new Date() } = {}) {
  const q = deps.query || (await import('../db.js')).query;
  const { rows } = await q(
    `SELECT s.id AS site_id, s.workspace_id, sp.industry, sp.industry_source, sp.industry_confidence,
            sp.share_industry_learning, sp.main_topics_json,
            fi.generator_id,
            count(*) FILTER (WHERE NOT fi.confounded AND fi.delta->>'verdict' = 'impact-positive')::int AS positive,
            count(*) FILTER (WHERE NOT fi.confounded AND fi.delta->>'verdict' = 'impact-negative')::int AS negative,
            count(*) FILTER (WHERE NOT fi.confounded AND (fi.delta->>'verdict' = 'impact-inconclusive' OR fi.delta->>'verdict' IS NULL))::int AS inconclusive,
            count(*) FILTER (WHERE fi.confounded)::int AS confounded
       FROM (
         -- Contamination guard: an outcome is set aside (counted, never voted) when another fix was merged on the same page
         -- within the window, because the movement cannot be credited to one change.
         SELECT f.*, EXISTS (
                  SELECT 1 FROM fix_impact o
                   WHERE o.site_id = f.site_id AND o.id <> f.id AND o.page_url IS NOT NULL AND o.page_url = f.page_url
                     AND abs(extract(epoch FROM (o.merged_at - f.merged_at))) < $1 * 86400
                ) AS confounded
           FROM fix_impact f
       ) fi
       JOIN sites s ON s.id = fi.site_id
       JOIN site_profiles sp ON sp.site_id = s.id
      WHERE fi.status = 'measured' AND fi.delta IS NOT NULL
      GROUP BY s.id, s.workspace_id, sp.industry, sp.industry_source, sp.industry_confidence, sp.share_industry_learning,
               sp.main_topics_json, fi.generator_id`,
    [CONFOUND_WINDOW_DAYS]
  );
  const skipped = {};
  const eligible = [];
  for (const r of rows) {
    const ok = canContribute(r);
    if (!ok.ok) { skipped[ok.reason] = (skipped[ok.reason] || 0) + 1; continue; }
    let topics = r.main_topics_json;
    if (typeof topics === 'string') { try { topics = JSON.parse(topics); } catch { topics = []; } }
    if (topics && !Array.isArray(topics)) topics = Object.keys(topics);
    const cls = classifyIndustry(r.industry, topics || []);
    eligible.push({ siteId: r.site_id, workspaceId: r.workspace_id, industry: cls.industry, subIndustry: cls.subIndustry, generatorId: r.generator_id, positive: r.positive, negative: r.negative, inconclusive: r.inconclusive, confounded: r.confounded });
  }

  const learned = buildKnowledgeRows(aggregateGroups(eligible), { now });
  const curated = curatedRows();
  const live = new Set();
  const counts = { validated: 0, candidate: 0, contradicted: 0, curated: curated.length, retired: 0 };

  // What is stored now, so every change of status / polarity / confidence can be logged with what it was before.
  const { rows: before } = await q(`SELECT id, industry, sub_industry, kind, subject, status, polarity, confidence, review_state FROM industry_knowledge`);
  const keyOf = (r) => `${r.industry}|${r.sub_industry ?? r.subIndustry}|${r.kind}|${r.subject}`;
  const prior = new Map(before.map((b) => [keyOf(b), b]));
  const log = async (e) => {
    await q(
      `INSERT INTO industry_knowledge_log (knowledge_id, industry, sub_industry, kind, subject, event, from_status, to_status,
                                           from_polarity, to_polarity, from_confidence, to_confidence, review_state, evidence, reason, actor)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,'system')`,
      [e.id, e.industry, e.subIndustry, e.kind, e.subject, e.event, e.fromStatus ?? null, e.toStatus ?? null,
       e.fromPolarity ?? null, e.toPolarity ?? null, e.fromConfidence ?? null, e.toConfidence ?? null, e.reviewState ?? null,
       JSON.stringify(e.evidence || {}), e.reason || '']
    );
  };

  const upsert = async (r) => {
    const { rows: saved } = await q(
      `INSERT INTO industry_knowledge (industry, sub_industry, kind, subject, surface, polarity, claim, evidence, confidence, status, source, last_evaluated_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13)
       ON CONFLICT (industry, sub_industry, kind, subject) DO UPDATE SET
         surface = EXCLUDED.surface, polarity = EXCLUDED.polarity, claim = EXCLUDED.claim, evidence = EXCLUDED.evidence,
         confidence = EXCLUDED.confidence, status = EXCLUDED.status, source = EXCLUDED.source,
         last_evaluated_at = EXCLUDED.last_evaluated_at, expires_at = EXCLUDED.expires_at
       RETURNING id, review_state`,
      [r.industry, r.subIndustry, r.kind, r.subject, r.surface, r.polarity, r.claim, JSON.stringify(r.evidence), r.confidence, r.status, r.source, now, r.expiresAt]
    );
    live.add(`${r.industry}|${r.subIndustry}|${r.kind}|${r.subject}`);
    const was = prior.get(keyOf(r));
    const base = { id: saved[0].id, industry: r.industry, subIndustry: r.subIndustry, kind: r.kind, subject: r.subject, evidence: r.evidence, reason: r.reason, reviewState: saved[0].review_state };
    if (!was) await log({ ...base, event: 'created', toStatus: r.status, toPolarity: r.polarity, toConfidence: r.confidence });
    else if (was.status !== r.status || was.polarity !== r.polarity || was.confidence !== r.confidence) {
      await log({ ...base, event: 'changed', fromStatus: was.status, toStatus: r.status, fromPolarity: was.polarity, toPolarity: r.polarity, fromConfidence: was.confidence, toConfidence: r.confidence });
    }
  };
  for (const r of learned) { await upsert(r); counts[r.status] += 1; }
  for (const r of curated) await upsert(r);

  // Learned rows that were stored before but are not produced any more: retire, never silently keep serving them.
  const { rows: existing } = await q(`SELECT id, industry, sub_industry, kind, subject, status, polarity, confidence, review_state FROM industry_knowledge WHERE kind = 'generator-outcome' AND status <> 'retired'`);
  for (const e of existing) {
    if (live.has(`${e.industry}|${e.sub_industry}|${e.kind}|${e.subject}`)) continue;
    await q(`UPDATE industry_knowledge SET status = 'retired', expires_at = NULL, last_evaluated_at = $2 WHERE id = $1`, [e.id, now]);
    await log({ id: e.id, industry: e.industry, subIndustry: e.sub_industry, kind: e.kind, subject: e.subject, event: 'retired', fromStatus: e.status, toStatus: 'retired', fromPolarity: e.polarity, fromConfidence: e.confidence, reviewState: e.review_state, reason: 'no longer produced by measured outcomes' });
    counts.retired += 1;
  }
  return { evaluatedProjectGeneratorPairs: rows.length, contributing: eligible.length, skipped, ...counts };
}

// ── use in ranking (Phase 4) ────────────────────────────────────────────────────────────────────────────────────────

// Pure: Map<generatorId, item> for the ranking step. Only learned generator-outcome items are included (curated starting
// points are guidance for people, not evidence for ranking), and where both a sub-industry and a whole-industry item exist
// for the same generator the more specific one wins. Anything not validated is still included so the ranking can SHOW it was
// seen and not used.
export function buildIndustryMap(intel) {
  const map = new Map();
  if (!intel || !intel.classified) return map;
  const items = [...intel.validated, ...intel.contradicted, ...intel.stale, ...intel.emerging].filter((i) => i.kind === 'generator-outcome');
  for (const i of items.sort((a, b) => (a.subIndustry ? 1 : 0) - (b.subIndustry ? 1 : 0))) map.set(i.subject, i);
  return map;
}

// Whether the ranking step reads industry knowledge at all. ON unless explicitly disabled. Safe to leave on: it only ever scores
// VALIDATED patterns (2+ projects, 5+ measured outcomes, 70% agreement), so with none it changes nothing.
export const industryRankingEnabled = (env = process.env) => onUnlessDisabled(env.INDUSTRY_INTELLIGENCE_RANKING);

// Never throws: a failure to load industry knowledge must leave ranking exactly as it was, not stop the day's run.
export async function loadIndustryMap(siteId, { deps = {} } = {}) {
  if (!(deps.enabled ?? industryRankingEnabled())) return new Map();
  try {
    return buildIndustryMap(await (deps.getIndustryIntelligence || getIndustryIntelligence)(siteId, { deps: deps.queryDeps }));
  } catch (err) {
    console.warn(`[industry-intelligence] not used for site ${siteId}: ${err.message}`);
    return new Map();
  }
}
