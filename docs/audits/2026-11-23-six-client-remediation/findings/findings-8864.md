# Site 8864 (Chayce Properties) remediation plan (PLAN ONLY, nothing implemented)

Basis: audit-8864.txt, maps/map-8864.json (production), repo snapshot repos/web-chayce-properties (no .git; last commit 2026-11-19 per the brief; may be stale vs GitHub, needs-verification against the live repo before any PR). Engine read: url-file-map.js, structural-detect.js, marker-setup.js, insertion-engine.js, adapters/data-array-content.js, audit script. Live probes: GET-only curl on chayceproperties.com. I also ran `detectInsertionPoint` (pure function, dummy DATABASE_URL, no connection) on the 5 fatal files plus 3 controls.

## 0. Headline findings

1. The 58 "NO FILE MAPPING" lines are **11 unique URLs** x action types: 8 city pages x 5 types (faq, schema, internal-links, expand-content, qa-content) + 3 blog posts x 6 types (meta-title + those 5). 8 x 5 + 3 x 6 = 58. All 11 are live HTTP 200. **None of the 58 are redirects, 404s or 410s**; the audit already skipped those 38 (31 are 410, 7 are 301/308).
2. The 8 city pages are NOT unmapped by omission. They match an existing pattern in the map (`^/elderly-removals-(...)/?$`) that has only `adapters["meta-title"]` and **no `file`**. So meta-title resolves (the "8 adapter-routed"), and the other 5 types find no file. Adding a `file` to that pattern would be wrong (section 1A).
3. The 25 fatal gaps = **5 unique files** (all `layout: v2-page.njk`, front-matter-only, zero body). Previous claim "no safe insertion point" is correct for the *automated engine*, and I reproduced it. But a safe manual insertion point exists (section 2).
4. Two traps found: (a) mapping `local-area.njk` as a `file` makes the detector pick the lone `<article class="v2-story">` card as the "content container", i.e. a marker inside a client-story card; (b) blog/v2 pages already render FAQ + FAQPage JSON-LD from front matter (`faq:` / `faqs:`), so faq/schema markers risk duplicate visible FAQ and duplicate FAQPage schema.

## 1. The 58 unmapped actions: 11 unique URLs

All status values are live curl results from 2026-11-23.

### 1A. Live city pages (8 URLs, 200): rendered by one shared template

| URL | Status | Rendered by (evidence) |
|---|---|---|
| /elderly-removals-corby/ | 200 | src/areas/local-area.njk + src/_data/localAreas.json entry `slug: corby` |
| /elderly-removals-daventry/ | 200 | same, `daventry` |
| /elderly-removals-kettering/ | 200 | same, `kettering` |
| /elderly-removals-leicester/ | 200 | same, `leicester` |
| /elderly-removals-market-harborough/ | 200 | same, `market-harborough` |
| /elderly-removals-milton-keynes/ | 200 | same, `milton-keynes` |
| /elderly-removals-rushden/ | 200 | same, `rushden` |
| /elderly-removals-wellingborough/ | 200 | same, `wellingborough` |

Evidence: `local-area.njk` front matter: `pagination: data: localAreas, size: 1, alias: area`, `permalink: "/elderly-removals-{{ area.slug }}/"`, 16.5 KB body, layout inherited from `src/areas/areas.json` (base.njk). 20 slugs exist in localAreas.json (14 with `localFaqs`, 6 without, incl. leicester). One template file drives all 20 URLs.

Current map entry (production): `patterns[0]` = `{match:"^/elderly-removals-(kettering|...|banbury)/?$", adapters:{"meta-title":{id:"data-array-content", format:"json-array", dataFile:"src/_data/localAreas.json", idField:"slug", idPrefix:"elderly-removals-", fields:{title:"seoTitle"}}}}`. This is why meta-title is fine and the rest "has no file".

**Recommendation per action type (do NOT add a `file` to this pattern):**

