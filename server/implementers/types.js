// Documentation-only contract for Action Center Implementers — no runtime
// code. Mirrors server/generators/types.js's contract shape deliberately.
//
// An implementer takes an APPROVED draft and turns it into a real GitHub
// pull request against the site's own repo — the step generators never do
// (generators only ever produce draft content, see generators/types.js).
// Work is split by domain, not one monolithic "apply" function: each module
// in this directory declares which generator ids it `handles`, mirroring how
// a human dev team would split frontend vs. backend work, with the actual
// commit/PR mechanics shared via lib/github-ops.js so neither implementer
// re-implements GitHub plumbing.

/**
 * @typedef {Object} ImplementerMeta
 * @property {string} id            stable kebab-case slug, e.g. "backend"
 * @property {string} name          display name
 * @property {string} description   one sentence
 * @property {string[]} handles     generator ids (drafts.action_type values) this implementer applies
 */

/**
 * @typedef {Object} ApplyResult
 * @property {boolean} ok
 * @property {string} [branchName]  set when ok:true
 * @property {string} [prUrl]       set when ok:true
 * @property {number} [prNumber]    set when ok:true
 * @property {string} [reason]      set when ok:false — a stable machine-readable code,
 *                                    e.g. "no-file-mapping" | "merge-strategy-not-implemented" | "github-error"
 * @property {string} [error]       set when ok:false — a human-readable explanation
 */

/**
 * Every file in server/implementers/ (other than types.js, registry.js, and
 * the lib/ helpers) must export exactly:
 *
 *   export const meta = { ... };                      // ImplementerMeta
 *   export async function apply(site, draft) { ... }   // (site row, drafts row) => Promise<ApplyResult>
 *
 * apply() must NEVER throw for a foreseeable failure (no file mapping, an
 * unimplemented merge strategy, a GitHub API error) — it returns an honest
 * {ok:false, reason, error} instead, the same never-fabricate discipline
 * server/agents/ai-visibility.js and content-gap.js use for
 * status:'insufficient-data'. apply() must NEVER merge a pull request —
 * merging is always a human, on GitHub itself.
 */

/**
 * Render mode: HOW an approved draft's content actually lands on a page —
 * 'visible' (render the content's visible representation, plus any
 * structured data alongside it) or 'schema-only' (structured data only,
 * skipping the visible fragment — for a content type that already has a
 * hand-built, differently-styled visible presentation on the page, e.g. a
 * bespoke FAQ accordion, so nothing gets duplicated). Only valid for content
 * types with an actual separate schema fragment (lib/marker-merge.js's
 * buildMergeValues) — requesting it for one that doesn't is an honest error.
 *
 * This is NOT static config and has no config surface at all — see
 * lib/render-inspector.js's inspectRenderMode(fileContent, actionType),
 * called fresh by backend.js's computeMarkerMerge on every apply/preview.
 * Deterministic-first, LLM only as a fallback:
 *   1. Cheap regex/structural evidence collectors run first (existing
 *      SEOAI marker, existing FAQPage JSON-LD, visible-FAQ signal strength —
 *      heading text, accordion/component keywords, a templating loop
 *      rendering question/answer fields). A 'strong' or 'none' signal
 *      decides the mode immediately — no LLM call at all.
 *   2. Only a 'weak'/ambiguous signal escalates to an LLM call, and even
 *      then the model reports FACTS (hasVisibleFaqSection, evidenceQuotes,
 *      hasSafeInsertionPoint) — never a mode directly. This module (not the
 *      model) turns that evidence into the same mode decision the
 *      deterministic path would have made, just with lower confidence.
 *   3. Every result carries { mode, confidence, reason, source }. Below
 *      CONFIDENCE_THRESHOLD (70) — including any parse/call failure, treated
 *      as confidence 0 — `mode` is null and the caller must stop rather than
 *      guess: routes/action-center.js returns 422 `render-mode-uncertain`
 *      with the confidence/reason/suggestedMode, and the one way a human's
 *      choice re-enters the flow is an explicit `renderMode` in the next
 *      approve/push-branch request body (`apply(site, draft, {
 *      renderModeOverride })`) — a per-call override, never persisted as
 *      site config, so the page is re-inspected fresh again next time.
 *
 * Adapter routing is a SEPARATE, unrelated decision — see below — because
 * "which framework-specific code should own this write" isn't something to
 * infer from page content the way visible-vs-schema-only is.
 */

