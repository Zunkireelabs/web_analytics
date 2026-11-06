# Findings-only Python, one recommendation system, canonical page key

Status: PROPOSAL. Nothing in this document has been applied to any shared or production data, and no cron job has been changed.
Everything marked "verified" was checked in this repository or on the local OrbStack database. Everything marked "unverified" was not.

Roles: the Data Analyst (Python) **finds** issues. The analytics app decides whether it is the **same** issue as one it found itself,
makes **one** fix with **one** generator, and ships it on the **one** cron ship run. A person still merges the pull request.

---

## 1. Python is findings-only

### How Python is scheduled (this is NOT the same in every environment)

| Environment | Mechanism | Entry point | When |
|---|---|---|---|
| Staging | host crontab, installed by `deploy-staging.yml`, runs `docker compose exec -T app python -m scripts.run_nightly_pipeline` | `scripts/run_nightly_pipeline.py` | 22:00 UTC = **03:45 Kathmandu** |
| Production | in-process scheduler inside the container (`app/ingestion/scheduler.py`), `ANALYSIS_SCHEDULE_HOUR_UTC=4` | `app/analysis/run_pass.py` | 04:00 UTC = **09:45 Kathmandu** (ingestion at 03:00 UTC = 08:45) |

Consequences:

1. A switch placed only in `run_nightly_pipeline.py` (what was first built) does **not** reach production. Both entry points call
   `run_draft_trigger()`, and that function is the only place that asks the app to generate drafts.
2. The staging cron uses `docker compose exec` into an **already running** container. An environment variable written on the
   crontab line is ignored. The variable must be in the container's own environment (the `data-analyst-agent/.env` that each
   deploy workflow writes, read through `env_file`) and the container must be recreated for it to take effect.
3. Production's findings arrive at 09:45 Kathmandu, **after** the 05:30 orchestrator and after the 07:45 live-design stage. The
   03:45 time in the schedule is staging's. See "Schedule alignment" below.

### What was built (all default-off, no behaviour change until the variable is set)

* `app/investigations/draft_switch.py`: one rule. Only `ANALYST_DRAFT_TRIGGER=off` (any case, trimmed) turns the draft step off.
  Unset keeps today's behaviour.
* The check sits at **both** choke points: `run_draft_trigger()` (covers the nightly script and the production scheduler) and
  `generate_draft()` in `app/mcp_client/tools.py` (raises `DraftTriggerDisabled`, so any other caller, present or future, fails
  loudly instead of drafting). The nightly script also skips its `preparing_drafts` activity row when off.
* Every run logs `ANALYST_DRAFT_TRIGGER=<value> (draft trigger ON|OFF: findings only)`, so the logs prove what a deployed container
  received.
