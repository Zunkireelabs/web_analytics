// Turns segment.js's structural, real-class-grounded page data into the
// Design Profile v2 the rest of the platform consumes. One model call per
// site (not per-page, not an agentic loop) — this is classification/
// synthesis over facts already extracted deterministically, the same
// "grounded, never invented" discipline design_task.py's OpenHands prompt
// enforced, just applied to real live-DOM class strings instead of repo
// source.
import { callLLMForJson } from '../../llm.js';
import { DESIGN_PROFILE_VERSION } from './schema.js';
import { maxTextPx, isFixedHeightOnly } from '../../lib/text-scale.js';

const SYSTEM_PROMPT = `You are analyzing structural facts already extracted from a real, live website's rendered pages — real HTML class attributes, real computed text styles, real section ordering. You are NOT reading source code and you must NEVER invent a class name, color, or pattern that isn't present in the data you're given.

Your job: synthesize this into a website design system description. For every field, pick the class string(s) that appear most consistently across the sections/pages you were given for that role. If a slot has no real evidence in the data, set it to null rather than guessing — a missing pattern is honest; an invented one is not.

Respond with ONLY a JSON object matching this exact shape (all string values must be real class strings copied from the input data, or null):
{
  "styling": "tailwind" | "css-modules" | "plain-css" | "unknown",
  "framework": string | null,
  "typography": {
    "heading": { "section": string|null, "item": string|null, "page": { "hero": string|null, "standard": string|null } },
    "body": string|null,
    "link": string|null
  },
  "color": { "text": string|null, "muted": string|null, "accent": string|null, "surface": string|null, "border": string|null },
  "spacing": { "section": string|null, "itemGap": string|null },
  "layout": { "container": string|null, "prose": string|null },
  "components": {
    "accordion": { "wrapper": string|null, "item": string|null, "trigger": string|null, "panel": string|null } | null,
    "card": { "wrapper": string|null, "body": string|null } | null,
    "list": { "wrapper": string|null, "item": string|null, "divider": string|null } | null,
    "button": { "primary": string|null, "secondary": string|null } | null,
    "articleBody": { "wrapper": string|null } | null,
    "table": { "wrapper": string|null, "headerCell": string|null, "row": string|null, "cell": string|null } | null
  },
  "responsive": { "breakpoints": string[] },
  "navigation": {
    "header": { "sectionRoles": string[], "notes": string },
    "footer": { "sectionRoles": string[], "notes": string }
  },
  "pageTypePatterns": {
    "<pageType>": { "sectionOrder": string[], "textHierarchy": [{"role": string, "classes": string|null, "styleNotes": string}], "notes": string }
  },
  "evidence": { "pagesAnalyzed": string[], "notes": string }
}`;

// Every observed body-role text sample across every page, as
// { classes, style, text } — the ground truth the model's `typography.body`
// pick is checked against below.
// Site chrome is not a model for page body copy. A footer paragraph on this
// platform's own first client is `text-navy-200 ... max-w-sm` — light text
// sized for a dark navy footer — and it appears on every page, so it wins any
// frequency contest against the real prose class while rendering nearly
// invisible on a white content background. Header/nav are excluded for the
// same reason.
const CHROME_ROLES = new Set(['header', 'nav', 'footer']);

export function bodySamples(segmentedPages) {
  const out = [];
  for (const page of segmentedPages || []) {
    for (const section of page.sections || []) {
      if (CHROME_ROLES.has(section.role)) continue;
      for (const item of section.textHierarchy || []) {
        if (item.role === 'body' && item.classes) out.push(item);
      }
    }
  }
  return out;
}

// Mirrors capture.js's in-page isLabelLike, applied here to the style already
// captured for a sample. Kept as its own copy deliberately: capture.js's runs
// in the browser and cannot be imported, and this one must keep working
// against profiles captured before that function existed.
function isLabelStyle(style) {
  if (!style) return false;
  if (style.textTransform === 'uppercase') return true;
  if (parseFloat(style.fontSize) < 14) return true;
  const ls = parseFloat(style.letterSpacing);
  return !Number.isNaN(ls) && ls >= 1;
}

