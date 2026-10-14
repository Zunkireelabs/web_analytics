import { classifyPageType } from '../../design-agent/live-analysis/schema.js';

// Resolve what ROLE a page plays — an inline article body or a section-built
// page — from evidence, with the URL regex as the last resort.
//
// The bug this fixes: heading scale comes from classifyPageType, an
// English-URL regex. A post under /insights/ (when the regex lacks it), /recursos/,
// or any non-English prefix classifies 'other', is treated as a section page,
// and gets hero-scale headings next to hand-written posts at article scale.
//
// classifyPageType is deliberately NOT widened: its output keys
// designProfile.pageTypePatterns[type] and every stored canonical template,
// so widening it would silently re-key and invalidate them all. This
// resolver sits above it instead, with the regex as its last tier.
//
// Tiers, highest authority first:
//   A (high)   tenant config (siteRoot.pageRoles, newContentTargets[type].pageRole)
//              and the action type itself — a blog post IS an article body
//              whatever its URL looks like.
//   C (medium) the captured profile: a sibling captured as 'blog-article'
//              under the same first path segment makes that prefix an article
//              prefix. This is how /articulos/ becomes known with no regex.
//   D (low)    classifyPageType, unchanged.
// (Tier B — repo layout via deriveNewContentContract — needs async repo reads
// and is a later addition; callers that already hold that contract can pass
// `layoutRole` and it slots in between A and C.)

export const PAGE_ROLES = Object.freeze(['inline-article', 'section-page', 'unknown']);

// Intrinsically article bodies: the generated artifact IS prose in an
// article layout, regardless of where the URL puts it.
const INLINE_ACTION_TYPES = new Set(['blog-outline', 'direct-answer', 'translation']);
// Intrinsically built from sections.
const SECTION_ACTION_TYPES = new Set(['landing-page']);

const INLINE_PAGE_TYPES = new Set(['blog-article', 'legal']);

// Tier B from a derived newcontent contract (newcontent-contract.js): a
// directory whose human-written siblings all declare a post/article layout is
// an article directory, whatever it is called. Pure, so a caller that already
// holds the contract (it is derived per directory and cached) can pass the
// verdict as `layoutRole` without this module touching the repo.
//
// null means "the layout name says nothing" — the contract being UNKNOWN, or a
// name like `base.njk` that every page type uses — never a guess.
const ARTICLE_LAYOUT_RE = /(^|[\/_.-])(post|blog|article|story|news|entry)([\/_.-]|$)/i;
const SECTION_LAYOUT_RE = /(^|[\/_.-])(landing|home|service|product|pricing)([\/_.-]|$)/i;

export function layoutRoleFromContract(contract) {
  const layout = contract && !contract.unknown ? String(contract.layout || '') : '';
  if (!layout) return null;
  if (ARTICLE_LAYOUT_RE.test(layout)) return 'inline-article';
  if (SECTION_LAYOUT_RE.test(layout)) return 'section-page';
  return null;
}

export function isInlineRole(role) {
  return role === 'inline-article';
}

const firstSegment = (url) => {
  try {
    const seg = new URL(url, 'https://placeholder.invalid').pathname.split('/').filter(Boolean)[0];
    return seg ? seg.toLowerCase() : null;
  } catch { return null; }
};

const normRole = (v) => (PAGE_ROLES.includes(v) ? v : null);

export function resolvePageRole(site, { pageUrl = null, permalink = null, actionType = null, layoutRole = null } = {}) {
  const target = pageUrl || permalink;
  const root = site?.url_file_map?.siteRoot || {};
  const prefix = target ? firstSegment(target) : null;

  // Tier A — explicit tenant config beats everything.
  const targets = site?.url_file_map?.newContentTargets || root.newContentTargets;
  const targetCfg = actionType ? targets?.[actionType]?.pageRole : null;
  if (normRole(targetCfg)) {
    return { role: targetCfg, confidence: 'high', source: 'newContentTargets', evidence: `newContentTargets.${actionType}.pageRole` };
  }
  const prefixCfg = prefix ? root.pageRoles?.[prefix] : null;
  if (normRole(prefixCfg)) {
    return { role: prefixCfg, confidence: 'high', source: 'siteRoot.pageRoles', evidence: `pageRoles.${prefix}` };
  }
  if (actionType && INLINE_ACTION_TYPES.has(actionType)) {
    return { role: 'inline-article', confidence: 'high', source: 'action-type', evidence: actionType };
  }
  if (actionType && SECTION_ACTION_TYPES.has(actionType)) {
    return { role: 'section-page', confidence: 'high', source: 'action-type', evidence: actionType };
  }

  // Tier B — a caller-supplied repo-layout verdict.
  if (normRole(layoutRole) && layoutRole !== 'unknown') {
    return { role: layoutRole, confidence: 'high', source: 'repo-layout', evidence: 'layoutRole' };
  }

  // Tier C — what the site's own captured pages say about this prefix.
  const pages = root.designProfile?.pages;
  if (prefix && Array.isArray(pages)) {
    const sameSection = pages.filter((p) => p?.url && firstSegment(p.url) === prefix && p.pageType);
    const articles = sameSection.filter((p) => INLINE_PAGE_TYPES.has(p.pageType)).length;
    if (articles > 0 && articles >= sameSection.length - articles) {
      return { role: 'inline-article', confidence: 'medium', source: 'captured-profile', evidence: `${articles}/${sameSection.length} captured /${prefix}/ pages are articles` };
    }
    // Captured pages under the prefix that are NOT articles are real
    // evidence of a section prefix.
    if (sameSection.length && articles === 0) {
      return { role: 'section-page', confidence: 'medium', source: 'captured-profile', evidence: `${sameSection.length} captured /${prefix}/ page(s), none article` };
    }
  }

  // Tier D — the regex, last, and honest about its weakness.
  if (target) {
    let type = 'other';
    try { type = classifyPageType(new URL(target, 'https://placeholder.invalid').href, { propertyType: site?.property_type }); } catch { /* other */ }
    if (INLINE_PAGE_TYPES.has(type)) return { role: 'inline-article', confidence: 'low', source: 'url-regex', evidence: type };
    if (type !== 'other') return { role: 'section-page', confidence: 'low', source: 'url-regex', evidence: type };
  }
  return { role: 'unknown', confidence: 'low', source: 'none', evidence: 'no evidence at any tier' };
}
