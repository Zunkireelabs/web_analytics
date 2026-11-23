# Production database changes made on 2026-11-23

One approved write, and one unapproved write that was then reversed.

## 1. Accidental overwrite (not approved), then restored (approved)
Running the audit script `server/scripts/audit-url-file-map.js` writes `sites.action_center_config_checked_at` and
`sites.action_center_config_gap_count` on every run. A "read-only" copy I made did not remove that write, so one run per site
overwrote both columns on six sites. Three of those runs could not read GitHub (the App key is not available locally), so they
stored misleading counts (8871: 0, 8872: 0, 8874: 1).

Restore, approved by the owner, one transaction, only those two columns on those six rows, read back and verified:

| site | name | count after the overwrite | restored count |
|---|---|---:|---:|
| 1 | Zunkiree Labs | 42 | 62 |
| 8862 | Admizz Education | 201 | 77 |
| 8864 | Chayceproperties | 83 | 24 |
| 8871 | Superrank | 0 | 306 |
| 8872 | Zennly | 0 | 289 |
| 8874 | MOBILISE | 1 | 50 |

`action_center_config_checked_at` was set to NULL ("never successfully audited") rather than today's time. The values that were in the
database immediately before the restore are in `gap-count-overwrite-values-before-restore.json`. The original timestamps were not
recorded, so they cannot be restored.

## 2. Fix so it cannot happen again
`audit-url-file-map.js --no-record` skips the write. The three later audits on the production server used a copy of the script with the
write removed (verified before running); no further writes occurred.

## 3. url_file_map applies (approved by the owner, after PR #247 was merged and deployed)
Run from a clean clone of `main` with `server/scripts/apply-url-file-map-proposal.js --apply`, one site and phase at a time, each after a
dry-run showing 0 conflicts. The merge is three-way onto the map as it was at the moment of the write (row-locked, `patchUrlFileMap`).
After each write the stored map was read back and compared with the approved proposal (key order and `_rev` ignored): identical.

| order | site | proposal | stored rev before -> after |
|---|---|---|---|
| 1 | 1 Zunkiree | `zunkiree-1-proposed-map.json` (12 pages added, 15 removed, 1 changed, 1 pattern added) | 63 -> 64 |
| 2 | 8862 Admizz | `admizz-8862-phase1-config-only-map.json` (53 pages added, 12 changed) | 46 -> 47 |
| 3 | 8862 Admizz | `admizz-8862-phase2-needs-engine-map.json` (`{...post}` FAQ adapters, `/answers/*` pattern) | 47 -> 48 |
| 4 | 8864 Chayce | `chayce-8864-proposed-map.json` (one pattern: `^/blog/([^/]+)/?$` -> `src/blog/$1.md`; newly covers 19 blog posts, changes no page entry) | 29 -> 30 |
| 5 | 8862 Admizz | `admizz-8862-phase3-faq-more-pages-map.json`, merged with `--base admizz-8862-phase2-needs-engine-map.json` (`page-data-object` FAQ adapter on 19 more pages; 7 refused by the engine and left out) | 48 -> 49 |

Full copies of both maps from just before the first write were saved outside git (they hold client configuration), as
`pre-apply-map-1-rev63.json` and `pre-apply-map-8862-rev46.json`, in the working scratch folder of the 2026-11-23 session. To reverse a
site, restore its map from that copy (keeping the then-current `_rev`).

## 4. No other production write
Sites 8871, 8872 and 8874 were not changed.

Prepared and dry-run, NOT applied (needs the engine in this PR deployed first, then approval): `admizz-8862-phase4-city-data-faq-map.json`, merged with
`--base admizz-8862-phase3-faq-more-pages-map.json --engine-deployed` (FAQ adapter in `dataFile` mode on `/birgunj` and `/janakpur`).

Prepared and dry-run (32 of 32 real-data dry-runs), NOT applied: `chayce-8864-phase2-city-actions-map.json`, merged with `--base chayce-8864-proposed-map.json --engine-deployed`
(FAQ with `q`/`a` keys, a structured `relatedPosts` list for internal links, text fields for expanded content and Q&A on the 20 city pages; schema and
the 5 front-matter pages declared not applicable with reasons). Apply only after the engine here is deployed AND the Chayce template PR is on `main`.

Prepared and dry-run (20 of 20 real-data dry-runs), NOT applied: `zunkiree-1-phase2-industries-map.json`, merged with `--base zunkiree-1-proposed-map.json --engine-deployed`
(an `/industries/<id>/` pattern: title/description, FAQ, related posts, expanded content and Q&A; schema declared not applicable on the industry and product
pages because their templates already render it). Apply only after the engine here is deployed AND zunkireelabs-web #153 (the industry template block) is on `main`.
The industries data fix (zunkireelabs-web #151) is already on `stage`; it must also be on `main`.

Copies of the maps from before the writes (outside git, same reason as the others): `pre-apply-map-8864-rev29.json` and
`pre-apply-map-8862-rev48-before-phase3.json`.
