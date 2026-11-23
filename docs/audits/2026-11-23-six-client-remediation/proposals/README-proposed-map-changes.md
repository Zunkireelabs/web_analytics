# Proposed url_file_map changes — NOT APPLIED (production writes need approval)

Generated 2026-11-23 from the current production maps. Each change was dry-run against the real repo files with the platform's own resolver and adapters. Apply only with the site's `_rev` unchanged (optimistic concurrency); re-generate if it moved.


## Zunkiree (site 1), base _rev 63

### all changes  (`zunkiree-1-proposed-map.json`)
- pages added: 12; removed: 15; changed: 1; patterns 7 -> 8
- removed: `/services/`, `/products/gaamma/`, `/services/aeo-seo/`, `/products/dental-ai/`, `/services/ai-ecommerce/`, `/services/data-systems/`, `/services/ai-development/`, `/services/app-development/`, `/services/custom-software/`, `/services/web-development/`, `/services/saas-development/`, `/nl/services/web-development`, `/products/ai-booking-engine/`, `/products/ai-commerce-agent/`, `/services/ai-customer-experience/`
- added: `/solutions/`, `/solutions/aeo-seo/`, `/solutions/ai-ecommerce/`, `/solutions/data-systems/`, `/solutions/ai-development/`, `/solutions/app-development/`, `/solutions/custom-software/`, `/solutions/web-development/`, `/solutions/saas-development/`, `/solutions/ai-customer-experience/`, `/blog/insights/`, `/nl/solutions/ai-ecommerce/`
- changed: `/`
- new pattern: `^/products/(orca|search|ai-crm)/?$` -> faq via `src/_data/platformProducts.js`


## Admizz (site 8862), base _rev 46

### PHASE 1: works with today's engine  (`admizz-8862-phase1-config-only-map.json`)
- pages added: 53; removed: 0; changed: 12; patterns 7 -> 7
- changed: `/study-in-canada`, `/study-in-germany`, `/study-in-newzealand`, `/study-in-south-korea`, `/study-in-uk-from-nepal`, `/study-in-uae-from-nepal`, `/study-in-dubai-from-nepal`, `/study-in-india-from-nepal`, `/study-in-finland-from-nepal`, `/study-in-australia-from-nepal`, `/study-in-south-korea-from-nepal`, `/events/uk-education-expo-oct-2026`
- added (own-folder pages that today resolve to the shared `[slug]` file): 53 entries, e.g. `/accreditation-and-results`, `/ai-in-study-abroad-applications-what-universities-allow-nepali-students`, `/ai-in-universities-2026-assessment-integrity-international-students`, `/australia-2027-national-planning-level-student-visa-nepali-students` ...

### PHASE 2: phase 1 plus {...post} FAQ adapters; apply only after the engine PR is deployed  (`admizz-8862-phase2-needs-engine-map.json`)
- pages added: 53; removed: 0; changed: 20; patterns 7 -> 7
- on top of phase 1, changed: `/study-abroad-from-nepal`, `/uk-student-visa-cost-2027`, `/uk-student-visa-from-nepal`, `/germany-blocked-account-2026-nepali-students`, `/how-to-get-your-noc-from-nepal-for-study-abroad`, `/study-in-germany-from-nepal-costs-intakes-visa-2026`, `/australia-student-visa-english-test-scores-ielts-pte-toefl-2026`, `/compex-scholarship-2026-complete-guide-for-nepalese-students-to-study-in-india`; `patterns[3]` (/answers/*) gains a faq adapter


## Not proposed (and why)
- **Zunkiree `/industries/real-estate/`**: unmapped on purpose. A data file merges a separate `seo` object over the array, so an adapter would edit shadowed fields and change nothing live.
- **Zunkiree `/solutions/` body markers**: its template never renders `{{ content }}`, so only the FAQ adapter is proposed.
- **Admizz `newContentTargets` (blog-outline, direct-answer, translation, privacy-policy)**: held. The two target folders point at `src/app/blogs` but real posts live at `src/app/<slug>` and `src/app/answers/<slug>`, and the generator has two unfixed engine gaps (it omits `path`, and emits an `export const answer` Next rejects). Translation: the site has no locale routes. Decision needed.
- **Admizz `renderCapabilities`**: no change. The 5 reported gaps are 2 audit false positives (fixed in the engine PR) and 3 real ones that must stay blocked.
- **Admizz 168 template-driven body actions**: stay unsupported, already blocked before any draft.
- **MOBILISE `siteRoot.layoutTemplate`** (`src/_includes/layouts/base.njk`): recommended but held. Today it only changes the layout a NEW page would emit, and new content stays blocked. Set it together with the Eleventy-compatible target and head-partial work.
- **SuperRank**: no map change. Its analytics-install and security-headers recommendations are dismissed by the platform's duplicate guard once the engine fix is deployed.
