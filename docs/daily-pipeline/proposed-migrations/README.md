# Proposed migrations: NOT in server/migrations on purpose

Every .sql file in `server/migrations/` is applied on every deploy (`server/migrations/run.js`). These files live here so nothing
runs until you approve them. To adopt one: review it, copy it into `server/migrations/` under the next free number, commit, deploy.

| File | What | Reversible by |
|---|---|---|
| `A_recommendations_page_key.sql` | nullable `recommendations.page_key`, nothing reads it | dropping the column |
| `B_sites_url_policy.sql` | nullable `sites.url_policy` (JSONB evidence: www, scheme, trailing slash per project) | dropping the column |
| `C_page_key_open_unique.sql` | unique open index on (site_id, page_key, recommendation_type), created CONCURRENTLY, after backfill and merges | dropping the index |

Data changes (backfilling `page_key`, folding proven duplicates) are NOT migrations: they are reviewed scripts with a printed plan
(`server/scripts/plan-page-key-migration.js`, dry run only) because a data statement in `server/migrations/` would re-run on every
deploy forever (see `server/migrations/migrations.test.js`).
| `D_daily_pipeline_runs.sql` | the orchestrator checkpoint table (`daily_pipeline_runs`) | dropping the table |
