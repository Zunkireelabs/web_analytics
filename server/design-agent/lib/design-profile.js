// The website-level design language of one tenant site, and the projection of
// that language into the per-component templates the design-sensitive
// generators render through.
//
// WHY THIS EXISTS
//
// The Design Agent's only persisted output used to be five HTML blobs, one
// per action type (faq, expand-content, internal-links, qa-content,
// content-wrapper). Its OpenHands session genuinely analysed the whole site
// first — the task prompt tells it to work out the framework, where reusable
// components live, and how styling is organised before concluding anything —
// but the only thing it was allowed to RETURN was those blobs. The
// site-level understanding was thrown away when the container exited and
// re-derived from scratch for every action type, and nothing else in the
// platform could ever consult it.
//
// That made every design-sensitive generator an island: with no template for
// its type, each one fell back to its own hardcoded DEFAULT_* markup
// (marker-merge.js), so the same site could ship an FAQ in one visual
// language and a Q&A block in another. Presentation was being invented
// per-generator instead of derived from the site.
//
// So the profile is the SOURCE and component templates are PROJECTIONS of it.
// One analysis per site rather than one per action type; a new design-
// sensitive content type needs no new repo analysis at all, because its
// template is composed from design knowledge the site already has.
//
// Every value here is a real class string or markup pattern observed in the
// tenant's actual repository — never invented, same grounding rule the
// component-template task already enforced. The profile carries no client
// content, only presentation vocabulary.

// v2: the profile is now derived by live-site analysis (server/design-agent/
// live-analysis/) instead of an OpenHands/Docker repo read — see that
// module's schema.js for the additive fields (pages, pageTypePatterns,
// navigation, evidence) v2 carries on top of these same flat vocabulary
// fields. The version bump exists so an old, still-stored v1 profile is
// never treated as usable without being re-derived — isProfileUsable below
// enforces it via validateDesignProfile's version check.
export const DESIGN_PROFILE_VERSION = 2;

// Joins class fragments, dropping empties, so a profile that legitimately has
// no value for a slot produces clean markup instead of stray whitespace or
// the string "undefined" in a class attribute.
// Dedupes at the TOKEN level, not the fragment level. Two slots on the same
// profile legitimately carry overlapping classes — a site whose `layout.prose`
// and `spacing.section` are both "py-12 md:py-20" is describing one real
// convention twice, not two — and joining them naively shipped
// `class="py-12 md:py-20 py-12 md:py-20"` and `class="... gap-3 gap-3"` into
// real customer pages. First occurrence wins, so fragment order still decides
// precedence for any framework that resolves conflicts by source order.
function cx(...parts) {
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    if (typeof part !== 'string') continue;
    for (const token of part.trim().split(/\s+/)) {
      if (!token || seen.has(token)) continue;
      seen.add(token);
      out.push(token);
    }
  }
  return out.join(' ');
}

function attr(cls) {
  return cls ? ` class="${cls}"` : '';
}

// Structural completeness only — this deliberately does NOT judge whether the
// classes are good, which is what checkTemplateFreshness (against the real
// live CSS) already answers. A profile missing the fields the projections
// actually read is unusable; a profile with sparse optional patterns is fine
// and simply projects a plainer template.
export function validateDesignProfile(profile) {
  const errors = [];
  if (!profile || typeof profile !== 'object') return { ok: false, errors: ['No design profile.'] };
  if (profile.version !== DESIGN_PROFILE_VERSION) {
    errors.push(`Unsupported design profile version ${profile.version} (expected ${DESIGN_PROFILE_VERSION}).`);
  }
  // typography.body and typography.heading are what EVERY projection reads.
  // Without them there is no design language to project, only guesses.
  if (!profile.typography?.body) errors.push('typography.body is required — it is the base text style every projection builds on.');
  if (!profile.typography?.heading?.item) errors.push('typography.heading.item is required — the style used for a repeating item heading (an FAQ question, a section title).');
  if (!profile.layout?.container && !profile.layout?.prose) {
    errors.push('layout needs at least one of container/prose — the wrapper every block is placed inside.');
  }
  return { ok: errors.length === 0, errors };
}

export function isProfileUsable(profile) {
  return validateDesignProfile(profile).ok;
}

