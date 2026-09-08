// Pure normalization: capture.js's raw per-page block list -> the
// schema.js `sections` shape. No browser, no network — deliberately
// separate from capture.js so this heuristic logic is unit-testable without
// Playwright, and so a future capture-source change (a different renderer,
// a cached HTML snapshot) can reuse it unchanged.

const ROLE_KEYWORDS = [
  // Ordered most-specific first — a block can match several keyword sets
  // (e.g. a pricing section with a CTA), so specificity beats recency.
  ['faq', /\b(faq|frequently asked|questions)\b/i],
  ['pricing', /\b(pricing|plans?|packages?)\b/i],
  ['testimonials', /\b(testimonials?|reviews?|what (our|clients?) say)\b/i],
  ['team', /\b(our team|meet the team|leadership)\b/i],
  ['features', /\b(features?|why (choose|us))\b/i],
  ['cta', /\b(get started|contact us|book (a|now)|sign up|request a)\b/i],
];

function guessRole(block, { isFirst, isLast, landmarkOverride }) {
  if (landmarkOverride) return landmarkOverride;
  const text = `${block.headingText || ''} ${block.classes || ''}`.toLowerCase();
  for (const [role, re] of ROLE_KEYWORDS) {
    if (re.test(text)) return role;
  }
  if (isFirst && block.headingLevel === 1) return 'hero';
  if (isFirst) return 'hero';
  if (isLast) return 'footer';
  if (block.ctaText && !block.bodyText) return 'cta';
  return 'content';
}

function widthBucket(block) {
  if (!block.viewportWidth) return 'normal';
  const ratio = block.width / block.viewportWidth;
  if (ratio >= 0.98) return 'full';
  if (ratio >= 0.75) return 'wide';
  if (ratio >= 0.4) return 'normal';
  return 'narrow';
}

function alignmentOf(block) {
  const align = block.headingStyle?.textAlign || block.bodyStyle?.textAlign;
  if (align === 'center' || align === 'right') return align;
  return 'left';
}

function textHierarchyOf(block) {
  const items = [];
  if (block.headingText) {
    items.push({
      role: block.headingLevel === 1 ? 'heading' : 'subheading',
      text: block.headingText,
      tag: `h${block.headingLevel}`,
      style: block.headingStyle,
      classes: block.headingClasses || '',
      // Full live-captured outerHTML, threaded through untouched from
      // capture.js — the exact anchor a typography-drift finding's
      // recommended fix (content-integrity-repair.js's 'typography-drift'
      // fixType) patches against. See capture.js's outerHtmlOf for why this
      // must be the live DOM's markup, not a re-derived one.
      outerHtml: block.headingOuterHtml || '',
    });
  }
  if (block.bodyText) items.push({ role: 'body', text: block.bodyText, tag: 'p', style: block.bodyStyle, classes: block.bodyClasses || '', outerHtml: block.bodyOuterHtml || '' });
  if (block.ctaText) items.push({ role: 'cta', text: block.ctaText, tag: block.ctaTag, style: null, classes: block.ctaClasses || '' });
  // capture.js's pickLink() already excludes anything button-shaped (a
  // background color, or a btn/button class) so this is real inline-link
  // evidence, not another copy of the cta above — see pickLink's own comment
  // for the "first <a> in a block is usually its CTA" trap this avoids.
  // No `text`: capture.js only reads this link's classes, not its content.
  // profile-extract.js's typography.link is exactly what this role backs,
  // and design-drift.js's role verification reads this role to catch a link
  // template that was actually derived from a button (the bug
  // correctLinkTypography exists to fix) — before this, that check had no
  // evidence to verify against, because this role never reached `sections`.
  if (block.linkClasses) items.push({ role: 'link', text: null, tag: 'a', style: null, classes: block.linkClasses || '' });
  return items;
}

// Real class strings observed on this block's matched elements — the raw
// vocabulary profile-extract.js selects/synthesizes designSystem.components
// from. Never invented here, only copied out of the live DOM (capture.js).
function componentsOf(block) {
  const out = [];
  if (block.accordionLike) out.push({ type: 'accordion', classes: block.accordionClasses });
  if (block.cardLike) out.push({ type: 'card', classes: block.cardClasses });
  if (block.ctaText) out.push({ type: 'button', classes: block.ctaClasses });
  if (block.listClasses?.wrapper) out.push({ type: 'list', classes: block.listClasses });
  if (block.tableLike) out.push({ type: 'table', classes: block.tableClasses, outerHtml: block.tableOuterHtml || '' });
  if (block.imageCount > 0) out.push({ type: 'imagery', classes: '' });
  return out;
}

// blocks: capture.js's raw per-page array, newest/topmost order already
// preserved by `order`. Returns the schema's `sections` array for one page.
export function segmentPage(blocks) {
  const sorted = [...(blocks || [])].sort((a, b) => a.order - b.order);
  const landmarkOf = (block) => (block.landmark === 'header' ? 'header' : block.landmark === 'nav' ? 'nav' : block.landmark === 'footer' ? 'footer' : null);
  const firstContentIndex = sorted.findIndex((b) => !landmarkOf(b));
  const lastContentIndex = sorted.length - 1 - [...sorted].reverse().findIndex((b) => !landmarkOf(b));
  const sections = sorted.map((block, i) => {
    const landmarkOverride = landmarkOf(block);
    const role = guessRole(block, { isFirst: i === firstContentIndex, isLast: i === lastContentIndex && lastContentIndex !== firstContentIndex, landmarkOverride });
    return {
      role,
      order: i,
      classes: block.classes || '',
      alignment: alignmentOf(block),
      width: widthBucket(block),
      textHierarchy: textHierarchyOf(block),
      components: componentsOf(block),
      spacing: {
        before: i > 0 ? Math.max(0, block.top - (sorted[i - 1].top + sorted[i - 1].height)) : null,
        after: i < sorted.length - 1 ? Math.max(0, sorted[i + 1].top - (block.top + block.height)) : null,
      },
      imagery: { count: block.imageCount || 0, hasBackground: !!block.hasBackgroundImage },
    };
  });

  // precedes/follows are role-to-role hints, not indices, so a later
  // cross-page reconciliation ("what usually follows a hero on this site?")
  // doesn't need to carry positional data around.
  return sections.map((s, i) => ({
    ...s,
    follows: i > 0 ? sections[i - 1].role : null,
    precedes: i < sections.length - 1 ? sections[i + 1].role : null,
  }));
}

// Applies segmentPage to every page a capture returned, keeping url/pageType/title.
export function segmentSite({ pages } = {}) {
  return (pages || []).map((page) => ({
    url: page.url,
    pageType: page.pageType,
    title: page.title,
    sections: segmentPage(page.blocks),
  }));
}

// Consolidates one representative pattern per page type across however many
// pages of that type were captured (usually just one, since discoverPages
// already picks one representative URL per type) — the `pageTypePatterns`
// half of the schema. Kept deliberately light (section role order + text
// hierarchy roles only, no full style dump) since profile-extract.js is
// what turns this into the rich, prose-described pattern the schema wants;
// this is just the deterministic skeleton it's grounded in.
export function buildPageTypePatterns(segmentedPages) {
  const byType = new Map();
  for (const page of segmentedPages || []) {
    if (!byType.has(page.pageType)) byType.set(page.pageType, []);
    byType.get(page.pageType).push(page);
  }
  const patterns = {};
  for (const [pageType, pages] of byType) {
    patterns[pageType] = {
      exampleUrls: pages.map((p) => p.url),
      sectionOrder: pages[0]?.sections.map((s) => s.role) || [],
    };
  }
  return patterns;
}
