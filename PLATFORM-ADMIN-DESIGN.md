# Zunkiree Platform Administration — Architecture & Design

**Status: design only. Nothing in this document is implemented.** No files were modified, no migrations were run, no routes or UI were created to produce this document.

**Revision note**: this version incorporates every required change from `PLATFORM-ADMIN-REVIEW.md`'s security/architecture review. The architecture is unchanged in shape from the prior version — the review found the layering sound — but Phase 0/3/3.5/4/5/6 and the schema in §G.3 have material corrections. Source of truth for "what exists today" is `PLATFORM-ADMIN-AUDIT.md`, cross-checked directly against migrations and source during both the original design pass and this revision (see inline citations below for anything re-verified specifically for this revision, including migrations 057–061 and `server/mcp/oauth-provider.js`, which post-date the original audit and were not in the first version of this document).

**Non-negotiable constraint carried through this whole design**: the existing multi-tenant architecture is untouched. `sites` stays the tenant table, `users.site_id` stays the ownership link, tenant data stays isolated by `site_id`, and the customer-facing dashboard (analytics, agents, Action Center, Command Center, integrations, MCP self-service) is not redesigned. Platform Administration is a layer *above* this, not a replacement for it. Same app, same Postgres database, additive schema only, no new service.

---

## A. Current Foundation (what gets reused)

| Concern | Existing asset | Reuse plan |
|---|---|---|
| Tenant identity | `sites` table (~15 migrations of columns) | Extend with lifecycle columns only — no restructure |
| Tenant ownership | `users.site_id` FK | Unchanged; schema already permits multiple `users` rows per `site_id` |
| Staff/client split | `isInternalSite()` / `requireInternalSite` (`login.js`) | Kept as the coarse platform gate; role becomes the fine-grained layer on top |
| Tenant console | `/clients` + `ClientOnboarding.jsx` + `server/routes/clients.js` | This *is* ~80% of Platform Admin's Tenants module already — extend, don't rebuild |
| Signup intake | `signup_requests` table + approve/reject flow | Reused as-is; pattern (token/hash pending-row → approve → provision) is copied for invitations |
| Agent execution | `agents/registry.js` (auto-discovery) + `agents/runner.js` (single choke point, persists to `agent_runs`, emits SSE via `activity-bus.js`) | Surfaced read-only in Platform Ops; no changes to execution path |
| Cron | `server/cron.js` (`node-cron`, no queue) | Surfaced read-only; scheduling logic untouched |
| Integration health | `integrations.js` + `integration_health` table, staff-gated already | Reused as the model for a broader System Health view |
| MCP tokens (manual) | `api_tokens` table (054-056), `mcp-tokens.js`, `mcp/permissions.js`, `mcp/auth.js` | Self-service layer untouched; platform view is a new *read/audit* layer beside it, not a replacement |
| **MCP tokens (OAuth)** | `oauth_clients`/`oauth_authorization_codes`/`oauth_access_tokens`/`oauth_refresh_tokens` (migrations 057-060), `sites.oauth_max_permission_level` (061), `server/mcp/oauth-provider.js`, `server/routes/oauth-consent.js` | **Newly identified in this revision — not in the original audit.** A full OAuth 2.1 + PKCE authorization flow, independent of the manual-token flow, tied to individual `users.id` (not just `sites.id`). Reused as-is; extended in Phase 3 for suspension enforcement (see §D) |
| Token provenance | `created_via_token_id` (migration 056) | Reused directly for the MCP provenance chain view |
| Error surface | Centralized Express error handler (`index.js:121-124`) | Reused as the hook point to also write to the new audit/error surface |

**Confirmed re-verified for this revision**: `server/mcp/oauth-provider.js` (full file read directly). Key facts that shape §D and §I below:
- Per-request access-token validation for OAuth-issued tokens goes through the **same** `server/mcp/auth.js` `requireMcpToken` middleware as manual `api_tokens` — confirmed by the file's own comment (`oauth-provider.js:184-186`): *"Not on requireMcpToken's hot path — server/mcp/auth.js calls the store lookup directly, matching the manual-token path's shape."* This means a single site-status check inside `requireMcpToken`, applied uniformly after either lookup resolves a `site_id`, covers both manual and already-issued OAuth access-token requests — **one code change, not two**.
- Token **issuance and refresh**, however, happen through a structurally separate path: `exchangeAuthorizationCode` and `exchangeRefreshToken` in `oauth-provider.js`, reached via the OAuth token endpoint, not `requireMcpToken`. This path must independently reject issuing/refreshing a token for a suspended tenant — it is not covered by fixing `requireMcpToken` alone.
- `sites.oauth_max_permission_level` (migration 061) has a `CHECK` constraint permitting only `read_only`/`ai_actions`/`automation` — **`admin` is not a legal value**. Confirmed directly in the migration. This means OAuth-issued MCP tokens are *structurally* incapable of reaching `admin` tier regardless of what a client requests (`computeEffectivePermissionLevel`, `oauth-provider.js:49-53`, takes the `min` of requested scope and this ceiling — never widens). This existing DB-level guarantee is reused as-is and cited explicitly in §C.2/§I below, rather than treated as if it needed building.
- `exchangeRefreshToken` already implements OAuth 2.1 refresh-token-reuse detection (`oauth-provider.js:142-151`) — reusing a rotated-away refresh token revokes the entire token family. Unrelated to this design but confirmed not to conflict with anything proposed here.

**Gaps confirmed with nothing to build on** (carried into this design as genuinely new work): human roles/RBAC, multi-user-per-tenant, tenant self-edit of settings, tenant deletion, any system/ops monitoring, cross-tenant MCP visibility, a platform-wide audit log, password reset (only self-service change-with-current-password exists today — there is no "forgot password" flow at all).

---

## B. Proposed Platform Administration Architecture

No new service, no new deployment. Platform Administration is:
- The **same Express app**, same session auth, same Postgres database.
- A **new role dimension** on top of the existing `users` table (see §C), replacing the current binary `isInternal` check with a graded one that still passes through the same gate for backward compatibility.
- A **new set of staff-only routes** (`/api/internal/...`, extending the existing prefix `clients.js` already uses) for cross-tenant operations — never a parallel API surface.
- A **new audit-log table** written to by every mutating admin route, platform or tenant.
- A **new frontend section**, logically separate from the client dashboard's nav, reachable only when the session's role qualifies.

