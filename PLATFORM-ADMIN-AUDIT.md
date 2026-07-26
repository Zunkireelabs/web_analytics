# Audit: Current Administration Capabilities — Zunkiree Analytics

**Context.** Before designing a "Zunkiree Platform Administration" system, the user asked for a factual audit of what admin capability already exists in the codebase today, across 10 specific areas — no proposals, no new design. This document is that audit, verified against the actual source (not the `master-product` skill doc, which is stale in places — it doesn't mention `signup_requests`, `api_tokens`, `Settings.jsx`, or the `/clients` staff console at all). This is a pure research deliverable; no code was or will be changed as part of this task.

---

## 1. Authentication & Users

**Login — fully implemented.** `POST /api/login` (`server/routes/login.js:14-27`), email+password, bcrypt, Postgres-backed session (`connect-pg-simple`, survives restarts). Session encodes `userId` **and** `siteId` together — one login is tied to exactly one tenant. `requireAuth` (`login.js:168-175`) is the sole gate for every client-facing route.

**User model — implemented, minimal.** `users` table (migration `011`): `id`, `site_id` (FK, cascade delete), `email` (globally unique across all sites), `password_hash`, `created_at`. No `role` column. `server/store/users.js` has `getUserByEmail/createUser/getUserById/updateUserPassword` — no `deleteUser`, no `listUsersForSite`.

**Roles — coarse, binary.** No `role`/`is_admin` column anywhere. The only tier split is "internal" vs "client," computed as `session.siteId === process.env.COMPANY_SITE_ID` (`isInternalSite`, `login.js:160-163`), enforced via `requireInternalSite` middleware (404s, not 403, so a client can't even detect the route). A separate 4-tier model (`read_only < ai_actions < automation < admin`) exists but only governs **MCP API tokens**, not human users — every logged-in human already has full access to their own site.

**Site ownership — implemented.** `users.site_id` is the ownership link. Every data route reads `req.siteId` from the session, never from a client-supplied param.

**Multi-user support — not implemented.** `users.email` is globally unique, one row = one login = one site. No invite mechanism, no join table. Confirmed via all 4 call sites of `createUser()`: CLI script, and two staff-only routes in `clients.js`. `Settings.jsx` has no "add a teammate" UI. Today, multiple people sharing a client account must share one password.

## 2. Client / Tenant Management

**`sites` table — implemented, evolved through ~15 migrations** (001 → 049): core identity/timezone, Google Doc IDs per report type, `website_domain`, `logo_data_url`, `report_email_to`, narrative caches, `onboarded_at`/`baseline_run_id`, GitHub repo config (`repo_owner/name/url/default_branch/tech_stack/github_pat_env_var/url_file_map`), growth-plan narrative cache.

**Client onboarding — implemented, two parallel paths:**
- **CLI**: `npm run create-client` then `npm run connect-site` (`server/scripts/`).
- **Staff web UI** `/clients` (`ClientOnboarding.jsx`, gated `isInternal`) backed by `server/routes/clients.js` (`requireAuth, requireInternalSite`): create site → connect GSC/GA4 (triggers a live baseline pipeline: discovery, real ingest, one agent run, site audit) → optional GitHub repo connect → retry-baseline → per-client review report → cross-client growth summary.

**Public signup — implemented as request-then-approve, not auto-provisioning.** `signup_requests` table (migration `037`): public `POST /api/signup-requests` hashes and stores a pending request; staff list/approve/reject in `clients.js` (approve does an atomic claim to prevent double-approval, then runs the same create-site+create-user sequence). A separate, simpler `contact_requests` flow (migration `046`) handles sales leads — no password, no account, staff review happens outside the app.

**Client deletion — completely missing.** No `DELETE FROM sites` anywhere, no `deleteSite`/`deleteClient` function, no UI/API/script path. Child-table FKs are `ON DELETE CASCADE` so a manual DB delete would cascade cleanly, but nothing triggers one.

**Client-specific settings — implemented, but staff/CLI-writable only.** `report_email_to`, `logo_data_url`, `website_domain`, timezone, repo config all live on `sites`. Only write paths: `clients.js` (staff-gated) or CLI scripts. A logged-in client cannot edit their own logo, domain, or report recipient anywhere in the product today.

**Tenant isolation — implemented, consistent.** Every fact/data table carries `site_id`; every route derives `req.siteId` from the session (never a client-supplied param). Single shared Postgres DB/single process — isolation is row-level, not per-tenant DB/schema.

## 3. Integrations

| Integration | Status | Notes |
|---|---|---|
| Google Search Console | Fully automated | Shared OAuth (env vars) or optional per-site service account (`secrets/clients/<id>/`, currently unused). Daily cron ingest. |
| GA4 | Fully automated | Same credential model. Daily cron ingest. |
| Google Docs | Automated (daily/weekly/executive) + manual monthly | 4 report types write to per-site Docs; **monthly has no cron trigger**, CLI-only. |
| GitHub | Manual/on-demand only | Client-facing Action Center feature (opens PRs on the *client's own* repo with AI-approved fixes). PAT-based, no octokit. Merge to `main` is explicitly never automated. |
| Email | Automated (reports) + synchronous (leads) | Nodemailer/SMTP. Daily report email is cron-triggered; contact-lead email fires on form submit. |
| AI/LLM (OpenAI/Anthropic) | Implemented, provider auto-selected | `server/llm.js`. A second, opt-in "agentic" multi-round orchestrator exists, gated behind an env flag + real API key, off by default. |
| DataForSEO (SERP + backlinks) | Automated, monthly cadence | Optional; agents degrade honestly without credentials — matches the memory note that real SERP data is still budget-gated. |
| Google Custom Search | Automated | Free alternative to DataForSEO SERP. |
| Common Crawl | Manual only | Reads from own DB, populated by an un-scheduled script — matches memory note that this ETL still needs a real scheduled run. |
| PageSpeed Insights | Automated, optional | Core Web Vitals input for technical-seo agent. |
| Slack/Teams/push/Stripe/WordPress/Shopify | Not implemented | Only mentioned in code comments as future extension points. In-app notifications are the only working channel. |

## 4. Background Services

**Cron (`node-cron`, `server/cron.js`) — implemented, no queue system.** No Bull/pg-boss/Agenda anywhere — every job is a cron callback, a manual CLI script, or a synchronous request handler.
- Daily (default 07:00): ingest → narrative → email → daily doc → 11 daily-cadence agents → notifications → watchlist sync.
- Weekly (default Thu 08:00): page discovery → weekly doc → competitor/authority/ai-recommendation agents (monthly-cadence, gated inside) → executive report doc.
- Hourly catch-up guard, boot-time startup catch-up, boot-time stale-audit-run reaper, hourly fix-verification re-checker.
- **Monthly Google Doc report has no cron entry** — CLI-only gap.

**Agent orchestration — implemented, well-factored.** `server/agents/registry.js` auto-discovers ~15 agents. `runner.js` is the single choke point (timing, persistence, live SSE events). Two orchestrators: a fixed fan-out (`orchestrator.js`, used by cron) and an opt-in LLM-driven multi-round one (`lib/agentic-orchestrator.js`). Triggered by cron, manual per-agent API call, Command Center refresh, or MCP tool calls — every path funnels through `runAgent()`.

**Report generation — mixed automation**, see table in §3/cron above; monthly is the one manual-only report type.

## 5. Monitoring

**System-health dashboards — none.** Every dashboard in the app is client-facing SEO/growth analytics, scoped by session `siteId`. No ops dashboard (CPU/memory/uptime/latency/DB pool).

**Logging — raw `console.log`/`console.error` only.** No logging library (no winston/pino/morgan), no log files/rotation/aggregation, across ~62 server files.

**Error handling — one centralized Express handler** (`server/index.js:121-124`): logs to stdout, returns generic 500. No error-tracking service (no Sentry). No `process.on('uncaughtException'/'unhandledRejection')` — confirmed zero hits.

**Health endpoints — minimal.** `GET /api/health` returns `{ok:true}` only, no dependency checks. Closest thing to real ops monitoring is `GET /api/integrations/health` + `POST /api/integrations/:id/check` (staff-only) — but that's third-party *integration* connectivity, not app/server health.

**Metrics — `server/routes/metrics.js` is entirely client analytics** (GSC/GA4 numbers), not system/ops metrics. No request-rate/latency/error-rate instrumentation exists anywhere.

## 6. MCP (Model Context Protocol)

**Status vs. plan doc:** `MCP-PLAN.md` still opens with "Status: planning only — nothing in this document has been built yet." That is false — MCP is fully implemented and mounted live (`server/index.js:24,80`) — but the shipped design diverged from the plan (4-tier permissions vs. the plan's 2-tier `read_only`/`full`; `server/mcp/tools/` split into 4 files vs. one). The plan doc should not be trusted as current-state documentation.

**Everything implemented:**
- `server/mcp/auth.js` — bearer-token middleware, with local in-memory rate limiting (60 req/min per token, 20 invalid/min per IP) — explicitly noted in comments as "not production-grade," per-process only.
- `server/mcp/permissions.js` — 4 tiers: `read_only < ai_actions < automation < admin`, `atLeast()` ordering, fails closed on unknown levels.
- 23 read-only tools (site info, series/breakdowns/movers, agent status/activity/runs, command center, drafts, recommendations) — always registered.
- 8 `ai_actions` tools (run agent, refresh, generate/update/delete/submit draft, mark implemented) — `rollback_draft` deliberately excluded from MCP at every tier, dashboard-only by product decision.
- 4 `automation` tools (approve/push/open-PR/check-PR-status) — anything touching GitHub.
- 3 `admin` tools (list/create/revoke tokens) — an `admin` token can mint further `admin` tokens with no extra human confirmation (documented deliberate choice).

**Token system — implemented.** `api_tokens` table (migrations 054-056): SHA-256 hash (not bcrypt, deliberate), prefix for UI display, `permission_level` (CHECK-constrained), `created_via_token_id` (provenance/audit trail for self-minted tokens). Self-serve HTTP routes (`mcp-tokens.js`) gated by `requireAuth` only — every client, not just staff, can mint tokens. High-tier creation requires re-entering the account password first (`verify-password`) — explicitly a "speed bump, not a hard boundary" per code comments.

**Frontend — `McpTokensCard.jsx`**, embedded in `Settings.jsx`: create/list/revoke, tier picker, one-time plaintext display, ready-made `claude mcp add` snippet.

**Missing/not implemented (all deliberate, not accidental):**
- No cross-tenant MCP admin surface at all — no tool or route lists/audits/revokes tokens across sites; every MCP capability is scoped to the calling token's own site.
- No MCP request audit log beyond a single `last_used_at` timestamp.
- No MCP Resources or Prompts — Tools only.
- App-wide rate limiting doesn't exist outside the MCP endpoint itself.

## 7. Existing Settings Pages

**Customer-facing (`/settings`, unconditional for every session):** account email display (read-only), self-service change-password, and `McpTokensCard` (token create/list/revoke). That's the entire client-facing settings surface — no profile/branding self-edit, no notification/report-email self-edit, no team/user management.

**Internal-only (`/clients`, `isInternal`-gated):** the de facto platform admin console — client list w/ status, new-client creation, signup-request approve/reject queue, connect GSC/GA4 (triggers live baseline pipeline), retry-baseline, connect-repo, per-client review report, cross-client growth summary. No delete/deactivate capability here either.

## 8. Hidden / Internal Routes

**Staff-gated (`requireAuth` + `requireInternalSite`, mounted last in `server/index.js` due to a documented ordering hazard):** `clients.js` (platform console), `copilot.js` (AI Copilot chat), `integrations.js` (integration health), `notifications.js`, `watchlist.js`, `commoncrawl-backlinks.js`.

**Naming trap — NOT staff-gated despite sounding internal:** `agents.js`, `action-center.js`, `command-center.js`, `growth-report.js`, `site-audit.js` are all client-facing, `requireAuth`-only, scoped per-session. Code comments explicitly flag this ("client-facing growth tooling... never a staff-only cross-client view").

**MCP router** (`mcp.js`, `mcp-tokens.js`) sits in its own auth lane (bearer token, not session) and must be mounted before every `requireAuth` router or it gets 401'd by session auth first — a confirmed-live bug the mount order now prevents.

## 9. Internal-Only Features

Frontend gating all keys off one boolean, `GET /api/me`'s `isInternal`:
- `/clients` route + sidebar nav section (only fully staff-only page).
- AI Copilot floating button/panel.
- `NotificationBell` in the sidebar.
- `/milestones` "All Clients" toggle (the route itself is client-reachable; only the cross-client aggregate view is staff-only).
- `/settings` is explicitly **not** gated — every account gets it.

## 10. Future Platform-Administration Building Blocks

What already exists and could become modules of a future admin console, versus what's a genuine gap:

**Reusable as-is / extend:**
- `clients.js` + `ClientOnboarding.jsx` — already 80% of a tenant-management console (list, create, approve signups, connect integrations, review health). Missing only: edit-in-place, delete/deactivate, audit trail of who changed what.
- MCP's 4-tier permission model (`permissions.js`) — the pattern (not the code) could generalize from "token tiers" to "human user roles," since human roles don't exist yet.
- `integrations.js` health-check pattern — could extend from GSC/GA4-only to a general per-integration ops panel.
- Agent registry/runner (`registry.js`/`runner.js`) — already a clean single choke point; an admin console could surface it directly (run any agent for any site, view run history) with only a UI layer, no new backend.
- `api_tokens` provenance column (`created_via_token_id`) — already gives a partial audit trail; extending it to a full action log (who did what, when) is additive, not a rewrite.

**Genuine gaps with no existing building block:**
- Human roles/permissions beyond the single internal/client boolean.
- Multi-user-per-tenant / team management.
- Client self-edit of their own settings (logo, domain, report email).
- Client deletion/deactivation, anywhere.
- Any system/ops monitoring (logging library, error tracking, real health checks, app metrics) — an admin console would currently have nothing to surface here.
- Cross-tenant MCP token visibility/audit for staff.
- A real action/audit log across the platform (who created/approved/deleted what, when) — currently only implicit in scattered timestamps (`created_by`, `created_via_token_id`, `reviewed_at`).

---

This audit is complete. No design or implementation follows from this task — the user will decide next steps separately.
