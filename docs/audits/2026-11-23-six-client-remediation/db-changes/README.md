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

## 3. No other production write
All map changes in `../proposals/` are NOT applied. They are applied only by `server/scripts/apply-url-file-map-proposal.js --apply`,
after review, one site at a time.
