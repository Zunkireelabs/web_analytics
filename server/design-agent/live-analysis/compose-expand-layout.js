// Composes a NEW, more visually distinct HTML layout for the expand-content
// action type — a departure from design-profile.js's PROJECTORS, which only
// ever recombine classes verbatim from the site's existing prose/article
// markup. A site whose real article body is itself bare heading+paragraph
// (the common case — see project notes: a client screenshot of exactly this)
// gives projectExpandContent nothing to build visual distinction from, even
// though the profile may carry a real card/button/color vocabulary the site
// uses ELSEWHERE (its pricing cards, its CTAs) that this content type never
// draws on.
//
// This module is deliberately the one place in the Design Agent that lets an
// LLM invent new MARKUP STRUCTURE (a card grid, an accent marker, a
// two-column layout) — a real exception to design-profile.js's "never
// invent" rule, not a violation of it. What still may never be invented is
// the site's visual IDENTITY: every class used must be either (a) a real
// class fragment already observed in this site's profile ("brand tokens"),
// or (b) drawn from a small, fixed, brand-neutral set of Tailwind layout
// utilities (STRUCTURAL_ALLOWLIST) that carry no color/font/radius/shadow
// opinion of their own. validateGeneratedExpandLayout enforces this
// deterministically after generation — the model is never trusted on its
// own, the same "verify, don't trust" discipline profile-extract.js's
// correctBodyTypography/correctHeadingTypography already apply to profile
// extraction.
//
// Tailwind-only: the structural vocabulary below is Tailwind utility class
// syntax. A site whose profile.styling isn't 'tailwind' gets no generated
// layout — composeGeneratedExpandLayout returns null and the caller keeps
// design-profile.js's plain projectExpandContent output, exactly as it does
// today for any site with no usable profile at all.
import { callLLMForJson } from '../../llm.js';
import { isProfileUsable } from '../lib/design-profile.js';

// Same patterns generators/lib/design-consistency-gate.js already polices
// generator prose with — kept as a local copy rather than an import because
// design-agent must not depend on generators (design-profile.js's escapeHtml
// documents the same boundary for implementers).
const INLINE_STYLE_RE = /\bstyle\s*=\s*["'][^"']*["']/i;
const RAW_COLOR_RE = /#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]+\)/;
const UNSAFE_MARKUP_RE = /<script|<\/script|\bon[a-z]+\s*=|javascript:/i;

// Layout/box-model/shape utilities only — nothing here expresses a color, a
// font, or a specific radius/shadow COLOR (box-shadow's default is neutral
// black at low opacity in every Tailwind build, not a brand choice). Every
// value a reviewer would call "this site's look" — color.*, typography.*,
// spacing.section/itemGap, components.card/button — must come from the real
// profile instead; this set exists only so a generated layout can arrange
// those real values into something other than a vertical stack.
const STRUCTURAL_ALLOWLIST = new Set([
  'flex', 'inline-flex', 'grid', 'block', 'inline-block', 'hidden', 'relative', 'absolute',
  'grid-cols-1', 'grid-cols-2', 'grid-cols-3',
  'flex-col', 'flex-row', 'flex-wrap', 'flex-1', 'flex-shrink-0', 'shrink-0', 'grow',
  'items-start', 'items-center', 'items-end', 'items-baseline',
  'justify-start', 'justify-center', 'justify-end', 'justify-between', 'justify-around',
  'gap-2', 'gap-3', 'gap-4', 'gap-6', 'gap-8',
  'w-full', 'w-auto', 'h-full', 'aspect-square',
  'text-center', 'text-left', 'mx-auto',
  'rounded', 'rounded-sm', 'rounded-md', 'rounded-lg', 'rounded-xl', 'rounded-full',
  'shadow', 'shadow-sm', 'shadow-md', 'border', 'border-2',
]);

// Every real class fragment on the profile that this content type could
// plausibly reuse — the site's own colors, typography, spacing, and
// component vocabulary. Broader than projectExpandContent's own inputs
// (which is deliberately narrow) because a GENERATED layout is allowed to
// draw on card/button/list styling this site uses elsewhere, the exact gap
// this module exists to close.
function collectBrandTokens(profile) {
  const strings = [
    profile?.typography?.heading?.section,
    profile?.typography?.heading?.item,
    profile?.typography?.body,
    profile?.layout?.container,
    profile?.layout?.prose,
    profile?.spacing?.section,
    profile?.spacing?.itemGap,
    profile?.color?.text,
    profile?.color?.muted,
    profile?.color?.accent,
    profile?.color?.surface,
    profile?.color?.border,
    profile?.components?.card?.wrapper,
    profile?.components?.card?.body,
    profile?.components?.button?.primary,
    profile?.components?.button?.secondary,
    profile?.components?.list?.wrapper,
    profile?.components?.list?.item,
    profile?.components?.list?.divider,
    profile?.components?.articleBody?.wrapper,
  ];
  const tokens = new Set();
  for (const s of strings) {
    if (typeof s !== 'string') continue;
    for (const token of s.trim().split(/\s+/)) {
      if (token) tokens.add(token);
    }
  }
  return tokens;
}

function stripResponsivePrefix(token) {
  return token.replace(/^(sm:|md:|lg:|xl:|2xl:)/, '');
}

