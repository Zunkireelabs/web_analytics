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
 * Render capability: whether a given file target actually gets a Markdown
 * pass run on it by the site's own static-site generator BEFORE this app
 * commits a fresh Markdown-with-front-matter body to it (see
 * lib/newpage-render.js) — checked by lib/rendering-gate.js, the generic
 * pre-PR Rendering Validation Gate wired into lib/github-ops.js's
 * pushDraftBranch (the one choke point every implementer's apply() shares,
 * so this fires for landing pages, blog posts, direct-answer pages,
 * translations, legal/compliance pages, and any future generator that
 * reuses newpage-render.js's shape — never anything page-specific).
 *
 * This app never runs the target repo's own build (each client site is a
 * separate repo with its own Eleventy/Hugo/Astro/etc. pipeline — see the
 * action-center-onboarding skill), so whether a `.njk`/`.html` file actually
 * gets Markdown-processed can't be inferred from the extension string alone
 * — it depends on that specific repo's own template-engine config. This is
 * therefore explicit, human-recorded metadata, not a guess:
 *
 *   url_file_map.renderCapabilities = {
 *     generator: 'eleventy',            // free-text, informational only — any static-site generator/framework
 *     extensions: {
 *       '.md':      { markdown: true },
 *       '.11ty.md': { markdown: true },
 *       '.njk':     { markdown: false }, // Nunjucks alone does not run a Markdown pass
 *       '.html':    { markdown: false },
 *     },
 *     overrides: {                      // per action_type, takes priority over the extensions table
 *       'landing-page': { markdown: true }, // e.g. this target's specific file is known to carry templateEngineOverride: "njk,md"
 *     },
 *   }
 *
 * Recorded once per site via `npm run connect-repo` (server/scripts/connect-repo.js),
 * the same file/step that already records pages/patterns/newContentTargets/
 * siteRoot. `npm run audit-url-file-map` reports any newContentTargets entry
 * with no matching (or unsafe) renderCapabilities entry as a config gap,
 * surfaced the same way as every other onboarding gap (Integration Health —
 * server/integrations/github.js).
 *
 * Fails closed: no recorded renderCapabilities at all, or no entry matching
 * a specific target, is treated exactly like an explicit `markdown: false`
 * — lib/rendering-gate.js will never let a real PR be opened for a file it
 * can't positively vouch for. This is Phase 1 (config-level proof, checked
 * synchronously before a single byte is committed) of a two-layer design.
 *
 * Phase 2 — an actual client-repo build, verifying the real rendered HTML
 * output rather than just config — is also implemented, as
 * `checkClientBuildStatus` in the same module. It runs in GitHub Actions,
 * IN THE CLIENT REPO, never on this app's own infrastructure (see the
 * action-center-onboarding skill's "Build location" decision — running
 * `npm install`/build from an arbitrary client repo is real remote-code-
 * execution risk this app deliberately never takes on itself). Installed
 * once per site via `node server/scripts/install-rendering-workflow.js`,
 * which opens a PR adding `.github/workflows/rendering-validation.yml` +
 * `scripts/check-rendered-output.mjs` (templates at
 * implementers/lib/rendering-validation-templates/) to the CLIENT repo.
 * That workflow builds the site and runs the checker script against the
 * real output directory, reporting back as a GitHub Check Run named
 * exactly `rendering-gate.js`'s `CLIENT_BUILD_CHECK_NAME`
 * ("rendering-validation"). `checkClientBuildStatus(site, ref)` reads that
 * check back via the GitHub API — same `{ok, reason, error}` contract as
 * Phase 1, so a caller can treat both uniformly.
 *
 * Optional `renderCapabilities.build` config feeds the generated workflow:
 *
 *   url_file_map.renderCapabilities.build = {
 *     installCommand: "npm ci",
 *     buildCommand: "npm run build",
 *     outputDir: "_site",
 *   }
 *
 * Phase 2 is intentionally NOT in lib/rendering-gate.js's synchronous
 * `CHECKS` array (see that array's own comment) — it needs a real build of
 * a real committed ref, which can only exist once a branch/PR is already
 * out there, so it can't block the initial commit the way Phase 1 does.
 * Its result becomes available to check (e.g. before staff marks a draft
 * "approved/published," or as a merge-readiness badge) only after the PR
 * exists and the workflow has run.
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
 *   url_file_map.patterns[].placements = { [actionType]: { same shape } }  // matches every URL that pattern resolves (e.g. one entry covers every /blog/:slug post)
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
 *   [actionType]` -> pattern-level `patterns[].placements[actionType]`
 *   (matches whichever pattern resolveFile would also match — a real
 *   shared marker convention, not a per-post config chore; marker NAMES
 *   are fixed strings here, not $1-substituted like resolveFile's file
 *   paths) -> site-level `defaults.placements[actionType]` -> legacy flat
 *   `pages[url].markers` (the pre-placement config shape, read unmodified)
 *   -> nothing configured. A site that has only ever used the legacy flat
 *   `markers` shape needs no migration — it keeps working exactly as before.
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

/**
 * Sitemap regeneration: NOT this platform's job by default, for any tenant.
 * A real static-site build (Eleventy, Next.js, Hugo, Gatsby, ...) already
 * regenerates its own sitemap from its own page collection on every build,
 * and `stage` already auto-deploys (rebuilds) on every merge (company-wide
 * CI/CD convention, not app-specific — see
 * ~/Travel/ci-cd-deployment-master-guide). So once a draft's merge lands,
 * the target repo's own build produces an up-to-date sitemap without this
 * app doing anything extra. If a tenant's build pipeline auto-regenerates
 * its sitemap, that principle still holds fully — nothing here should ever
 * touch that tenant's sitemap file.
 *
 * The one explicit, opt-in exception: a tenant whose build does NOT
 * regenerate its own sitemap (e.g. a hand-maintained static sitemap.xml with
 * no build-time page-collection step) can opt in by setting
 * `url_file_map.siteRoot.sitemap` to that file's real repo path (same
 * onboarding step as `nginxConfig`/`llmsTxt`/`htmlLang` above — never
 * guessed; absence is an honest "not enabled for this site" outcome, see
 * server/agents/sitemap.js and server/generators/sitemap.js). Even then the
 * scope is narrow and additive-only: the sitemap agent/generator only ADDS
 * URLs already discovered via the existing crawl/GSC/page_inventory pipeline
 * that are missing from the live sitemap; it never removes an entry, even
 * an orphaned one (surfaced as a note for manual review instead — v1 has no
 * reliable enough signal to conclude an orphaned URL should be deleted). Like
 * every other generator, this goes through the normal
 * draft -> branch -> PR -> human-merge flow (this file's own apply()
 * contract above) — nothing here ever writes directly to a tenant's repo or
 * auto-merges anything.
 */
export {};