/**
 * Adapter routing: WHICH implementer actually handles a (site, page, action
 * type) — the default backend/frontend implementer, or a named adapter
 * (server/implementers/adapters/<id>.js, see adapters/registry.js) that
 * bypasses it entirely. This — unlike render mode above — stays static,
 * explicit config, because there's no page-content evidence that tells you
 * which adapter to use; it's an integration decision, not a content-
 * placement judgment call.
 *
 * Config shape: `url_file_map.pages[url].adapters = { [actionType]: 'adapter-id' }`
 * (see lib/url-file-map.js's resolveAdapter). No config → no adapter,
 * default implementer routing, exactly as if this key didn't exist.
 *
 * An adapter is a full implementer replacement scoped to one (site, page,
 * action type), not globally per action type. It owns entirely how and
 * where it writes the change — updating an existing React component, an
 * Eleventy data file, a Nunjucks include, a Markdown file, a CMS API call,
 * or any other target; it is NOT assumed to be "a UI component." An adapter
 * must export the same { apply(site, draft), mergeToStage(site, draft) }
 * contract as any other implementer.
 *
 * server/implementers/resolve.js is the single place that turns a draft +
 * its resolved adapter config into "which implementer/adapter actually
 * runs," used by every caller (routes/action-center.js's push-branch,
 * merge-to-stage, approve-and-publish, and preview) so they never diverge.
 */

/**
 * Placement: WHERE an approved draft's content lands on a page, decoupled
 * from both WHAT the generator produced and HOW it renders (render strategy,
 * above). Resolved by lib/url-file-map.js's resolvePlacement(site, pageUrl,
 * actionType) -> { slot, markers }.
 *
 * Config shape, generic across every action type:
 *
 *   url_file_map.pages[url].placements = {
 *     [actionType]: { slot?: string, markers: { [field]: markerName } }
 *   }
 *   url_file_map.defaults.placements = { [actionType]: { same shape } }  // site-wide, inherited
 *
 * - `slot` is a logical, framework-agnostic location — the recommended
 *   vocabulary (lib/url-file-map.js's STANDARD_SLOTS) is `metadata`, `head`,
 *   `hero`, `page-top`, `content`, `related-content`, `faq`, `before-footer`,
 *   `page-end`, `site-root` — but it is never validated against; any string
 *   is a valid custom slot. Omitted, it falls back to that action type's
 *   platform default (e.g. `faq` -> `faq`, `internal-links` -> `related-content`).
 *   It exists for adapters and future tooling (a preview badge, a config
 *   linter) to reason about *where* something conceptually belongs — the
 *   marker-splice mechanism itself only needs `markers`.
 * - `markers` is a raw `{field: markerName}` object the config author writes
 *   directly (field names observed via Draft Preview — e.g. `faq`, or
 *   `title`/`metaDescription` for meta-title). This module has zero
 *   knowledge of which fields a given action type actually produces; that
 *   stays entirely in lib/marker-merge.js, which already filters marker
 *   entries against whatever fields are present in a draft's built values.
 * - Resolution order (highest priority first): page-level `placements
 *   [actionType]` -> site-level `defaults.placements[actionType]` -> legacy
 *   flat `pages[url].markers` (the pre-placement config shape, read
 *   unmodified) -> nothing configured. A site that has only ever used the
 *   legacy flat `markers` shape needs no migration — it keeps working
 *   exactly as before.
 * - A content type with no page-based placement concept at all (blog-outline/
 *   landing-page/translation create NEW files via resolveNewContentTarget/
 *   resolveTranslationTarget, never a marker splice) simply resolves to
 *   `{slot: null, markers: null}` — a normal, expected outcome, not an error.
 * - Deliberately NOT included yet (no real use case in this codebase today,
 *   and neither needs a config-shape migration to add later): per-fragment
 *   placement (splitting one action type's multiple representations across
 *   different slots/markers), and any priority/ordering scheme for two
 *   content types targeting the same slot.
 */
export {};