- `file: "src/areas/local-area.njk"` on the pattern is the obvious fix and is unsafe, for three reasons:
  1. `isSharedTemplateFile()` (url-file-map.js:172) returns true for a pattern file without `$n`; page-specific writes are refused by design (a static edit would show on all 20 cities).
  2. I ran the detector on this file: it returns `ok:true, fileKind:"html", containerDescription:"article"`, offset 5254, which is the closing tag of the single `<article class="v2-story">` card (client-story card at ~line 5025-5254). A marker there lands **inside a client story card**. The `article` selector is only rejected when more than one `<article>` exists or the ancestor is carousel-like; neither applies.
  3. Placing blocks there would break the page design (CLAUDE.md design preservation).
- **schema (8 URLs): do not map.** The template already emits FAQPage JSON-LD from `area.localFaqs` / `area.faqTitle` (local-area.njk lines ~186-189) plus other JSON-LD. A marker block would duplicate it. Leaving "no mapping" is the correct, honest outcome.
- **faq (8 URLs): optional, needs a template change first (manual, separate ticket).** The existing data-array adapter can write `localAreas.json`, but it writes `{question, answer, _aiManaged}` objects into an `itemsField` (js-data-splice.js:531, 601), while the template reads `f.q` / `f.a` from `localFaqs`. Writing into `localFaqs` would mix key shapes and render blank questions. Safe route:
  - Template (manual, human review), in the visible FAQ loop near local-area.njk:109-114 add a second loop over a NEW field, e.g. `{% for f in area.aiFaqs %}<details><summary>{{ f.question }}</summary><p>{{ f.answer }}</p></details>{% endfor %}`, and the same items to the FAQPage JSON-LD at ~186-189. The loop text must match `for <x> in area.aiFaqs` (faq-render-mode.js `templateRendersItemsField` checks this).
  - Then add to the same pattern: `"adapters":{"meta-title":{...unchanged...},"faq":{"id":"data-array-content","format":"json-array","dataFile":"src/_data/localAreas.json","idField":"slug","idPrefix":"elderly-removals-","itemsField":"aiFaqs"}}`.
  - Until the template change merges: needs-verification, do not add the adapter (a config with no rendering loop is blocked by the render check anyway).
- **internal-links, expand-content, qa-content (8 URLs each): do not map.** The template has no free-content slot and no data field for them; any file mapping is either the shared template (refused) or the story-card trap. Honest outcome stays "unmapped". If these types are wanted on city pages, that is a design ticket (new `area.extraContent` data field + a styled `v2-sec` block in the template, then a `data-array-content` `fields`/`itemsField` config); not automated-safe.

Net effect for 1A: **no map change is recommended today.** The map is already correct for meta-title; the other 40 actions should stay un-mappable until a template change exists.

### 1B. Live blog posts (3 URLs, 200): safe to map; one pattern preferred

| URL | Status | Repo file (exists) |
|---|---|---|
| /blog/later-life-relocation-uk-practical-guide/ | 200 | src/blog/later-life-relocation-uk-practical-guide.md |
| /blog/dbs-checked-removals-uk-what-to-ask/ | 200 | src/blog/dbs-checked-removals-uk-what-to-ask.md |
| /blog/removals-company-for-older-people-near-me-what-to-look-for/ | 200 | src/blog/removals-company-for-older-people-near-me-what-to-look-for.md |

Evidence: `src/blog/blog.json` gives every post `layout: blog-post.njk`, `permalink: "/blog/{{ page.fileSlug }}/"`; the 3 md files have no `permalink` override, so URL slug = filename. Each ends with plain Markdown (`**Related:** ...`), no raw HTML/scripts (0 `<script|<div|<section`). The map has no `/blog/` pattern; the 3 are missing because they were renamed after the map entries were made (the map still holds the old slugs, see 1C).

Proposed addition (production map, schema = `patterns[]` entry; exact JSON):

