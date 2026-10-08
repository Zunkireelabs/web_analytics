// TENANT DESIGN KNOWLEDGE — the pure half. What a lesson about one tenant's
// design looks like, how it is keyed, and how it is put in front of a
// generator. Storage is store/design-knowledge.js, on the existing
// agent_fix_memory table (category 'design', migration 189).
//
// Two rules shape everything here:
//   1. TENANT-SPECIFIC. A lesson is about how THIS site's pages are built; it
//      is keyed by the site's own page family and never travels to another
//      tenant. Nothing here carries a class, colour or URL out of its tenant.
//   2. REASONS, NOT PATCHES. A lesson records the root cause and the shape of
//      the fix ("the FAQ block was emitted bare; this site wraps it in its
//      own accordion"), plus what was tried and did not hold, so a repeat is
//      recognised by pattern rather than by replaying a value.

// The Quality Gate / design-gate reasons that are about DESIGN or STRUCTURE
// (as opposed to scaffolding or schema), the component each concerns, and why
// they happen. `component` is a coarse bucket so lessons from different pages
// meet; the page family and the free-text detail carry the specifics.
export const DESIGN_PATTERNS = Object.freeze({
  'structure-section-count': { component: 'page-structure', rootCause: 'The draft has a different number of sections than this site\'s established pages of that type.' },
  'structure-missing-heading': { component: 'page-structure', rootCause: 'The draft omits a heading this site\'s established pages of that type always carry.' },
  'structure-section-order': { component: 'page-structure', rootCause: 'The draft orders its sections differently from this site\'s established pages of that type.' },
  'structure-missing-role': { component: 'page-structure', rootCause: 'The draft lacks a section role (e.g. a closing call to action) that this site\'s established pages of that type have.' },
  'design-role-mismatch': { component: 'design-profile', rootCause: 'The stored design profile assigns a style to the wrong role, so correct markup is judged wrong.' },
  'bare-unstyled-markup': { component: 'typography', rootCause: 'Markup was emitted without this site\'s own classes, so it renders in browser defaults.' },
  'bare-tag-inconsistent-styling': { component: 'typography', rootCause: 'Some elements carry this site\'s classes and others of the same kind do not.' },
  'raw-color-value': { component: 'color', rootCause: 'A literal colour was written instead of this site\'s own colour classes.' },
  'inline-style': { component: 'spacing', rootCause: 'Inline styles were used instead of this site\'s own utility classes.' },
  'design-incomplete': { component: 'design-profile', rootCause: 'The captured design does not cover what this page renders.' },
  'render-deviation': { component: 'typography', rootCause: 'Rendered into a real page of this site, the draft measures differently (scale, spacing, line length or overflow).' },
  'design-integrity-failed': { component: 'design-profile', rootCause: 'The draft failed the design-integrity check against this site\'s captured roles.' },
  'template-missing-placeholder': { component: 'component-template', rootCause: 'A derived component template dropped a placeholder the generator needs.' },
});

export const isDesignPattern = (patternId) => Object.prototype.hasOwnProperty.call(DESIGN_PATTERNS, patternId);
export const designIssues = (issues) => (issues || []).filter((i) => i && isDesignPattern(i.patternId));

// The tenant's OWN word for a kind of page: the first path segment, singular.
// Deliberately not a fixed vocabulary — /features/, /solutions/, /servicios/
// and /case-studies/ each become their own family for the tenant that uses
// them, which is how a Feature page is told from a Solution page even when
// the URL regex files both under 'service'.
export function pageFamilyOf(url) {
  let seg = '';
  try { seg = new URL(url, 'https://x.invalid').pathname.split('/').filter(Boolean)[0] || ''; } catch { return 'unknown'; }
  seg = seg.toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!seg) return 'home';
  if (seg.length > 3) seg = seg.replace(/ies$/, 'y').replace(/(?<!s)s$/, '');
  return seg;
}

export function designSignature({ patternId, family = 'any', component = 'any' }) {
  return `design:${family}:${component}:${patternId}`.toLowerCase();
}

const clip = (s, n = 400) => (typeof s === 'string' ? s.slice(0, n) : s);
const uniq = (arr) => [...new Set((arr || []).filter(Boolean))];

/**
 * Builds the row fields for one lesson.
 * @param {object} p
 * @param {'fix'|'anti-pattern'} p.kind
 * @param {string} p.patternId
 * @param {string} [p.pageType]  the classified page type
 * @param {string} [p.pageUrl]   used only to derive the tenant's page family
 * @param {string} [p.detail]    what the guard observed
 * @param {string} [p.correction] what was asked of the generator / done to fix it
 * @param {string[]} [p.files]
 * @param {object} [p.validation] { passed, gate, attempts }
 * @param {object|null} [p.baseline] pre-fix page totals { impressions, clicks, ... }
 */
