// A brand-free STRUCTURE reference for expand-content, derived once from a
// well-structured site (zunkireelabs) and offered to other tenants that opt in.
//
// SCOPE: expand-content ONLY. No other page type or generator uses this, and
// the containment test asserts it. Every other page keeps its client's own
// design; this is the one place a shared reference is wanted.
//
// What "structure" means here, precisely:
//   shared (this spec)      — how many sections, in which ROLE order, what SHAPE
//                             each takes (card/list/table/prose), heading
//                             level relative to the host page, whether a table
//                             is ever warranted, and where the block is placed.
//   NEVER shared            — any class, colour, font, spacing value, template
//                             or wrapper. Those come from the tenant's own
//                             profile, always.
//
// And the tenant's own evidence wins FIELD BY FIELD: if its captured pages say
// anything about a field, that is used and the reference fills only genuine
// blanks. The opposite would converge every client on one site's shape, which
// is the reverse of "design according to that website".

export const SPEC_VERSION = 1;

export const ROLES = Object.freeze(['hero', 'content', 'features', 'pricing', 'testimonials', 'faq', 'cta']);
export const SHAPES = Object.freeze(['card', 'list', 'table', 'prose']);
export const HEADING_LEVELS = Object.freeze(['section', 'item']); // section -> h2, item -> h3 under a host page's h1
export const PLACEMENT_ANCHORS = Object.freeze(['after-last-content-section']);
const CHROME_ROLES = new Set(['header', 'footer', 'nav']);

const SECTION_COUNT_BOUNDS = { min: 1, max: 5 };

