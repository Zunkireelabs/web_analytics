// Verified product knowledge (product_capabilities, migrations 111 + 176)
// turned into prompt text for generators that WRITE about a product — landing
// pages today, feature / how-it-works copy next. The positioning guard
// (positioning-guard.js) already CHECKS a finished draft against capabilities;
// this is the other half: giving the model the real facts up front so it has
// no reason to invent any.
//
// Only 'verified' rows ever reach here (getProductKnowledge's default), and
// only for property_type = 'product' sites: a website tenant's generation
// prompt is deliberately left byte-for-byte as it was.
import { getProductKnowledge } from '../../store/data-analyst.js';

const KIND_HEADINGS = Object.freeze({
  capability: 'What the product does',
  flow: 'How it works',
  pricing: 'Pricing',
  audience: 'Who it is for',
  proof: 'Proof points',
});
const KIND_ORDER = Object.freeze(['capability', 'flow', 'audience', 'pricing', 'proof']);

function detailsText(details) {
  if (!details || typeof details !== 'object') return '';
  const parts = [];
  if (Array.isArray(details.steps) && details.steps.length) {
    parts.push(details.steps.map((s, i) => `${i + 1}. ${String(s)}`).join(' '));
  }
  for (const [key, value] of Object.entries(details)) {
    if (key === 'steps' || value === null || value === undefined || value === '') continue;
    parts.push(`${key}: ${Array.isArray(value) ? value.join(', ') : String(value)}`);
  }
  return parts.join(' | ');
}

// One line per fact; the same shape for every kind so the model reads them
// uniformly. Pure and deterministic (testable without a database).
export function formatKnowledgeLine(row) {
  const head = `${row.name}${row.category ? ` (${row.category})` : ''}`;
  const body = [row.description, detailsText(row.details)].filter(Boolean).join(' — ');
  return body ? `- ${head}: ${body}` : `- ${head}`;
}

export function formatProductFacts(rows) {
  const verified = (rows || []).filter((r) => r && r.name);
  if (!verified.length) return '';
  const byKind = new Map();
  for (const row of verified) {
    const kind = KIND_HEADINGS[row.kind] ? row.kind : 'capability';
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(row);
  }
  const sections = [];
  for (const kind of KIND_ORDER) {
    const group = byKind.get(kind);
    if (group?.length) sections.push(`${KIND_HEADINGS[kind]}:\n${group.map(formatKnowledgeLine).join('\n')}`);
  }
  return sections.join('\n\n');
}

// Returns '' for a website tenant, a site with no verified facts yet, or any
// lookup failure — generation then proceeds exactly as it did before this
// existed (never a fabricated fallback, never a blocked draft).
export async function loadProductFactsFor(site, { getKnowledge = getProductKnowledge } = {}) {
  if (!site || site.property_type !== 'product') return '';
  try {
    return formatProductFacts(await getKnowledge(site.id, 'verified'));
  } catch (e) {
    console.warn(`[product-facts] could not load verified product knowledge for site ${site.id}: ${e.message}`);
    return '';
  }
}