// ── Projections ────────────────────────────────────────────────────────────
//
// Each returns { wrapper, row } (or { wrapper } for content-wrapper) carrying
// the exact placeholder tokens design-drift.js's validatePlaceholders
// requires. That contract is deliberately NOT duplicated here — design-drift
// re-validates every projection against its own REQUIRED_PLACEHOLDERS before
// anything is persisted, so this module can never quietly drift from the
// authority on what a valid template looks like.

// An FAQ is a disclosure pattern. If the site has a real accordion, use it —
// that IS this site's answer to "how do we present a question the user can
// open". Only when the site has no such pattern do we fall back to a
// semantic definition list, still styled from the site's own typography.
function projectFaq(profile) {
  const t = profile.typography;
  const acc = profile.components?.accordion;
  const baseCls = cx(profile.layout?.container, profile.spacing?.section);

  if (acc?.trigger && acc?.panel) {
    // list.divider is deliberately NOT merged in here. The accordion carries
    // its own wrapper convention, and a site whose list divider differs from
    // its accordion's (divide-gray-100 vs divide-gray-200 — the values in this
    // module's own test fixture) ends up with two competing divide-* colours
    // on one element, resolved by whichever the framework happens to emit
    // last. That is the same class-merge bug this file already fixes for
    // internal-links' anchor; the divider belongs only to the <dl> fallback
    // below, which is the branch that actually renders a divided list.
    return {
      wrapper: `<div${attr(cx(baseCls, acc.wrapper))} x-data="{ activeIndex: null }">\n{{ROWS}}\n</div>`,
      row: [
        `  <div${attr(cx(acc.item, profile.spacing?.itemGap))}>`,
        `    <button @click="activeIndex = activeIndex === {{INDEX}} ? null : {{INDEX}}"${attr(cx(acc.trigger, t.heading.item))}>{{QUESTION}}</button>`,
        `    <div x-show="activeIndex === {{INDEX}}"${attr(cx(acc.panel, t.body))}>{{ANSWER}}</div>`,
        '  </div>',
      ].join('\n'),
    };
  }

  return {
    wrapper: `<dl${attr(cx(baseCls, profile.components?.list?.divider))}>\n{{ROWS}}\n</dl>`,
    row: `  <dt${attr(t.heading.item)}>{{QUESTION}}</dt>\n  <dd${attr(cx(t.body, profile.spacing?.itemGap))}>{{ANSWER}}</dd>`,
  };
}

// Same disclosure semantics as FAQ, but native <details>/<summary> when the
// site has no JS accordion — deliberately NOT reusing projectFaq's markup
// wholesale, because a site that presents FAQs as an accordion may still
// present inline Q&A statically. Both draw on the same typography, which is
// the point: two different structures, one visual language.
function projectQaContent(profile) {
  const t = profile.typography;
  const wrapperCls = cx(profile.layout?.container, profile.spacing?.section);
  return {
    wrapper: `<div${attr(wrapperCls)}>\n{{ROWS}}\n</div>`,
    row: [
      `  <details${attr(cx(profile.components?.card?.wrapper, profile.spacing?.itemGap))}>`,
      // The <h3> is load-bearing, not decoration. qa-content exists to fix
      // "Missing question-style headings", and the only thing that measures
      // that is page-content.js's questionHeadingCount: h1/h2/h3 whose text
      // ends in "?". A bare <summary> is not a heading tag and never counts,
      // so a projected template — the path EVERY site with a design profile
      // takes — shipped Q&A that could never satisfy the check that drafted
      // it, silently, forever. marker-merge.js's DEFAULT_QA_TEMPLATE nests
      // the h3 for exactly this reason and says so; the projection has to
      // match that structure, not just its styling.
      '    <summary>',
      `      <h3${attr(t.heading.item)}>{{QUESTION}}</h3>`,
      '    </summary>',
      `    <div${attr(t.body)}>{{ANSWER}}</div>`,
      '  </details>',
    ].join('\n'),
  };
}

