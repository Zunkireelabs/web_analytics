// General mechanism for repairing a recommendation blocked by missing
// TEMPLATE PLUMBING (an insertion point, data field, or adapter config the
// client's site doesn't yet expose) — as opposed to a recommendation
// blocked by a genuinely missing FACT (real business data we cannot invent).
//
// The two are easy to conflate. store/recommendations.js's classifyBlockedKind
// already labels the "shared/generated template" case 'site-fact', but that
// label describes an architectural constraint of the ROUTE (many URLs share
// one template), not a missing real-world fact — a page generated from
// src/_data/locations.js still has a real place, or a real SIBLING page's
// real place, to receive real AI-managed content. This module tells those
// apart on real evidence (does a slot exist? does a sibling route's own
// template already have one for this exact generator?), never a guess.
//
// Every AI-managed insertion point this codebase writes into already follows
// one fixed, self-documenting shape — see location.njk/location-service.njk
// on zunkireelabs-web for real examples this was derived from:
//
//   {# comment mentioning "AI-managed" and "server/generators/<id>.js" #}
//   {% if <fieldExpr> %}
//   {{ <fieldExpr> | safe }}        (or `| dump | safe` for raw JSON-LD)
//   {% endif %}
//
// That shape is the load-bearing evidence this module reads and writes —
// never invented, always copied from a real example already in the repo.

