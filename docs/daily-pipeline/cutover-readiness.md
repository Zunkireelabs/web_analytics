# Unified daily pipeline: cutover readiness

Nothing here is committed, deployed or applied. No production data was written: production was only READ, inside
`BEGIN TRANSACTION READ ONLY`, and live evidence was gathered with plain GETs of the projects' public pages.
Client URLs are deliberately not copied into this file; the reports print them on demand.

## Status against the instructions

| # | Instruction | Status |
|---|---|---|
| 1 | Production Python findings at 03:45 Kathmandu; orchestrator depends on confirmed completion; never silently stale | **Done in code, not deployed.** `deploy.yml`: ingest 20:00 UTC, analysis 22:00 UTC. Python writes a `findings_complete` marker only after every findings stage succeeds; the orchestrator's analyst stage **fails** (and syncs nothing) without it. **Blocker:** see B1, B2. |
| 2 | Merge trailing slash / http-https only with redirect or canonical evidence | **Done.** `lib/page-key/equivalence.js` + per-project `site-policy.js`. Path case and meaningful query parameters are never merged. |
| 3 | Run both production reports, read-only | **Done.** Results below. |
| 4 | Corroboration in both orders | **Done**, tested against a real database. |
| 5 | WORK_CLAIMS_ENABLED off, no one-fix-per-page rule | **Kept off.** Nothing in this work sets it. |
| 6 | Prepare the safe page-key migration after the reports | **Done** as proposals + a dry-run plan generator (no write path). |
| 7 | Validation extraction, generation, live design validation, correction loops, prepared-only shipping, job integration, one 11:00 run | **NOT done.** See "Remaining work". |
| 8 | Test report, migration plan, cron replacement list, rollback | This document. |
| 9 | Real Python test environment, actually run pytest | **Done.** Python 3.12 (the service's Dockerfile version) via uv, pytest 9.2.0, pytest-asyncio 1.4.1. |

## Production report results (read-only)

**Database identified:** the remote Supabase database in the local `.env`; it holds Zunkiree Labs (1), Admizz (8862), Chayce (8864)
and five others, AND the Data Analyst's tables (deploy.yml confirms production Python shares the staging analyst database).

**Python -> app parity: NOT a pass.**
* No Python insights in the last 30 days. The 231 that exist are all for Zunkiree Labs and date from 23 Aug to 3 Sep 2026.
* Of 13 eligible historical findings: 5 arrived, 2 merged correctly, **6 never became a recommendation** (several are one page written
  with and without www, exactly the page-key problem).
* Therefore `ANALYST_DRAFT_TRIGGER` stays ON (unset) for now. Note that the draft step has not produced anything since 4 Sep either.

**Canonical page-key duplicates:** 250 open recommendations, 184 URL-keyed.
* 0 collisions and 0 rewrites under the always-safe rules.
* 2 collision groups (both `broken-link-fix`, sites 1 and 8862), differing only by a trailing slash, no drafts attached.
  **Both proven equivalent by redirect** (live).
* 110 rows would change if trailing slashes were merged globally, which evidence does not allow: Zunkiree and Chayce redirect TO the
  slash, Admizz redirects AWAY from it. The key must follow each site's own redirect target.

**Per-project URL policy (live evidence):** Zunkiree www->bare, https, slash added; Admizz www->bare, https, slash stripped; Chayce
www->bare, https, slash added. Other active projects: see the plan output.

## Blocking issues found (each needs a ticket and a decision)

* **B1. The production Python pipeline fails every run.** `investigating` raises "Multiple rows were found when one or none was required"
  after about an hour (40 failures; latest 5 Nov 2026 07:23 UTC). Nothing after it has run since 4 Sep: no insights, no
  recommendations, no drafts from Python. Until this is fixed the orchestrator's analyst stage will (correctly) fail every day.
* **B2. Two Python schedulers write one database.** Staging's host crontab (22:00 UTC) and production's in-container scheduler (now 04:00
  UTC) both run against the shared analyst database; production data shows two chains a day (01:10 and 06:23 UTC). Moving production
  to 22:00 UTC makes them start together. Exactly one must own the night before deploying.
* **B3. Parity gap.** 6 eligible historical findings never reached the queue; find out why (sync window, gates) before switching the
  Python draft step off.

## Test report

| Suite | Result |
|---|---|
| Node, every new or changed test file (pipeline, page key, equivalence, parity, migrations guard, earlier Get Started / Overview work) | 107 / 107 pass |
| Node, real database (local OrbStack): corroboration in both orders, idempotency, different issue untouched, closed row untouched | 6 / 6 pass |
| Node, existing suites around the changed files (analyst*, recommendations*, recommendation-coordinator*, growth-opportunities-sync) | 305 / 305 pass, after adding the new export to four test mocks and the new `corroborated` count to one shape assertion |
| Python, full suite (pytest 9.2.0, Python 3.12) | 172 pass, **2 fail**: `tests/collectors/test_keyword_discovery_cycle.py` (two tests). Pre-existing: they call `_run_external_research` without its newer `window_end` argument; `keyword_clustering.py` is unchanged since its 11 Sep commit and untouched here. |
| Python, new tests | `test_draft_switch.py` 10/10, `test_findings_complete_marker.py` 2/2 (inside the 172) |

Commands are in each test file's header; the Python environment: `uv venv --python 3.12`, `uv pip install -r requirements.txt pytest pytest-asyncio`.

Not covered by automated tests: the live HTTP evidence (exercised against the real sites, not in CI), the deploy workflow change
(YAML validated only), and the orchestrator against real stages end to end.

## Migration plan (none applied)

All proposed files are in `docs/daily-pipeline/proposed-migrations/` (outside `server/migrations/`, which auto-applies on deploy).
Order: D (checkpoint table) when the pipeline is approved; then for the page key: B (url_policy) -> A (page_key) -> writers fill
page_key behind a flag -> backfill script -> fold proven duplicates from the reviewed dry-run plan
(`server/scripts/plan-page-key-migration.js`) -> C (unique index, CONCURRENTLY) -> readers switch behind a flag -> retire the old index
after a clean week. Full detail: `findings-and-page-key-plan.md` section 4.

## Cron replacement list (for the cutover; nothing changed yet)

| Today | At cutover |
|---|---|
| 07:00 daily body (`CRON_SCHEDULE`): ingest, agents, repairs, chained shipping, learning tail | replaced by the 05:30 orchestrator (research, repairs as stages) and the 11:00 ship run |
| :05 hourly daily-job catch-up | replaced by the orchestrator's own resume guard (checkpointed) |
| startup catch-up (`runStartupCatchup`) | must be gated off or redirected to the orchestrator, or a deploy mid-window re-runs research |
| chained shipping inside the daily body | `SHIP_CRON_SCHEDULE='0 11 * * *'` with an Asia/Kathmandu ship timezone; prepared-only |
| :35 ship catch-up | kept, made prepared-only, `SHIP_HOUR_LOCAL=11`, catch-up end later (sites are Asia/Kolkata, 15 min behind) |
| 05:00 content-gap refresh, 05:15 competitor growth, 06:00 design queue, 06:30 trend radar | moved into the orchestrator |
| 00:00 UTC analyst fusion + sync | moved into the analyst stage (one fusion, one sync, after the completion marker) |
| Monday 00:00 UTC keyword-gap refresh + ship cycle | refresh into the analyst stage; qualification with `deferDraft: true` (recommendations only); drafting and shipping by the pipeline |
| Python: staging crontab 22:00 UTC and production scheduler | exactly one owner of 22:00 UTC against the shared database (B2) |
| kept as is | ingest jobs (PostHog 03:40, rank tracking 04:30), hourly verification / PR poll / impact, reports, sign-up jobs, monthly design scans |

## Rollback strategy

* Every pipeline behaviour is behind flags that default off (`DAILY_PIPELINE_ENABLED`, `SHIP_PREPARED_ONLY`); turning a flag off
  restores today's cron behaviour with no deploy of old code.
* Python: `ANALYST_DRAFT_TRIGGER` unset restores today's draft step; the completion marker is an extra activity row and harmless.
  The schedule change is two env lines in `deploy.yml`.
* Corroboration: only appends a finding id and a supporting agent to already-open rows; reverting the code stops it. Nothing is deleted.
* Page key: additive column and index; folded duplicates become `superseded` (no delete), so the logged ids can be reopened.
* Checkpoint table: additive; dropping it removes only pipeline history.

## Remaining work (instruction 7), in the order it should be done

1. Extract the checks in `approveAndPublishDraft` (Quality Gate, implementer preview with the responsive repair loop, rendering gate,
   technical check with repair) into one `validateDraft` that never pushes; `approveAndPublishDraft` calls it, behaviour unchanged.
   There are no tests on that function today, so it needs characterization tests first.
2. A `prepare` mode for the auto-remediation selection (same budgets, breakers and lanes) that generates, submits and validates, then
   marks the shipping-queue item `prepared`; and a ship mode that takes only `prepared` items.
3. The generate, design-live and prepare stages call those; correction loops reuse the existing bounded repair attempts.
4. Move the research, repair and learning steps into stages, then the cron cutover above.

---

## Update: Python repair (completed) and item 7 progress

### Python investigating-stage failure: root cause and fix
* **Root cause (a query bug, not bad data).** `app/insights/engine.py` `_milestone_insights` asked `metric_period_stats` for exactly one
  weekly row per client and score metric with no `period_end` filter and no ordering. That table keeps one row per week (its unique key
  includes `period_end`), so from the second week of history the query matched every stored week and `scalar_one_or_none()` raised
  "Multiple rows were found". Production had 25 / 20 / 20 weekly `health_score` rows for the three clients. Read-only checks found
  **zero duplicate records** anywhere this stage reads (insights identity, analyst recommendations per insight, the stats key).
* **Fix.** Read the latest site-level weekly row (`dimension = site`, `ORDER BY period_end DESC LIMIT 1`), the same shape
  `root_cause.py` already uses; the milestone insight it writes is about the site and that week.
* **Regression test** (`tests/insights/test_milestone_weekly_history.py`, real Postgres): 3/3 failed on the old code with the exact
  production error, 3/3 pass after the fix (latest week used; an older crossing does not fire; a page-level row is not mistaken for the site).
* **End-to-end run** on a fresh local database built by the service's own 42 migrations, with a synthetic client (120 days, one
  declining page, a health score crossing 50): the real production entry point (`run_analysis_pass`) finished, every stage completed,
  `findings_complete` written, 9 insights (6 page-level), 9 investigations, 9 analyst recommendations, **0 drafts requested** (switch off).
  Two per-client errors in that run were caused by the synthetic client's fake MCP token (`InvalidToken`), isolated by design.