```
                 ┌─────────────────────────────────────────┐
                 │              Zunkiree App                │
                 │   (one Express process, one Postgres DB) │
                 └─────────────────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              │                                 │
   Customer-facing surface              Platform Administration surface
   (UNCHANGED)                           (NEW layer, staff-role gated)
   - /overview /insights /reports        - /admin/tenants   (extends /clients)
   - /action-center /command-center      - /admin/users     (NEW)
   - /settings (self, MCP tokens)        - /admin/mcp       (NEW, read+revoke)
   - Agents, GSC/GA4/GitHub ingestion    - /admin/ops       (extends integrations
     (all existing, session-scoped         health + agent/cron visibility)
     by req.siteId — untouched)          - /admin/audit-log (NEW)
```

Both surfaces share `requireAuth`. Platform routes add a second gate, `requirePlatformRole(minRole)`, which subsumes today's `requireInternalSite`. **`platform_settings` and its `/admin/settings` page are removed from this program of work entirely — see §G.4.**

---

## C. Role and Permission Matrix

Three independent axes, per the brief — **do not collapse MCP tiers into human roles.**

### C.1 Human roles

| Role | Scope | Can see | Can create | Can edit | Can delete/deactivate | Requires platform privilege? | Status this release |
|---|---|---|---|---|---|---|---|
| **Platform Admin** | All tenants | Every tenant, every user, every MCP token (metadata only), audit log, system health | New tenants, invite platform staff, invite/assign any tenant's users | Any tenant's config, any user's role | Suspend/delete any tenant, disable/remove any user, revoke any MCP token | — (this *is* the platform privilege) | **Active — built and enforced from Phase 1** |
| **Platform Support** | All tenants, read-mostly | Same visibility as Platform Admin | Nothing tenant-destructive | Operational actions only (retry-baseline, re-run agent), not tenant/user records | Nothing | Yes, but capped below Admin | **Reserved only.** Value exists in the `role` CHECK constraint from Phase 0 so it can be assigned without a later migration, but **no route enforces a distinction from `platform_admin` in this release** — see rationale below. |
| **Tenant Admin** | Own tenant only | Own tenant's data, own tenant's users, own tenant's MCP tokens, own tenant's settings | Invite users to own tenant (tenant-tier roles only — see §E), create own MCP tokens (existing capability) | Own tenant's settings (logo, domain, report email — currently staff-only, becomes tenant-admin-editable), own users' roles restricted to tenant-tier roles | Remove/disable own tenant's users, revoke own tenant's MCP tokens | No | **Active — built from Phase 4** |
| **Tenant Member** | Own tenant only | Own tenant's dashboard, agents, drafts, reports (i.e., today's default client experience) | Drafts, agent runs, MCP tokens at their own discretion (existing self-serve behavior) | Own password | Nothing user/tenant-level | No | **Active — default role for today's single-user tenants** |
| **Tenant Viewer** | Own tenant only | Read-only version of Member | Nothing | Own password | Nothing | No | **Reserved only**, same rationale as Platform Support |

**Why `platform_support`/`tenant_viewer` are reserved-but-not-enforced (review finding, resolved)**: no route in the codebase today distinguishes "can operate but not destroy" from "can do anything" (`clients.js` gates its entire router with one line, `router.use(requireAuth, requireInternalSite)` — confirmed, no per-route differentiation exists), and no tenant route distinguishes read-only members from full members. Building enforcement for these two roles before any route needs the distinction would either grant them the same access as the tier above (defeating the purpose) or require reworking every existing route's authorization simultaneously. **Decision**: the CHECK constraint includes both values from Phase 0 (cheap, forward-compatible), but no middleware or UI branches on them until a later phase actually produces routes that need the distinction (tracked explicitly, not silently dropped).

Key design choice: **today's single client account becomes `tenant_admin` by default on migration; today's internal-site accounts become `platform_admin` by default** (see §K, Phase 0) — this is a no-op for existing behavior and only becomes meaningful once multi-user-per-tenant and the platform/tenant tier split actually matter in later phases.

### C.2 MCP token permission tiers (unchanged, kept fully separate from §C.1)

| Tier | Scope | Notes |
|---|---|---|
| `read_only` | Own tenant, read-only tools | Default, unchanged |
| `ai_actions` | Own tenant, draft lifecycle | Unchanged |
| `automation` | Own tenant, GitHub PR lifecycle | Unchanged |
| `admin` | Own tenant, token management (incl. self-replicating) | Unchanged — **still scoped to its own tenant.** An `admin`-tier MCP token today can mint more tokens for *its own site only*; it has no path to another tenant's data and no path to a human session. This design does not change that, and explicitly does not grant `admin`-tier MCP tokens any Platform Admin capability. A human Platform Admin's elevated access is a property of their `users.role`, never inferred from any token. |

**OAuth-issued tokens cannot reach `admin` at all — by database constraint, already in place.** `sites.oauth_max_permission_level` (migration 061) is `CHECK`-constrained to `read_only`/`ai_actions`/`automation` only; `admin` is not a legal value. Confirmed directly against the migration and `oauth-provider.js`'s `computeEffectivePermissionLevel` (§A above). This design relies on and preserves that existing constraint rather than introducing a new one — the manual-token flow (`mcp-tokens.js`, session-authenticated, human-issued) remains the only path to `admin`-tier MCP tokens, unattended OAuth grants never reach it.

### C.3 Cross-axis rule

A user's `users.role` and any MCP token's `permission_level` are independent columns on independent entities (`users` vs `api_tokens`/`oauth_access_tokens`). No code path may read one to infer the other. The only legitimate bridge is provenance/audit: "platform admin X created MCP token Y for tenant Z" is a fact worth logging, not a permission grant.

---

## D. Tenant Lifecycle