// Long-form body sections appended to an existing page: headings plus prose,
// in the site's own article typography rather than a generic wrapper.
function projectExpandContent(profile) {
  const t = profile.typography;
  // layout.container is included here for the same reason every sibling
  // projection includes it: without it the block is the only thing on the page
  // that is not inside the site's horizontal container, so it renders full
  // bleed, edge to edge, while everything above and below it is gutter-aligned.
  // (Confirmed live on zunkireelabs.com's homepage — expand-content was the one
  // projection that omitted it.)
  const wrapperCls = cx(
    profile.layout?.container,
    profile.components?.articleBody?.wrapper || profile.layout?.prose,
    profile.spacing?.section,
  );
  return {
    wrapper: `<div${attr(wrapperCls)}>\n{{ROWS}}\n</div>`,
    row: `  <section${attr(profile.spacing?.itemGap)}>\n    <h2${attr(t.heading.section || t.heading.item)}>{{HEADING}}</h2>\n    <div${attr(t.body)}>{{BODY}}</div>\n  </section>`,
  };
}

// Same content as projectExpandContent, but for a page whose OWN sections are
// built from the site's card component (a portfolio/case-study grid, e.g.
// zunkireelabs.com/projects/) rather than the plain editorial pages
// projectExpandContent's bare heading+paragraph rows match fine. Injecting
// that bare row onto a card-heavy page reads as unstyled, bolted-on text next
// to real cards — not because the typography is wrong (it's the same
// verified typography every other projection uses), but because the page
// around it has visual weight this row never picks up.
//
// Deliberately NOT a PROJECTORS entry / real action type: this is a variant
// of 'expand-content' selected per-page by the caller (marker-merge.js),
// never its own actionType — there is no separate generator, gate, or
// COMPONENT_TEMPLATE_KEY concept for it. Returns null exactly when the site
// has no real captured card component, so a caller can fall through to
// projectExpandContent — never invents a card look for a site that doesn't
// have one.
export function projectExpandContentCard(profile) {
  if (!isProfileUsable(profile)) return null;
  const card = profile.components?.card;
  if (!card?.wrapper) return null;
  const t = profile.typography;
  const wrapperCls = cx(profile.layout?.container, profile.spacing?.section);
  const rowCls = cx(card.wrapper, profile.spacing?.itemGap);
  const inner = card.body
    ? [
      `    <div${attr(card.body)}>`,
      `      <h2${attr(t.heading.section || t.heading.item)}>{{HEADING}}</h2>`,
      `      <div${attr(t.body)}>{{BODY}}</div>`,
      '    </div>',
    ].join('\n')
    : [
      `    <h2${attr(t.heading.section || t.heading.item)}>{{HEADING}}</h2>`,
      `    <div${attr(t.body)}>{{BODY}}</div>`,
    ].join('\n');
  return {
    wrapper: `<div${attr(wrapperCls)}>\n{{ROWS}}\n</div>`,
    row: `  <div${attr(rowCls)}>\n${inner}\n  </div>`,
  };
}

function normalizedPath(url) {
  try { return new URL(url).pathname.replace(/\/+$/, '') || '/'; } catch { return url; }
}

// Whether THIS SPECIFIC captured page (not the site in general) is built from
// repeating card sections — schema.js's pages[].sections[].components, the
// same evidence componentsOf()/segment.js already derives from capture.js's
// cardLike/cardClasses. Requires at least two card sections, not one: a
// single incidental card (a lone testimonial, a pricing callout) does not
// make a page "card-heavy" the way a portfolio/case-study grid is — one
// misclassified page shouldn't flip every future generated section on it
// into card styling.
//
// Returns false (never throws) for a page the capture pass never visited —
// that is the common case (capture is a handful of representative pages, not
// a full crawl) and the caller's correct fallback is the plain projection,
// not an error.
export function pageUsesCardSections(profile, pageUrl) {
  const pages = profile?.pages;
  if (!Array.isArray(pages) || !pageUrl) return false;
  const target = normalizedPath(pageUrl);
  const page = pages.find((p) => p?.url && normalizedPath(p.url) === target);
  if (!page) return false;
  const cardSections = (page.sections || []).filter(
    (s) => Array.isArray(s.components) && s.components.some((c) => c?.type === 'card'),
  );
  return cardSections.length >= 2;
}