* **Found by the end-to-end run:** the new `findings_complete` marker violated `ai_activity_log_task_type_check`. Added Alembic
  migration `0042` (additive; upgrade/downgrade/re-upgrade verified locally) and made the marker write non-fatal.
* **Python -> app parity, end to end** (Python API served over HTTP from the test database, the app's real fetch and sync): 9 insights
  fetched; the app's own meta-title recommendation gained `analyst-insights` as supporter with 3 Python finding ids (app first); an
  expand-content recommendation was created from the Python finding and its forecast finding merged into it (Python first); parity
  report: 5/5 eligible findings present -> switch-off SAFE. On synthetic data: copying production data locally was refused by the
  permission system and was not attempted another way.
* **Scheduler ownership:** `deploy.yml` production scheduler ingest 20:00 / analysis 22:00 UTC is the only scheduled owner;
  `deploy-staging.yml` no longer installs the nightly crontab and removes an old one (keeps `CRON_TZ=UTC` for the Common Crawl entry;
  simulated); `ANALYST_DRAFT_TRIGGER=off` in both. Both entry points refuse to start while another run is live (stale rows ignored).
* **Orchestrator:** the analyst stage is now a readiness gate (waits without blocking other stages or projects; deferred with its reason
  at the deadline), because a production run takes several hours and may finish after 07:00 Kathmandu.
* **Tests:** Python full suite 177 pass / 2 fail with the test database (172 pass / 5 skip / 2 fail without it); the 2 are the
  pre-existing `test_keyword_discovery_cycle.py` failures. Orchestrator 29/29.

### New issues found (each needs a ticket)
1. Decision: removing staging's cron stops **predictive alerts and the morning briefing**, which only the wider nightly script sends;
   production's `run_pass` deliberately excludes them. Either add them to production's run (a product decision) or accept the change.
2. A worsening **position** never counts as a decline (both sides test `pct_change < 0`, but a worse rank is a higher number), so the
   `qa-content` mapping for position is effectively unreachable.
3. `analyst_recommendations.insight_id` has no unique constraint although two queries assume one row (0 duplicates today).
4. The 6 historical production findings that never reached the queue (parity) are still unexplained.

### Item 7 progress
| Step | Status |
|---|---|
| Characterization tests for `approveAndPublishDraft` | **Done**: 21 tests (404/status, Quality Gate, no-repo path, resolution errors, preview failure, responsive repair success and exhaustion, repair rejected by the gate, rendering gate, technical repair success and exhaustion, learning side effects and their position, full call order, deferPr, push failure, uncertain render mode, PR failure, CMS path, no merge) |
| Extract `validateDraft()` without publishing | **Done**: a pure move; the same 21 tests pass identically on the original and the extracted code; the 22 test files that import `action-center.js` give identical results before and after (353 pass, the same 7 database-dependent failures) |
| Keep all existing Quality Gates | Unchanged by construction (moved, not edited) |
| Separate generation from validation; Design Agent live validation; bounded correction loops; `markPrepared`; prepared-only shipping; PR creation and duplicate prevention tests; 11:00 cron cannot take unprepared work | **Not started** |

---

## Update 2: notifications, ranking direction, unique indexes, the six findings, prepare/ship

### Alerts and morning briefings (production keeps sending them)
* Audit: the staging script's last two calls send them: `deliver_predictive_alerts()` (pushes active forecast-risk alerts to the app
  through each client's MCP token; the app delivers in-app and at most one email per site per day) and `generate_morning_briefing()`
  (stores an `executive_briefings` row the Analyst page reads; not an email). Production's `run_pass` sent neither.
* Change: one shared step, `app/notifications/nightly.py` `send_nightly_notifications()`, called by BOTH entry points at the same moment
  the staging script sent them (after every findings stage of a successful run). Not a copy of the staging script.
* Once only: a completed `notifying` activity row today means skip (allowed by migration 0042); the briefing generator also skips a
  briefing that already exists for that client, cadence and day. A failed send is not recorded, so the next run retries.
* Residual risk: alert delivery stops at the first client whose token cannot be decrypted (pre-existing, also true in the staging script).
* Tests: `tests/notifications/test_nightly_notifications_once.py` (3, real Postgres) and the updated `tests/analysis/test_run_pass.py`.

### Search ranking decline (fixed)
* Root cause: position is lower-is-better, but four decisions tested "pct_change < 0" / "anomaly direction low" directly: Python
  `_is_decline` (findings eligibility), the insight engine's forecast-risk rule (which feeds predictive alerts: improvements were alerted
  on, declines were not), the app's `isDecline` (fix eligibility) and analyst fusion's decline signal. Already correct and unchanged: the
  recommendation text and opportunity scoring (they used `LOWER_IS_BETTER_METRICS`), the app's ranking sorts and gaps.
