# P0: Master Agent, client instances and data isolation

Status: REVISION 2 for review (decisions of 2026-11-05 incorporated). Specification only. No code, schema, migration, cron or production behaviour is changed by this document.
Measured on: 2026-11-05. Phases P4 (model router + Baseten) and P5 (training pipeline) are postponed, not removed.

## 1. Decisions already taken

1. One shared codebase, one platform Master Agent, one Agent Factory. A client **instance** is a *logical* Growth Agent, not a process. No duplicated codebases.
2. Training on client data or derived examples for shared or industry-level models is **opt-in**. Project memory and learning stay per project regardless.
3. Order: P0 spec, P1 admin visibility, P2 Agent Factory, P3 queue-based orchestration, then P4 and P5.
4. The decision engine, specialist agents, validation and GitHub shipping stay intact. Nothing here replaces them.
5. **Opt-in scope (decided).** Client data, derived examples and outcomes are used in shared or industry-level training or fine-tuning only with explicit opt-in. Anonymised, counts-only industry aggregates (class B) continue as they are. Project-specific memory and learning stay enabled for every project.
6. **Database isolation (decided).** Application-level scoping now, plus automated tenant-isolation tests, plus database-level backstops on the highest-risk tables **before P5**. The roughly 45 untyped tables are classified and the 27 `client_id` analyst tables investigated as the first P1 task. The production database role is verified (section 2.1). No schema, role or production behaviour changes until each is separately approved.
7. **P1 (approved scope).** A read-only admin instance view and isolation tests, nothing more.
8. **No automatic merging (decided).** The agent opens pull requests and never merges into `stage` or `main`. See section 11.
9. **P4 and P5 stay on the roadmap, not implemented.**

## 2. Measured facts (read-only; this is what the design stands on)

Source: a read-only transaction against the database the repo's `.env` points at (the live Supabase pooler). Aggregate numbers only; no client content was read. Assumption: production uses the same role as this connection. I did not look at the production host, so that is **unverified**.

**How the production role gets verified (P1, not yet done).** Two safe ways, neither touching the production host: (a) a human reads the production `DATABASE_URL` user name from the secret store (the user part only, never the password) and compares it with `postgres`; or (b) the production app exposes the same read-only catalog query (`select current_user, rolbypassrls from pg_roles ...`) through an existing admin diagnostics route, and a platform admin runs it. I recommend (a) because it needs no code. The result goes into section 2.1 and replaces the assumption.

### 2.1 Database tenant isolation
| Check | Result |
|---|---|
| Application role | `postgres`, not superuser, **`rolbypassrls = true`** |
| Tables in `public` | 149 |
| Row Level Security enabled | 149 of 149 |
| RLS **forced** (`relforcerowsecurity`) | 0 |
| RLS policies | **0** |
| Table owner | `postgres` for all |
| `anon` / `authenticated` grants | on all 149 tables |

**Conclusion.** The application role bypasses RLS, so RLS gives the app **no** tenant isolation. What migration 225 achieved is default-deny for Supabase's public API roles (`anon`, `authenticated`): they hold grants, but with RLS on and no policy they read nothing. That protects against Data API exposure. It does not separate one client from another inside the app.