// The model is told to pick the most CONSISTENT class for each role, and on a
// site that puts an eyebrow above every section heading, the most consistent
// body-role class IS the eyebrow. Prompt wording cannot fix that — the label
// genuinely is the modal paragraph — so the pick is verified against the real
// computed styles instead, and replaced with the best genuinely body-like
// sample when it fails.
//
// Returning null when NO sample is body-like is the intended outcome, not a
// degradation: validateDesignProfile requires typography.body, so a null makes
// the whole profile unusable and every generator falls back to its plain
// default. Shipping no styling is recoverable; shipping every paragraph on a
// customer's site as a tiny uppercase label is what this exists to prevent.
export function correctBodyTypography(chosen, samples) {
  // Nothing captured means nothing to check against — not evidence the pick is
  // wrong. Every other path below has real samples to reason from.
  if (!samples.length) return { body: chosen, corrected: false };

  // The pick stands only when it was actually OBSERVED and observed as prose.
  // A class the model returned that appears in no body sample is unconfirmed:
  // the prompt requires every value to be copied from the supplied data, so an
  // unobserved one is either from another role or invented, and neither earns
  // the benefit of the doubt when a verified candidate is available.
  const matching = samples.filter((s) => normalizeClasses(s.classes) === normalizeClasses(chosen || ''));
  if (chosen && matching.length && !matching.every((s) => isLabelStyle(s.style))) {
    return { body: chosen, corrected: false };
  }

  const bodyLike = samples.filter((s) => !isLabelStyle(s.style));
  if (!bodyLike.length) return { body: null, corrected: true };

  const best = pickCentralClass(bodyLike);
  return { body: best, corrected: best !== chosen };
}

// The most REPRESENTATIVE class string in a set of samples, scored by token
// centrality rather than by how often a whole class string repeats.
//
// Counting whole strings barely works: real sites give almost every element
// its own combination of one-off modifiers (`max-w-2xl mx-auto`,
// `line-clamp-2`, `mb-8`), so nearly every candidate is unique and the
// "winner" comes down to map insertion order — which is how an early version
// of this picked a 24px pull-quote as the site's body copy.
//
// The convention is the tokens that recur ACROSS those variants. On this
// platform's first client, `text-gray-600` and `leading-relaxed` appear on the
// 16px, 18px and 20px paragraphs alike while the size and width modifiers
// differ every time — so the class made of only high-frequency tokens is the
// convention, and the longer ones are that convention plus local emphasis.
function pickCentralClass(samples) {
  const df = new Map();
  for (const s of samples) {
    for (const token of new Set(normalizeClasses(s.classes).split(' '))) {
      df.set(token, (df.get(token) || 0) + 1);
    }
  }

  const candidates = new Map();
  for (const s of samples) {
    const norm = normalizeClasses(s.classes);
    candidates.set(norm, (candidates.get(norm) || 0) + 1);
  }

  return [...candidates.entries()]
    .map(([classes, count]) => {
      const tokens = classes.split(' ');
      const meanDf = tokens.reduce((sum, t) => sum + df.get(t), 0) / tokens.length;
      return { classes, count, meanDf, size: tokens.length };
    })
    // Most central first; then the one actually seen most often; then the
    // shorter one, which is the convention without an element's extra emphasis.
    .sort((a, b) => b.meanDf - a.meanDf || b.count - a.count || a.size - b.size)[0].classes;
}

// typography.link is meant to be the site's INLINE link style — what a link
// inside a sentence or a related-links list looks like. When it comes back
// byte-identical to components.button.primary, it is not that: capture.js used
// to take each block's first <a>, which in a hero is the CTA button, so the
// profile learned a button as the site's link convention and internal-links
// rendered every related link as a full-width filled button.
//
// capture.js no longer picks that way, but a profile derived before the fix
// still carries it, and this is cheap and unambiguous. The secondary button —
// the site's own low-emphasis text link treatment — is the honest replacement
// when there is one; null otherwise, which drops internal-links back to body
// typography rather than inventing a link style.
export function correctLinkTypography(chosen, components = {}) {
  const primary = components.button?.primary;
  if (!chosen || !primary || normalizeClasses(chosen) !== normalizeClasses(primary)) {
    return { link: chosen, corrected: false };
  }
  return { link: components.button?.secondary || null, corrected: true };
}

// Heading classes observed on real heading TAGS, grouped by level, excluding
// site chrome. capture.js records the tag it read each style from, which is
// the only thing that reliably separates "the page title" from "a section
// title" — the two look similar in a flat class list and are very different
// in size.
export function headingSamplesByLevel(segmentedPages) {
  const byLevel = new Map();
  for (const page of segmentedPages || []) {
    for (const section of page.sections || []) {
      if (CHROME_ROLES.has(section.role)) continue;
      for (const item of section.textHierarchy || []) {
        if (!/^h[1-6]$/.test(item.tag || '') || !item.classes) continue;
        if (isLabelStyle(item.style)) continue; // an uppercase eyebrow rendered as an <h2>
        if (!byLevel.has(item.tag)) byLevel.set(item.tag, []);
        byLevel.get(item.tag).push(item);
      }
    }
  }
  return byLevel;
}

