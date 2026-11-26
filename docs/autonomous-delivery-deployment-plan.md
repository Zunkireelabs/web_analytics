# Autonomous delivery system: deployment plan, migration impact, rollback, and what only production can prove

Status: BUILT AND TESTED LOCALLY on `feature/autonomous-issue-resolution`. Nothing here has been merged, deployed, or applied to production. Merging to `main`
deploys automatically (`.github/workflows/deploy.yml` builds, runs migrations, restarts), so **every step below that says "merge" needs the owner's explicit OK.**

## 1. What ships

| Phase | Piece | Where |
|---|---|---|
| 0 | Worker window derived from one constant (cron could not drift again); nightly re-check ends before the window; skipped ticks logged; worker survives deploys, hands over finished answers through restarts, gives back orphaned claims at startup | `server/lib/worker-session.js`, `cron.js`, `tools/claude-code-worker/*` |
| 1 | Per-project daily record and item ledger | migrations 268, 269; `lib/delivery-cycle.js` |
| 2 | ETag conditional GitHub reads; least-recently-served ordering; DB pool error listener | `github/client.js`, `lib/site-run.js`, `db.js` |
| 3 | Strict design protection for every visible change | migration 272; `lib/design-protection/`, `design-agent/protection/` |
| 4 | 16:30 consolidation, preserved delivery, retrying day close | `lib/delivery-consolidation.js` |
| 5 | Content index + overwrite guard | migration 270; `lib/content-index/` |
| 6 | Evidence gate, article gate, per-article quarantine, 5-per-cycle ceiling | `lib/blog-cycle/` |
| 7 | Continuous research, ready pool, decision log | `lib/topic-research/` |
| 8 | pr_opened / human_merged / production_verified, alerts, status page | migration 271; `lib/delivery-{lifecycle,alerts,status}.js`, `/admin/delivery` |

## 2. Migration impact (all additive: `IF NOT EXISTS`, no data statements, no drops)

| # | Adds | Risk |
|---|---|---|
| 268 | table `delivery_cycles` | none (new) |
| 269 | table `delivery_items` | none (new) |
| 270 | tables `content_index`, `topic_decisions` | none (new) |
| 271 | 4 nullable columns on `drafts` (`merged_by`, `merged_by_type`, `merged_at`, `production_verified_at`) + one partial index | low: nullable columns, no rewrite of existing rows |
| 272 | tables `design_baselines`, `design_protection_decisions` | none (new) |

All five apply cleanly in order on a fresh database via the repo runner (279 migrations). Numbers 268-272 are free on `main` (it ends at 267) and no open branch or PR uses them; claim them in the PR description.

## 3. Switches and their first-deploy values (all in code, so a deploy with no env change is the safe configuration)

| Flag | Values | Default | Effect when not `on`/`enforce` |
|---|---|---|---|
| `DELIVERY_RECORD_MODE` | on, off | on | off: no day record or item writes |
| `DELIVERY_CONSOLIDATION_MODE` | log, on, off | log | log: reports what it would open, touches nothing on GitHub |
| `DELIVERY_ALERTS_MODE` | log, on, off | log | log: logged + on the status view, no email |
| `GITHUB_CONDITIONAL_GETS_MODE` | on, off | on | off: every read unconditional, as before |
| `DESIGN_PROTECTION_MODE` | off, log, enforce | log | log: records what it would hold, ships unchanged |
| `BLOG_EVIDENCE_GATE`, `BLOG_ARTICLE_GATE`, `OVERWRITE_GUARD`, `TOPIC_RESEARCH` | off, log, on/enforce | log | log: decisions recorded, nothing held or proposed |
| `BLOG_CYCLE_MAX` | number | 5 (a ceiling, never a quota) | |

A value that is not one of the listed ones falls back to the default, never to the enabling value.

Existing production values that interact: `LLM_WORKER_MODE=on`, `DESIGN_GATE_MODE=enforce`, `NEWPAGE_RENDER_GATE_ENABLED=true`, `BLOG_DAY_EVERY_N_DAYS=3`, `BLOG_DAY_MAX_BLOGS=6`.
The laptop worker script changed: restart it after the deploy (`tools/claude-code-worker/README.md`).

## 4. Deployment sequence (each numbered step is its own merge, and its own OK)

1. **Merge the whole branch with every switch at its default.** Effects: day record written (observation only), 16:30/17:00 steps in log mode, design protection and the blog gates in log mode, research in log mode. The window now runs to 17:00. Check next morning: `[delivery-day]` lines for all six projects, `delivery_cycles` has six closed rows, `design_protection_decisions` and `topic_decisions` are filling, no `[db]` crash lines.
2. **Day 1-2 of log mode:** read `protectionSummary()` and the status page. Question to answer: would enforcing take any client's output to zero? Look at `awaiting-baseline` volume per client and let the baseline queue (every 30 minutes) fill it.
3. `DELIVERY_CONSOLIDATION_MODE=on`, `DELIVERY_ALERTS_MODE=on`.
4. `OVERWRITE_GUARD=enforce`, then `DESIGN_PROTECTION_MODE=enforce` client by client only after its baselines are `ready` and its log-mode would-block rate is understood.
5. `BLOG_EVIDENCE_GATE=enforce` and `BLOG_ARTICLE_GATE=enforce` once each client has a verified business profile (not checked for all six yet).
6. `TOPIC_RESEARCH=on` after reading one cycle of logged decisions.
7. Production data actions, each separately approved: restoring the 17 abandoned blog drafts' content into the pool (a re-screen, not a write to client repos); re-screening the 104 open blog recommendations through the gates (a dry run first).

MOBILISE stays review-first with PRs to staging until the owner says otherwise.

## 5. Rollback

| Level | How | Time |
|---|---|---|
| One piece | set its switch to `off` (or `log`) in the deploy env and redeploy | minutes |
| Code | `.github/workflows/rollback.yml`, or revert the merge commit | about 10 min |
| Schema | nothing to undo: new tables and nullable columns are ignored by old code | n/a |
| Worker laptop | restore the previous `tools/claude-code-worker/` and restart it | minutes |
| Data | every production data action prints its own backup file and restore command first | minutes |

Delivery branches (`action-center/batch-<site>-<date>`) are never deleted by this system.

## 6. What local testing cannot prove (needs real days on production)

- Real client templates through the design protection (fixtures and a real browser were used, not live client pages): baselines may come out `unstable` for some templates.
- The relevance judge, article gate and proposal creation against real models and real business profiles (stand-ins were used).
- That a 304 really costs no GitHub quota in production (documented GitHub behaviour; measure the Zunkiree call count per pass before and after).
- The worker's real throughput on a blog day (30 blogs x about 3.4 minutes was estimated at about 16% of two lanes; the Claude usage limit on the laptop is unmeasured).
- Three consecutive real days, each with six closed day records by 17:00 Nepal time, each client holding a PR or a preserved delivery, at least one design-checked visible change shipped, and zero cases where a status says success while the item failed. Query for the last one: items with `state = 'shipped'` whose draft has no PR, and cycles with status `delivered` and no `pr_url`.