// A list of links. Uses the site's real list pattern and link colour so
// related-content blocks look like the site's other link lists.
function projectInternalLinks(profile) {
  const t = profile.typography;
  const list = profile.components?.list;
  return {
    wrapper: `<ul${attr(cx(profile.layout?.container, list?.wrapper, profile.spacing?.section))}>\n{{ROWS}}\n</ul>`,
    // t.link ALONE when the site has a link convention — never cx(t.link,
    // t.body). Those two slots each carry a full colour/size/weight class list,
    // so merging them puts two competing `text-*` colours on one anchor and
    // lets whichever the framework resolves last win at random. Body typography
    // is the fallback for a site with no link convention, not a supplement.
    row: `  <li${attr(cx(list?.item, profile.spacing?.itemGap))}><a href="{{URL}}"${attr(t.link || t.body)}>{{ANCHOR_TEXT}}</a></li>`,
  };
}

// Whole-page markdown content (compliance pages, and any future net-new
// page). One {{BODY}} slot, wrapped in whatever this site wraps long-form
// article content in — the single most important thing to get right for a
// page that is otherwise entirely generated.
function projectContentWrapper(profile) {
  const cls = cx(
    profile.layout?.container,
    profile.components?.articleBody?.wrapper || profile.layout?.prose,
    profile.spacing?.section,
  );
  return { wrapper: `<div${attr(cls)}>\n{{BODY}}\n</div>` };
}

const PROJECTORS = {
  faq: projectFaq,
  'qa-content': projectQaContent,
  'expand-content': projectExpandContent,
  'internal-links': projectInternalLinks,
  'content-wrapper': projectContentWrapper,
};

// Action types this module can compose from a profile alone, with no repo
// analysis. Exported so callers can ask before queueing Design Agent work.
export function isProjectable(actionType) {
  return Object.hasOwn(PROJECTORS, actionType);
}

export function projectableActionTypes() {
  return Object.keys(PROJECTORS);
}

/**
 * Compose one component template from the site's design language.
 * Returns null when the profile is unusable or the type isn't projectable —
 * never a partially-built template, matching the refuse-rather-than-guess
 * discipline the exact-match injectors already follow.
 */
export function projectComponentTemplate(profile, actionType) {
  const projector = PROJECTORS[actionType];
  if (!projector || !isProfileUsable(profile)) return null;
  return projector(profile);
}

export function projectAllComponentTemplates(profile, actionTypes = projectableActionTypes()) {
  const out = {};
  for (const actionType of actionTypes) {
    const template = projectComponentTemplate(profile, actionType);
    if (template) out[actionType] = template;
  }
  return out;
}

// ── Content-block projections ──────────────────────────────────────────────
//
// The net-new page renderers (newpage-render.js: landing pages, blog posts,
// direct-answer pages, translations, compliance pages) emit MARKDOWN, not the
// marker-merge HTML templates above, so they cannot consume a component
// template. They were therefore the last places still shipping presentation
// this platform invented rather than derived — a call to action as a bare
// `[label](#)` link, and sections as plain headings regardless of how the
// site actually presents a block of content.
//
// These projections give those renderers the same design language everything
// else now uses. Each returns null when the site genuinely has no such
// pattern, and every caller falls back to exactly what it emitted before, so
// a site with no profile is byte-for-byte unchanged.
//
// MARKDOWN SAFETY: raw HTML inside a markdown document is only parsed as an
// HTML block when it is surrounded by blank lines, and inner markdown is only
// parsed if it too is separated by blank lines. Every helper here follows the
// same open/blank/body/blank/close shape newpage-render.js's fillContentWrapper
// already relies on.

// A real call-to-action in the site's own button styling. Falls back to null
// (caller keeps its markdown link) when the site has no button convention —
// inventing one would be exactly the guessing this module exists to stop.
// `label` is raw LLM output (landing-page.js's content.cta) and this is the
// one place in the projection layer that splices a model-authored string into
// raw HTML. Every comparable substitution site — marker-merge.js's QUESTION /
// ANSWER / ANCHOR_TEXT fills — escapes first; this one did not, so a CTA
// containing a `<` or a bare `&` (ordinary LLM output, e.g. "Save 20% & book")
// emitted a broken or arbitrary inline tag into a live customer page. Kept as
// a local copy rather than imported: design-agent must not depend on
// implementers, and this is four replaces.
function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function projectCta(profile, { label, href = '#' } = {}) {
  const cls = profile?.components?.button?.primary;
  if (!cls || !label) return null;
  return `<a href="${escapeHtml(href)}" class="${cls}">${escapeHtml(label)}</a>`;
}