// Same failure as typography.body, one level up. A generated block's <h2> is a
// SECTION heading, but nothing checked which tag a candidate class came from,
// so this platform's first client had typography.heading.section set to its
// homepage <h1> style (`text-4xl md:text-5xl lg:text-6xl`). Every heading in
// an injected expand-content block therefore rendered at hero size — visibly
// larger than the real section headings above and below it on the same page.
//
// h2 is the authority for a section heading and h3 for a repeating item
// heading (an FAQ question), falling back to h2 when a site has no h3. A level
// with no samples leaves the model's pick alone: no evidence is not a defect.
//
// `pageHeadingSamples` (headingPageSamplesByContext below) splits real <h1>
// samples by whether their own section is a hero — this site's own real
// evidence, per context, never a rule imported from another site. A site
// that genuinely runs a bigger h1 in a hero than on an interior page gets
// BOTH values recorded (heading.page.hero / heading.page.standard) instead
// of being forced into one flat number, which is what let a real per-
// template design decision get misread as drift. Either slot with no
// samples is left null — no evidence is not a defect here either.
export function correctHeadingTypography(chosen = {}, byLevel, pageHeadingSamples = { hero: [], standard: [] }) {
  const out = { ...chosen };
  const corrected = [];

  const sectionSamples = byLevel.get('h2');
  if (sectionSamples?.length) {
    const best = pickCentralClass(sectionSamples);
    if (best !== chosen.section) { out.section = best; corrected.push('section'); }
  }

  const itemSamples = byLevel.get('h3')?.length ? byLevel.get('h3') : byLevel.get('h2');
  if (itemSamples?.length) {
    const best = pickCentralClass(itemSamples);
    if (best !== chosen.item) { out.item = best; corrected.push('item'); }
  }

  // A repeating ITEM heading (an FAQ question, a card title) can never
  // legitimately render LARGER than the section heading it sits beneath —
  // that inverts the site's own hierarchy, and an FAQ question set at page-
  // title scale is exactly what it looks like on the page. This is a
  // self-consistency rule, not an imported design opinion: both values are
  // this site's own real captured evidence, and the check only asks whether
  // they agree with each other.
  //
  // It fires when a site has no h3 samples at all and `item` had to fall back
  // to the same h2 pool as `section` (above), but the two central picks
  // landed on different h2 treatments — one a genuine section heading, one an
  // oversized display heading. Confirmed live on admizzeducation.com, which
  // derived item at 50px against a 42px section heading, then shipped FAQ
  // questions bigger than the section title above them.
  //
  // The repair is deliberately to reuse `section` rather than invent a
  // smaller class: a step-down size this site never actually uses would be a
  // guess, while the section heading is real, live, and known to render
  // correctly. Equal-size is a mild hierarchy flattening; larger is a visible
  // defect.
  const itemPx = maxTextPx(out.item);
  const sectionPx = maxTextPx(out.section);
  if (itemPx != null && sectionPx != null && itemPx > sectionPx) {
    out.item = out.section;
    corrected.push('item:capped-to-section');
  }

  const page = { ...(chosen.page || {}) };
  if (pageHeadingSamples.hero?.length) {
    const best = pickCentralClass(pageHeadingSamples.hero);
    if (best !== page.hero) { page.hero = best; corrected.push('page.hero'); }
  }
  if (pageHeadingSamples.standard?.length) {
    const best = pickCentralClass(pageHeadingSamples.standard);
    if (best !== page.standard) { page.standard = best; corrected.push('page.standard'); }
  }
  out.page = page;

  return { heading: out, corrected };
}

