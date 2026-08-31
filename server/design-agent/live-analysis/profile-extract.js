// Turns segment.js's structural, real-class-grounded page data into the
// Design Profile v2 the rest of the platform consumes. One model call per
// site (not per-page, not an agentic loop) — this is classification/
// synthesis over facts already extracted deterministically, the same
// "grounded, never invented" discipline design_task.py's OpenHands prompt
// enforced, just applied to real live-DOM class strings instead of repo
// source.
import { callLLMForJson } from '../../llm.js';
import { DESIGN_PROFILE_VERSION } from './schema.js';

const SYSTEM_PROMPT = `You are analyzing structural facts already extracted from a real, live website's rendered pages — real HTML class attributes, real computed text styles, real section ordering. You are NOT reading source code and you must NEVER invent a class name, color, or pattern that isn't present in the data you're given.

Your job: synthesize this into a website design system description. For every field, pick the class string(s) that appear most consistently across the sections/pages you were given for that role. If a slot has no real evidence in the data, set it to null rather than guessing — a missing pattern is honest; an invented one is not.

Respond with ONLY a JSON object matching this exact shape (all string values must be real class strings copied from the input data, or null):
{
  "styling": "tailwind" | "css-modules" | "plain-css" | "unknown",
  "framework": string | null,
  "typography": {
    "heading": { "section": string|null, "item": string|null },
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
    "articleBody": { "wrapper": string|null } | null
  },
  "responsive": { "breakpoints": string[] },
  "navigation": {
    "header": { "sectionRoles": string[], "notes": string },
    "footer": { "sectionRoles": string[], "notes": string }
  },
  "pageTypePatterns": {
    "<pageType>": { "sectionOrder": string[], "textHierarchy": [{"role": string, "styleNotes": string}], "notes": string }
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

  // Scored by TOKEN centrality, not by how often a whole class string repeats.
  // Counting whole strings barely works: real sites give almost every
  // paragraph its own combination of one-off modifiers (`max-w-2xl mx-auto`,
  // `line-clamp-2`, `mb-8`), so nearly every candidate is unique and the
  // "winner" is decided by map insertion order — which is how the first
  // version of this picked a 24px pull-quote.
  //
  // The site's actual body convention is the tokens that recur ACROSS those
  // variants. On this platform's first client, `text-gray-600` and
  // `leading-relaxed` appear on the 16px, 18px and 20px paragraphs alike,
  // while the size and width modifiers differ every time — so the class made
  // of only high-frequency tokens is the convention, and the long ones are
  // that convention plus per-section emphasis.
  const df = new Map();
  for (const s of bodyLike) {
    for (const token of new Set(normalizeClasses(s.classes).split(' '))) {
      df.set(token, (df.get(token) || 0) + 1);
    }
  }

  const candidates = new Map();
  for (const s of bodyLike) {
    const norm = normalizeClasses(s.classes);
    if (!candidates.has(norm)) candidates.set(norm, 0);
    candidates.set(norm, candidates.get(norm) + 1);
  }

  const best = [...candidates.entries()]
    .map(([classes, count]) => {
      const tokens = classes.split(' ');
      const meanDf = tokens.reduce((sum, t) => sum + df.get(t), 0) / tokens.length;
      return { classes, count, meanDf, size: tokens.length };
    })
    // Most central first; then the one actually seen most often; then the
    // shorter one, which is the convention without a section's extra emphasis.
    .sort((a, b) => b.meanDf - a.meanDf || b.count - a.count || a.size - b.size)[0].classes;

  return { body: best, corrected: best !== chosen };
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
export async function extractDesignProfile(segmentedPages, { siteId, generatorId = 'design-agent-live' } = {}) {
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

  return {
    version: DESIGN_PROFILE_VERSION,
    site: { pagesAnalyzed: pages.map((p) => p.url) },
    styling: extracted.styling || 'unknown',
    framework: extracted.framework || null,
    typography: { ...typography, body },
    color: extracted.color || {},
    spacing: extracted.spacing || {},
    layout: extracted.layout || {},
    components: extracted.components || {},
    responsive: extracted.responsive || { breakpoints: [] },
    navigation: extracted.navigation || {},
    pages: (segmentedPages || []).map((p) => ({ url: p.url, pageType: p.pageType, sections: p.sections })),
    pageTypePatterns: extracted.pageTypePatterns || {},
    evidence: extracted.evidence || { pagesAnalyzed: pages.map((p) => p.url), notes: '' },
  };
}