```
 [Signup request]           [Staff-created]
        │                         │
        ▼                         ▼
   PENDING  ──approve──►  CREATED (site row + first tenant_admin user)
                                  │
                                  ▼
                         ONBOARDING (connect GSC/GA4, optional GitHub,
                                     baseline pipeline runs — existing
                                     clients.js `connect` + `retry-baseline`)
                                  │
                                  ▼
                              ACTIVE  ◄────────────┐
                              │   │                │
                       suspend│   │reactivate      │
                              ▼   │                │
                          SUSPENDED ────────────────┘
                              │
                        soft-delete (Phase 3, reversible
                        within retention window)
                              ▼
                        SOFT-DELETED
                              │
                        hard-delete — Phase 3.5, separate,
                        irreversible (see below)
                              ▼
                           GONE
```

- **PENDING → CREATED**: existing `signup_requests` approve flow, or existing staff "create client" form. **REUSE, unchanged.**
- **CREATED → ONBOARDING → ACTIVE**: existing `connect`/`retry-baseline` endpoints in `clients.js`. **REUSE, unchanged.**
- **ACTIVE ↔ SUSPENDED**: requires a new `sites.status` column (`active`/`suspended`/`soft_deleted`, default `active` — existing rows unaffected). **Suspension must be enforced independently across all three authentication/access lanes** — this was the single largest correction from the security review, since the three lanes are structurally separate in this codebase:
  1. **Web session** — `requireAuth` (`login.js`) gains a `sites.status === 'active'` check.
  2. **Manual MCP bearer token** — `requireMcpToken` (`mcp/auth.js`) gains the same check, applied after `tokenRow.site_id` resolves. Per §A above, this single change also covers already-issued OAuth access tokens, since both paths converge on this middleware.
  3. **OAuth token issuance/refresh** — `oauth-provider.js`'s `exchangeAuthorizationCode` and `exchangeRefreshToken` gain an explicit site-status check before issuing/rotating a token, since this path does not go through `requireMcpToken`.

  Do not assume changing `requireAuth` alone protects MCP or OAuth — it does not; these are three independent code paths and all three must be updated together in the same phase (Phase 3), or suspension is silently incomplete on whichever lane is missed.

  Suspension must also **unconditionally reject `COMPANY_SITE_ID` as a target**, enforced as a server-side guard at the top of the suspend/delete route handler itself (not a UI-only restriction) — accidentally suspending the company's own tenant would lock out every platform staff member simultaneously, with no in-app path to undo it, since the undo action itself requires an active platform session.

  Suspension should also pause that tenant's cron jobs (skip in `listConnectedSites()` filter, `job.js:301-304` — a one-line additive change) so a suspended client doesn't keep consuming GSC/GA4 quota or sending reports.

