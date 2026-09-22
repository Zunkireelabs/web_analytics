import { getFileContent, defaultBranchName } from '../../github/client.js';
import { resolveFile } from '../../implementers/lib/url-file-map.js';
import { detectInsertionPoint } from '../../implementers/lib/structural-detect.js';

// Real production incident, confirmed 2026-09-22 (Admizz Education, site
// 8862): 116 abandoned expand-content drafts, none matching any existing
// attempt-classification.js RULE, all sharing one real structural cause —
// these pages (country/city landing pages built on CountryPageTemplate /
// NepalVariantTemplate) are entirely data-object-driven: page.tsx builds one
// local `const nepalData = {...}` and returns a single self-closing
// `<CountryPageTemplate data={nepalData} .../>` with no free-form JSX body
// region at all. structural-detect.js's detectInsertionPoint already knows
// this correctly ('self-closing-root-no-body' / 'no-jsx-return-found') —
// but only implementers/lib finds out AFTER a full LLM generation has
// already run and a draft has already been created and abandoned. Every one
// of those 116 abandons paid a real LLM call for content that could never
// be inserted.
//
// This is the SAME check, run once at generation time instead of apply
// time: real cost is saved (no LLM call for a page this can never write
// to), and the caller gets an honest, immediate, specific refusal instead
// of a draft that silently fails hours or days later. A page-data-object-
// shaped page genuinely has no free-prose region — expand-content cannot
// apply there without a template change (a design/product decision, not a
// content-generation one, and out of scope for this generator to make
// unilaterally per CLAUDE.md's design-preservation rule).
//
// Return contract, same shape as generators/lib/faq-data-source.js's
// findRealFaqDataSource (an established convention in this codebase):
//   { ok: true }                       — safe to proceed, structurally compatible
//   { ok: false, reason, detail }      — genuinely incompatible, refuse with this message
//   null                                — couldn't check (no repo, no mapping, fetch failed) —
//                                          a capability gap, not evidence either way; caller
//                                          proceeds unchanged rather than blocking on an
//                                          inability to verify
export async function checkExpandContentStructuralFit(site, pageUrl) {
  if (!site?.repo_owner || !site?.repo_name) return null;
  const filePath = resolveFile(site, pageUrl);
  if (!filePath) return null;

  const file = await getFileContent(site, filePath, defaultBranchName(site)).catch(() => null);
  if (!file) return null;

  const result = detectInsertionPoint(file.content, filePath);
  if (result.ok) return { ok: true };

  if (result.reason !== 'self-closing-root-no-body' && result.reason !== 'no-jsx-return-found') {
    // A different structural problem (e.g. genuinely unsupported file type)
    // — not this check's concern; let the existing apply-time path surface
    // it as it always has, rather than this generator guessing at a reason
    // it isn't specifically about.
    return { ok: true };
  }

  return {
    ok: false,
    reason: result.reason,
    detail: `${filePath} has no free-form body region to expand — its content is entirely defined by a data object ` +
      `passed to a shared template component (${result.error}). Expanding this page's content would require adding ` +
      `a new field to that template, which is a design/template change, not a content edit — expand-content cannot ` +
      `safely apply here until that ships.`,
  };
}
