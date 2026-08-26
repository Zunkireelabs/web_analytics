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

  return {
    version: DESIGN_PROFILE_VERSION,
    site: { pagesAnalyzed: pages.map((p) => p.url) },
    styling: extracted.styling || 'unknown',
    framework: extracted.framework || null,
    typography: extracted.typography || {},
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