// spacing.section describes a section's VERTICAL RHYTHM — the padding/margin
// that separates it from what's around it. A fixed height (`h-[70px]`,
// `h-16`) is never that: it is the measured height of whatever single element
// the capture happened to read (very often the site's own fixed-height
// navbar), and applying it to a wrapper holding arbitrary-length drafted
// content clips or overlaps that content.
//
// Confirmed live on admizzeducation.com, whose profile stored
// `spacing.section: "h-[70px]"` — its navbar height — which then composed
// into every projected component wrapper, including the `<dl>` holding six
// Q&A pairs. marker-merge.js already strips a fixed height at RENDER time,
// so this is the same rule one stage earlier, at the point the value would be
// stored as a site convention: a measurement mistake should not be persisted
// as design knowledge and then repeatedly stripped by every consumer that
// remembers to.
//
// Dropped to null rather than replaced with a guessed padding — null means
// "this site has no recorded section rhythm", which every consumer already
// handles, while an invented `py-16` would be a cross-site default of exactly
// the kind this platform never applies.
export function correctSpacing(spacing, siteId = null) {
  const out = { ...(spacing || {}) };
  for (const field of ['section', 'itemGap']) {
    if (out[field] && isFixedHeightOnly(out[field])) {
      if (siteId != null) {
        console.warn(
          `[design-agent] site ${siteId}: spacing.${field} was "${out[field]}" — a fixed height, not spacing. Dropped.`,
        );
      }
      out[field] = null;
    }
  }
  return out;
}

// Real <h1> samples, split by whether their own section is a hero — the only
// per-site signal that reliably tells a hero title apart from an interior
// page's title (a section.role, already produced by segment.js, not a guess
// made here). Excludes site chrome and label-styled text, same as
// headingSamplesByLevel.
export function headingPageSamplesByContext(segmentedPages) {
  const hero = [];
  const standard = [];
  for (const page of segmentedPages || []) {
    for (const section of page.sections || []) {
      if (CHROME_ROLES.has(section.role)) continue;
      for (const item of section.textHierarchy || []) {
        if (item.tag !== 'h1' || !item.classes) continue;
        if (isLabelStyle(item.style)) continue;
        (section.role === 'hero' ? hero : standard).push(item);
      }
    }
  }
  return { hero, standard };
}

// Real 'subheading' textHierarchy samples (role assigned by segment.js's
// textHierarchyOf: any non-h1 heading), grouped by pageType — the same
// per-page real-class evidence compactPageForPrompt already hands the model,
// just re-grouped here for cross-checking the model's OWN pageTypePatterns
// summary against it. Excludes chrome and label-styled text, same as
// headingSamplesByLevel above.
function subheadingSamplesByPageType(segmentedPages) {
  const byType = new Map();
  for (const page of segmentedPages || []) {
    for (const section of page.sections || []) {
      if (CHROME_ROLES.has(section.role)) continue;
      for (const item of section.textHierarchy || []) {
        if (item.role !== 'subheading' || !item.classes) continue;
        if (isLabelStyle(item.style)) continue;
        if (!byType.has(page.pageType)) byType.set(page.pageType, []);
        byType.get(page.pageType).push(item);
      }
    }
  }
  return byType;
}

// pageTypePatterns.textHierarchy is a MODEL SUMMARY across a page type's own
// pages, not a direct per-page capture — same distance from ground truth
// that made typography.body/heading need their own correction pass above.
// Left unchecked, the model regularly returned this shape with 'subheading'
// entries carrying only a prose styleNotes and no classes at all (or, worse,
// an unobserved/invented one), which is exactly why
// marker-merge.js's groundedInlineHeadingClass — the one consumer of this
// field — could never find a real class to restyle an inline (blog/article)
// page's stripped section heading with, and shipped a bare, unstyled <h2>
// instead. Same discipline as correctBodyTypography: a `classes` value only
// stands when it is actually OBSERVED for that exact (pageType, role) pair;
// otherwise it is replaced with the real central class for that pair, or
// left null when there is no evidence at all — never invented.
export function correctPageTypeTextHierarchy(patterns, segmentedPages) {
  const samplesByType = subheadingSamplesByPageType(segmentedPages);
  const out = {};
  const corrected = [];

  for (const [pageType, pattern] of Object.entries(patterns || {})) {
    const samples = samplesByType.get(pageType) || [];
    const textHierarchy = (pattern.textHierarchy || []).map((entry) => {
      if (entry.role !== 'subheading') return entry;
      if (!samples.length) return entry.classes ? { ...entry, classes: null } : entry;

      const matching = samples.filter((s) => normalizeClasses(s.classes) === normalizeClasses(entry.classes || ''));
      if (entry.classes && matching.length) return entry;

      const best = pickCentralClass(samples);
      if (best !== entry.classes) corrected.push(pageType);
      return { ...entry, classes: best };
    });
    out[pageType] = { ...pattern, textHierarchy };
  }

  return { pageTypePatterns: out, corrected };
}

function normalizeClasses(classes) {
  return classes.trim().split(/\s+/).filter(Boolean).join(' ');
}