* Fix: one source of truth per language (`app/metrics/direction.py`, `server/lib/metric-direction.js`); every decision goes through it.
  The alert wording for position says it worsens; every other metric's wording is unchanged.
* Tests: 3->2 improved, 3->3 unchanged, 3->8 declined, 8->15 declined on every path (Python 17, Node 14). Three existing tests had
  encoded the bug (a "decline" helper used -30 for position); they now build a real decline.

### Missing unique indexes (proposals, tested locally, not applied)
* Both queries: `app/insights/engine.py` `_replace_insight` and `app/insights/recommendations.py` (dashboard summary) use
  `.scalar_one_or_none()` on `analyst_recommendations.insight_id`. Intended key: one recommendation per insight (the engine inserts only
  for insights without one). Migration 0001 created the table without the constraint its siblings got.
* Concurrency risk: check-then-insert with a slow LLM call in between; two runs at once (the old two-scheduler situation) can insert two
  rows, after which every run raises "Multiple rows were found". Same latent gap on `insights` (six-column identity, all NOT NULL).
* Read-only production check: 231 rows, 0 null, 0 duplicates; 0 duplicate insight identities.
* Proposals: `proposed-migrations/python_0043_*` and `python_0044_*`. Each refuses to run if duplicates exist and lists them (nothing is
  deleted or chosen). Tested locally: applies on clean data; the database then refuses a duplicate; with a planted duplicate the migration
  refused, row count unchanged, version unchanged; full up/down cycle.

