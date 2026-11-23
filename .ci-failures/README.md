# Server tests: 35 tests fail in CI (found 2026-11-22, on PR 246's first run of the new job)

Status: NOT fixed. Not caused by PR 246: the same tests fail on origin/main alone (checked by running these files on a local Postgres,
once on main and once on the PR 246 tree; no test fails only on the PR tree).

The CI job "Server tests" (added to .github/workflows/ci.yml) runs `node --test server/` against a throwaway Postgres 16, migrated from
server/migrations. 9,414 tests, 35 fail, 34 skipped, 770 s. Deploy does not depend on it (deploy.yml only builds the dashboard).

## Failure groups (and the fix for each)

| # | Cause | Files | Fix |
|---|---|---|---|
| 1 | A test replaces store/users.js with an incomplete mock (no `createUser`); the file cannot load | routes/workspaces.test.js, routes/action-center.page-type.test.js (+ probably lib/action-center-reconciler.test.js, e2e/design-validation.e2e.db.test.js: file-level "test failed") | Add the missing export to the mock. Test-only. |
| 2 | Expectations no longer match behavior | agents/font-consistency.test.js (9), agents/visual-quality.test.js (14), agents/lib/analyst-outlook.test.js (2), ai-crawlers/ai-crawlers.db.test.js (3: expected /HTTP 503/, got 'server error'), agents/lib/generator-learning.test.js (4: expected 30 rows, got 26) | Decide per test whether code or test is right. Needs investigation. |
| 3 | A real guard blocks the test setup | design-agent/worker.test.js ('stale url_file_map write ... revision <NULL>, current revision 0', code 40001) | Check the optimistic-lock guard is behaving as designed, then fix the test setup. |
| 4 | "no code in the server merges a pull request" rule | lib/growth-lifecycle.acceptance.test.js: flags agents/lib/platform-staging-merge.js, github/client.js, lib/ship-flow.js | Decide whether the rule or those files should change. |
| 5 | Analyst/forecast tables are not in the test database | lib/tenant-isolation.db.test.js (5): approval_history->investigations, investigation_events->investigations, forecast_points->forecast_runs, feature_importance_scores->feature_importance_runs, root_cause_analysis_nodes->root_cause_analysis_runs, metric_dimension_support->metrics_catalog | Create those tables in the test DB, or update the table list. |

## Progress (branch fix/ci-server-tests-failing, in the main folder, local, not pushed)
- DONE group 1a: routes/workspaces.test.js (mocks of store/users.js and report/email.js were missing exports). 52/52 pass.
- action-center-reconciler.test.js: passes ALONE (35/35); fails only in the full-suite run -> interference/timing under load (investigate).
- e2e/design-validation.e2e.db.test.js: NOT a mock problem. openai@4.104.0 -> formdata-node@4.4.1 -> web-streams-polyfill@4.0.0-beta.3 has no
  ESM named export `ReadableStream`; the file fails at import in CI too. Needs a dependency decision (override web-streams-polyfill, or load openai differently in that test).
- routes/action-center.page-type.test.js: exists only on PR 246's branch (not on main); same missing-mock cause, fix it after PR 246 merges.

## Do after PR 246 merges
- Work on this branch (fix/ci-server-tests-failing, folder web_analytics-fix-ci-tests), one commit per group, starting with group 1.
- When the suite is green, remove `continue-on-error` from the "Server tests" job (if it was added) so the job blocks again.

## Reproduce locally
docker run -d --name pg -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=test -p 55432:5432 postgres:16
DB_SSL=off COMPANY_SITE_ID=1 GSC_PROPERTY=sc-domain:example.test GA4_PROPERTY_ID=1 DATABASE_URL=postgres://test:test@localhost:55432/test node server/migrations/run.js
DB_SSL=off COMPANY_SITE_ID=1 DATABASE_URL=postgres://test:test@localhost:55432/test node --experimental-test-module-mocks --test server/<file>.test.js
(Run in a clean checkout with no .env: this machine's .env makes two extra llm tests fail locally.)
