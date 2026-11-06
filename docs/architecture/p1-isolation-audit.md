# P1 Phase 1: database isolation audit

Status: DRAFT for review. Read-only. No schema, role, migration, cron or production change was made.
Method: foreign keys and columns read from the local database (schema equals the migrations through 242); row counts and role facts read from the live Supabase database in a read-only transaction. No client content was read.
Companion to `p0-master-agent-and-instances.md` (revision 2).

## 1. The 45 tables that carry no `site_id`, `workspace_id` or `client_id`

Classes: A instance-private, B shareable aggregate, C training-eligible (opt-in), D platform-only. "Tenant path" is the foreign-key route to a tenant, read from the catalog.

### 1.1 Reach a tenant through a parent (isolation depends on the parent being filtered)
| Table | Tenant path (verified FK) | Class |
|---|---|---|
| approval_history | investigations.investigation_id -> client_id | A |
| investigation_events | investigations.investigation_id -> client_id | A |
| forecast_points | forecast_runs.forecast_run_id -> client_id | A |
| feature_importance_scores | feature_importance_runs.run_id -> client_id | A |
| root_cause_analysis_nodes | root_cause_analysis_runs.run_id -> client_id | A |
| copilot_messages | copilot_conversations.conversation_id -> site_id | A |
| watchlist_item_history | watchlist_items.watchlist_item_id -> site_id | A |
| execution_job_recommendations | execution_jobs, recommendations, drafts -> site_id | A |
| product_growth_config | products.product_id -> site_id | A |
| prospects | products.product_id -> site_id | A |
| trial_signups | products.product_id -> site_id | A (also pre-tenant) |
| password_resets, login_codes* | users.user_id -> site_id | D (credentials) |
| get_started_signups, onboarding_drafts, return_requests, signup_resume_links | users.user_id -> site_id | D (pre-tenant, personal data) |
| signup_requests | users, sites(created_site_id) | D |
| free_audit_leads | free_audit_reports.report_id | D (public lead data) |
| audit_log | sites(actor_site_id), sites(tenant_site_id) | A/D (it names a tenant on both sides) |
| workspaces | sites(legacy_site_id) | tenant root |

\* `login_codes` has no foreign key in the catalog and its columns were not inspected. Listed as class D (credentials) pending that check.

### 1.2 Platform tables, not tenant data (class D)
alembic_version, schema_migrations, session, job_locks, rate_limits, platform_activations, signup_recovery_settings, contact_requests, free_audit_reports, model_registry, model_registry_log, training_datasets.

### 1.3 Shared knowledge by design (class B, must stay aggregate or public)
industry_knowledge, industry_knowledge_log, commoncrawl_backlink_domains, commoncrawl_backlink_summary, commoncrawl_graph_releases, metrics_catalog, metric_dimension_support.

### 1.4 Findings that need a decision or a closer look
| Table | Observation | Risk |
|---|---|---|
| `query_translations` (query, language, translation) | A shared cache keyed by search query text. Those queries come from clients' Search Console data, stored with no tenant key. | Raw client search terms sit in a shared table. Low harm (a translation cache) but it breaks "class A never leaves the project". |
| `expand_structure_specs` (spec, `derived_from_site_id`, pages_observed) | A spec derived from one site's pages and stored with only a source-site column. | If a spec derived from client X is applied to client Y, structure learned from X crosses clients. Needs a check of how it is read. |
| `engineering_fix_lessons` (symptom, root_cause, fix_pattern, source_ref) | Global by design, but free text with a `source_ref`. | Could carry client-specific text; content not inspected. |
| `internal_errors` (message, stack, causes) | Platform error log, no tenant key. | Messages can contain URLs, page text or queries from any tenant. Must be platform-admin-only. |
| `clients` (analyst root, id = `sites.id`) | See section 2. | The convention is the only link to `sites`. |

None of these were changed.

## 2. The 27 tables with a `client_id` column (23 tenant tables + 4 OAuth tables)

- **23 reference `clients(id)`** with a real foreign key: ai_activity_log, analyst_recommendations, anomalies, client_business_values, confidence_scores, effort_estimations, executive_briefings, feature_importance_runs, forecast_accuracy, forecast_runs, impact_predictions, impact_projection_runs, ingestion_runs, insights, investigation_outcomes, investigations, metric_observations, metric_period_stats, opportunities, opportunity_scores, page_query_observations, recommendation_rankings, root_cause_analysis_runs.
- **4 are not tenants at all**: `oauth_access_tokens`, `oauth_authorization_codes` and `oauth_refresh_tokens` reference `oauth_clients`, and `oauth_clients` itself holds a text `client_id`. They identify an **OAuth application**, a different meaning of the same name. (My first draft said 24 + 3; the correct split is 23 + 4. The Phase 2 test now pins the count of 23.) Any "all client_id tables" rule or script must exclude them.
- **No foreign key links `clients` to `sites`.** `clients.id = sites.id` is a convention enforced only by `ensureAnalystClient` (`lib/tenant-provisioning.js`). Nothing in the database prevents an analyst client from pointing at the wrong site, or a site from being deleted while its analyst rows remain.

