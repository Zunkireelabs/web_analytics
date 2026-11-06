// Phase 7: turning VALIDATED learning records into privacy-safe training examples, versioned and split. Pure functions plus
// one loader. This module never trains, never calls a model, and never sends data anywhere; it only prepares files.
//
// A training example is a decision the platform made whose real-world result was MEASURED and was good:
//   decision (situation, evidence summaries, chosen action, rationale)  +  fix_impact verdict 'impact-positive'
// Not eligible (and counted in the manifest with the reason, never silently dropped):
//   - the decision has no measured outcome yet, or the outcome was inconclusive / insufficient-data   (no evidence it was good)
//   - the outcome is negative                                                                         (kept out of targets)
//   - the outcome is confounded (another fix on the same page inside the window)                       (cannot credit the decision)
//   - the project opted out of sharing learning                                                        (same consent as industry knowledge)
//   - the action is not one the decision engine can take
// Correlation is not causation: a "good" label means search results were better after the change, not that the decision caused it.

import { createHash } from 'node:crypto';
import { DECISION_ACTIONS } from '../agents/lib/decision-engine.js';
import { CONFOUND_WINDOW_DAYS } from './industry-intelligence.js';

export const SCHEMA_VERSION = 1;
export const SCRUBBER_VERSION = 1;
export const SPLIT = Object.freeze({ train: 80, validation: 10, eval: 10 }); // percent of WORKSPACES
const MAX_EVIDENCE_ITEMS = 12;
const MAX_TEXT = 600;

// ── privacy ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const URL_RE = /\bhttps?:\/\/[^\s"'<>)]+/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const DOMAIN_RE = /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|co|np|in|uk|au|ai|app|dev|info|biz|edu|gov)(?:\/[^\s"'<>)]*)?\b/gi;
const PHONE_RE = /(?<!\d)(?:\+?\d[\d\s().-]{8,}\d)(?!\d)/g;
const PATH_RE = /(?<![\w<])\/[A-Za-z0-9][A-Za-z0-9\-_/.%]{2,}/g;