- **SUSPENDED → SOFT-DELETED → (separately) hard delete**:
  1. *Soft delete* (Phase 3): `sites.status = 'soft_deleted'`, `deleted_at` timestamp set, all three auth lanes above already block access via the same `status !== 'active'` check, cron excluded, data retained. Reversible by a Platform Admin within a retention window.
     - **Open decision, not resolved by this design**: exact retention window length (e.g. 30 days) — see "Remaining design decisions."
  2. *Hard delete* — **Phase 3.5, deliberately separated from Phase 3**, treated as the single highest-blast-radius action in this entire design:
     - Irreversible. Only reachable from `platform_admin` (never `tenant_admin`, never a future `platform_support`), and only after the soft-delete retention window.
     - **Minimum confirmation for v1**: typed tenant-name re-entry (matching the GitHub/Vercel destructive-action pattern), required and non-negotiable.
     - **Explicitly decided for v1**: a mandatory typed *reason* field and/or second-admin approval are **not** required for the first release — typed-name confirmation is the v1 bar. This is stated explicitly per the review's request rather than left ambiguous; it is flagged in "Remaining design decisions" below as a policy choice this document is taking a default position on, which the user may override before Phase 3.5 is built.
     - **Audit-before-delete**: the `recordAuditEvent` call for the delete attempt happens *before* the irreversible `DELETE FROM sites` executes (not after), so the attempt is recorded even if the deletion subsequently fails partway through — see §G.3's `audit_log` schema for why this record survives the deletion itself.
     - **FK corrections required first** (Phase 0, see §G.3a) — without them, hard-delete fails with a foreign-key violation the first time it hits `growth_targets`, `integration_health`, or `signup_requests` (re-verified directly against all 61 migrations for this revision; the original design's claim that "cascade already exists and just works" was checked and found incorrect for these three tables specifically).
     - **Verification requirement**: before this phase ships, run the deletion against a fully populated test tenant containing rows in *every* FK-referencing table, explicitly including `growth_targets`, `integration_health`, and `signup_requests` (the three tables that needed the FK correction), and confirm both (a) the deletion completes without error and (b) the `audit_log` entry recording the deletion survives the deletion.
  3. Every step (suspend, reactivate, soft-delete, hard-delete attempt, hard-delete completion) writes to `audit_log`.

---

## E. User Lifecycle

```
 Tenant Admin (own tenant only) or Platform Admin (any tenant) invites
              │
              ▼
     user_invitations row created
     (email, role, site_id, invited_by, token_hash, expires_at)
     — site_id and allowed role are SERVER-DERIVED from the inviter's
       own identity, never trusted from the request body (see below)
              │
        [invite email sent — reuses existing nodemailer/report/email.js]
              │
              ▼
     Invitee opens link, sets password
     (atomic single-use consumption — see below)
              │
              ▼
     users row created (status='active', role=<invited role>)
              │
      ┌───────┼─────────┐
      ▼       ▼          ▼
  role changed  disabled  removed
  (bounded by                (soft: status='disabled' —
   inviter's own              see explicit session/token
   role — see below)          handling below)
```

- **Invite — server-side authorization, not just a stated rule**: this was a review CRITICAL finding (a naive handler trusting body-supplied `role`/`site_id` would let a Tenant Admin invite a `platform_admin` into someone else's tenant). Resolved explicitly:
  - A **Tenant-Admin-initiated** invite has its `site_id` **forced server-side to `req.siteId`** — never read from the request body — and its `role` restricted to `{tenant_admin, tenant_member, tenant_viewer}` (the reserved-but-unenforced `tenant_viewer` value may be *stored*, just not yet meaningfully differentiated per §C.1).
  - A **Platform-Admin-initiated** invite is the *only* path permitted to set `role` to a platform tier (`platform_admin`, or the reserved `platform_support`) or to target an arbitrary `site_id` (including `COMPANY_SITE_ID` for platform staff, or any tenant's `site_id` on that tenant's behalf).
  - Both cases: server derives the allowed `site_id`/`role` set from `req.userRole`/`req.siteId` (the authenticated caller), never from client input, as a named validation step in the route handler — not an assumed consequence of "roles exist."
- **Invitation table**: new `user_invitations`, deliberately separate from `users` (mirrors the existing `signup_requests` pattern). Columns: `id`, `site_id`, `email`, `role`, `invited_by` (`users.id`), `token_hash`, `expires_at`, `accepted_at` (null until accepted), `created_at`.
- **Accept — atomic, single-use**: public route (parallel to the existing public `/api/signup-requests`), validated and consumed in **one atomic statement** — `UPDATE user_invitations SET accepted_at = now() WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now() RETURNING ...` — mirroring the codebase's own existing atomic-claim pattern for `signup_requests` approval (`WHERE status = 'pending'` guard), which already exists specifically to prevent a double-claim race. A naive "check then update" (two statements) would have a real TOCTOU race; this is now specified as one statement, not left implicit. Rejects expired tokens (`expires_at` in the same clause) and already-accepted tokens (replay) in the same check. No plaintext token ever stored — only `token_hash`, same convention as `api_tokens`.
- **Role change**: a `PATCH` on the user's role. Tenant Admin can only change roles within their own `site_id` and only among tenant-tier roles (never elevate anyone to a platform tier); Platform Admin can change any user's role anywhere, including platform tiers. Same server-derivation rule as invite — the acting caller's own `role`/`siteId` bounds what they're allowed to set, never trusted from the request body.
- **Password reset (NEW — nothing like this exists today, confirmed: only self-service "change with current password" exists, no forgot-password flow at all)**: admin-triggered — Tenant Admin or Platform Admin (within their own scope) requests a reset for a user → emails a reset link (reuses `nodemailer`, reuses the token-hash pattern) → user sets a new password via the same atomic single-use consumption pattern as invitation acceptance (`password_resets` table: `id`, `user_id`, `token_hash`, `expires_at`, `used_at`, `created_at`).
- **Disable/remove — explicit token and session handling, not left implicit** (review CRITICAL finding, resolved):
  - Soft-disable (`users.status = 'disabled'`) blocks new logins without breaking `created_by`-style FK references elsewhere in the schema (`drafts.approved_by`, `api_tokens.created_by` both already `ON DELETE SET NULL`, confirmed against migrations 024 and 054).
  - **OAuth tokens are actively revoked, not left to expire naturally**: disabling a user immediately runs `UPDATE oauth_access_tokens SET revoked_at = now() WHERE user_id = $1` and the equivalent for `oauth_refresh_tokens` — a direct, cheap `UPDATE`, since `revokeOauthAccessTokenByRawValue`-style store functions already exist in `store/oauth-access-tokens.js`/`store/oauth-refresh-tokens.js` (confirmed in `oauth-provider.js`'s imports) and only need a `user_id`-scoped variant added alongside the existing raw-value-scoped one. This closes the gap where a disabled user's OAuth grants would otherwise remain live until natural expiry — confirmed directly: `oauth_access_tokens.user_id`/`oauth_refresh_tokens.user_id` only cascade-clear on a *hard* `DELETE FROM users`, never on a status update.
  - **Human browser sessions — explicit decision, stated rather than left open**: `connect-pg-simple`'s `session` table is keyed by session id with an opaque JSON payload, not indexed by `user_id`, so "find and destroy all sessions for user X" is not a built-in capability and would require either a secondary index or a full-table scan. This design adopts a **bounded-staleness strategy** for v1: disabling a user does not actively destroy their existing session, but the existing 14-day `maxAge` cookie window is the accepted maximum exposure, and a `users.status` check is added to `requireAuth` (same mechanism as tenant suspension, §D) so a disabled user's *next* request is rejected — the exposure window is "time until their next API call after being disabled," not "up to 14 days regardless." This is stated explicitly as the v1 decision rather than left implicit; see "Remaining design decisions" for the alternative (active session invalidation) if a tighter bound is wanted later.
  - Hard delete of a `users` row is a rarer, explicit action, same two-step-confirmation posture as tenant hard-delete, only from Platform Admin, not built in the same phase as soft-disable (deferred, not scoped for this program of work unless specifically requested).
- **Platform staff users**: same `users` table, same invitation flow, distinguished only by `site_id = COMPANY_SITE_ID` **and** `role IN ('platform_admin', 'platform_support')` (the latter reserved-only per §C.1). No separate staff-user table — one identity system, not two.

**Schema decision (re-confirmed for this revision, not assumed)**: extend `users` (add `role`, `status` columns) rather than introduce a separate membership/junction table. Re-verified directly against every migration: `users.site_id INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE` (migration 011) carries no uniqueness constraint of its own, and no migration since adds one — multiple `users` rows already share one `site_id` at the schema level; the only blocker was product surface (no invite flow), not schema shape. A junction table would only be justified if a single person needed to belong to multiple tenants simultaneously.

**Accepted identity constraint, stated explicitly (not an oversight)**: `users.email` is `UNIQUE` **globally**, not per-tenant (migration 011, re-confirmed). One consequence: a single email address cannot represent both a platform account and a tenant account, or accounts on two different tenants. This is accepted as a current product constraint for this design — it is not addressed or worked around here, and is called out explicitly per the review rather than left as a silent assumption.

---

## F. Platform Admin Modules

1. **Overview** — tenant counts by status, recent signups pending approval, recent audit events, any failed jobs in the last 24h. Read-only aggregation over existing tables + the new audit log.
2. **Tenants** — extends `ClientOnboarding.jsx`/`clients.js` 1:1: list, detail, connect GSC/GA4/GitHub (existing), plus new status controls (suspend/reactivate/soft-delete, with hard-delete as its own separately-gated action per Phase 3.5) and inline edit of tenant settings that are today staff-writable-only-via-form.
3. **Users** — NEW. Cross-tenant user directory (platform staff list + per-tenant user lists), invite, role change, disable/remove. No existing UI to extend.
4. **Integrations** — extends existing `integrations.js` health-check view; add per-tenant integration status roll-up.
5. **Agents & Jobs** — read-only surface over `agent_runs` (via `runner.js`'s existing persistence) and cron schedule state, reusing the existing SSE stream from `activity-bus.js`.
6. **MCP** — platform-level read/audit layer, physically separate module from the tenant-facing self-service card (see §G.2). Covers both manual `api_tokens` and OAuth-issued tokens.
7. **Audit Log** — searchable/filterable view over the new `audit_log` table (by actor, tenant, action type, date range).
8. **System Health (v1 scope, existing data only)** — DB connectivity ping, `integration_health` rollup, `agent_runs` failure-count aggregation, existing cron state. **Explicitly no new logging/error-tracking dependency (no Sentry, no Pino, nothing) in this project phase** — see §G.4/§K Phase 6. If deeper error observability is wanted later, it is a separate infrastructure initiative, not bundled into this admin console's first release.

**Platform Settings is not a module in this release** — removed per §G.4, not deferred-with-a-placeholder-page.

---

## G. Backend Architecture

### G.1 Middleware

- `requireAuth` (existing, `login.js`) — extended in Phase 3 to also check `sites.status === 'active'` for the session's own tenant (see §D for the caching/staleness trade-off this implies) and, in Phase 4, `users.status === 'active'` for the session's own user (same mechanism, same phase as the disable-user work in §E).
- `requirePlatformRole(minRole)` (**NEW**):
  ```
  requirePlatformRole(minRole):
    requireAuth must have already run
    if req.siteId !== COMPANY_SITE_ID → 404 (same as today's requireInternalSite)
    if user's role does not meet minRole → 404 (never 403, same "can't detect
      the route" posture that's deliberate today)
  ```
  Existing `requireInternalSite` call sites become `requirePlatformRole('platform_admin')` in Phase 1 — **not `'platform_support'`**, corrected from the original version of this design. Rationale: Phase 0's backfill makes every existing internal-site user `platform_admin` (§C.1); gating at `platform_support` in Phase 1 would be gating against a role nobody holds yet and that no route differentiates from `platform_admin` regardless (§C.1's reserved-only rationale). This keeps Phase 1 a genuine no-op.
- **Destructive actions require an additional, per-route check — not just the router-level floor** (review HIGH finding, resolved): `clients.js`'s existing `router.use(requireAuth, requireInternalSite)` (soon `requirePlatformRole('platform_admin')`) remains the floor for the whole router and is sufficient for non-destructive actions (connect, retry-baseline, connect-repo, review). **Suspend, soft-delete, hard-delete, and cross-tenant MCP token revoke each add their own explicit `requirePlatformRole('platform_admin')` check inline in the handler**, layered on top of the router-level floor. This is specified now so that if `platform_support` is ever activated later (§C.1), these specific routes do not silently inherit whatever the router-level floor becomes — they carry their own floor independently.
- Every suspend/delete route additionally guards, inline, at the top of the handler: `if (targetSiteId === COMPANY_SITE_ID) return res.status(400).json(...)` — unconditional, server-side, not a UI-only restriction.
- `requireTenantRole(minRole)` (**NEW**) — for tenant-admin-only actions inside the client-facing app (editing own tenant settings, inviting a teammate). Reads `req.userRole` and compares against `req.siteId` (never a param) — keeps tenant-scoped routes exactly as isolated as they are today.
- `recordAuditEvent(...)` (**NEW**, not middleware — a small helper called explicitly at the end of each mutating handler, or, for hard-delete specifically, *before* the irreversible operation per §D). Never called from a GET/read handler. `metadata` is an **allowlisted field set per action type** — never `req.body`/`req.query` passed through wholesale, and never includes passwords, reset tokens, invitation tokens, bearer tokens, or any other secret value, regardless of what a handler has access to.

### G.2 New routes (all additive, none replace existing ones)

- `POST /api/internal/tenants/:id/suspend`, `/reactivate`, `/soft-delete` — each with its own inline `requirePlatformRole('platform_admin')` + `COMPANY_SITE_ID` guard per §G.1. Extends `clients.js`.
- `POST /api/internal/tenants/:id/hard-delete` — **Phase 3.5, its own route, its own explicit confirmation payload** (typed tenant name), separate from the above.
- `GET/POST/PATCH/DELETE /api/internal/users` and tenant-scoped `GET/POST/PATCH/DELETE /api/users` (invite/list/role-change/disable) — new files `server/routes/users.js` and `server/routes/user-invitations.js`, following the existing router-per-concern convention. Invite handlers implement the server-side `site_id`/`role` derivation from §E, not client-supplied values.
- `POST /api/invitations/:token/accept` — public, atomic single-use consumption per §E.
- `POST /api/users/:id/reset-password` (admin-triggered, within the actor's own scope) + `POST /api/password-reset/:token` (public completion, atomic single-use) — `login.js` gains this request/complete pair alongside its existing `change-password`.
- `GET /api/internal/mcp-tokens` — cross-tenant token list, **metadata only, never `token_hash` or any raw token value** — confirmed the existing `listApiTokensForSite` SELECT already excludes `token_hash` (`api-tokens.js:36-43`); the new cross-tenant query follows the identical column list, just without the `site_id` filter.
- `POST /api/internal/mcp-tokens/:id/revoke` — **reuses the existing `revokeApiToken(siteId, id)` function as-is**, called with the *target* tenant's `site_id` (looked up from the token row first, then passed through) rather than the caller's own — this preserves the existing `WHERE id = $1 AND site_id = $2` defense-in-depth predicate (`api-tokens.js:45-52`) rather than bypassing it with a new site_id-less revoke path.
- `GET /api/internal/audit-log` — filterable read over the new table.
- `GET /api/internal/system-health` — DB ping + rollup of existing `integration_health` + `agent_runs` failure counts + existing cron state. No new instrumentation, no new dependency.

**Physical module separation for cross-tenant store functions** (review requirement, resolved): all cross-tenant/no-tenant-filter store functions (`listAllTenantsAcrossSites`-style, `listAllApiTokensAcrossSites`, etc.) live under a new `server/store/admin/` directory, physically separate from tenant-scoped equivalents in `server/store/read.js`/`server/store/api-tokens.js`. This is a guardrail, not cosmetic: it makes it structurally harder for a future engineer to accidentally import a cross-tenant function into a tenant-facing route file, since the import path itself signals "this has no tenant filter."

### G.3 Database — new tables/columns

All additive, all nullable/defaulted so existing rows are unaffected, **except** where noted below for the FK-correction migration, which alters existing constraints.

- `users`: `+role TEXT NOT NULL DEFAULT 'tenant_admin'` (CHECK constrained to `platform_admin`/`platform_support`/`tenant_admin`/`tenant_member`/`tenant_viewer` — includes the two reserved-only values from §C.1), `+status TEXT NOT NULL DEFAULT 'active'` (CHECK: `active`/`disabled`), `+last_login_at`.
- `sites`: `+status TEXT NOT NULL DEFAULT 'active'` (CHECK: `active`/`suspended`/`soft_deleted`), `+deactivated_at`, `+deleted_at`.
- `user_invitations` (new table): `id`, `site_id`, `email`, `role`, `invited_by`, `token_hash`, `expires_at`, `accepted_at`, `created_at`.
- `password_resets` (new table, same shape as invitations): `id`, `user_id`, `token_hash`, `expires_at`, `used_at`, `created_at`.
- **`audit_log`** (new table — schema expanded and FK-corrected per the review):
  ```
  id               SERIAL PRIMARY KEY
  actor_type       TEXT NOT NULL CHECK (actor_type IN ('platform_user','tenant_user','mcp_token','system'))
  actor_id         INTEGER              -- users.id or api_tokens.id depending on actor_type; NULL for 'system'
  actor_role       TEXT                 -- snapshot of the actor's role AT THE TIME of the action, not a live lookup
  actor_site_id    INTEGER REFERENCES sites(id) ON DELETE SET NULL   -- NEVER CASCADE, see below
  actor_email      TEXT                 -- denormalized snapshot, survives actor deletion
  tenant_site_id   INTEGER REFERENCES sites(id) ON DELETE SET NULL   -- NEVER CASCADE, see below
  tenant_name      TEXT                 -- denormalized snapshot, survives tenant deletion
  ip_address       INET
  user_agent       TEXT
  action           TEXT NOT NULL        -- e.g. 'tenant.suspended', 'tenant.hard_delete_attempted'
  target_type      TEXT
  target_id        TEXT
  metadata         JSONB                -- allowlisted fields only, per §G.1 — never raw req.body/req.query,
                                         -- never passwords/reset tokens/invitation tokens/bearer tokens
  success          BOOLEAN NOT NULL
  error_message    TEXT
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
  ```
  **Both `sites` FKs use `ON DELETE SET NULL`, never `CASCADE`** — this is the direct fix for the review's CRITICAL finding that a standard `CASCADE` FK (the codebase's dominant convention elsewhere) would cause hard-deleting a tenant to delete its own audit trail, including the log entry recording the deletion itself. `SET NULL` plus the denormalized `tenant_name`/`actor_email` snapshot columns means the row remains fully meaningful — readable, attributable — after the referenced `sites`/`users` rows are gone.
  **Audit records cannot be deleted or updated through the application** — no route, tool, or admin capability in this design ever issues an `UPDATE`/`DELETE` against `audit_log`, not even for Platform Admin. **This is additionally enforced at the database level**: the application's DB role should have its `UPDATE`/`DELETE` grants explicitly revoked on this table (`REVOKE UPDATE, DELETE ON audit_log FROM <app_role>`), so the guarantee doesn't depend solely on no code path existing today — it survives a future code change that might otherwise add one.

### G.3a — Corrective FK migration (Phase 0, precedes all lifecycle/audit work)

Re-verified directly against all 61 migrations for this revision (not assumed from the prior audit). Three tables have no explicit `ON DELETE` behavior on their `sites` FK, which Postgres defaults to `NO ACTION` — this **blocks** `DELETE FROM sites` if any row exists, which the original design incorrectly assumed would cascade cleanly:

| Table | Column | Current (found) | Corrected to |
|---|---|---|---|
| `growth_targets` | `site_id` (`NOT NULL`) | unspecified → `NO ACTION` | `ON DELETE CASCADE` |
| `integration_health` | `site_id` (nullable) | unspecified → `NO ACTION` | `ON DELETE CASCADE` |
| `signup_requests` | `created_site_id` (nullable) | unspecified → `NO ACTION` | `ON DELETE SET NULL` |

`growth_targets`/`integration_health` → `CASCADE`: both are purely derived/operational tenant data, safe to remove with the tenant. `signup_requests` → `SET NULL` (not `CASCADE`): preserves the historical fact that a signup request existed and was approved even after the resulting tenant is later hard-deleted, consistent with how `api_tokens.created_by`/`drafts.approved_by` already use `SET NULL` for the same "preserve history over the referenced row" reasoning (confirmed in migrations 024 and 054). This migration ships in **Phase 0**, well before Phase 3.5 needs it, so it can be tested independently against a scratch/dev database ahead of any lifecycle work depending on it.

### G.4 Platform Settings — removed from this release

**No `platform_settings` table, no `/admin/settings` route or page, in this program of work.** The review found no concrete operational need — the two examples originally considered (`AGENTIC_ORCHESTRATION_ENABLED`, a hypothetical "pause all cron" switch) are legitimately deploy-time/infra concerns already served adequately by environment variables today. Moving deployment secrets (`SESSION_SECRET`, SMTP credentials, API keys) into a DB-backed settings table would be a straightforward regression and is explicitly out of scope regardless. This is not "build only if needed" — it is **not planned** for this release; revisit only if a specific, named operational requirement is identified later, as its own separate proposal.

---

## H. Frontend Architecture

- New top-level area, e.g. `/admin/*`, rendered only when `GET /api/me` reports a qualifying platform role (extends the existing `isInternal` flag on that endpoint to also return `role`).
- `ClientOnboarding.jsx` gains status-control UI (suspend/reactivate/soft-delete, with hard-delete as a visually and procedurally distinct destructive-action flow requiring typed-name confirmation) alongside its existing connect/retry-baseline/review actions.
- New pages, no existing components to extend: `admin/Users.jsx` (directory + invite modal + role editor, enforcing the same role/site_id restrictions client-side as a UX nicety — server-side enforcement per §E is the real boundary), `admin/McpAdmin.jsx` (cross-tenant token table, metadata only, deliberately a separate component from tenant-facing `McpTokensCard.jsx` so the two code paths never share logic that could blur the isolation boundary), `admin/AuditLog.jsx` (filterable table), `admin/SystemHealth.jsx` (status tiles over existing-data rollups only).
- Navigation: a distinct "Platform Administration" nav group, visually separated from the existing `INTERNAL_NAV` "Internal Console" section in `Sidebar.jsx`.
- Tenant-facing additions (inside the *existing* client dashboard, not the new admin area): a "Team" tab in `Settings.jsx` for Tenant Admins to invite/manage their own tenant's users (role choices restricted client-side to tenant-tier roles, matching the server-side restriction), and unlocking the currently staff-only logo/domain/report-email fields for self-edit when the session's role is `tenant_admin`.
- **No `admin/PlatformSettings.jsx`** — removed per §G.4.

---

## I. Security Boundaries

```
Platform Admin  ──session, role check──►  ANY tenant's data
                                            (only via explicit :siteId param
                                             on /api/internal/* routes, each
                                             with its own requirePlatformRole
                                             check for destructive actions —
                                             never inferred from the admin's
                                             own session.siteId, which is
                                             always COMPANY_SITE_ID and is
                                             itself an unconditionally
                                             rejected target for suspend/delete)

Tenant Admin    ──session──►  req.siteId (own tenant only, from session —
                                unchanged from today's requireAuth behavior)

Tenant Member   ──session──►  req.siteId (own tenant only)

MCP Token       ──bearer token (manual OR OAuth-issued)──►  token's own
                    site_id (from api_tokens/oauth_access_tokens row, never
                    caller-supplied) + permission_level ceiling (OAuth
                    additionally capped below 'admin' by sites.
                    oauth_max_permission_level's CHECK constraint) —
                    independent lane, verified through requireMcpToken for
                    both token types, never intersects session-auth paths
```

**How tenant isolation survives Platform Admin access**: every existing tenant-scoped route already derives `req.siteId` exclusively from the session (never a client-supplied parameter) — unchanged. Platform routes are a *different, additional* set of routes that take an explicit target tenant id, are gated by `requirePlatformRole` (with destructive actions carrying their own additional per-route check, §G.1), and every read/write against another tenant's data is written to `audit_log` with both `actor_site_id` (the admin's own, always `COMPANY_SITE_ID`) and `tenant_site_id` (the target) recorded. A Platform Admin's session `siteId` never becomes the data-scope for another tenant's rows.

**How suspension survives across all three auth lanes**: per §D, the `sites.status` check is added independently to `requireAuth` (session), `requireMcpToken` (manual + already-issued OAuth tokens, one shared middleware), and `oauth-provider.js`'s token issuance/refresh (a fourth, structurally distinct point that `requireMcpToken` does not cover). All three/four must ship together in Phase 3 — a suspension that only touches `requireAuth` is not a real suspension.

**How MCP stays out of the human-privilege picture**: `requirePlatformRole` checks `users.role`, a column that does not exist on `api_tokens`/`oauth_access_tokens` and is never joined against either. `mcp/auth.js`'s request path never touches `req.session` (confirmed directly in the file), so an MCP bearer token — manual or OAuth-issued — can never satisfy `requireAuth`/`requirePlatformRole`, and a human session can never satisfy `requireMcpToken`. `admin`-tier MCP access is additionally unreachable via OAuth at all, by DB constraint (§C.2). The two auth lanes stay fully disjoint.

---

## J. Existing vs. New — full labeling

| Item | Label |
|---|---|
| Session auth, `requireAuth`, Postgres session store | REUSE EXISTING |
| `isInternalSite`/`requireInternalSite` binary check | EXTEND EXISTING → becomes the floor of `requirePlatformRole('platform_admin')` |
| `sites` table core columns | REUSE EXISTING |
| `sites.status`/`deactivated_at`/`deleted_at` | NEW CAPABILITY (additive columns) |
| `users` table core columns | REUSE EXISTING |
| `users.role`/`status`/`last_login_at` | NEW CAPABILITY (additive columns) |
| Multi-user-per-tenant (schema support) | REUSE EXISTING (already possible via FK, re-verified this revision) |
| Multi-user-per-tenant (invite/manage flow) | NEW CAPABILITY |
| `signup_requests` approve/reject flow | REUSE EXISTING |
| `signup_requests.created_site_id` FK behavior | **EXTEND EXISTING (corrective migration, Phase 0)** — currently unspecified/blocking, fixed to `SET NULL` |
| `growth_targets`/`integration_health` FK behavior | **EXTEND EXISTING (corrective migration, Phase 0)** — currently unspecified/blocking, fixed to `CASCADE` |
| `user_invitations` table + accept flow | NEW CAPABILITY (pattern copied from `signup_requests`, atomic single-use consumption) |
| Self-service change-password | REUSE EXISTING |
| Admin-triggered reset / forgot-password | NEW CAPABILITY |
| `/clients` tenant console | EXTEND EXISTING |
| Tenant self-edit of own settings | NEW CAPABILITY (fields already exist on `sites`, just staff-only today) |
| Tenant suspend/reactivate/soft-delete | NEW CAPABILITY |
| Tenant hard-delete | NEW CAPABILITY (Phase 3.5, separately gated) |
| `agents/registry.js`, `agents/runner.js`, `activity-bus.js` | REUSE EXISTING |
| `cron.js` job scheduling, `listConnectedSites` | REUSE EXISTING / EXTEND EXISTING (add `status === 'active'` filter) |
| Cron/job admin *visibility* | NEW CAPABILITY (read layer over existing execution) |
| `integrations.js` health check | REUSE EXISTING (model) / EXTEND EXISTING (roll-up view) |
| `api_tokens` table, self-serve token routes, `permissions.js` tiers | REUSE EXISTING, unchanged |
| **`oauth_clients`/`oauth_authorization_codes`/`oauth_access_tokens`/`oauth_refresh_tokens` (057-060)** | **REUSE EXISTING** — newly identified this revision, not previously documented in this design |
| **`sites.oauth_max_permission_level` CHECK excluding `admin` (061)** | **REUSE EXISTING** — already prevents OAuth tokens reaching `admin` tier |
| `requireMcpToken` (`mcp/auth.js`) | EXTEND EXISTING (add `sites.status` check — covers both manual and OAuth tokens in one change) |
| `oauth-provider.js` token issuance/refresh | EXTEND EXISTING (add `sites.status` check — separate code path from `requireMcpToken`) |
| Cross-tenant MCP token visibility/revoke | NEW CAPABILITY (new query, physically separated under `server/store/admin/`; revoke reuses existing `revokeApiToken` as-is) |
| OAuth token revocation on user disable | NEW CAPABILITY (new `user_id`-scoped variant of existing revoke store functions) |
| MCP invalid-auth attempt persistence | **Open decision — see "Remaining design decisions"**; today only in-memory in `mcp/auth.js` |
| `created_via_token_id` provenance | REUSE EXISTING |
| Centralized Express error handler | EXTEND EXISTING (hook for System Health, no new dependency) |
| Logging library / error tracking / app metrics | **Explicitly excluded from this release** — not planned, not "if needed" |
| `audit_log` table + `recordAuditEvent` helper | NEW CAPABILITY, `SET NULL` FKs + denormalized snapshots + DB-grant restriction |
| Platform Settings table/page | **Removed from this release entirely** |
| Frontend `ClientOnboarding.jsx` | EXTEND EXISTING |
| Frontend `McpTokensCard.jsx` | REUSE EXISTING (unchanged, tenant-facing) — platform MCP view is a separate NEW component |
| `Sidebar.jsx` `INTERNAL_NAV` | EXTEND EXISTING |
| Users/Audit Log/System Health pages | NEW CAPABILITY, no existing UI to extend |

---

## K. Implementation Phases

Nothing in this section is implemented. Each phase is independently shippable and reversible except where noted (Phase 3.5 is deliberately not reversible by design, which is why it's isolated).

1. **Phase 0 — Foundational schema + corrective FK migration.** Add `users.role`/`status`/`last_login_at`, `sites.status`/`deactivated_at`/`deleted_at`, all with safe defaults and backfill (`role` → `platform_admin` for existing `COMPANY_SITE_ID` users, `tenant_admin` for all others; `status` → `active` everywhere). **In the same phase**, ship the corrective FK migration from §G.3a (`growth_targets`/`integration_health` → `CASCADE`, `signup_requests.created_site_id` → `SET NULL`) and create the `audit_log` table with `SET NULL` FKs, denormalized snapshot columns, and the DB-grant restriction against `UPDATE`/`DELETE`. Zero route/UI changes. Verify: existing dev flow unchanged; a manual test-DB `DELETE FROM sites` against a tenant with rows in all three previously-blocking tables now succeeds.
2. **Phase 1 — RBAC middleware, no new destructive surface.** Introduce `requirePlatformRole`/`requireTenantRole`; swap existing `requireInternalSite` call sites to `requirePlatformRole('platform_admin')` (corrected from `platform_support` — see §G.1). Genuinely a no-op this time, since Phase 0's backfill already makes every existing internal user `platform_admin` and no destructive routes exist yet. `GET /api/me` gains `role`.
3. **Phase 2 — Audit logging, passive, wired to existing routes only.** `recordAuditEvent` helper (allowlisted metadata per action type, §G.1) called from the *existing* mutating handlers in `clients.js` and the *existing* `mcp-tokens.js` revoke action. No new actions, no new UI — starts capturing history before anything depends on it.
4. **Phase 3 — Tenant lifecycle (suspend/reactivate/soft-delete), all three auth lanes.** `sites.status` check added independently to `requireAuth`, `requireMcpToken`, and `oauth-provider.js`'s issuance/refresh path (§D, §I) — shipped together, not staggered. `listConnectedSites()` gains the status filter. New suspend/reactivate/soft-delete routes, each with the `COMPANY_SITE_ID` guard and inline `requirePlatformRole('platform_admin')` check. **Hard-delete is explicitly not in this phase.**
5. **Phase 3.5 — Hard tenant deletion.** Its own phase, its own sign-off, given the blast radius. Typed-tenant-name confirmation (v1 minimum, per §D's explicit decision), pre-delete audit write, relies on Phase 0's FK correction. Verification: delete a fully-populated test tenant with explicit rows in `growth_targets`/`integration_health`/`signup_requests`, confirm success, confirm the audit record survives. Recommend a staged rollout (available to one Platform Admin account first) before general availability, given there is no undo.
6. **Phase 4 — User/team management.** `user_invitations`/`password_resets` tables, invite/accept/role-change/disable routes with the server-side authorization derivation from §E built in from the start (not retrofitted), `users.status` check added to `requireAuth` (paired with the disable-user OAuth-token-revocation from §E), admin-triggered password reset. Largest net-new attack surface in the design — recommend a dedicated focused security pass on this phase specifically, beyond this document's general review, before it ships.
7. **Phase 5 — Platform MCP oversight.** Cross-tenant read route under the new `server/store/admin/` module (metadata only, no `token_hash`, §G.2), revoke reuses existing `revokeApiToken` with its `site_id + id` predicate intact. **Persisting invalid-auth attempts (currently in-memory only in `mcp/auth.js`) is an open decision for this phase, not committed** — see "Remaining design decisions."
8. **Phase 6 — Platform Ops / System Health, existing data only.** Read views over `agent_runs`, cron state, `integration_health`, DB ping. **No new dependency of any kind** — confirmed scope boundary, not a "worth considering" note.
9. **Phase 7 — UI consolidation.** Reorganize navigation into the fuller admin structure once the modules above exist. No `platform_settings` work in this or any phase of this release (§G.4).

Phase 0 and Phase 1 are the only true prerequisites for everything else; later phases can reorder without blocking each other, except Phase 3 must precede Phase 3.5 (suspension/soft-delete enforcement and the FK correction both need to exist before hard-delete is exercised).