### Live integrity (read-only, aggregates)
| Check | Result |
|---|---|
| analyst clients | 3 |
| sites | 8 |
| clients with no matching site | 0 |
| sites with no analyst client | 5 (2 soft-deleted, 3 active but not yet connected) |
| name mismatches between `clients` and `sites` | 0 |
| status mismatches | 0 (all 3 active/active) |
| every analyst client has an MCP token | 3 of 3 |

The 5 sites without an analyst client are explained by connection state (the analyst is provisioned on connect), but it is a **provisioning gap candidate for P2**: nothing reports "this project has no analyst instance" other than the readiness check.

`ai_activity_log.client_id` is **nullable by design**: the analyst's own model describes it as a stage-level "what is the AI doing now" feed, "NOT per-client", with `client_id` left null. It is the only nullable one of the 23; the Phase 2 test pins that.

### Which production tenants are real (read-only, from the live database)
| Site | Evidence | Reading |
|---|---|---|
| 1 Zunkiree Labs | platform_admin user, 4,098 agent runs, repo connected | real (your own site / platform identity) |
| 8862 Admizz Education | tenant user, 3,666 runs, repo connected | real client |
| 8864 Chayce Properties | tenant user, 4,125 runs, repo connected | real client |
| 8866 Dental, 8867 Dentals | created 2026-10-29, soft-deleted, no user, no activity | test data |
| 8868 MOBILISE | created 2026-11-01, owner on its own domain, not connected yet, no runs | real client, onboarding not finished (confirmed by the owner of the platform) |
| 8869 Zennly | created 2026-11-01, owner at the company domain, not connected | the company's own upcoming product; setup not finished, to be completed by the platform owner later |
| 8870 Guntabya | created 2026-11-02, not connected, no runs | test data (confirmed) |

So three tenants run today, plus one real client (MOBILISE) waiting to be connected and one own project (Zennly) waiting to be finished. Two further facts from the same query: workspace 2 ("Zunkiree Labs") holds **five** sites, including the two real client sites, so those clients are separated by `site_id` only, not by workspace; and three users have no project yet (two empty workspaces).

### How the Python service is isolated
- Every per-client route takes `client_id` from the URL and runs `get_active_client` (404 unknown, 403 suspended). It is guarded by **one static admin key** (`require_admin_key`), not per-tenant credentials. The service's own comment says it is internal and never client-facing.
- Therefore **isolation of analyst data is enforced in the Node app**, not in the Python service: any caller holding the admin key can read any client by changing the URL.
- Node's client-facing routes build the path from the session (`routes/client-analyst.js`: `/clients/${req.siteId}/...`, `/ask/${req.siteId}`), and the other callers use the site id of the job or capability context. The one deliberately cross-client call is `/admin/learning`, used only from `routes/platform.js`.
- **Staff proxy** (`routes/dataAnalyst.js`, about 30 calls, imported under the alias `callPython`): paths take `:clientId` from the URL. It is safe only because the whole router sits behind `requirePlatformRole('platform_admin')`, which also requires the caller's home site to be the company site, and the client-facing mirror (`clientAnalystRouter`) overwrites `:clientId` with the session's own site. The Phase 2 test now asserts both properties, and it finds calls under any import alias (my first version missed this file).
- Gaps: a single shared key (no per-tenant credential, no audit of which tenant a call was for) and no database backstop (section 3).

## 3. Database role (unchanged from P0)
The application role `postgres` has `BYPASSRLS`; 149 tables have RLS on, none forced, with 0 policies. RLS therefore stops only Supabase's API roles (`anon`, `authenticated`), not the application. **Still unverified for production**: a human must read the production `DATABASE_URL` user name (never the password) and compare it with `postgres`.

## 4. Recommendations (nothing applied)
1. **Tests now (Phase 2):** a planted-marker test for every table family above, a static check that every analyst call path is built from a trusted site id, and one that no tenant text reaches the shared tables in 1.3.
2. **Look closer before P5:** `query_translations`, `expand_structure_specs`, `engineering_fix_lessons`, `internal_errors` (section 1.4). Each is a separate decision, with its own approval.
3. **Backstop candidates before P5** (the opt-in training material and memory): `drafts`, `agent_fix_memory`, `generator_outcomes`, `fix_impact`, `project_memory_log`, `decisions`, and the analyst `insights` / `investigations` / `metric_observations`. Not applied.
4. **P2 input:** a `clients`-to-`sites` link check in the factory (create and verify), and a per-tenant analyst credential as a later hardening step.

## 5. Not verified
- Contents of `engineering_fix_lessons`, `expand_structure_specs` and `internal_errors` (columns and keys only were read, not rows).
- How `expand_structure_specs` and `query_translations` are read by the generators.
- The production database role.
- That the analyst service is not reachable from outside the private network (not investigated; no servers were touched).