function compactPageForPrompt(page) {
  return {
    url: page.url,
    pageType: page.pageType,
    title: page.title,
    sections: page.sections.map((s) => ({
      role: s.role,
      classes: s.classes,
      alignment: s.alignment,
      width: s.width,
      textHierarchy: s.textHierarchy.map((t) => ({ role: t.role, tag: t.tag, classes: t.classes, styleNotes: t.style })),
      components: s.components,
      spacing: s.spacing,
    })),
  };
}

// segmentedPages: segment.js's segmentSite() output. Returns a Design
// Profile v2 object, NOT yet stamped/validated — design-drift.js's
// persistDesignProfile does both, the same as the v1 pipeline always did.
export async function extractDesignProfile(segmentedPages, {
  siteId, generatorId = 'design-agent-live', responsiveMeasured = null,
} = {}) {
  const pages = (segmentedPages || []).map(compactPageForPrompt);
  const userPrompt = `Here is the structural data extracted from ${pages.length} real page(s) of this site:\n\n${JSON.stringify(pages, null, 2)}`;

  const extracted = await callLLMForJson(SYSTEM_PROMPT, userPrompt, {
    tier: 'monthly', maxTokens: 4000, generatorId, siteId,
  });

  const typography = extracted.typography || {};
  const { body, corrected } = correctBodyTypography(typography.body || null, bodySamples(segmentedPages));
  if (corrected) {
    console.warn(
      `[design-agent] site ${siteId}: typography.body "${typography.body}" looks like a label `
      + `(uppercase/small/wide-tracking), not body copy — using ${body ? `"${body}"` : 'null (profile unusable)'} instead.`,
    );
  }

  const { heading, corrected: headingsCorrected } = correctHeadingTypography(
    typography.heading || {}, headingSamplesByLevel(segmentedPages), headingPageSamplesByContext(segmentedPages),
  );
  const HEADING_SLOT_LABEL = { section: 'h2', item: 'h3', 'page.hero': 'h1 (hero section)', 'page.standard': 'h1 (non-hero)' };
  for (const slot of headingsCorrected) {
    const value = slot.startsWith('page.') ? heading.page[slot.split('.')[1]] : heading[slot];
    console.warn(
      `[design-agent] site ${siteId}: typography.heading.${slot} was not the class this site uses on its `
      + `${HEADING_SLOT_LABEL[slot] || slot} elements — corrected to "${value}".`,
    );
  }

  const { pageTypePatterns, corrected: pageTypesCorrected } = correctPageTypeTextHierarchy(
    extracted.pageTypePatterns || {}, segmentedPages,
  );
  if (pageTypesCorrected.length) {
    console.warn(
      `[design-agent] site ${siteId}: pageTypePatterns subheading class(es) for page type(s) `
      + `${[...new Set(pageTypesCorrected)].join(', ')} were not grounded in this page type's own real `
      + `sections — corrected against observed evidence.`,
    );
  }

  const components = extracted.components || {};
  const { link, corrected: linkCorrected } = correctLinkTypography(typography.link || null, components);
  if (linkCorrected) {
    console.warn(
      `[design-agent] site ${siteId}: typography.link was identical to components.button.primary `
      + `— that is a CTA button, not an inline link style. Using ${link ? `"${link}"` : 'null'} instead.`,
    );
  }

  return {
    version: DESIGN_PROFILE_VERSION,
    site: { pagesAnalyzed: pages.map((p) => p.url) },
    styling: extracted.styling || 'unknown',
    framework: extracted.framework || null,
    typography: { ...typography, body, heading, link },
    color: extracted.color || {},
    spacing: correctSpacing(extracted.spacing, siteId),
    layout: extracted.layout || {},
    components,
    // `breakpoints` stays exactly what it always was: the class PREFIXES the
    // model reported seeing. `measured` is the other half and is never
    // model-derived — it is arithmetic over real rendered geometry at real
    // device widths (responsive-analysis.js), so it cannot be hallucinated
    // and needs no correction pass the way typography does. Additive: a
    // profile derived before responsive probing existed, or by a caller that
    // skipped it, simply has `measured: null` and every existing reader of
    // `responsive.breakpoints` is unaffected.
    responsive: { ...(extracted.responsive || { breakpoints: [] }), measured: responsiveMeasured },
    navigation: extracted.navigation || {},
    pages: (segmentedPages || []).map((p) => ({ url: p.url, pageType: p.pageType, sections: p.sections })),
    pageTypePatterns,
    evidence: extracted.evidence || { pagesAnalyzed: pages.map((p) => p.url), notes: '' },
  };
}
