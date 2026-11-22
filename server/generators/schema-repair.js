import { analyzePageUrl } from '../agents/lib/page-content.js';
import { safeMessage } from '../lib/errors.js';
import { callLLMForJson } from '../llm.js';
import { findSchemaIssues } from './lib/schema-structure-guard.js';
import { llmFailure } from './lib/llm-error.js';
import { getSiteById } from '../store/read.js';
import { resolveFile } from '../implementers/lib/url-file-map.js';
import { getFileContent } from '../github/client.js';
import { baseBranch } from '../implementers/lib/github-ops.js';
import { countOccurrences } from '../implementers/lib/exact-match-patch.js';

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

// The patch step (implementers/lib/schema-repair-inject.js) only applies when
// `originalRaw` — the block's text as the LIVE, RENDERED page shows it — is
// found exactly once, verbatim, in the site's SOURCE file. For a templated
// site (Nunjucks/Liquid/PHP) the source holds `{{ ... }}` / `{% for %}` where
// the page shows values, so the text is simply not there; the draft was
// generated, paid for, approved, and then failed at apply with "anchor(s) no
// longer found verbatim" — six times on 2026-11-18 for one page, each logged
// as the generator's own logic error. Checking the same condition BEFORE the
// model is called turns that into an honest, free refusal.
//
// Best effort by design: if the site or source cannot be read here, the
// check is skipped and the apply step stays the authority, exactly as before.
// Exported for tests; `deps` lets them avoid the DB and GitHub.
export async function classifyAnchor(siteId, page, originalRaw, deps = {}) {
  const { fetchSite = getSiteById, resolve = resolveFile, fetchFile = getFileContent, branchOf = baseBranch } = deps;
  let site; let filePath; let file;
  try {
    site = await fetchSite(siteId);
    filePath = site ? resolve(site, page) : null;
    file = filePath ? await fetchFile(site, filePath, branchOf(site)) : null;
  } catch {
    return { status: 'unknown' }; // cannot check — leave the decision to the apply step
  }
  if (!file || typeof file.content !== 'string') return { status: 'unknown' };
  const count = countOccurrences(file.content, originalRaw);
  if (count === 1) return { status: 'patchable', count, filePath };
  return { status: count === 0 ? 'not-in-source' : 'ambiguous', count, filePath };
}

export async function assertAnchorPatchable(siteId, page, originalRaw, deps = {}) {
  const found = await classifyAnchor(siteId, page, originalRaw, deps);
  if (found.status === 'patchable' || found.status === 'unknown') return;
  const { count, filePath } = found;
  const why = count === 0
    ? `the block as rendered on ${page} is not found verbatim in ${filePath} (it comes from a shared template or layout, or the source changed since detection)`
    : `the block appears ${count} times in ${filePath}, so the one to change cannot be told apart`;
  // `unsupported`: this generator CANNOT make this fix at page level, which is a statement about the page's structure, not a
  // transient failure. verifyCurrentState (below) catches it before generation so it is parked once with its reason.
  throw Object.assign(
    new Error(`Cannot patch the structured data on ${page} automatically: ${why}. Edit ${filePath} by hand.`),
    { status: 400, userFacing: true, refusal: true, unsupported: true, reason: 'source-anchor-not-found' },
  );
}