* The only other Python writes to the app are `save_site_profile`, `save_keyword_clusters`, `save_keyword_gaps` (findings/inputs)
  and `push_predictive_alert`. None creates a draft or a PR. `generate_draft` was the only fix-making call, and it is the one
  now guarded. (Unverified: the MCP server's own permission model for each tool.)
* Defence in depth, optional: the Python client's MCP token needs the `ai_actions` permission to call `generate_draft`, but
  `push_predictive_alert` needs it too, so lowering it would also silence alerts. Not recommended as the main control.

### Order of operations before the switch is set to OFF

1. Run `server/scripts/report-analyst-parity.js` (read-only) against the real data. It applies the **app's own** eligibility rule
   (`seoDraftEligibility`) to every recent Python insight and says, per finding, whether it exists in the app's recommendations.
   Switching off is safe only when `missing` is 0 **and** at least one eligible finding was seen (zero findings is reported as
   "NOT a pass").
2. Put `ANALYST_DRAFT_TRIGGER=off` in the `data-analyst-agent/.env` heredoc of **both** `deploy-staging.yml` and `deploy.yml`.
3. After the deploy, prove the container has it: `docker exec <container> printenv ANALYST_DRAFT_TRIGGER` and look for
   `draft trigger OFF: findings only` in the next run's log.
4. After one night, confirm no new drafts with `source = 'analyst-auto'` were created.

Verified locally: the rule (7 cases), the parity builder (8 cases), the script's SQL on empty tables, and that the script refuses a
remote database without `REPORT_ALLOW_REMOTE_DB=yes`.
Not verified: end-to-end with real Python data. The Python tables are empty locally and the service is not running here. The
`pytest` file `tests/investigations/test_draft_switch.py` was written but **not run**: `pytest` is not installed in this environment.

### Schedule alignment (decision needed)

To have findings before 05:30 Kathmandu in **production**, the Python jobs must move earlier: for example
`ANALYSIS_SCHEDULE_HOUR_UTC=22` (03:45) and `INGEST_SCHEDULE_HOUR_UTC` earlier still. Trade-off: the app ingests Search Console and
Analytics in its own 05:30 research stage, **after** Python has run. Python would then analyse the data the app ingested the
**previous** morning, one day staler than today. The alternative is to move the app's ingestion ahead of Python (before 03:45).

---

## 2. One recommendation system: what is true today (verified by reading the code and by experiment)

| Requirement | Verdict | Evidence |
|---|---|---|
| 2. Python and app findings enter the same system | **Yes** | Analyst sync (`syncAnalystInsightsToActionCenter`) and fusion (`shipConclusion`) both write to `recommendations` through `insertRecommendation`, using the same `recommendationPageKey` as the app's own coordinator. |
| 3. Same issue, same page: combine evidence and `supporting_agents` | **Only one direction** | App-first then Python: the analyst sync does `if (existing) { skipped++; continue; }` and fusion does `if (existing) return { created:false }`. Neither calls `mergeIntoRecommendation`, so the Python finding id and the `supporting_agents` entry are dropped. Python-first then app: the coordinator merges correctly. |
| 4. One recommendation, one generator task, one fix | **Yes, with one hole** | `getRecommendations` finds a draft by looping over **all** of a recommendation's `finding_ids`, and `drafts_site_finding_id_unique` allows one non-abandoned draft per finding id. The hole is Python's own draft step: it drafts under its own finding id without going through the recommendation row, so the app does not see it and drafts again. That is the case the OFF switch closes. |
| 5. Different issues on one page stay independent | **Yes (by key)** | The open-recommendation identity is site + page key + fix type (`recommendations_dedup_key`). meta-title, schema and expand-content on one page are three rows. Some types add more (expand-content `page::focus`, broken-link `page::href`, content-integrity `page::fixType::section::role`). |

### The merge gap and its fix (proposed, not built)

Add a minimal `corroborateRecommendation(id, { findingId, agentId, evidence })` that only appends the finding id and the agent to
`supporting_agents` (and, if evidence is stored per finding, links it). It must not overwrite `params`, `risk_tier`,
`blocked_reason` or `status`. Call it from the two `existing` branches above. Tests: app-first then analyst; analyst-first then
app; the same agent twice is idempotent; different fix types are untouched.

---

## 3. Canonical page key

### The problem (verified)
For almost every fix type, `recommendationPageKey` returns `params.page` **exactly as written**; only broken-link, missing-page and
redirect fixes strip `www`, a trailing slash and a fragment. The database enforces one open row per (site, page text, fix type), so
`https://www.site.com/about/` and `https://site.com/about` are two recommendations for one page.
Demonstrated by calling the real function.

### Rules (`server/lib/page-key/canonical.js`, pure, not wired into anything)
* Always: lowercase host (parser), drop `#fragment`, drop tracking parameters (`utm_*`, `gclid`, `fbclid`, `msclkid`, ...), sort the
  remaining parameters.
* `www.` is removed **only** when it is an alias of the project's own domain (`sites.website_domain`). Without that evidence it is
  kept. A live redirect check is the stronger proof and is the next step; the report says "by configuration".
* **Path case is preserved.** Meaningful query parameters (`?page=2`, `?id=7`, `?lang=ne`) are preserved.
* Reported separately, never merged silently: trailing slash, http vs https. A person decides.
* Composite keys: only the page part is touched. `page::focus`, `page::href`, `redirect::from`, `page::fixType::section::role`
  keep everything after the first `::` exactly.
* Not URL keys (`topic::`, `landing::`, `comparison::`, `blog-image::`, `analytics:`, site-level `''`) are left alone.

### The read-only duplicate report
`node server/scripts/report-page-key-duplicates.js [--json] [--site <id>]`

* Runs in a `BEGIN TRANSACTION READ ONLY` and rolls back; refuses a remote database unless `REPORT_ALLOW_REMOTE_DB=yes`.
* For every open recommendation it lists the recommendation id, site id, original URL, normalized URL, fix type, detecting and
  supporting agents, finding ids and how many drafts are attached.
* A collision is reported at the **first level where it appears**, and each level states the decision it needs:
  `safe` (none), `trailing-slash` (decide), `scheme` (decide), `www-unverified` (verify the alias).
* It names which row a merge would keep (the oldest) and which it would fold in, and counts drafts on the rows that would be folded
  in, because those would need re-pointing.

**Local result (OrbStack dev database, 252 recommendations, 227 open, 103 URL-keyed):** 0 collisions; 0 rows would change under the
safe rules; 3 rows would change only if trailing slashes were merged. The local data has no Python findings, so this shows the
report works, not that production is clean. **The production report has not been run** and needs your OK first.

27 unit tests cover every rule above, including: path case kept, www only for the project's own domain, `?page=1` vs `?page=2`
kept apart, different fix types and different projects never colliding, composite keys, and non-URL keys.

---

## 4. Safe migration proposal (NOTHING BELOW HAS BEEN RUN)

Principles: additive first, never edit `page` in place, every step reversible, merges only after the report is reviewed, and no
data statement inside a migration file (migrations re-run on every deploy; `migrations.test.js` enforces this).

1. **Review** the production duplicate report and decide trailing slash and scheme. Confirm the www alias for each project (live
   check: both hosts resolve and one redirects to the other, or share a canonical tag).
2. **Migration A (additive, idempotent):** `ALTER TABLE recommendations ADD COLUMN IF NOT EXISTS page_key TEXT`. Nullable. No index yet.
   Nothing reads it.
3. **Code B (flag `CANONICAL_PAGE_KEY_WRITE`, default off):** every writer (coordinator, analyst sync, fusion, keyword gap) also
   writes `page_key = canonicalPageKey(page)`. Readers still use `page`. Safe to deploy and to turn off.
4. **Backfill (a script, not a migration):** fills `page_key` for existing rows in batches, inside a transaction, logging every
   row. Idempotent; run on a copy first.
5. **Resolve existing collisions (script, dry-run by default, reviewed list of ids):** for each collision group keep the **oldest**
   row; fold the others in: union `finding_ids`, union `supporting_agents` (adding the folded row's detectors), keep the highest
   priority and confidence, re-point attached drafts' recommendation link, then set the folded rows to `status = 'superseded'`
   (an existing status). Nothing is deleted, so it can be reversed from the logged ids.
6. **Migration C (additive):** `CREATE UNIQUE INDEX CONCURRENTLY recommendations_open_page_key ON recommendations (site_id, page_key, recommendation_type) WHERE status = 'open' AND page_key IS NOT NULL`. The old index stays.
   `CONCURRENTLY` cannot run inside a transaction, so this needs the migration runner to support it; if it cannot, create the index
   by hand with approval.
7. **Code D (flag `CANONICAL_PAGE_KEY_READ`, default off):** `findOpenRecommendation` and the coordinator match on `page_key`, falling
   back to `page` for rows without one. Turn on for one internal project, watch for duplicates and for missing merges, then all.
8. **Retire** the old index only after a full week with no collision and no fallback hits. Rollback at any step before that is
   just turning a flag off.

Order matters: the corroboration fix (section 2) and the canonical key interact. Do the corroboration fix first, so that when two
detectors now meet on one row the second one is recorded.

---

## 5. WORK_CLAIMS_ENABLED: do NOT enable it globally as it stands

There are two separate flags: `WORK_CLAIMS_ENABLED` (a first-come ledger, `claimForItem` at three producers) and
`WORK_ARBITER_ENABLED` (arbitration inside the ship lock, content intents only).

Experiment (real functions, local database, test rows removed afterwards), page `/pricing`, flag **on**:

| Order | Fix | Result |
|---|---|---|
| 1 | meta-title (daily-roster) | allowed |
| 2 | schema (analyst-fusion) | **refused**, same-intent |
| 3 | broken-link-fix | **refused**, incumbent holds |
| 4 | expand-content (analyst-fusion) | **refused**, incumbent holds |
| 5 | a technical fix | **refused**, incumbent holds |
| 6 | meta-title on another page | allowed |

With the flag **off** all of them were allowed. The unique open claim is per (site, page) and deliberately ignores the generator.
A refused claim makes the producer **drop** the item, and `releaseClaim` is never called by production code, so a claim lives for
its 24-hour TTL. Enabling it would therefore allow **one fix per page per day**, which breaks the rule that different issues on one
page stay independently actionable.

Interaction with deduplication: claims are taken only on the **insert** branch (a new row). Merging a second detector into an
existing row is not blocked. The unique recommendation index is unaffected.

Recommendation: leave `WORK_CLAIMS_ENABLED` off. If cross-producer protection is wanted, change `claimForItem` to claim only the
competing **content** intents (new-blog, expand-existing, internal-link) and to release on completion; leave meta, repair and
technical fixes unclaimed. That is a code change and needs its own review.

---

## 6. Monday keyword-gap opportunities in the unified queue (proposal)

Today (verified): the Monday cron (`0 0 * * 1` UTC = 05:45 Kathmandu) runs `runKeywordGapShipCycleForAllSites`, which calls
`qualifyAndShipContentGaps`. It creates an Action Center recommendation per qualified gap and **also generates the draft itself**
(`generateDraft`, source `analyst-keyword-gap`), at 05:45, outside the orchestrator's generate and prepare stages. I found no push or
PR call in that file, so the PR is opened by the shipping run; whether it ships the same day is unverified.

Proposed: in the orchestrator's analyst stage on Mondays, run the gap refresh and the qualification with `deferDraft: true` (the
option already exists), so each gap becomes a **recommendation only**. The generate stage then drafts it like any other, prepare
validates it, and the single 11:00 ship run opens one pull request per project containing everything. The separate Monday cron is
retired at the cutover. Python's gap discovery (`save_keyword_gaps`) stays a findings write.

---

## 7. Decisions needed

1. Production Python timing: move it earlier (and accept data one day staler), or move the app's ingestion ahead of it?
2. Trailing slash and http/https: merge or keep apart? (Per project if it differs.)
3. May the read-only duplicate report and the parity report be run against production? (Both open a READ ONLY transaction.)
4. Build the corroboration fix (section 2) before the page-key migration?
5. Confirm `WORK_CLAIMS_ENABLED` stays off.