// ---------------------------------------------------------------------------
// Identity firewall
// ---------------------------------------------------------------------------
// The spec is enum-and-integer only by construction, so a leak is already
// structurally impossible. This is the second, independent layer: scan every
// string anywhere in the value for anything that looks like site identity, so
// that a future field added carelessly cannot smuggle a class or a colour in.
const IDENTITY_PATTERNS = [
  [/#[0-9a-fA-F]{3,8}\b/, 'hex colour'],
  [/\brgba?\(|\bhsla?\(/i, 'colour function'],
  [/\b\d+(\.\d+)?(px|rem|em|vh|vw)\b/i, 'css length'],
  [/\b(?:(?:sm|md|lg|xl|2xl|hover|focus|dark):)?(?:text|bg|border|ring|shadow|rounded|font|leading|tracking|gap|space|divide|grid-cols|col-span|flex|items|justify|p[xytblr]?|m[xytblr]?|w|h|min-w|max-w|min-h|max-h)-[\w./\[\]-]+/, 'utility class'],
  [/\bclass(Name)?\s*=/i, 'class attribute'],
  [/https?:\/\//i, 'url'],
];

function walkStrings(value, visit, path = '') {
  if (typeof value === 'string') visit(value, path);
  else if (Array.isArray(value)) value.forEach((v, i) => walkStrings(v, visit, `${path}[${i}]`));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { visit(k, `${path}.<key>`); walkStrings(v, visit, `${path}.${k}`); }
}

export function validateExpandStructureSpec(spec) {
  const errors = [];
  const bad = (m) => errors.push(m);
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return { ok: false, errors: ['spec must be an object'] };

  const allowedKeys = new Set(['version', 'sectionCount', 'sectionOrder', 'shapes', 'headingLevels', 'tableUsage', 'placement']);
  for (const k of Object.keys(spec)) if (!allowedKeys.has(k)) bad(`unknown field "${k}" — the spec is a closed schema so identity cannot be added by accident`);

  if (spec.version !== SPEC_VERSION) bad(`version must be ${SPEC_VERSION}`);

  const sc = spec.sectionCount;
  if (!sc || !Number.isInteger(sc.min) || !Number.isInteger(sc.max) || sc.min < SECTION_COUNT_BOUNDS.min || sc.max > SECTION_COUNT_BOUNDS.max || sc.min > sc.max) {
    bad(`sectionCount must be integers with ${SECTION_COUNT_BOUNDS.min} <= min <= max <= ${SECTION_COUNT_BOUNDS.max}`);
  }
  if (!Array.isArray(spec.sectionOrder) || !spec.sectionOrder.length || spec.sectionOrder.some((r) => !ROLES.includes(r))) {
    bad(`sectionOrder must be a non-empty list of roles from: ${ROLES.join(', ')}`);
  }
  if (!spec.shapes || typeof spec.shapes !== 'object' || Object.entries(spec.shapes).some(([r, s]) => !ROLES.includes(r) || !SHAPES.includes(s))) {
    bad(`shapes must map roles (${ROLES.join(', ')}) to shapes (${SHAPES.join(', ')})`);
  }
  if (!spec.headingLevels || typeof spec.headingLevels !== 'object' || Object.entries(spec.headingLevels).some(([r, l]) => !ROLES.includes(r) || !HEADING_LEVELS.includes(l))) {
    bad(`headingLevels must map roles to ${HEADING_LEVELS.join('/')}`);
  }
  if (!spec.tableUsage || typeof spec.tableUsage.allowed !== 'boolean') bad('tableUsage.allowed must be a boolean');
  const pl = spec.placement;
  if (!pl || !PLACEMENT_ANCHORS.includes(pl.anchor) || !Array.isArray(pl.before) || pl.before.some((r) => !ROLES.includes(r))) {
    bad('placement must be { anchor: a known anchor, before: [roles] } — an anchor RULE, never a marker name or offset');
  }

  walkStrings(spec, (str, path) => {
    for (const [re, label] of IDENTITY_PATTERNS) if (re.test(str)) bad(`${label} at ${path}: "${str.slice(0, 40)}" — a structure spec may carry no site identity`);
  });

  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Observation: read structure out of captured pages (profile.pages[])
// ---------------------------------------------------------------------------
const bodySections = (page) => (page?.sections || []).filter((s) => !CHROME_ROLES.has(s?.role));

function shapeOf(section) {
  const types = new Set((section.components || []).map((c) => c?.type));
  if (types.has('table')) return 'table';
  if (types.has('card')) return 'card';
  if (types.has('list')) return 'list';
  return 'prose';
}

function headingLevelOf(section) {
  const tags = (section.textHierarchy || []).filter((t) => t?.role === 'heading' || t?.role === 'subheading').map((t) => String(t.tag || '').toLowerCase());
  if (tags.includes('h2')) return 'section';
  if (tags.includes('h3')) return 'item';
  return null;
}

const mode = (xs) => {
  const counts = new Map();
  for (const x of xs) counts.set(x, (counts.get(x) || 0) + 1);
  let best = null; let n = 0;
  for (const [k, c] of counts) if (c > n) { best = k; n = c; }
  return best;
};
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1) + 0.5))];

// Returns whatever the pages genuinely show, with null for every field they do
// not. Used both to derive the shared spec (from a reference site) and to read
// a TENANT's own evidence — the same reading in both places is what makes
// "tenant evidence wins per field" a meaningful comparison.
export function observeStructure(pages) {
  const list = (pages || []).filter((p) => bodySections(p).length);
  const empty = { sectionCount: null, sectionOrder: null, shapes: {}, headingLevels: {}, tableAllowed: null, placementBefore: null, pagesObserved: 0 };
  if (!list.length) return empty;

  const contentCounts = list.map((p) => bodySections(p).filter((s) => s.role === 'content').length).filter((n) => n > 0).sort((a, b) => a - b);
  const sectionCount = contentCounts.length
    ? {
      min: Math.max(SECTION_COUNT_BOUNDS.min, quantile(contentCounts, 0.25)),
      max: Math.min(SECTION_COUNT_BOUNDS.max, Math.max(quantile(contentCounts, 0.75), quantile(contentCounts, 0.25))),
    }
    : null;

  // Role order of the most representative page, consecutive duplicates collapsed.
  const collapse = (roles) => roles.filter((r, i) => ROLES.includes(r) && r !== roles[i - 1]);
  const orders = list.map((p) => collapse(bodySections(p).map((s) => s.role)).join('>'));
  const sectionOrder = orders.length ? collapse(mode(orders).split('>')) : null;

  const shapes = {}; const headingLevels = {};
  for (const role of ROLES) {
    const ss = list.flatMap((p) => bodySections(p).filter((s) => s.role === role));
    if (!ss.length) continue;
    shapes[role] = mode(ss.map(shapeOf));
    const lv = ss.map(headingLevelOf).filter(Boolean);
    if (lv.length) headingLevels[role] = mode(lv);
  }

  const tableAllowed = list.some((p) => bodySections(p).some((s) => shapeOf(s) === 'table'));

  // What follows the content block on this site's pages: the anchor rule.
  const after = list.map((p) => {
    const roles = bodySections(p).map((s) => s.role);
    const last = roles.lastIndexOf('content');
    return last === -1 ? [] : collapse(roles.slice(last + 1)).filter((r) => r !== 'content');
  });
  const placementBefore = after.length ? (mode(after.map((a) => a.join('>'))) || '').split('>').filter(Boolean) : null;

  return { sectionCount, sectionOrder, shapes, headingLevels, tableAllowed, placementBefore, pagesObserved: list.length };
}

// The shared reference, derived deliberately from one site's pages and
// validated before it can ever be persisted.
export function deriveExpandStructureSpec(pages) {
  const o = observeStructure(pages);
  const spec = {
    version: SPEC_VERSION,
    sectionCount: o.sectionCount || { min: 2, max: 4 },
    sectionOrder: o.sectionOrder?.length ? o.sectionOrder : ['content'],
    shapes: o.shapes,
    headingLevels: o.headingLevels,
    tableUsage: { allowed: Boolean(o.tableAllowed) },
    placement: { anchor: 'after-last-content-section', before: o.placementBefore || [] },
  };
  const verdict = validateExpandStructureSpec(spec);
  return verdict.ok ? { ok: true, spec, pagesObserved: o.pagesObserved } : { ok: false, errors: verdict.errors };
}

// ---------------------------------------------------------------------------
// The prior a specific tenant gets
// ---------------------------------------------------------------------------
// Per field: the tenant's own observed evidence first, the shared reference
// only where the tenant shows nothing. `sources` records which won, so a
// reviewer can see exactly how much of a draft's structure was borrowed.
export function expandStructurePrior(spec, tenantProfile, { pageType = null } = {}) {
  if (!spec || !validateExpandStructureSpec(spec).ok) return null;

  const pages = (tenantProfile?.pages || []).filter((p) => !pageType || p.pageType === pageType);
  const own = observeStructure(pages);
  const sources = {};
  const pick = (field, ownVal, refVal, present) => {
    const useOwn = present(ownVal);
    sources[field] = useOwn ? 'tenant' : 'reference';
    return useOwn ? ownVal : refVal;
  };

  const sectionCount = pick('sectionCount', own.sectionCount, spec.sectionCount, (v) => v != null);
  const sectionOrder = pick('sectionOrder', own.sectionOrder, spec.sectionOrder, (v) => Array.isArray(v) && v.length);
  const shapes = {}; const headingLevels = {};
  for (const role of ROLES) {
    const s = own.shapes[role] || spec.shapes[role]; if (s) { shapes[role] = s; (sources.shapes ||= {})[role] = own.shapes[role] ? 'tenant' : 'reference'; }
    const h = own.headingLevels[role] || spec.headingLevels[role]; if (h) { headingLevels[role] = h; (sources.headingLevels ||= {})[role] = own.headingLevels[role] ? 'tenant' : 'reference'; }
  }
  // A table is warranted only if neither the tenant nor the reference shows
  // one — the more conservative of the two, since a table is the shape most
  // likely to be foreign to a site that has never drawn one.
  const tableAllowed = own.tableAllowed == null ? spec.tableUsage.allowed : own.tableAllowed;
  sources.tableUsage = own.tableAllowed == null ? 'reference' : 'tenant';
  const placementBefore = pick('placement', own.placementBefore, spec.placement.before, (v) => Array.isArray(v) && own.pagesObserved > 0);

  return {
    sectionCount, sectionOrder, shapes, headingLevels,
    tableUsage: { allowed: Boolean(tableAllowed) },
    placement: { anchor: spec.placement.anchor, before: placementBefore },
    sources, tenantPagesObserved: own.pagesObserved,
  };
}

// Plain text for the generator prompt. Roles and counts only — never a class.
export function structurePlanText(prior) {
  if (!prior) return '';
  const { min, max } = prior.sectionCount;
  const lines = [
    `Structure to follow (how this kind of page is organised — wording and facts still come only from the page text above):`,
    `- Write ${min === max ? min : `${min} to ${max}`} section(s).`,
  ];
  const order = prior.sectionOrder.filter((r) => r !== 'content');
  if (order.length) lines.push(`- Sections of other kinds, if present, appear in this order: ${order.join(' → ')}.`);
  if (!prior.tableUsage.allowed) lines.push('- Do not use a table.');
  return lines.join('\n');
}

// Layout assertions for composeGeneratedExpandLayout's validator. The class
// allowlist is untouched; this only checks the SHAPE the prior asks for.
export function assertLayoutMatchesPrior(layout, prior, profile) {
  if (!prior) return { ok: true };
  const row = String(layout?.row || ''); const wrapper = String(layout?.wrapper || '');
  const level = prior.headingLevels.content || prior.headingLevels.features;
  if (level) {
    const tag = level === 'section' ? 'h2' : 'h3';
    if (!new RegExp(`<${tag}[\\s>]`, 'i').test(row)) return { ok: false, reason: 'prior-heading-level', detail: tag };
  }
  const shape = prior.shapes.content;
  if (shape === 'list' && !/<li[\s>]/i.test(row) && !/<ul[\s>]/i.test(wrapper)) return { ok: false, reason: 'prior-shape', detail: 'list' };
  if (shape === 'card') {
    const cardTokens = String(profile?.components?.card?.wrapper || '').split(/\s+/).filter(Boolean);
    // Only enforceable when the tenant HAS a card vocabulary; inventing one is
    // exactly what the class allowlist exists to forbid.
    const used = new Set([...`${wrapper}\n${row}`.matchAll(/class\s*=\s*"([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/).filter(Boolean)));
    if (cardTokens.length && !cardTokens.some((t) => used.has(t))) return { ok: false, reason: 'prior-shape', detail: 'card' };
  }
  return { ok: true };
}

export function isExpandStructureRefEnabled(site) {
  return site?.url_file_map?.siteRoot?.expandStructureRef === true;
}