### The six older findings (all traced; nothing inserted or altered)
All six come from the last successful Python run (4 Sep 2026, 04:17 UTC) and were returned by the insights endpoint (verified by
replaying its query read-only); none ever produced a recommendation in any status. The app's sync created recommendations from the same
batch for five other pages from 3 Oct onward, and none before (consistent with the old soft-404 bug fixed on 1 Oct).

| Insight | Finding | Ingested | Eligible | Creation attempted | Stopped at | Root cause | Fix |
|---|---|---|---|---|---|---|---|
| 3309 | impressions decline, homepage (www) | yes | yes (expand-content) | yes | gate: drop `file-missing` | the site's url_file_map maps `/` to `src/pages/index.njk`, deleted in the client repo on 2 Oct ("drop legacy homepage"); the homepage is now `src/pages/homepage-v2.njk` | correct the mapping (data change, needs approval); make the gate BLOCK (visible) instead of drop when the mapped file is gone but the page is live |
| 3324 | clicks decline, homepage (www) | yes | yes (meta-title) | yes | gate: drop `file-missing` | same | same |
| 3325 | clicks decline, homepage | yes | yes (meta-title) | yes | gate: drop `file-missing` | same | same |
| 3389 | impressions decline, homepage | yes | yes (expand-content) | yes | gate: drop `file-missing` | same | same |
| 3445 | impressions decline, a location page | yes | yes (expand-content) | yes | gate: drop `adapter-data-not-ready` | the data-array adapter only parses `export default [ ... ]`; the client's `src/_data/locations.js` changed on 2 Oct to `const cities = [...]; export default cities.map(...)`, so no location entry can be found (verified: real `isDataReady` on the real file returns false). Every location-page fix has been silently dropped since 2 Oct | teach the parser that form (with tests on the real file shape); make a parse failure BLOCK with its reason instead of drop |
| 3515 | position change, homepage | yes | NO (correctly) | no | eligibility | the ranking IMPROVED (-18%); it only looked eligible under the inverted rule fixed above | none needed |