**Tenant isolation today is therefore enforced only by application code:** every query is meant to carry `site_id` (or `workspace_id`, or the analyst's `client_id`). There is no database backstop. One query that forgets the filter leaks across clients, and nothing below the app would stop it.

### 2.2 Tenant keys across 164 tables (local schema, same migrations)
- 93 tables carry `site_id`. 2 more carry only `workspace_id`.
- 27 carry the analyst's `client_id` (`sites.id` by convention, per `lib/tenant-provisioning.js`). **This is a second tenant key** and is easy to miss in an isolation review.
- About 45 carry no tenant key. First-pass classification (by name; foreign keys not yet checked per table):
  - platform or pre-tenant: sign-ups, return requests, leads, login codes, sessions, rate limits, locks, migrations, audit log.
  - shared knowledge by design: `industry_knowledge*`, `commoncrawl_*`, `model_registry*`, `training_datasets`, `metrics_catalog`.
  - child rows that reach a tenant through a parent (for example `forecast_points`, `investigation_events`, `root_cause_analysis_nodes`, `approval_history`, `watchlist_item_history`).
  - **to verify individually in P1:** `copilot_messages`, `product_growth_config`, `engineering_fix_lessons`, `query_translations`, `internal_errors`, `expand_structure_specs`.
- The `sites` table has 108 columns. That is where most of an instance's configuration lives today.

### 2.3 Execution time and resources
- Production has 8 sites: 6 active, 2 soft-deleted. **3 are connected and analysed daily** (1, 8862, 8864). Sites 8868 to 8870 have no GSC/GA4 yet.
- **`auto_remediation_enabled` is false on every site.** All 235 auto-remediation runs in the last 14 days ended `disabled`; 8 drafts were created in 14 days. **Autonomous shipping is not running in production today.** Surge Mode and the atomic ceiling only take effect once a project's flag is switched on.
- Daily agent analysis, steady state: about 17 to 29 agent runs per site per day, **130 to 460 s** of summed agent time per site. The whole daily window for 3 sites spans about 30 to 60 minutes (01:00 to 02:30 UTC), so **roughly 10 to 20 minutes of wall time per site** once ingest, narrative and email are included.
- Slowest agents (p95): `executive-report` about 310 s, `blog-image` about 110 s, `technical-seo` about 60 s, `duplicate-content` about 54 s, `visual-quality` about 49 s, `font-consistency` about 47 s (the last two drive a browser).
- Two bursts (Oct 29 to 30: about 300 runs per site) are visible; I believe they were one-off backfills but did not confirm.
- Database: 195 MB. `max_connections` is 60 with 13 in use. The app pool is 10 connections per process.
- Not measured: host CPU and memory, LLM spend per site, GitHub call counts. Code comments cite a 5,000 per hour GitHub budget shared per installation.

### 2.4 What this means for P3
- Sequential at today's wall time, **100 sites is about 17 to 33 hours**. It cannot fit in a day. This is an estimate extrapolated from 3 sites, not a measured result.
- Concurrency has three real ceilings: DB connections (60 total, shared with the Python analyst and the web tier), the browser-driving agents (memory heavy), and the GitHub token budget per installation. The queue needs per-resource limits, not just a worker count.
- The first queue milestone is therefore modest: a few workers, a per-resource semaphore, then raise.

## 3. Instance specification (InstanceSpec v1)

An instance is the complete set of state and configuration for one project. It must be readable as one object (P1) and creatable by one idempotent procedure (P2).

| Part | Where it lives today | Owner |
|---|---|---|
| Identity | `sites` row, `workspace_id`, `client_number`, analyst `client_id` (= `sites.id`) | Factory |
| Lifecycle state | `sites.status`, `growth_started_at`, `surge_mode_until` | Factory, then Master |
| Connections | GSC / GA4 / PostHog / repo / CMS columns and tables | Client onboarding |
| Configuration | feature flags and limits on `sites` (autonomy, `auto_remediation_*`, rank tracking, competitor growth, target places, brand colour) | Instance |
| Business context | `site_profiles`, capabilities, design profile | Instance |
| Project memory | `project_memory_log`, `agent_fix_memory` (client scope) | Instance |
| Execution history | `agent_runs`, `drafts`, `shipping_queue`, `auto_remediation_runs`, `deployments`, `fix_impact` | Instance |
| Behaviour and outcome learning | `generator_outcomes`, `fix_impact`, behaviour-learning tables | Instance |
| Analyst data | the 27 `client_id` tables, in the Python service | Analyst service |

**Lifecycle (proposed, P2):** `requested -> provisioning -> connecting -> baselining -> active -> paused -> offboarding -> soft_deleted`. Only `active` and `soft_deleted` exist in practice today; the rest are inferred from flags and are what P1 makes visible.

## 4. Master Agent: responsibilities and boundary

**Owns (P3):** which instance runs next and when; fairness across clients; platform-wide budgets (GitHub per installation, model spend, DB connections, browser slots); instance health, stuck-job detection and retry; lifecycle transitions.

**Does not own:** what a finding is, how it is ranked, whether it ships, or how it is written. Those stay with the specialist agents, decision engine, daily queue, autonomy gates and shipping workflow. The Master Agent calls them for one instance at a time.

**Today's pieces it grows out of:** `cron.js` / `job.js` (when), `agents/orchestrator.js` (per-site report fan-out), `lib/autonomous-quota.js` (how much), `lib/job-lock.js` (mutual exclusion).

## 5. Isolation contract

| Class | Rule | Examples |
|---|---|---|
| A. Instance-private | Never leaves the project. Every read is keyed by that project. | pages, queries, drafts, memory, designs, competitors, credentials |
| B. Shareable aggregate | May leave only as counts of labelled categories from enough distinct projects and workspaces. | industry patterns (`MIN_SITES` 3 plus distinct workspaces today) |
| C. Training-eligible | Only for projects with an explicit opt-in, scrubbed, split by workspace. | `training-examples.js` output |
| D. Platform-only | Not tenant data. | sign-ups, rate limits, locks, model registry |

**Requirements derived from the findings above**
1. Treat application code as the only isolation layer until a database backstop exists (section 7).
2. Every new table declares its class and its tenant key in its migration header.
3. Isolation tests plant a marker string in one project and prove it never appears in another project's output. Extend `layer-isolation.db.test.js` to the analyst `client_id` tables and to the model-context injectors (`withAgentMemory`, `withDesignContext`, `withCompetitorContext`).
4. Cross-client reuse (`learned-repair` borrowing a fix) must keep carrying no client text. It stays a P1 audit item.

## 6. Data permission (opt-in)

Proposed per project, default **none**, changeable only by a workspace owner, every change logged:
`none` (default) < `industry_aggregate` < `shared_training` < `dedicated_model`.
Class C data is built only from projects at `shared_training` or above. A dedicated model for a client trains only on that client's data and only at `dedicated_model`.

**Decided.** Opt-in governs class C (client data, derived examples and outcomes used for shared or industry-level training, and any dedicated-model training). Class B, anonymised counts-only industry aggregates built from enough distinct projects and workspaces, continues for all projects, because it carries no client text, URL, query or domain. Class A (project memory and learning) is unaffected and stays on for every project. The structural privacy tests on class B stay and are extended in P1.

The permission itself is a P5 prerequisite, so **no column or table is added now**. P1 only shows the (default `none`) permission as a read-only field in the instance view if it already exists in code; it does not exist yet, so the view shows "not configured, treated as none".

## 7. Database isolation options (decision for P1/P2, not built here)

| Option | Gives | Cost / risk |
|---|---|---|
| A. Keep app-level scoping, add tests and a query lint | Zero production risk | No database backstop |
| B. Separate least-privilege app role without `BYPASSRLS`, with policies keyed on `site_id` / `workspace_id` set per request | A real backstop | Large change touching every query path; a policy mistake takes the app down; the Python service needs the same |
| C. Restrict only the highest-risk tables (training and memory) with policies, reached only through a narrow role | Backstop where leaks cost most | Two access paths to maintain |

**Decided:** A now (tests, query lint, no role or schema change); C before P5 starts, for the tables that hold class C source material and project memory, each as its own approved change; B stays a later decision using what P1 measures.

## 8. Gap list

1. No single readable "instance" view; the state is spread over `sites` columns and about 120 tables (93 by `site_id`, 27 by `client_id`, 2 by `workspace_id`).
2. No lifecycle state machine. The status values are `active` and `soft_deleted` only.
3. Two tenant keys (`site_id`, analyst `client_id`) and about 45 untyped tables.
4. No database-level isolation (section 2.1).
5. A sequential daily loop that does not scale to 100 sites (section 2.4).
6. Autonomous shipping is off everywhere, so the loop that Surge Mode and the ceiling serve has no production traffic yet.
7. Industry aggregation is not gated by consent (section 6).
8. No per-resource budget: DB connections, browser slots and GitHub budget are managed implicitly.

## 9. P0 exit criteria and P1 scope

P0 is accepted when this revision is approved. P1 (read-only) then proceeds in this order:

1. **Classify the roughly 45 untyped tables.** For each: class (A to D), tenant path (own key, or the parent table and foreign key that reaches it), and evidence (the foreign-key definition, read from the catalog). Output is a table in this document's appendix. No schema change.
2. **Investigate the 27 `client_id` analyst tables.** Confirm that `client_id` equals `sites.id` for every row, find rows whose `client_id` has no site, check how the Python service scopes its own queries, and list which of its endpoints can read across clients. Report only; no change to the Python service.
3. **Verify the production database role** (section 2.1).
4. **Isolation tests.** Extend `layer-isolation.db.test.js` to the analyst tables and the three model-context injectors, using planted marker strings. They run on the local database only.
5. **Read-only admin instance view.** Platform-admin only, assembled from section 3 for one project at a time: identity, lifecycle, connections, flags and limits, growth stage and surge status, last runs, memory versions, counts of drafts and outcomes, training permission ("not configured, treated as none"). No write action anywhere on the page. It follows the mockup-first rule: mockups for your review before any build.

Out of scope for P1: any schema or migration, any role change, any change to scheduling or shipping, the factory, the queue, P4 and P5.

## 10. Not verified

- That production runs with the same database role as this connection.
- Foreign keys of the child tables listed as "reach a tenant through a parent".
- Host CPU and memory, per-site model spend, GitHub call volumes.
- Whether the Oct 29 to 30 bursts were one-off.
- Whether GitHub branch protection and the `production` environment approval are configured as section 11 assumes (the workflow files are read; the GitHub settings are not visible from here).
- The 100-site extrapolation.

## 11. Git workflow: no automatic merging

### 11.1 The flow
```
 agent: branch + commits ──► PR  feature/…  ->  stage        (agent opens, never merges)
                                      │  CI checks (ci.yml)
                      HUMAN reviews + merges into stage
                                      │  push to stage triggers deploy-staging.yml
 agent: detects the stage merge, checks stage is green
        ──► promotion PR  stage  ->  main                      (agent opens, never merges)
                                      │  CI checks
                      HUMAN reviews + merges into main
                                      │  push to main triggers deploy.yml (environment: production)
 agent: verifies the production deployment (read-only), reports
```

### 11.2 What the agent may and may not do
| May | May not |
|---|---|
| Create a branch named `<type>/<KEY>-<n>-<name>`, commit, push the branch (after the human's OK to push) | Merge any PR into `stage` or `main`, by any means (button, `gh pr merge`, API, auto-merge) |
| Open a PR to `stage` with the ticket id in the title | Enable GitHub auto-merge on any PR |
| After a human stage merge: open the promotion PR `stage -> main`, with the list of included PRs and the check results | Push directly to `stage` or `main` |
| Read CI and deployment status, and verify production after the human merge | Approve its own PR, or bypass required checks or reviews |
| Report failures and stop | Re-run a failed deploy or roll back without being asked (`rollback.yml` is a manual workflow) |

### 11.3 Making "no merge" structural, not a promise
Instructions alone are not enough, so the platform should enforce it. These are GitHub settings, changed by a repository admin, not by the agent:
1. Branch protection on `stage` and `main`: require a pull request, at least one human approval, required status checks (`ci.yml`), no direct pushes, no force pushes, and "restrict who can merge" to named humans.
2. The agent's GitHub credential has write access to branches and pull requests only. It is not in the merge allow-list, and **auto-merge is disabled** at repository level.
3. The `production` environment requires a human reviewer (already named in `deploy.yml`; whether the approval rule is set is not visible from here).
4. Existing evidence for the same principle on **client** repositories: the platform's own shipping ends at an open PR and never merges (`drafts-agent-cannot-merge.test.js`, `no-direct-production-pr.test.js`). This section applies the same rule to the platform's own repository.

### 11.4 Prerequisites that do not exist today
- **There is no `stage` branch.** `origin` has only `main` and feature branches, and `CLAUDE.md` says PRs target `main` until ticket SRANK-20 decides when `stage` returns. The workflows `ci.yml` (PRs to `main` and `stage`) and `deploy-staging.yml` (push to `stage`) are already written for it. A local `stage` branch still exists in this checkout (at `958d6c8`, its remote deleted, fully contained in `main` and 82 commits behind `origin/main`), but it is not a restored branch and must not be treated as one. Bringing `stage` back is the owner's decision under SRANK-20, which this document does not change; a human restores and protects it when that decision is made.
- Until then the agent follows today's rule: PRs target `main`, and a human merges them. Merging to `main` deploys production automatically (`deploy.yml`), so this is the stricter of the two situations.
- **The promotion PR is prepared by the agent, subject to checks.** Preconditions it must verify and show in the PR body before it opens one: the stage merge commit exists; `ci.yml` and `deploy-staging.yml` are green on that commit; the diff `main...stage` contains only reviewed, merged PRs; migrations in the diff are listed explicitly (the deploy applies them automatically); no unresolved review threads. If any precondition fails, it opens no PR and says why.
- **Migrations and promotion.** Any migration in a promotion PR is flagged at the top of the PR, since merging to `main` applies it to production.

### 11.5 Verifying production after the human merge
Read-only, and only what is reachable from here: the GitHub Actions run for the merge commit (all jobs green), the deployed commit SHA matching the merge commit, the health endpoint, and the new migration version appearing in `schema_migrations`. It reports each result as verified or not verified. It does not investigate any server by address.

### 11.6 Roadmap status
| Phase | Status |
|---|---|
| P0 Architecture | revision 2, awaiting approval |
| P1 Admin visibility + isolation tests | approved scope, starts after this revision is approved |
| P2 Agent Factory | queued |
| P3 Queue-based Master Agent | queued, before P4 |
| P4 Model router + Baseten | postponed, on roadmap, not implemented |
| P5 Training pipeline | postponed, on roadmap, not implemented |