```json
{ "match": "^/blog/([^/]+)/?$", "file": "src/blog/$1.md" }
```

Append to `patterns` (after the existing elderly-removals pattern; they do not overlap). Why a pattern, not 3 `pages` entries: 17 blog md files in the repo have no entry (moving-checklist-for-older-people-uk, moving-house-process-uk-step-by-step, care-home-assisted-living-sheltered-housing-or-staying-put-uk, helping-a-parent-move-home-when-you-live-far-away-uk, moving-day-checklist-uk, moving-an-elderly-parent-into-your-home-uk, what-to-do-with-furniture-when-downsizing-uk, downsizing-in-northampton-local-help-and-what-to-plan, avoiding-scams-when-hiring-help-for-an-older-persons-move-uk, moving-in-northamptonshire-councils-council-tax, moving-into-a-care-home-from-hospital-uk, retirement-housing-in-northampton-uk-guide, how-to-downsize-a-family-home-uk-step-by-step, moving-a-parent-into-a-care-home-northampton-local-guide, plus the 3 above). One pattern covers all of them and any future post, and `$1` in the file means `isSharedTemplateFile` is false (one file per URL). Exact `pages` entries win over the pattern, so no existing blog entry changes behaviour. It does not match `/blog` or `/blog/page/2/` (second segment). Fallback if the lead wants minimal blast radius: three explicit `pages` entries, e.g. `"/blog/later-life-relocation-uk-practical-guide": {"file":"src/blog/later-life-relocation-uk-practical-guide.md"}` (same for the other two).

