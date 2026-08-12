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

export const DESIGN_PROFILE_VERSION = 1;

// Joins class fragments, dropping empties, so a profile that legitimately has
// no value for a slot produces clean markup instead of stray whitespace or
// the string "undefined" in a class attribute.
function cx(...parts) {
  return parts.filter((p) => typeof p === 'string' && p.trim()).map((p) => p.trim()).join(' ');
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
  const wrapperCls = cx(profile.layout?.container, profile.spacing?.section, profile.components?.list?.divider);

  if (acc?.trigger && acc?.panel) {
    return {
      wrapper: `<div${attr(cx(wrapperCls, acc.wrapper))} x-data="{ activeIndex: null }">\n{{ROWS}}\n</div>`,
      row: [
        `  <div${attr(cx(acc.item, profile.spacing?.itemGap))}>`,
        `    <button @click="activeIndex = activeIndex === {{INDEX}} ? null : {{INDEX}}"${attr(cx(acc.trigger, t.heading.item))}>{{QUESTION}}</button>`,
        `    <div x-show="activeIndex === {{INDEX}}"${attr(cx(acc.panel, t.body))}>{{ANSWER}}</div>`,
        '  </div>',
      ].join('\n'),
    };
  }

  return {
    wrapper: `<dl${attr(wrapperCls)}>\n{{ROWS}}\n</dl>`,
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
      `    <summary${attr(t.heading.item)}>{{QUESTION}}</summary>`,
      `    <div${attr(t.body)}>{{ANSWER}}</div>`,
      '  </details>',
    ].join('\n'),
  };
}

// Long-form body sections appended to an existing page: headings plus prose,
// in the site's own article typography rather than a generic wrapper.
function projectExpandContent(profile) {
  const t = profile.typography;
  const wrapperCls = cx(profile.components?.articleBody?.wrapper || profile.layout?.prose, profile.spacing?.section);
  return {
    wrapper: `<div${attr(wrapperCls)}>\n{{ROWS}}\n</div>`,
    row: `  <section${attr(profile.spacing?.itemGap)}>\n    <h2${attr(t.heading.section || t.heading.item)}>{{HEADING}}</h2>\n    <div${attr(t.body)}>{{BODY}}</div>\n  </section>`,
  };
}

// A list of links. Uses the site's real list pattern and link colour so
// related-content blocks look like the site's other link lists.
function projectInternalLinks(profile) {
  const t = profile.typography;
  const list = profile.components?.list;
  return {
    wrapper: `<ul${attr(cx(profile.layout?.container, list?.wrapper, profile.spacing?.section))}>\n{{ROWS}}\n</ul>`,
    row: `  <li${attr(cx(list?.item, profile.spacing?.itemGap))}><a href="{{URL}}"${attr(cx(t.link, t.body))}>{{ANCHOR_TEXT}}</a></li>`,
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
export function projectCta(profile, { label, href = '#' } = {}) {
  const cls = profile?.components?.button?.primary;
  if (!cls || !label) return null;
  return `<a href="${href}" class="${cls}">${label}</a>`;
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
