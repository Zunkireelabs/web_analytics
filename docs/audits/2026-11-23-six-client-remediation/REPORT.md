# SuperRank six-client remediation plan — 2026-11-23

Status: AUDIT AND PLAN ONLY. Nothing here has been implemented. No commits, branches, PRs, production writes, client-repo edits or deploys were made for this report. Detail per client: `findings-1.md`, `findings-8862.md`, `findings-8864.md`, `findings-8871.md`, `findings-8874.md` (same folder). Zennly (8872) is deliberately EXCLUDED at the owner's request (see §1).

Evidence base: audit runs of 2026-11-23 (sites 1, 8862, 8864 from a local run; 8871/8872/8874 from the production server's GitHub App), repo snapshots = local `origin/main` exports (NOT freshly fetched; may lag GitHub — every finding is needs-verification against live main/staging before a PR), and real engine code run against those snapshots. Audit counts are per action type, never unique files.

## 1. Executive summary
- The headline audit numbers badly overstate the real work. The real unique-file work is much smaller than the action-level counts, and a meaningful share should NOT be "fixed" at all:
  - Zunkiree: 30 unmapped actions = 5 URLs; 10 fatal = 2 files. Mostly map-only fixes.
  - Admizz: 196 rows = 42 files, of which 41 are data-only wrapper pages where markers are the wrong tool. Real fixes are config (−13) plus one small engine change (−15); 168 rows stay unsupported by design and 123 are already blocked pre-draft.
  - Chayce: 58 unmapped actions = 11 URLs; 25 fatal = 5 files. Safe manual marker lines + one blog pattern.
  - SuperRank: no per-page gaps. Head-region fix is a one-line comment pair, but the analytics install and nginx marker should be DISMISSED, not fixed.
  - MOBILISE: one set of config values; the single fatal gap is an audit false positive; analytics install not wanted.
- Three recurring themes: (1) audit logic gaps/false positives (stale "must be hand-placed" nginx wording; wrong file resolved; truncated meta regex; ignores pre-draft gates and adapters; mis-flags TSX render gaps); (2) analytics-install should be declined on 4 of 5 sites because GA4/GTM already exists; (3) shared templates mean per-page markers are often unsafe — adapters or layout-level fixes are correct.
- Do not optimise for zero audit gaps. Several flags are best resolved by dismissing the recommendation or fixing the audit.
- Zennly: the owner is onboarding the Zennly marketplace (separate repo, shares zennly.io). Zennly's current business-site findings (1 fatal marker gap; head region not detectable in `src/_includes/base.njk`; nginx marker missing; 59 old /businesses/* 308 redirects need no mapping) are recorded but not planned here.

## 2. Six-client status table
| Client | Site | Stack | Audit result (action-level) | Unique work items | Real blockers |
|---|---|---|---|---|---|
| Zunkiree | 1 | eleventy | 30 unmapped, 2 missing files, 10 fatal, 1 avatar unverified | 5 URLs, 2 files, 2 product .njk, 1 avatar | product-v2 layout renders empty section for marker-only body |
| Admizz | 8862 | next.js | 196 fatal, 5 render, 2 targets | 42 files (5 families), 5 render rows, 4 targets | shared-template pages; wrong blog/answer target dirs; engine spread-locator |
| Chayce | 8864 | eleventy | 58 unmapped, 25 fatal | 11 URLs, 5 files | city pages are shared-template; design check for hand-placed blocks |
| SuperRank | 8871 | astro | 0 unmapped/fatal; head region; nginx | 1 layout line (optional) | none; recommend dismissing analytics + nginx |
| Zennly | 8872 | eleventy | 1 fatal, head region, nginx | — | EXCLUDED pending marketplace onboarding |
| MOBILISE | 8874 | eleventy | 1 fatal (false positive), layoutTemplate, nginx | config only | staging branch ahead of main (unread) |

## 3. Unique affected files (per client)
- **Zunkiree (1):** `src/pages/solutions.njk`, `src/pages/solutions/app-development.njk`, `.../custom-software.njk`, `src/pages/nl/solutions/ai-ecommerce.njk`, (not mapped) industries `real-estate` via `src/pages/industries/industry-pages.njk` + `src/_data/industries.js`; missing: `src/pages/index.njk`→`homepage-v2.njk`, `src/blog/insights.md`→`insights.njk`; fatal: `src/pages/products/orca.njk`, `products/search.njk` (layout `product-v2.njk`, data `platformProducts.js`); 15 stale map keys; avatar `src/assets/images/team/sadin-shrestha.webp`.
- **Admizz (8862):** 42 files under `src/app/` — Family A 17 (GeneratedBlogPost), B 11 (CountryPageTemplate), C 11 (NepalVariantTemplate), D 2 (birgunj, janakpur), E 1 (`events/uk-education-expo-oct-2026`). Full list in findings-8862.md §1. Plus `src/app/layout.tsx` (no change).
- **Chayce (8864):** 8 city URLs via `src/areas/local-area.njk` + `localAreas.json`; 3 blogs `src/blog/<slug>.md`; fatal: `probate-house-clearance`, `how-it-works`, `elderly-move-manager-uk`, `care-home-removals`, `storage-during-your-move` (layout `v2-page.njk`).
- **SuperRank (8871):** `src/layouts/Layout.astro` (optional), `nginx/static.conf` (no action recommended).
- **MOBILISE (8874):** `src/_includes/layouts/base.njk` (config value), `nginx/static.conf` (optional), `src/contact/index.njk` + `heads/*.njk` (no change; audit false positive).

## 4. Root causes grouped by shared template/component
1. Front-matter-only pages with empty bodies (Zunkiree orca/search; Chayce 5 pages): detector's 40-char minimum refuses; hand-placed markers needed, but the layout may render an empty padded section (Zunkiree product-v2) — layout guard first.
2. Data-driven wrapper pages (Admizz 41 files; Chayce city template; Zunkiree catalog.njk/industries): nothing to host a body marker; correct tool is an adapter on the data file, not a marker.
3. Stale map after a site refactor (Zunkiree /services→/solutions, homepage-v2, insights; Admizz south-korea entry mapped to a docs .md; 23 URLs mapped to shared `[slug]`).
4. Audit false positives/stale text (MOBILISE open-graph on /contact/; "must be hand-placed" nginx wording stale — engine auto-inserts, real failure is `headers-not-inherited`; Admizz TSX render gaps; ignores templateDrivenBodyBlock).
5. Analytics already installed elsewhere (SuperRank cookie-consent GA4; Chayce inline GA4; MOBILISE analytics.js; Admizz GTM/Pixel/gtag): analytics-install would double-count or load before consent.
6. Head region undetectable when `<head>` contains template expressions (SuperRank Layout.astro; Zennly base.njk likely same class — unverified).

## 5. Proposed fixes (insertion points / config) — see per-client files for exact diffs
- Zunkiree: map-only (3 pages, `/`, `/blog/insights/`, `/solutions/` FAQ adapter) → clears 18/30 + both missing files; products FAQ adapter via `platformProducts.js`; or layout guard in product-v2.njk then 5 markers on orca/search.
- Admizz: F1 events adapters (−3); F2 `page-data-object` faq on 10 pages (−10); F3 engine spread-locator then 15 pages (−15); F4 map hygiene; F5 correct blog-outline/direct-answer dirs (`src/app` `/{slug}`; `src/app/answers` `/answers/{slug}`) after two engine gaps are fixed; keep `.tsx` markdown:false.
- Chayce: blog pattern `^/blog/([^/]+)/?$` → `src/blog/$1.md`; 3 comment-only markers (INTERNALLINKS, EXPANDEDCONTENT, QACONTENT) after front matter on 5 pages (no FAQ/SCHEMA markers); city pages: no map change.
- SuperRank: optional `<!-- SEOAI:HEAD:START --><!-- SEOAI:HEAD:END -->` after viewport meta in Layout.astro; dismiss analytics-install; no nginx marker/headers draft.
- MOBILISE: `siteRoot.layoutTemplate = src/_includes/layouts/base.njk` ONLY together with `"layout": null` on newContentTargets (else new pages get a build-breaking layout); no marker changes; nginx marker optional.

## 6. Automated vs manual
- Automated-safe once approved: map-only entries (Zunkiree, Chayce blog pattern, Admizz F1/F2, F4 mapping fixes).
- Needs engine change first: Admizz F3 (spread locator), audit-script fixes (4 items), Admizz F5 renderer gaps.
- Manual client-repo review (local build + screenshots): Zunkiree product-v2 guard/markers, catalog.njk block, industries.js; Chayce 5 pages' markers; SuperRank Layout.astro line.
- Dismiss rather than fix: SuperRank analytics-install/security-headers/81 canonicals; MOBILISE analytics-install; Admizz/Chayce analytics-install drafts; Admizz translation target.
- Unsupported by design (168 Admizz rows): schema/body types on template pages.

## 7. Proposed URL-to-file mapping changes (SEPARATE, for approval; NOT applied; production writes)
| Site | Change | Evidence | Uncertainty |
|---|---|---|---|
| 1 | add `/solutions/app-development/`, `/solutions/custom-software/` (+altTextDataSources), `/nl/solutions/ai-ecommerce/` | files exist; URLs 200 | nl faq/schema/qa duplicate FAQPage risk |
| 1 | `/` → `src/pages/homepage-v2.njk` | permalink `/` | no git history (inferred) |
| 1 | `/blog/insights/` → `src/blog/insights.njk` | hand-built listing | meta-title manual (eleventyComputed) |
| 1 | `/solutions/` → `solutions.njk` + faq adapter servicesFaq.json | catalog.njk renders servicesFaq | body markers never render |
| 1 | `^/products/(orca\|search\|ai-crm)/?$` faq adapter platformProducts.js | data array shape | owner must confirm Orca FAQ wanted |
| 1 | optional: re-key 11 /services/*, delete 4 dead /products/* (15 entries; investigator said 14 — recount) | files missing, URLs 301 | none functional |
| 8862 | F1 events adapters; F2 faq adapter on 10 pages; F3 on 8 pages + answers pattern (after engine change); F4 south-korea file fix + 23 own-folder pages; F5 target dirs | see findings-8862.md | snapshot freshness; build check |
| 8864 | add blog pattern (or 3 explicit pages); optional prune 16 stale keys; NO city mapping; tombstone ~10 gambling slugs (DB write) | files exist; URLs 200 | tombstone list needs review |
| 8871 | none | — | — |
| 8874 | layoutTemplate (+ layout:null on targets); optional blog pattern `placements` | single shared base.njk | staging branch unread |
Each must be shown to the owner with exact JSON diff and site ID before any production write.

## 8. Website design/functionality risk assessment
- Highest: Zunkiree product-v2 (marker-only body renders ~96–160px empty section) — guard or adapter first; MOBILISE layoutTemplate without `layout:null` (build break); Admizz wrong blog/answer dirs (build fail / redirecting URLs); SuperRank/Chayce analytics install (double-count; consent/privacy).
- Medium: Chayce hand-placed blocks sit outside `v2-sec` wrapper (needs visual check); duplicate FAQPage JSON-LD on pages with existing FAQ/schema (Chayce blogs, Zunkiree nl, Admizz templates).
- Low: head-region comment pairs; adapter-only map entries.
- Multi-tenant: every proposal is scoped to one site's map or repo; no shared template of another client is touched. Platform-code changes (audit fixes, spread locator) are engine-level and must be tested for all six sites' fixtures.

## 9. Validation and testing plan (before any implementation approval)
Per change: local build of the client repo on a branch cut from latest main (and staging where it is the PR target: MOBILISE/others); render before/after HTML diff of every affected page; screenshots desktop (1440) and mobile (390) for any template/layout touch; check nav, internal links, images, scripts and console errors; confirm markers sit in valid structural spots (not inside `<script>`, attributes, or template tags) and are detected by `detectInsertionPoint`/`classifyMarkerGap`; run the repo's own validators (e.g. Admizz `validate-content.mjs`, `npm run build`); re-run the audit (read-only variant, or after the DB-write line is removed) on all six sites; confirm agents can read/apply with a dry-run draft on a copy; confirm no cross-client config changed (diff of each site's `url_file_map` _rev only for the intended site). Platform changes: unit tests in `server/` (structural-detect, page-data-object, audit script) plus full test run.

## 10. Implementation order and dependencies
1. Audit-script fixes (platform repo): stop writing `action_center_config_*` on read-only runs, resolve `placements` head partial, quote-aware meta regex, consult pre-draft gates/adapters, TSX renderer check, update nginx wording.
2. Map-only changes (smallest blast radius), one site at a time with owner approval: Zunkiree → Chayce blog pattern → Admizz F1/F2/F4 → MOBILISE config.
3. Engine change for Admizz F3, then its config.
4. Client-repo PRs, one per client, owner-opened, from latest main: Zunkiree product-v2 guard (+ markers), Chayce 5 marker pages, SuperRank Layout.astro (optional).
5. Admizz target-dir/renderer fixes (after engine gaps).
6. Re-audit all six; final report.
Dependencies: Zennly after marketplace onboarding; MOBILISE after staging branch is read; Admizz F5 after renderer gaps.

## 11. Outstanding decisions needing the owner
1. Zunkiree orca/search: layout guard + markers, or FAQ adapter only? Confirm an Orca FAQ is wanted.
2. Decline analytics-install on SuperRank, Chayce, MOBILISE, Admizz? (recommended: yes; MOBILISE needs a DECIDE ticket.)
3. Chayce: add city-page FAQ support via a template change, or leave city pages unmapped (recommended)? Tombstone ~10 gambling slugs?
4. Admizz: approve engine change for `{...post}` spread; approve target-dir correction; translation target (no locale routes) — DECIDE.
5. SuperRank: add the optional HEAD marker pair?
6. MOBILISE: read the `staging` branch before any config (32 of 45 mapped pages 404 on prod, 200 on staging).
7. Zennly marketplace: separate project vs path-scoped site on zennly.io; repo/branch; GitHub App installation.
8. Plane tickets (SRANK): search for duplicates, then create per client + DECIDE tickets.

## Summary
- **Safe and automatable (after approval):** map-only entries; Admizz F1/F2; Chayce blog pattern; Zunkiree page entries.
- **Manual review:** product-v2 layout guard + 2 product pages; Chayce 5 pages; SuperRank Layout.astro; catalog.njk block.
- **Blocked by missing info:** MOBILISE staging branch contents; repo snapshots may lag GitHub; Zennly/marketplace repo; live-render verification not yet done anywhere.
- **Needs production approval:** every `url_file_map` change; tombstones; any DB write; and any restore of action-center fields (already done — see below).

## Proposed recovery action vs what already happened
An earlier audit run accidentally overwrote `action_center_config_checked_at` and `action_center_config_gap_count` on all six sites. With the owner's explicit approval the gap counts were restored to 62/77/24/306/289/50 and `checked_at` was set to NULL (backup at `scratchpad/phase1-backup.json`; read-back verified). The three later audits on the production server used a copy of the script with the write removed (verified), so no further writes occurred. NOTE: this report's audit data for sites 1, 8862, 8864 came from the earlier local run (whose results are valid); `action_center_config_checked_at` remains NULL for all six, meaning "never successfully audited" — a proper audit run after the platform fix in §10 step 1 would set it.