// Re-checks, against the LIVE page and the real source, whether this recommendation can still be acted on. Never throws and never
// guesses: anything it cannot establish returns still_valid with the reason, exactly as a generator with no verifier would.
//   nothing malformed or duplicated is left      -> already_resolved (closed only with this evidence)
//   the block does not exist in this page's file -> needs_human: it comes from a shared layout, so no page-level patch can fix it
//   anything else                                -> still_valid
export async function verifyCurrentState(rec, ctx = {}) {
  const page = rec?.params?.page || rec?.page;
  if (!page) return { decision: 'still_valid', reason: 'no-page', evidence: null };
  const analyze = ctx.analyze || analyzePageUrl;
  let fetched;
  try { fetched = await analyze(page); } catch (err) { const { id } = safeMessage('schema-repair.verifyCurrentState', err, 'live check failed'); return { decision: 'still_valid', reason: 'live-check-failed', evidence: { error: `live check failed (ref: ${id})` } }; }
  if (!fetched?.ok) return { decision: 'still_valid', reason: 'live-check-failed', evidence: { error: String(fetched?.error || 'unreachable').slice(0, 120) } };

  const { malformedSchemaBlocks, duplicateSchemaTypes, schemaScriptBlocks } = fetched.analysis;
  const malformed = (malformedSchemaBlocks || []).length;
  const dupes = duplicateSchemaTypes || [];
  // A page that shows NO structured data at all is not evidence the duplicate was fixed: it is just as likely a bot-challenge page,
  // an error page or a different rendering. Only a page that still carries real JSON-LD, none of it broken or duplicated, closes it.
  if (!malformed && !dupes.length && !(schemaScriptBlocks || []).length) {
    return { decision: 'still_valid', reason: 'no-structured-data-seen', evidence: { page } };
  }
  if (!malformed && !dupes.length) {
    return { decision: 'already_resolved', reason: 'no-malformed-or-duplicate-schema-on-live-page', evidence: { page, checkedAt: new Date().toISOString(), blocks: (schemaScriptBlocks || []).length } };
  }
  const originalRaw = malformed ? malformedSchemaBlocks[0] : (schemaScriptBlocks || []).filter((b) => b.types.includes(dupes[0]))[1]?.raw;
  if (!originalRaw) return { decision: 'still_valid', reason: 'block-not-isolated', evidence: { page } };
  const anchor = await classifyAnchor(ctx.site?.id ?? rec.site_id, page, originalRaw, ctx.anchorDeps);
  if (anchor.status === 'not-in-source') {
    return {
      decision: 'needs_human', reason: 'shared-layout-schema',
      evidence: { page, duplicateTypes: dupes, malformed, sourceFile: anchor.filePath, message: `The ${dupes[0] || 'structured data'} block on this page is generated by a shared template or layout (it is not in ${anchor.filePath}), so a page-level fix cannot change it. It needs one change in the shared layout, which then fixes every page.` },
    };
  }
  return { decision: 'still_valid', reason: anchor.status === 'patchable' ? 'confirmed-on-live-page-and-patchable' : 'confirmed-on-live-page', evidence: { page, anchor: anchor.status } };
}

// params: { page: string }
export async function generate({ siteId, params }) {
  const { page } = params || {};
  if (!page) throw Object.assign(new Error('page is required'), { status: 400 });

  const fetched = await analyzePageUrl(page);
  if (!fetched.ok) throw Object.assign(new Error(`Could not fetch page: ${fetched.error}`), { status: 400, userFacing: true, refusal: true, temporary: true, reason: 'page-unreachable' });
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
        { status: 400, userFacing: true, refusal: true, reason: 'empty-schema-block' },
      );
    }
    await assertAnchorPatchable(siteId, page, originalRaw);
    let jsonLd;
    try {
      jsonLd = await callLLMForJson(SYSTEM, originalRaw, { task: 'content', maxTokens: 700, generatorId: meta.id, siteId });
    } catch (err) {
      throw llmFailure(err, 'Schema repair failed: model did not return valid JSON', { status: 400 });
    }
    const issues = findSchemaIssues({ jsonLd });
    if (issues.length) {
      throw Object.assign(
        new Error(`Repaired schema still fails structural validation (${issues.map((i) => i.patternId).join(', ')}) — refusing to ship a still-broken fix.`),
        { status: 502, userFacing: true, refusal: true, reason: 'repair-still-invalid' },
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
      throw Object.assign(new Error(`Could not isolate a removable duplicate "${duplicateType}" block on ${page} — it may have changed since detection.`), { status: 400, userFacing: true, refusal: true, reason: 'block-not-isolated' });
    }
    await assertAnchorPatchable(siteId, page, originalRaw);
    return {
      content: { page, fixType: 'remove-duplicate', duplicateType, originalRaw },
      summary: `Remove duplicate "${duplicateType}" JSON-LD block on ${page}`,
    };
  }

  // The live page was just re-read and nothing is left to repair: that is evidence the issue is gone, not a generator failure. But a
  // page with no JSON-LD at all proves nothing (a challenge or error page looks like that), so that case stays open.
  const resolved = (schemaScriptBlocks || []).length > 0;
  throw Object.assign(new Error('No malformed or duplicate structured data was found on this page.'), { status: 400, userFacing: true, refusal: true, reason: resolved ? 'nothing-left-to-fix' : 'no-structured-data-seen', ...(resolved ? { stale: true, alreadyResolved: true } : { temporary: true }) });
}