// Matches one AI-managed slot block: an optional preceding Nunjucks comment
// (captured to find the generator hint), the if/endif guard, and the
// fieldExpr the guard tests (e.g. "location.expandedContent",
// "serviceContent.reviewSchema"). `[\s\S]*?` (not `.`) so the comment body
// can span multiple lines, matching every real example in this codebase.
// Content between {% if %}/output and output/{% endif %} is matched
// non-greedily rather than assumed empty: a real example (location-service.njk's
// reviewSchema slot) wraps its output in a literal <script type="application/
// ld+json"> tag, not adjacent to the guard.
const SLOT_BLOCK_RE =
  /(\{#([\s\S]*?)#\}\s*)?\{%\s*if\s+([\w.]+)\s*%\}([\s\S]*?)\{\{\s*([\w.]+)\s*(?:\|\s*dump\s*)?\|\s*safe\s*\}\}([\s\S]*?)\{%\s*endif\s*%\}/g;

// The comment convention every existing slot uses to say which generator
// owns it — "see server/generators/expand-content.js" (or a bare mention of
// the generator id near "AI-managed"). Falls back to null (unknown owner)
// rather than guessing from the field name, since a field named
// "reviewSchema" could plausibly be mistaken for "schema" by name alone.
const GENERATOR_HINT_RE = /server\/generators\/([\w-]+)\.js/;

// Parses every AI-managed slot in a template source. Pure, no I/O — the
// caller supplies the already-fetched file content.
export function parseAiManagedSlots(templateSource) {
  const slots = [];
  let m;
  SLOT_BLOCK_RE.lastIndex = 0;
  while ((m = SLOT_BLOCK_RE.exec(templateSource))) {
    const [raw, , comment, guardExpr, , outputExpr] = m;
    if (guardExpr !== outputExpr) continue; // guard and output must agree on the same field — anything else isn't this convention
    const hintMatch = comment && GENERATOR_HINT_RE.exec(comment);
    slots.push({
      fieldExpr: guardExpr,
      generatorId: hintMatch ? hintMatch[1] : null,
      isAiManaged: Boolean(comment && /ai-managed/i.test(comment)),
      raw,
      start: m.index,
      end: m.index + raw.length,
    });
  }
  return slots;
}

export function findSlotForGenerator(slots, generatorId) {
  return slots.find((s) => s.generatorId === generatorId) || null;
}

export function fieldNameFromExpr(fieldExpr) {
  const parts = fieldExpr.split('.');
  return parts[parts.length - 1];
}

export function baseVarFromExpr(fieldExpr) {
  const parts = fieldExpr.split('.');
  return parts.slice(0, -1).join('.');
}

// Ports a sibling template's real slot block onto THIS template's own base
// variable — the only thing that changes is which object the field hangs
// off of (e.g. "location.expandedContent" -> "serviceContent.expandedContent"),
// never the field name itself, never the surrounding markup shape. A plain
// word-boundary replace, not a rewrite, so nothing about the sibling's own
// wording/comment is invented — only the one token that must differ.
export function adaptSlotBlock(siblingSlot, targetBaseVar) {
  const fromBaseVar = baseVarFromExpr(siblingSlot.fieldExpr);
  const escaped = fromBaseVar.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b${escaped}\\.`, 'g');
  return siblingSlot.raw.replace(re, `${targetBaseVar}.`);
}

// The core decision. Every input is real evidence already fetched by the
// caller — this function makes no network call and invents nothing.
//
//   templateSource        — the real page family's own template source
//   siblingTemplateSources — [{ label, source }] for OTHER route families in
//                            the SAME site that share this route's data file
//                            (the general definition of "sibling" — see
//                            repair-template-capability.js's dataFile-based
//                            grouping), each already fetched
//   generatorId            — the blocked recommendation's generatorId
//   hasAdapterConfig        — whether url_file_map already has an adapter
//                             wired for this exact (pattern, generatorId)
//
// Returns one of:
//   'already-wired'       — a slot exists AND config points at it; nothing to do
//   'plumbing-gap'        — a slot already exists in THIS template but no
//                           adapter config points at it (Class A)
//   'safe-capability-gap' — no slot here, but a sibling route's template has
//                           one for this exact generator, with real markup
//                           to derive from (Class B)
//   'architectural-gap'   — no slot here and no sibling to derive from; a
//                           human decision is required (Class D)
export function classifyCapabilityGap({ templateSource, siblingTemplateSources = [], generatorId, hasAdapterConfig }) {
  const ownSlots = parseAiManagedSlots(templateSource);
  const ownSlot = findSlotForGenerator(ownSlots, generatorId);

  if (ownSlot && hasAdapterConfig) {
    return { classification: 'already-wired', ownSlot };
  }
  if (ownSlot && !hasAdapterConfig) {
    return { classification: 'plumbing-gap', ownSlot, anchorSlots: ownSlots };
  }

  // No slot here. Look for a sibling — a DIFFERENT route family in this same
  // site whose template already solved this exact generator, for the same
  // underlying data. Only a real, already-shipped example counts as
  // "established pattern" — never a guess about what one might look like.
  for (const sib of siblingTemplateSources) {
    const sibSlots = parseAiManagedSlots(sib.source);
    const sibSlot = findSlotForGenerator(sibSlots, generatorId);
    if (sibSlot) {
      return {
        classification: 'safe-capability-gap',
        siblingLabel: sib.label,
        siblingSlot: sibSlot,
        // Where the derived block should be inserted in THIS template: right
        // after this template's own last AI-managed slot, if it has any —
        // matching the exact grouping convention every real example in this
        // codebase already follows (AI-managed sections kept together). If
        // this template has NO existing AI-managed slot at all, there is no
        // local anchor to place it safely by evidence alone — falls through
        // to 'architectural-gap' below instead of guessing a position.
        anchorEnd: ownSlots.length ? ownSlots[ownSlots.length - 1].end : null,
      };
    }
  }

  return { classification: 'architectural-gap' };
}

// Builds the patched template source for a 'safe-capability-gap' result.
// Throws if the gap has no anchor — callers must not invent a position.
export function buildTemplatePatch(templateSource, gapResult, targetBaseVar) {
  if (gapResult.classification !== 'safe-capability-gap') {
    throw new Error(`buildTemplatePatch requires a 'safe-capability-gap' result, got '${gapResult.classification}'`);
  }
  if (gapResult.anchorEnd == null) {
    throw new Error('No local anchor (an existing AI-managed slot in this same template) to safely place the derived block after — refusing to guess a position.');
  }
  const adapted = adaptSlotBlock(gapResult.siblingSlot, targetBaseVar);
  const before = templateSource.slice(0, gapResult.anchorEnd);
  const after = templateSource.slice(gapResult.anchorEnd);
  return `${before}\n\n${adapted}\n${after}`;
}

// Derives a data-array-content adapter config for `generatorId` by cloning
// an existing adapter already configured on the SAME route pattern (e.g. its
// meta-title adapter) — same dataFile/idField/format/nestedField, since
// those describe the DATA FILE'S shape and are identical for every action
// type on one route, and pointing `fields` at the newly-found slot's own
// field name. Never invents dataFile/idField — only ever copies them from a
// real, already-working adapter on the same pattern.
export function deriveAdapterConfig(existingAdapterConfig, { generatorId, valueKey, fieldName }) {
  if (!existingAdapterConfig) {
    throw new Error('deriveAdapterConfig requires an existing adapter on the same route pattern to clone dataFile/idField/format from.');
  }
  const { id, format, dataFile, idField, nestedField } = existingAdapterConfig;
  return { id, format, dataFile, idField, ...(nestedField ? { nestedField } : {}), fields: { [valueKey]: fieldName } };
}

// The value key buildMergeValues (marker-merge.js) returns for each
// generatorId's rendered-HTML-single-field action types — the SAME key
// deriveAdapterConfig's `fields` mapping must use on its left-hand side.
// Deliberately a closed, explicit list mirroring marker-merge.js's real
// switch, not a guessed transform of generatorId — 'internal-links' really
// does return `links`, not `internalLinks`.
export const GENERATOR_VALUE_KEYS = {
  'expand-content': 'expandedContent',
  'qa-content': 'qaContent',
  'internal-links': 'links',
};