// One content block in the site's card convention, with its markdown body
// left as markdown so it still renders normally inside the wrapper.
export function projectCard(profile, { heading, body, headingLevel = 2 } = {}) {
  const card = profile?.components?.card;
  const cls = cx(card?.wrapper);
  if (!cls) return null;

  const inner = cx(card?.body);
  const hashes = '#'.repeat(Math.min(Math.max(headingLevel, 1), 6));
  const parts = [`<div${attr(cls)}>`, ''];
  if (inner) parts.push(`<div${attr(inner)}>`, '');
  if (heading) parts.push(`${hashes} ${heading}`, '');
  if (body) parts.push(body, '');
  if (inner) parts.push('</div>', '');
  parts.push('</div>');
  return parts.join('\n');
}

// A table STRUCTURE — never a fixed cross-tenant look. Two tiers, in order:
//
// 1. IMITATE: this site already has a real <table> somewhere (captured by
//    live-analysis/capture.js's tableLike/tableClasses) — its own observed
//    wrapper/header/row/cell classes are used verbatim, same "real markup
//    wins" rule projectCard/projectCta already follow.
//
// 2. COMPOSE, don't invent: most tenant sites have never shipped a
//    comparison table, so tier 1 has nothing to imitate — this is the gap
//    that made a real client's own table repair a one-off hand-tuned script
//    instead of something every tenant could get. Rather than leave every
//    such tenant permanently unrepairable, this tier builds a plain,
//    semantic table SKELETON (real <table>/<thead>/<tbody>, left-aligned
//    text columns, a horizontal-scroll wrapper for narrow viewports — the
//    same structural rules regardless of tenant) and fills it with ONLY
//    classes this profile already recorded as real — typography.body for
//    cell text, typography.heading.item for header-cell weight,
//    color.border for row dividers, color.surface for header-row
//    separation. Nothing here is a color, font, radius or shadow invented
//    for this function; every token is one `checkTypographyRole` (or an
//    equivalent role check, once one exists for color/spacing) can already
//    trace back to real evidence on THIS site. Two sites with identical
//    typography/color tokens get the identical table; two sites with
//    different tokens get visibly different tables — the point.
//
// Returns null only when there is neither a real table nor the base
// typography.body token every other projection also requires — the same
// abstention checkTypographyRole's 'not-set' already models: no evidence is
// an honest null, not a guess.
export function projectTable(profile) {
  const real = profile?.components?.table;
  if (real?.wrapper) {
    return {
      tableClass: real.wrapper,
      headerCellClass: real.headerCell || '',
      rowClass: real.row || '',
      cellClass: real.cell || real.headerCell || '',
    };
  }

  const body = profile?.typography?.body;
  if (!body) return null;

  const border = profile?.color?.border;
  return {
    tableClass: cx('w-full border-collapse'),
    headerCellClass: cx(profile?.typography?.heading?.item || body, profile?.color?.surface, 'text-left'),
    rowClass: cx(border && 'border-b', border),
    cellClass: cx(body, 'text-left'),
  };
}

// The wrapper a whole net-new page's body is placed inside. Deliberately the
// SAME projection content-wrapper templates are built from, so a page rendered
// through this route and a compliance page rendered through the component
// template land in identical markup.
export function projectPageWrapper(profile) {
  const projected = projectComponentTemplate(profile, 'content-wrapper');
  return projected?.wrapper || null;
}

// Provenance stamp, mirroring stampTemplateVerification's shape so a profile
// and a template carry the same kind of evidence trail.
export function stampDesignProfile(profile, { derivedBy, derivedRef = null, at = new Date() } = {}) {
  if (!profile) return profile;
  return {
    ...profile,
    version: DESIGN_PROFILE_VERSION,
    derivedAt: at.toISOString(),
    derivedBy,
    derivedRef: derivedRef == null ? null : String(derivedRef),
  };
}