Also found: the sync keeps re-creating recommendations from findings that are two months old (the last Python run was 4 Sep); the
orchestrator's analyst stage refuses unconfirmed findings, but the existing 00:00 UTC sync does not. Needs a ticket.

### Item 7 progress
| Step | Status |
|---|---|
| Separate generation from validation | **Done** as `lib/daily-pipeline/prepare.js`: generate (existing Quality Gate + bounded regeneration) -> submit -> `validateDraft` -> `markPrepared` only after everything passed; nothing approved or pushed |
| Live design checks | Done inside `validateDraft` (the live responsive preview against the real page, unchanged) plus the design-profile gate (no usable profile: wait for the Design Agent, not prepared) |
| Bounded correction and retry loops | The existing bounded loops (regeneration; responsive repair; technical repair) are kept; across passes the queue's attempts and `releaseItem` (outage -> retry, content -> failed) bound it |
| `markPrepared` only after all validation | Done and tested |
| Prepared-only shipping | Done as `lib/daily-pipeline/ship.js` (lists prepared, claims via the queue's `WHERE state='prepared'`, re-validates at push, one batch PR) |
| Tests that unprepared work can never ship; PR creation, duplicate prevention, failure/recovery | Done (17 tests, mocked GitHub; no PR is created anywhere) |
| 11:00 shipping guard | Done (`shipPreparedForAllSites`: refuses before 11:00 Kathmandu or with `SHIP_PREPARED_ONLY` off) |
| Never auto-merge | Ship stage has no merge capability; `finalizeBatchPr` opens a PR only (characterized) |
| NOT done | candidate selection for prepare must be the auto-remediation selection (lanes, budgets, pacing, breakers) extracted, not reimplemented; wiring `prepare`/`ship` into the orchestrator stages and cron; moving the existing research/repair/learning jobs into stages |

## Update: automatic stale page-file mapping repair (uncommitted, not deployed)

When a page's mapped file is gone but the page is live (and not a soft-404), the gate now calls `server/implementers/lib/stale-mapping-repair.js` before blocking.
Evidence is the literal `permalink:` front matter, the same field the site generator uses; nothing is guessed.

| Result | What happens |
|---|---|
| exactly one file declares the page's permalink, passes the shared-target veto | `url_file_map` entry repaired (other fields kept), audit row written, the finding is re-evaluated through the normal gates |
| no file | blocked in Action Center, "manual re-mapping required" |
| several files | blocked, candidates listed, nothing changed |
| only candidate is a layout / already mapped elsewhere / pagination generator | blocked with the reason |
| API error, timeout, truncated tree, any unreadable template, stale file still in tree | blocked, "will be retried next pass", nothing changed |
| page not live / soft-404 | unchanged: dropped as `file-missing` |
| page on another domain | refused, repo not even scanned |

Safety: write is compare-and-set against the freshly re-read site row (same repo, mapping still points at the stale file); one attempt per page per pass; audit holds old entry, new entry, evidence, repo.
Optional proposal `proposed-migrations/E_capability_repairs_unverifiable.sql` lets the audit table store the "unverifiable" outcome (until applied, only that audit insert fails and is logged).
Production effect once deployed: the first run would re-map the real homepage (`src/pages/index.njk` -> `src/pages/homepage-v2.njk`). That is a write to the production sites table, so it needs the cutover approval.
Tests: `stale-mapping-repair.test.js` (15), gate tests 46/46 (9 new, incl. homepage end to end). Full Node suite on local DB: 7134 tests, 32 failing, all 32 fail identically on a clean HEAD (10 route files that fail to import, plus font-consistency, visual-quality, technical-seo-analysis).

## Update: real-data parity on the local production copy, and the pipeline wiring (all uncommitted, nothing deployed)

### Real-data parity (local copy of production, no production access)
- Python tail run (generating_recommendations onward) completed on the copy with the LLM calls SKIPPED (recommendation tailoring, reasoning, briefing narration): the recommendation text is the template text, narration_status 'failed'. The LLM path was NOT exercised, so this is not full end-to-end parity. Notifications were deliberately not sent (the copy holds real client contact data).
- Defect found and fixed: the app read only the 200 newest insights (a dashboard cap), hiding eligible findings. Opt-in paging (`limit`, `offset`, `since_days`, `has_more`) on `GET /clients/{id}/insights` plus `server/lib/analyst-insight-feed.js`; the default response is unchanged. A failed page or a feed that never ends throws instead of syncing a partial list.
- After the fix, project 1: 3350 insights, 58 eligible = 18 created + 36 matched an existing recommendation + 4 dropped; project 8862: 2855 insights, 274 eligible = 20 created + 204 matched + 50 dropped; project 8864: 640 insights, 0 eligible. Re-running the sync created 0 and duplicated 0 (idempotent); no open duplicate (site, page, type) exists.
- Every drop (54) has one reason: `faq-schema-already-present` (the page already carries FAQ schema, so a Q&A fix cannot help). The sync now reports `droppedByReason`.
- Limit of this check: the copy has no GitHub credentials, so repo reads fail safe ("could not verify"), and the stale-mapping repair correctly refused to guess (426 unreadable templates). The repair logic is proven by tests, not by a real repo scan.

### Pipeline wiring (inert unless DAILY_PIPELINE_ENABLED=true)
- Candidate selection extracted verbatim from autoRemediateSafeRecommendations into selectRemediationCandidates (92 -> 94 characterization tests pass unchanged, plus 5 new for the extraction and 3 for drainOnly).
- Stages: research, design-baseline, analyst, repair (role correction, content repair, template capability, FAQ onboarding, blocked refresh, AI-visibility ship; fails unless every step succeeded), generate (selection into the shipping queue), design-live, prepare (claims only the auto-remediation lane; never approves or pushes).
- 11:00 Kathmandu: ONE ship of prepared, draft-backed work (never merged); then the shared repair queues drain in drainOnly mode (nothing new is generated); then the learning update. Legacy morning, hourly catch-up, separate ship and 00:00 analyst lanes stand down only when the pipeline is enabled AND its schedule is valid.
- To verify in staging before cutover: the prepared ship and the drain-only run use the same per-site per-day batch branch; confirm the day ends with one PR per project.