Safety of the 6 actions once mapped (all through the engine's self-heal path, same as the 303 self-healing actions already on ~25 other blogs):
- Detector result for a blog md (control: cost-of-moving-house-uk.md): `ok:true, fileKind:"markdown", "the Markdown/MDX article body (end of file)"`. Markers are `<!-- SEOAI:X:START --><!-- SEOAI:X:END -->` appended to the Markdown body, rendered at `{{ content | safe }}` inside the post's article (blog-post.njk:74).
- **Duplicate risk (needs-verification):** posts have front-matter `faq:` already rendered as a visible `.blog-post-faq` block and as FAQPage JSON-LD by `blog-post.njk` (lines 39-41, 77-80). A generated visible FAQ or schema block in the body could duplicate both. The engine has `render-inspector` / `faq-render-mode` guards that look for an existing visible FAQ signal, so this is mitigated but I did not run them; verify on first PR before approving faq/schema drafts for blogs.
- meta-title on md: title/description are front-matter line fields (`title:`, `description:` present in all 3), the supported line convention; no body marker needed.

### 1C. Redirects (301/302/308): do NOT create mappings

These are served by nginx and have no page to write to. Not part of the 58 (the audit skipped them); listed because the production map contains stale keys for them.

| URL | Status | Target |
|---|---|---|
| http://chayceproperties.com/ | 308 | https://chayceproperties.com/ |
| /news/ | 301 | /blog/ |
| /faq/ | 301 | /elderly-removals-faq/ |
| /senior-movers-kettering/ | 301 | /elderly-removals-kettering/ |
| /blog/moving-company-for-seniors-near-me-what-to-look-for/ | 301 | /blog/removals-company-for-older-people-near-me-what-to-look-for/ |
| /blog/what-to-do-with-unwanted-furniture-downsizing-uk/ | 301 | /blog/planning-furniture-and-floor-plan-for-a-smaller-home/ |
| /blog/questions-to-ask-a-removals-company-uk/ | 301 | /blog/choosing-removals-company-for-elderly-person-uk/ |

(Rules live in nginx/templates/default.conf.template lines ~75-103; I confirmed `/news/` -> 301 /blog/, and the other targets, with curl.)

Stale `pages` keys whose file does not exist and whose URL now 301s (optional cleanup, low value, separate trivial ticket): `/faq/`, `/news/`, `/our-services/`, `/blog/senior-move-cost-uk`, the four `/relocating-to/*`, `/blog/choosing-relocation-partner-uk-move`, `/blog/downsizing-your-family-home-uk-guide`, `/blog/senior-relocation-uk-practical-guide`, `/blog/how-to-plan-a-stress-free-senior-move`, `/blog/moving-a-parent-guide-for-adult-children`, `/blog/what-does-full-service-moving-company-do`, `/blog/dbs-checked-movers-uk-what-to-ask`, `/blog/moving-company-for-seniors-near-me-what-to-look-for` (16 keys; all verified 301 except none live). Removing them changes no live behaviour. Note `/blog/choosing-removals-company-for-elderly-person-uk` is 200 and mapped correctly. The new live regional pages `/elderly-removals-home-counties/` etc. (200, rendered by `src/areas/region.njk`, shared pagination template, permalink `/{{ region.slug }}/`) are unmapped and should follow the same rule as 1A: no `file` on a shared template.

### 1D. 404s: none found in the 58

No URL among the 58, nor among the 38 skipped, returned 404 (curl spot check of 10 skipped URLs plus all 11 candidates).

### 1E. 410s (31 skipped URLs): do NOT map; tombstone is optional

Examples verified 410: `/online-casino-gambling-united-kingdom/`, `/?h=8020347041280`, `/?p=9224`, `/shop/storeSearch/KeepCriteriaInput.aspx?...`. They are SEO-spam/hacked-site leftovers (gambling slugs, `?h=`/`?p=` query ids, WordPress-shop paths). nginx already returns 410 for the shop/wp patterns (default.conf.template lines ~51-71, `return 410` + `error_page 410 /404.html`). No file mappings; none belong in `url_file_map`.

`seo_tombstoned_urls` (migration 190, `sites.seo_tombstoned_urls`; read by agents/gsc-url-audit.js `isTombstoned` and agents/lib/dead-link-intent.js): a per-site list of OWN-domain URLs "intentionally deleted and must stay 404", compared on hostname + path (trailing slash ignored); it stops the audit from re-reporting them and stops `technical-seo` from emitting `missing-page-create` to recreate them. Proposal only (a DB write, needs explicit human OK, not done): the ~10 spam *page* URLs (gambling/casino slugs: online-casino-gambling-united-kingdom, best-gambling-website-uk, best-real-money-online-casinos-in-united-kingdom, roulette-strategy-united-kingdom, how-to-find-the-best-united-kingdom-free-spins, gala-casino-glasgow, craps-dice-names, casinos-in-scotland, list-of-all-united-kingdom-casinos, gambling-in-united-kingdom-legal) are reasonable tombstone candidates because they have GSC impressions and could attract a "create the missing page" recommendation. The `?h=`, `?p=`, `/shop/...` query/path variants are probably better left to the existing 410 rule (path-only comparison makes query-string tombstones ineffective: needs-verification of normalizeUrlKey). Not required for the 58.

## 2. The 25 fatal gaps = 5 unique files

Files (all `layout: v2-page.njk`, all marked by audit reason `fatal-no-safe-anchor`; each has 5 missing: faq, schema, internal-links, expand-content, qa-content):

1. src/areas/probate-house-clearance.njk (121 lines, closing `---` is the last line)
2. src/how-it-works.njk (94)
3. src/areas/elderly-move-manager-uk.njk (118)
4. src/areas/care-home-removals.njk (141)
5. src/areas/storage-during-your-move.njk (127)

Shared template/layout: `src/_includes/v2-page.njk` (extends base.njk). 24 pages use it; 17 of the 24 are front-matter-only like these (the other 12 not flagged only because they had no audit candidate: downsizing-help-for-elderly, home-staging-before-you-sell, house-clearance-for-the-elderly, long-distance-removals-for-older-people, moving-after-bereavement, moving-elderly-parent, moving-into-sheltered-housing, moving-parent-with-dementia, northampton, packing-service-uk, retirement-village-moving-service, unpacking-and-settling-in-service). The same gap will appear for them the moment they become candidates.

**Do the Nunjucks templates genuinely lack safe insertion points?** For the automated engine: yes, confirmed. Running `detectInsertionPoint` on all 5 gives `{"ok":false,"reason":"no-confident-html-container"}`:
- detectHtmlContainer: no `<main>/<article>/.content...` anywhere in the file (the whole page is YAML front matter).
- detectLayoutFragmentContainer: has `layout:` and no `<html>`, but body (after the closing `---`) is empty, `< MIN_CONTAINER_TEXT (40)` chars -> `no-fragment-body`.
- detectBeforeFooterContainer: no footer. Controls: packages.njk (real body) resolves via `html-fragment`; blog md resolves via `markdown`.

But a safe point exists for a human: the file's own body. The layout renders it at `{{ content | safe }}` (v2-page.njk line 90), after the `stories` section and before `tips`/`local`/`faqs`/`related`/`final`. Anything placed after the closing `---` renders there. HTML comments are inert, and marker NAMES/format are exactly what the engine uses (`<!-- SEOAI:NAME:START --><!-- SEOAI:NAME:END -->`, insertion-engine.js markerComment/insertMarkerAt), so once present `hasMarker()` is true and the engine never needs to detect anything.

### Proposed insertion (manual, one-time, in each of the 5 files)

Surrounding lines, identical shape in all 5 (example: storage-during-your-move.njk, end of file):

```
service:
  type: Storage during a move
  name: Storage When Moving House
  priceKey: gold
---
<!-- SEOAI:INTERNALLINKS:START --><!-- SEOAI:INTERNALLINKS:END -->
<!-- SEOAI:EXPANDEDCONTENT:START --><!-- SEOAI:EXPANDEDCONTENT:END -->
<!-- SEOAI:QACONTENT:START --><!-- SEOAI:QACONTENT:END -->
```

(append the three lines after the existing final `---` line; nothing else in the file changes. Marker names are the platform defaults from url-file-map.js: INTERNALLINKS, EXPANDEDCONTENT, QACONTENT.)

- **Do NOT place FAQ or SCHEMA markers in these 5 files.** Every one has `faqs:` front matter (probate l.70, how-it-works l.58, move-manager l.71, care-home l.91, storage l.81) that v2-page.njk already renders as a visible FAQ section (lines 120-130) and as FAQPage JSON-LD (line ~175), plus WebPage/BreadcrumbList/Service JSON-LD from front matter. Extra FAQ or schema blocks would duplicate. Leave faq/schema as intentionally unplaced (the audit will keep listing them as fatal; that is acceptable, or the lead can ask for an audit-side exemption later: not proposed here). A proper fix for faq on these pages is a front-matter `faqs:` adapter (new code), out of scope.
- **Placement quality caveat:** a block at `{{ content }}` sits mid-page between the "included/steps" sections and "tips", outside any `v2-sec`/`v2-wrap` container. Generated expand/qa/links HTML must therefore come wrapped by the site's own component templates (designProfile) or it will render as bare unstyled content. This is a design-validation item (CLAUDE.md section 8: render and compare per page before approving the first draft). Internal-links in particular fit better near the `related` section, but v2-page offers no per-page slot there; accept the content position or skip internal-links on v2-page pages.
- Alternative (rejected): put the markers once in `_includes/v2-page.njk`. That is a shared layout: every marker value written there would appear on all 24 pages (same shared-template rule as `isSharedTemplateFile`). Do not do this.
- Alternative (rejected/needs product decision): front-matter-driven slots (e.g. layout renders `{% if aiExpanded %}...{% endif %}`) need a new adapter that writes front matter; none exists for Eleventy.
- Alternative: `markerSetup.enabled` (marker-setup.js) opens one marker-only PR, but it calls the same `resolveInsertion`, so these 5 files would come back `unresolved`. It does not help here.

Classification: engine-automated = no (confirmed unresolvable); manual one-time human edit = yes, 5 files, ~3 lines each, comment-only. faq/schema on these 5 = do not place.

## 3. Risk review

| Change | Layout | Styling | Content | Scripts | Routing |
|---|---|---|---|---|---|
| Add `{"match":"^/blog/([^/]+)/?$","file":"src/blog/$1.md"}` pattern | none (config only, no repo change) | none | none until a draft is approved; then reviewed PR | none | none (map does not alter site routes) |
| Remove 16 stale `pages` keys | none | none | none | none | none (all 301 at nginx) |
| 3-line marker stub in 5 v2-page files | none: comments after front matter render as empty whitespace at `{{ content }}`, no element, no padding | none | none | none | none (no front-matter key touched) |
| city faq via template loop (optional, later) | adds a details block only when `aiFaqs` exists, same markup as existing `.v2-faq details` | reuses existing classes | adds items | edits JSON-LD script body (inside `<script>`); needs careful manual diff | none |

Marker placement verification:
- v2 stubs sit AFTER the closing `---`: not inside front matter, not inside a `<script>`, an attribute, or a `{% %}`/`{{ }}` tag; Nunjucks passes `<!-- -->` through. The files end exactly at `---` today (verified: closing `---` is the last line in all 5), so a trailing newline plus 3 lines is the only diff. Eleventy `.njk` has `markdown:false` in renderCapabilities, so comments are not Markdown-processed.
- Blog md markers append at EOF of the Markdown body after a plain paragraph line: HTML comment as an HTML block, inert. No raw HTML blocks in the 3 posts to interleave with.
- City pages: nothing placed (see 1A).
- Existing `<!-- SEOAI:HEAD:START -->` in base.njk:67 is already inside `<head>` outside any script. Untouched.

## 4. Nothing here touches the working pieces

- nginx: no proposal touches `nginx/templates/default.conf.template` (SEOAI:SECURITY-HEADERS marker present, 410/301 rules stay as is). The redirect/410 sections are read-only observations.
- Canonical / OG: base.njk lines for `<link rel="canonical">` / `og:*` are not edited. The 22 "unmapped-but-live-verified-ok" canonical/open-graph rows stay verified-ok. The pattern addition for blogs does not map canonical/open-graph to any new marker (canonical stays derived by base.njk; the 303 self-healing list does include a `canonical` auto-marker for blogs and pages: **needs-verification**, because base.njk already emits a canonical, a second `canonical` marker value written into the md body would be a body-level `<link>`, not the head one; check engine behaviour for canonical on md before approving any canonical draft for blogs).
- Analytics: base.njk already installs GA4 inline (`G-RXT1PVN3Z0`, prod hostname guard). The audit says the `SEOAI:ANALYTICSSCRIPTGA4` marker "will self-heal at apply time". I found no existing-install dedupe in marker-merge.js (grep for gtag/googletagmanager found nothing in the analytics-install path): **needs-verification**. Recommendation: do not approve an `analytics-install` draft for this site; it would add a second GA4 tag. No change to base.njk is proposed.

## 5. Ordered next steps (all need a human OK before anything is applied)

1. Config, no repo change: add the blog pattern to url_file_map (DB write, needs explicit OK). Re-run the audit to confirm the 18 blog actions disappear from NO FILE MAPPING (3 posts x 6).
2. One small PR in web-chayce-properties: the 3-line marker stub in 5 files (comment-only), then visually validate one drafted block per template.
3. Decide separately (new tickets): city faq via `aiFaqs` template loop + adapter; city/region expand/links/qa slot (design change); stale-key cleanup; spam-slug tombstones; verify analytics-install and blog canonical/faq duplicate behaviour.
4. Leave unmapped on purpose: city schema/internal-links/expand/qa; v2 pages faq/schema.