export function buildDesignLesson(p) {
  const info = DESIGN_PATTERNS[p.patternId] || { component: 'other', rootCause: null };
  const family = p.family || (p.pageUrl ? pageFamilyOf(p.pageUrl) : 'any');
  const component = p.component || info.component;
  const fix = p.kind === 'fix';
  const where = family === 'any' ? 'pages' : `"${family}" pages`;
  return {
    kind: p.kind,
    signature: designSignature({ patternId: p.patternId, family, component }),
    generatorId: p.generatorId || null,
    symptoms: fix
      ? `On this site's ${where}, generated ${component} output hit "${p.patternId}" and was corrected.${p.detail ? ` Observed: ${clip(p.detail, 240)}` : ''}`
      : `On this site's ${where}, an attempt to fix "${p.patternId}" in ${component} did not hold.${p.detail ? ` Observed: ${clip(p.detail, 240)}` : ''}`,
    rootCause: info.rootCause,
    affectedPattern: `${component} on this site's ${where} (${p.patternId})`,
    fixStrategy: fix
      ? (p.correction ? clip(p.correction) : 'Match this site\'s own established pattern for this page family.')
      : `Do not repeat: ${p.correction ? clip(p.correction) : 'the same change'} — it was tried and the result still failed validation.`,
    fixPattern: fix && p.correction ? clip(p.correction) : null,
    context: {
      patternId: p.patternId, pageType: p.pageType || null, family, component,
      evidence: p.detail ? [clip(p.detail, 300)] : [],
      files: uniq(p.files).slice(0, 12),
      validation: p.validation || null,
      baseline: p.baseline || null,
      triedFix: p.kind === 'anti-pattern' && p.correction ? [clip(p.correction, 300)] : [],
    },
    sourceRef: p.draftId != null ? `draft:${p.draftId}` : null,
  };
}

// Folds a repeat observation into the stored context: evidence and files
// accumulate (bounded), the newest validation and baseline win, tried-fixes
// accumulate so a failed approach is remembered once however often it recurs.
export function mergeDesignContext(prev, next) {
  const a = prev || {};
  const b = next || {};
  return {
    ...a, ...b,
    evidence: uniq([...(a.evidence || []), ...(b.evidence || [])]).slice(-6),
    files: uniq([...(a.files || []), ...(b.files || [])]).slice(0, 12),
    triedFix: uniq([...(a.triedFix || []), ...(b.triedFix || [])]).slice(-6),
    baseline: b.baseline ?? a.baseline ?? null,
    impact: a.impact ?? b.impact ?? null,
  };
}

/**
 * Ranks stored rows for the current job. Scores by how specifically the row
 * speaks to it: same pattern, same page family, same component, same page
 * type. Fix lessons beat anti-patterns on a tie only because both are shown;
 * the ordering just decides which survive the limit.
 */
export function rankDesignKnowledge(rows, { patternIds = [], family = null, component = null, pageType = null, limit = 6 } = {}) {
  const want = new Set(patternIds);
  const hasCriteria = want.size > 0 || Boolean(family || component || pageType);
  return (rows || [])
    .map((r) => {
      const c = r.designContext || {};
      let score = 0;
      if (c.patternId && want.has(c.patternId)) score += 4;
      if (family && c.family === family) score += 3;
      if (component && c.component === component) score += 2;
      if (pageType && c.pageType === pageType) score += 1;
      return { r, score };
    })
    .filter((x) => x.score > 0 || !hasCriteria)
    .sort((x, y) => y.score - x.score || y.r.confidence - x.r.confidence)
    .slice(0, limit)
    .map((x) => x.r);
}

/**
 * The block put in front of a generator BEFORE it writes: what is known to
 * work on this tenant and what is known not to. null when nothing applies, so
 * a tenant with no history behaves exactly as before.
 */
export function formatDesignKnowledge(rows) {
  if (!rows?.length) return null;
  const fixes = rows.filter((r) => r.lessonKind === 'fix');
  const antis = rows.filter((r) => r.lessonKind === 'anti-pattern');
  const lines = ['KNOWN ABOUT THIS SITE\'S DESIGN (learned from earlier validated work on this same site — apply it, and do not relearn it):'];
  fixes.forEach((r) => lines.push(`- ${r.rootCause ? `${r.rootCause} ` : ''}What worked: ${r.fixStrategy}`));
  if (antis.length) {
    lines.push('Tried on this site and did NOT hold — do not repeat:');
    antis.forEach((r) => lines.push(`- ${r.fixStrategy.replace(/^Do not repeat:\s*/i, '')}`));
  }
  return lines.join('\n');
}
