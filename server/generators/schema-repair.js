import { analyzePageUrl } from '../agents/lib/page-content.js';
import { callLLMForJson } from '../llm.js';
import { findSchemaIssues } from './lib/schema-structure-guard.js';

// Handles BOTH 'Invalid structured data' (a real <script type=
// "application/ld+json"> block on the page failed to parse) and 'Duplicate
// schema' (two+ real blocks share the same @type) — page-content.js already
// detects both (malformedSchemaBlocks/duplicateSchemaTypes) but previously
// mapped both to a null generator, since neither fits schema.js's own job
// (drafting NEW schema for a page that has none). This generator repairs/
// dedupes what's already there instead. Auto-fixable now because the actual
// file patch (implementers/lib/schema-repair-inject.js) only ever applies
// when the exact broken/duplicate block text is still found byte-for-byte
// in the site's real source — never a guess against a template that may
// have changed since detection (same discipline duplicate-id-fix.js's one
// safe auto-fix shape already follows).
export const meta = {
  id: 'schema-repair',
  name: 'Structured Data Repair',
  description: 'Repairs a malformed JSON-LD block, or removes a duplicate one, using only the real values already on the page — never invents new facts.',
  recommendationTags: [],
};

const SYSTEM = 'You are a structured-data specialist. The JSON-LD block given below failed to parse as valid JSON — ' +
  'fix ONLY its syntax (unescaped quotes, trailing commas, missing braces/brackets, etc.) so it parses, while ' +
  'preserving every real value it already contains exactly as-is. Never add, remove, or change any actual field ' +
  'value — if a value looks incomplete or ambiguous even after fixing syntax, keep it as close to the original ' +
  'literal text as possible rather than guessing what it "should" say. Respond with ONLY the corrected JSON-LD object.';

// params: { page: string }
export async function generate({ siteId, params }) {
  const { page } = params || {};
  if (!page) throw Object.assign(new Error('page is required'), { status: 400 });

  const fetched = await analyzePageUrl(page);
  if (!fetched.ok) throw Object.assign(new Error(`Could not fetch page: ${fetched.error}`), { status: 400 });
  const { malformedSchemaBlocks, duplicateSchemaTypes, schemaScriptBlocks } = fetched.analysis;

  // Malformed takes priority when a page somehow has both — it's the more
  // clearly broken state (a script tag that doesn't even parse) versus
  // duplicate (both blocks are individually valid, just redundant).
  if (malformedSchemaBlocks?.length) {
    const originalRaw = malformedSchemaBlocks[0];
    // The same emptiness guard the duplicate branch below already has, and
    // the second half of the fabrication fix (page-content.js is the first).
    // Defense in depth on purpose: an empty `originalRaw` is not merely
    // unusable as an exact-match anchor, it is a prompt with NOTHING to
    // repair — and the model answered that by inventing schema outright
    // ("John Doe", johndoe@example.com, "123 Main St, Anytown", two
    // different fabrications across drafts 242 and 279). findSchemaIssues
    // cannot catch it: invented schema is structurally valid. Refuse before
    // the model is ever called, rather than paying for a fabrication and
    // discovering it only when the empty anchor fails to apply.
    if (!originalRaw?.trim()) {
      throw Object.assign(
        new Error(`The malformed JSON-LD block on ${page} is empty — there is nothing to repair, and generating one would mean inventing it. Remove the empty <script type="application/ld+json"> tag instead.`),
        { status: 400, userFacing: true },
      );
    }
    let jsonLd;
    try {
      jsonLd = await callLLMForJson(SYSTEM, originalRaw, { maxTokens: 700, generatorId: meta.id, siteId });
    } catch {
      throw Object.assign(new Error('Schema repair failed: model did not return valid JSON'), { status: 400 });
    }
    const issues = findSchemaIssues({ jsonLd });
    if (issues.length) {
      throw Object.assign(
        new Error(`Repaired schema still fails structural validation (${issues.map((i) => i.patternId).join(', ')}) — refusing to ship a still-broken fix.`),
        { status: 502, userFacing: true },
      );
    }
    return {
      content: { page, fixType: 'repair-malformed', originalRaw, jsonLd },
      summary: `Repaired malformed JSON-LD (${jsonLd['@type'] || 'unknown type'}) on ${page}`,
    };
  }

  if (duplicateSchemaTypes?.length) {
    const duplicateType = duplicateSchemaTypes[0];
    // First real <script> tag carrying this type is kept (usually the
    // "original," same convention duplicate-id-fix.js's buildFixPlan
    // already uses); every later one is a removal candidate. Only the
    // first later occurrence is drafted per run — same "one bounded,
    // reviewable change at a time" shape as every other generator here.
    const carriers = (schemaScriptBlocks || []).filter((b) => b.types.includes(duplicateType));
    const originalRaw = carriers[1]?.raw;
    if (!originalRaw) {
      throw Object.assign(new Error(`Could not isolate a removable duplicate "${duplicateType}" block on ${page} — it may have changed since detection.`), { status: 400, userFacing: true });
    }
    return {
      content: { page, fixType: 'remove-duplicate', duplicateType, originalRaw },
      summary: `Remove duplicate "${duplicateType}" JSON-LD block on ${page}`,
    };
  }

  throw Object.assign(new Error('No malformed or duplicate structured data was found on this page.'), { status: 400, userFacing: true });
}