function extractClassTokens(html) {
  const tokens = [];
  const re = /class\s*=\s*"([^"]*)"/g;
  let m = re.exec(html);
  while (m) {
    tokens.push(...m[1].trim().split(/\s+/).filter(Boolean));
    m = re.exec(html);
  }
  return tokens;
}

// Deterministic, never trusts the model's own claim of compliance — the same
// "verify what came back, don't take the LLM's word for it" discipline used
// throughout profile-extract.js. Returns { ok: true } or { ok: false,
// reason, detail? }; never partial credit.
export function validateGeneratedExpandLayout(candidate, profile) {
  if (!candidate || typeof candidate !== 'object') return { ok: false, reason: 'not-an-object' };
  const { wrapper, row } = candidate;
  if (typeof wrapper !== 'string' || typeof row !== 'string') return { ok: false, reason: 'missing-wrapper-or-row' };
  if (!wrapper.includes('{{ROWS}}')) return { ok: false, reason: 'missing-placeholder', detail: '{{ROWS}}' };
  if (!row.includes('{{HEADING}}') || !row.includes('{{BODY}}')) {
    return { ok: false, reason: 'missing-placeholder', detail: '{{HEADING}}/{{BODY}}' };
  }

  const combined = `${wrapper}\n${row}`;
  if (INLINE_STYLE_RE.test(combined)) return { ok: false, reason: 'inline-style' };
  if (RAW_COLOR_RE.test(combined)) return { ok: false, reason: 'raw-color-value' };
  if (UNSAFE_MARKUP_RE.test(combined)) return { ok: false, reason: 'unsafe-markup' };

  const allowed = collectBrandTokens(profile);
  const invalid = [...new Set(
    extractClassTokens(combined)
      .map(stripResponsivePrefix)
      .filter((token) => !allowed.has(token) && !STRUCTURAL_ALLOWLIST.has(token)),
  )];
  if (invalid.length) return { ok: false, reason: 'invented-classes', detail: invalid };

  return { ok: true };
}

const SYSTEM_PROMPT = `You compose ONE new HTML layout for a "content expansion" section — a small number of heading+paragraph blocks appended to an existing page on a real website — designed to be more visually engaging than a bare heading and paragraph stacked with no visual structure.

You are given two lists:
1. BRAND TOKENS — real CSS class fragments already observed on this exact site (its colors, typography, spacing, and existing card/button/list styling). Use ONLY these values for anything that expresses this site's visual identity: color, font, spacing, border-radius, shadow.
2. STRUCTURAL CLASSES — a small, fixed, brand-neutral set of layout utilities (flex/grid arrangement, generic gap/shape/shadow) you may use freely, for arrangement only.

Rules, strictly enforced by a program after you respond — a violation is discarded, not merely discouraged:
- Never use a class that is not in one of the two lists above.
- Never invent a hex color, rgb() value, or inline style="" attribute.
- Never emit <script>, an on*="" event handler, or a javascript: URL.
- Design something more distinctive than a plain stacked <h2>+<p> — for example a bordered/shadowed card per section, a small accent-colored marker beside the heading, or a layout that responds at wider breakpoints — composed only from the allowed classes.

Respond with ONLY a JSON object of this exact shape:
{
  "wrapper": "<div class=\\"...\\">\\n{{ROWS}}\\n</div>",
  "row": "  <section class=\\"...\\">\\n    <h2 class=\\"...\\">{{HEADING}}</h2>\\n    <div class=\\"...\\">{{BODY}}</div>\\n  </section>"
}
wrapper must contain the literal token {{ROWS}} exactly once. row must contain the literal tokens {{HEADING}} and {{BODY}} exactly once each. Every class="..." attribute must be built only from the two provided lists, space-joined.`;

function buildUserPrompt(brandTokens) {
  return `BRAND TOKENS (real classes observed on this site — use only these for color/font/spacing/radius/shadow):\n${brandTokens.join(' ')}\n\nSTRUCTURAL CLASSES (brand-neutral layout utilities — use freely for arrangement only):\n${[...STRUCTURAL_ALLOWLIST].join(' ')}\n\nDesign the "expand content" section layout now.`;
}

// Returns a validated { wrapper, row } template, or null when generation
// isn't possible/safe — never a partially-validated result. A null return is
// the intended, unremarkable outcome for any site without a usable Tailwind
// profile: the caller (live-analysis-handler.js) keeps design-profile.js's
// plain projected template, exactly as it does today when no profile exists
// at all. One retry lives inside callLLMForJson's own `validate` hook; a
// second consecutive failure is logged and treated the same as "can't
// generate right now", not escalated.
export async function composeGeneratedExpandLayout(profile, { siteId, generatorId = 'design-agent-expand-layout' } = {}) {
  if (profile?.styling !== 'tailwind') return null;
  if (!isProfileUsable(profile)) return null;

  const brandTokens = [...collectBrandTokens(profile)].sort();
  if (!brandTokens.length) return null;

  try {
    const candidate = await callLLMForJson(SYSTEM_PROMPT, buildUserPrompt(brandTokens), {
      tier: 'monthly',
      maxTokens: 1200,
      generatorId,
      siteId,
      validate: (parsed) => validateGeneratedExpandLayout(parsed, profile).ok,
    });
    const verdict = validateGeneratedExpandLayout(candidate, profile);
    return verdict.ok ? candidate : null;
  } catch (err) {
    console.warn(`[design-agent] site ${siteId}: expand-content layout generation failed — keeping the plain projected template (${err.message}).`);
    return null;
  }
}