const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// `knownTerms`: strings that identify THIS project (its name, domain, brand) and must never appear.
export function scrubText(text, knownTerms = []) {
  // Whole urls and emails go first, while they are still intact; client names are replaced afterwards.
  let out = String(text ?? '').replace(URL_RE, '<URL>').replace(EMAIL_RE, '<EMAIL>');
  for (const term of knownTerms) {
    const t = String(term || '').trim();
    if (t.length >= 3) out = out.replace(new RegExp(escapeRe(t), 'gi'), '<CLIENT>');
  }
  return out
    .replace(DOMAIN_RE, '<DOMAIN>')
    .replace(PHONE_RE, '<PHONE>')
    .replace(PATH_RE, '<PATH>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT);
}

// Last line of defence. Throws rather than cleaning, so a gap in the scrubber shows up in a test, not in a dataset.
export function assertTrainingSafe(example, knownTerms = []) {
  const text = JSON.stringify([example.input, example.output]);
  const bad = [];
  if (/https?:\/\//i.test(text)) bad.push('url');
  if (new RegExp(EMAIL_RE.source).test(text)) bad.push('email');
  if (new RegExp(DOMAIN_RE.source, 'i').test(text)) bad.push('domain');
  for (const term of knownTerms) {
    const t = String(term || '').trim();
    if (t.length >= 3 && new RegExp(escapeRe(t), 'i').test(text)) bad.push('client term');
  }
  if ('siteId' in example || 'workspaceId' in example || 'site_id' in example) bad.push('tenant id field');
  if (bad.length) throw new Error(`Refusing to keep an unsafe training example: ${[...new Set(bad)].join(', ')}`);
  return example;
}

// ── eligibility ──────────────────────────────────────────────────────────────────────────────────────────────────────

// row: one decision joined to its measured outcome and its project. Pure.
export function classifyDecision(row) {
  if (!row) return { include: false, reason: 'no-row' };
  if (row.share_industry_learning === false) return { include: false, reason: 'project-opted-out' };
  if (!row.workspace_id) return { include: false, reason: 'no-workspace' };
  if (!DECISION_ACTIONS.includes(row.action)) return { include: false, reason: 'unknown-action' };
  if (row.decision_status !== 'verified' || row.impact_status !== 'measured') return { include: false, reason: 'no-measured-outcome' };
  if (row.confounded) return { include: false, reason: 'confounded' };
  const verdict = row.verdict;
  if (verdict === 'impact-positive') return { include: true, label: 'good' };
  if (verdict === 'impact-negative') return { include: false, reason: 'negative-outcome' };
  return { include: false, reason: 'inconclusive-outcome' };
}

const asArray = (v) => (Array.isArray(v) ? v : typeof v === 'string' ? safeJson(v, []) : []);
function safeJson(s, fallback) { try { return JSON.parse(s); } catch { return fallback; } }

// Pure. Builds one scrubbed example (no ids inside) plus its split key kept OUTSIDE the example.
export function toExample(row, knownTerms = []) {
  const evidence = asArray(row.evidence).slice(0, MAX_EVIDENCE_ITEMS).map((e) => ({
    source: String(e?.source || 'unknown').slice(0, 40),
    summary: scrubText(e?.summary, knownTerms),
  })).filter((e) => e.summary);
  const input = {
    situation: scrubText(row.situation, knownTerms),
    evidence,
    missingEvidence: asArray(row.missing_evidence).slice(0, 8).map((m) => scrubText(m, knownTerms)),
  };
  const output = {
    action: row.action,
    rationale: scrubText(row.rationale, knownTerms),
    confidence: Number(row.confidence),
  };
  const example = { input, output, label: 'good' };
  example.id = createHash('sha256').update(JSON.stringify([input, output])).digest('hex').slice(0, 16);
  return assertTrainingSafe(example, knownTerms);
}

// ── split ────────────────────────────────────────────────────────────────────────────────────────────────────────────

// A whole workspace goes to ONE split, so a client's decisions never sit in training and evaluation together (leakage would
// make the evaluation look better than it is). Deterministic: the same workspace always lands in the same split.
export function splitFor(workspaceId) {
  const n = parseInt(createHash('sha256').update(`split:v${SCHEMA_VERSION}:${workspaceId}`).digest('hex').slice(0, 8), 16) % 100;
  if (n < SPLIT.train) return 'train';
  if (n < SPLIT.train + SPLIT.validation) return 'validation';
  return 'eval';
}

// ── dataset ──────────────────────────────────────────────────────────────────────────────────────────────────────────

// rows: decisions joined as described in classifyDecision, plus `workspace_id` and `knownTerms` (array) per row.
export function buildDataset(rows) {
  const excluded = {};
  const splits = { train: [], validation: [], eval: [] };
  const workspaces = { train: new Set(), validation: new Set(), eval: new Set() };
  const seen = new Set();
  for (const row of rows || []) {
    const c = classifyDecision(row);
    if (!c.include) { excluded[c.reason] = (excluded[c.reason] || 0) + 1; continue; }
    const ex = toExample(row, row.knownTerms || []);
    if (seen.has(ex.id)) { excluded.duplicate = (excluded.duplicate || 0) + 1; continue; } // identical examples would inflate counts
    seen.add(ex.id);
    const split = splitFor(row.workspace_id);
    splits[split].push({ ...ex, split });
    workspaces[split].add(row.workspace_id);
  }
  for (const k of Object.keys(splits)) splits[k].sort((a, b) => (a.id < b.id ? -1 : 1));
  const all = [...splits.train, ...splits.validation, ...splits.eval];
  const actionCounts = {};
  for (const e of splits.train) actionCounts[e.output.action] = (actionCounts[e.output.action] || 0) + 1;
  const version = createHash('sha256').update(JSON.stringify([SCHEMA_VERSION, SCRUBBER_VERSION, all.map((e) => e.id)])).digest('hex').slice(0, 16);
  const manifest = {
    version,
    schemaVersion: SCHEMA_VERSION,
    scrubberVersion: SCRUBBER_VERSION,
    counts: { train: splits.train.length, validation: splits.validation.length, eval: splits.eval.length, total: all.length },
    workspaces: { train: workspaces.train.size, validation: workspaces.validation.size, eval: workspaces.eval.size },
    trainActionCounts: actionCounts,
    excluded,
    label: 'positive measured outcome (observed association, not proven cause)',
  };
  return { version, splits, manifest };
}

// One JSON object per line, ready to write to a file. Pure.
export const toJsonl = (examples) => examples.map((e) => JSON.stringify(e)).join('\n') + (examples.length ? '\n' : '');

const GENERIC_NAME_WORDS = new Set(['education', 'educational', 'consultancy', 'consultants', 'consulting', 'services', 'service', 'solutions', 'digital', 'group', 'company', 'limited', 'institute', 'academy', 'international', 'global', 'center', 'centre', 'studio', 'agency', 'health', 'care', 'clinic', 'travel', 'real', 'estate', 'software', 'technology', 'technologies', 'labs', 'online', 'store', 'shop']);

// Everything that names THIS project: its name, domain, search property and the brand word inside the domain.
export function identifyingTerms({ site_name, website_domain, gsc_property }) {
  const terms = new Set([site_name, website_domain, gsc_property].filter(Boolean).map(String));
  // Distinctive words of the project's name (a text often says "Acme", not "Acme Education Consultancy Pvt"). Generic words
  // stay, otherwise every example would lose words like "education".
  for (const w of String(site_name || '').split(/[^A-Za-z0-9]+/)) {
    if (w.length >= 4 && !GENERIC_NAME_WORDS.has(w.toLowerCase())) terms.add(w);
  }
  for (const d of [website_domain, gsc_property]) {
    const host = String(d || '').replace(/^sc-domain:/, '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
    const label = host.split('.')[0];
    if (label && label.length >= 4) terms.add(label);
  }
  return [...terms];
}

// ── loader ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export async function loadDecisionRows({ deps = {} } = {}) {
  const q = deps.query || (await import('../db.js')).query;
  const { rows } = await q(
    `SELECT d.id, d.situation, d.evidence, d.missing_evidence, d.action, d.rationale, d.confidence, d.status AS decision_status,
            s.workspace_id, s.name AS site_name, s.website_domain, s.gsc_property,
            COALESCE(sp.share_industry_learning, true) AS share_industry_learning,
            fi.status AS impact_status, fi.delta->>'verdict' AS verdict,
            (fi.page_url IS NOT NULL AND EXISTS (
               SELECT 1 FROM fix_impact o
                WHERE o.site_id = fi.site_id AND o.id <> fi.id AND o.page_url = fi.page_url
                  AND abs(extract(epoch FROM (o.merged_at - fi.merged_at))) < $1 * 86400)) AS confounded
       FROM decisions d
       JOIN sites s ON s.id = d.site_id
       LEFT JOIN site_profiles sp ON sp.site_id = s.id
       LEFT JOIN fix_impact fi ON d.outcome_ref = 'fix_impact:' || fi.id::text`,
    [CONFOUND_WINDOW_DAYS]
  );
  return rows.map((r) => ({ ...r, knownTerms: identifyingTerms(r) }));
}
