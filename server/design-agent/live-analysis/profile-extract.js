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
function bodySamples(segmentedPages) {
  const out = [];
  for (const page of segmentedPages || []) {
    for (const section of page.sections || []) {
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
  const matching = samples.filter((s) => s.classes === chosen);
  const chosenIsLabel = matching.length > 0 && matching.every((s) => isLabelStyle(s.style));
  if (chosen && !chosenIsLabel) return { body: chosen, corrected: false };

  const bodyLike = samples.filter((s) => !isLabelStyle(s.style));
  if (!bodyLike.length) return { body: null, corrected: true };

  // Most frequently observed body-like class wins — same "most consistent"
  // rule the prompt asks for, now applied to a candidate set that cannot
  // contain a label.
  const counts = new Map();
  for (const s of bodyLike) counts.set(s.classes, (counts.get(s.classes) || 0) + 1);
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  return { body: best, corrected: best !== chosen };
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
