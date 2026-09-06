# Security & Architecture Review — Platform Administration Design

**Status: review only. No files were modified, no migrations run, no code written.** This reviews `PLATFORM-ADMIN-DESIGN.md` against the actual codebase — every claim below was re-verified directly against source (not re-derived from the earlier audit or design doc's own summaries). Where the earlier audit or design turned out to be wrong or incomplete, that is called out explicitly.

**Scope note surfaced during this review, not in either prior document**: the codebase has grown since the original audit. Migrations **057–061** exist (`oauth_clients`, `oauth_authorization_codes`, `oauth_access_tokens`, `oauth_refresh_tokens`, `sites.oauth_max_permission_level`) and were in neither `PLATFORM-ADMIN-AUDIT.md` nor `PLATFORM-ADMIN-DESIGN.md`. This is a full OAuth 2.1/PKCE-based MCP authorization flow, tied directly to individual `users.id` (not just `sites.id`), issued through a separate `server/mcp/oauth-provider.js`. It materially affects §3, §5, §8, and §9 below and is treated as in-scope for this review.

---

## 1. Multi-tenancy

**Verified correct, with one real gap.**

- `req.siteId` is set exclusively from `req.session.siteId` in `requireAuth` (`login.js:168-175`), which is itself set only from the DB row at login (`login.js:23-24`) — never from client input. Confirmed by direct grep across every tenant-scoped router (`metrics.js`, `agents.js`, `action-center.js`, `command-center.js`, `reports.js`, `growth-report.js`, `site-audit.js`, `watchlist.js`, `notifications.js`): no route uses `req.params`/`req.query`/`req.body` as a tenant-scoping value. One route (`site-audit.js:38-40`) fetches a resource by non-tenant id then cross-checks `row.site_id !== req.siteId` — a correct existing IDOR-prevention pattern, worth reusing explicitly (see §7).
- **The existing `/api/internal/*` precedent is weaker than the design implies.** `clients.js` gates its entire router with one line — `router.use(requireAuth, requireInternalSite)` (`clients.js:22`) — and every handler then takes `Number(req.params.id)` straight into store functions with only an *existence* check, no per-request authorization beyond "is this caller on the company site at all." That's acceptable today because there is exactly one internal tier. **It stops being acceptable the moment a second, lower-privileged platform tier (`platform_support`) exists**, because a router-level gate applies uniformly to every route behind it — including future destructive ones. This is not a hypothetical: the design's own Phase 1 (§K) proposes exactly this swap. See §2 and §7 for the concrete fix.

**Finding — HIGH**: Router-level (not per-route) RBAC gating in `clients.js` means any new destructive route (suspend/delete tenant) added to that router would inherit whatever minimum role the router itself is gated at, unless each destructive route adds its own stricter check. The design's Phase 1 ("swap `requireInternalSite` → `requirePlatformRole('platform_support')`," described as a no-op) is only a no-op for *today's* routes — it silently sets the floor for *tomorrow's* routes too if not revisited in Phase 3.

## 2. Human RBAC

**Roles are reasonably scoped, but two of the five are premature for an MVP.**

- `platform_admin` / `tenant_admin` / `tenant_member` are justified — each maps to a real, distinct capability set the design identifies.
- **`platform_support` is not yet meaningful.** No existing route in the codebase distinguishes "staff who can operate but not destroy" from "staff who can do anything" — that distinction doesn't exist today (confirmed: `clients.js` has one uniform gate). Introducing the role before any route actually enforces the distinction means it either (a) grants the same access as `platform_admin` in practice, defeating its purpose, or (b) requires simultaneously reworking every existing internal route's authorization to add the distinction — a much bigger Phase 1 than "swap one middleware call."
- **`tenant_viewer` has the same problem** — no current route restricts write access within a tenant differently from read access; every authenticated tenant user can already do everything a "member" can.
- **Existing internal functionality and `platform_support`**: yes, all of today's existing internal capabilities (connect/retry-baseline/connect-repo/review/growth-summary, signup approve/reject, Copilot, integration health checks, notifications, watchlist) should remain reachable at the `platform_support` floor once it's meaningful — none of them are individually destructive. Only the **new** destructive capabilities this design adds (suspend/delete tenant, disable/remove *platform* users, revoke *another tenant's* MCP token) should require `platform_admin` specifically.

**Finding — MEDIUM**: Reserve `platform_support` and `tenant_viewer` as valid CHECK-constraint values now (cheap), but do not build enforcement or UI for them until Phase 3+ has actually produced routes that need the distinction (see revised phasing, §L).

**Finding — MEDIUM**: Hard tenant deletion is the single highest-blast-radius action in the entire design and today has zero precedent of *any* destructive tenant operation to compare against. Consider requiring either a second `platform_admin`'s approval or a mandatory typed reason/justification field before the delete executes, not just a typed-tenant-name confirmation.

## 3. MCP vs. human permissions

**The separation itself is structurally sound and verified in code — but two lifecycle mechanisms in the design don't reach MCP/OAuth at all.**

- Confirmed directly: `mcp/auth.js`'s `requireMcpToken` never reads/writes `req.session` (grep across the whole file — the only hit is a comment stating this explicitly, line 70). `req.mcpSiteId` (line 102) comes only from the resolved `tokenRow`, never a request parameter. `mcp/tools/admin.js`'s three admin tools (`list_api_tokens`, `create_api_token`, `revoke_api_token`) all use `siteId` from closure (traced to `req.mcpSiteId`) — none accept a site id as a tool argument. `revokeApiToken(siteId, id)`'s SQL requires **both** `id` and `site_id` in the `WHERE` clause (`api-tokens.js:45-52`), so even a guessed token id can't be revoked cross-tenant. This confirms the design's core claim: MCP `admin` cannot reach another tenant, and cannot become a human Platform Admin (no code path joins `api_tokens`/`users.role`).
- **The OAuth flow (057-061, not in the original audit) reinforces this independently**: `sites.oauth_max_permission_level` explicitly excludes `'admin'` from its CHECK constraint (migration 061) — OAuth-issued MCP tokens can *never* reach `admin` tier, by DB constraint, regardless of what a client requests. Good defense in depth, already in place, worth citing in the design as existing reinforcement rather than treated as absent.
- **Gap 1 (tenant suspension does not reach MCP) — CRITICAL**: The design's Phase 3 proposes suspension enforcement *only* inside `requireAuth`. Since `requireMcpToken` never touches `req.session` and has no `sites.status` check of its own, **a suspended tenant's MCP bearer tokens and OAuth access tokens continue to work exactly as before.** This isn't "MCP breaking" (the review question's framing) — it's the opposite and worse: suspension silently fails to apply to an entire access path. `requireMcpToken` (and the OAuth token-validation path in `oauth-provider.js`) must independently check the token's `site_id`'s status.
- **Gap 2 (disabled/removed users don't lose OAuth access) — CRITICAL**: `oauth_access_tokens.user_id` and `oauth_refresh_tokens.user_id` both `REFERENCES users(id) ON DELETE CASCADE` (migrations 059-060) — but that only fires on a hard `DELETE FROM users`, not on a `status = 'disabled'` update, which is what the design proposes for the common case. A disabled tenant user's already-issued OAuth access/refresh tokens remain fully valid until natural expiry. See §8 for the parallel human-session version of this same gap.

## 4. Existing user schema

**The earlier audit's claim is correct — independently re-verified against the schema, not assumed.**

- `users.site_id INT NOT NULL REFERENCES sites(id) ON DELETE CASCADE` (migration 011) has no uniqueness constraint of its own — multiple `users` rows can already share one `site_id`. Confirmed via the full FK/constraint catalog: no `UNIQUE(site_id)` or `UNIQUE(site_id, ...)` constraint exists on `users` anywhere in 001-061.
- `users.email UNIQUE` **is** global, not per-tenant (migration 011, re-confirmed). This does create one real, currently-unaddressed limitation: **a single person cannot hold accounts on two different tenants (or a platform account and a tenant account) using the same email.** For a platform staff member who might also want a tenant-side account under the same address (e.g., to review a client's dashboard as that client would see it), this doesn't work today and isn't addressed by the design. This is a reasonable limitation to accept, but it is a product decision, not a neutral fact — flagging per the "do not silently decide" instruction rather than assuming it's fine.
- Given the above, a separate membership/junction table is correctly judged unnecessary **for the stated scope** (one user, one tenant). It would only be justified if "one person, multiple tenants" becomes a requirement — explicitly out of scope per the design, and this review agrees that's the right line to hold for now.
- Adding `role`/`status` columns is schema-sufficient for the proposed model. No missing piece found.

**Finding — LOW**: Document the "one email, one tenant (or the one platform tenant)" limitation explicitly as an accepted constraint, not an oversight.

## 5. Tenant lifecycle

**The active → suspended → deleted state machine is sound in shape; enforcement has two concrete correctness problems.**

- **Self-lockout risk — CRITICAL**: Nothing in the design excludes `COMPANY_SITE_ID` from being a valid target of the proposed suspend/delete routes. If a Platform Admin's own company site is ever suspended (accidental bulk action, wrong id typed, a bug), and `requireAuth` then blocks any session whose site isn't `active`, **every platform staff member is locked out simultaneously**, including from the UI that would undo it. The suspend/delete routes must explicitly reject `siteId === COMPANY_SITE_ID` as an invalid target, at the route layer, unconditionally.
- **Performance/architecture shift — MEDIUM**: `requireAuth` today does zero DB queries — it reads only `req.session` (`login.js:168-175`, confirmed). Adding a `sites.status` check means either (a) a DB round-trip on *every single authenticated API request in the entire application* (a real, app-wide latency/DB-load change, not scoped to admin routes), or (b) caching status in the session itself and accepting some staleness (a suspended tenant could keep working for up to the session's remaining life unless the session is also actively invalidated on suspend). The design doesn't pick one — it should, explicitly, before implementation. Recommendation: cache `status` in session at login, and force session invalidation as part of the suspend action (see §8's session-invalidation gap, which needs solving either way) rather than adding a per-request join.
- **MCP/OAuth not covered — CRITICAL, cross-referenced from §3.** Suspension as designed only touches `requireAuth`. Must be extended to `requireMcpToken` and the OAuth token-validation path, or suspending a tenant does not actually stop that tenant's data access via MCP.
- **Cron correctly scoped**: `listConnectedSites()` (`job.js:301-304`) is a simple JS filter over `listSites()`'s full result set — adding `&& s.status === 'active'` there is a small, low-risk, correctly-targeted change, exactly as the design proposes. No issue found here.
- **Reports/integrations**: no independent breakage found beyond what's already covered by the cron filter — daily/weekly/executive report generation and GSC/GA4 ingestion all originate from the same `listConnectedSites()` call path.

### Hard deletion — foreign keys re-verified directly, design's claim is **wrong**

The design states: *"existing `ON DELETE CASCADE` FKs mean a manual DB-level delete would cascade cleanly... hard delete is the first thing that would exercise it."* **This is incorrect.** A full FK catalog across all 61 migrations found **three tables with no `ON DELETE` behavior specified on their `sites` FK**, which defaults to Postgres `NO ACTION` and will **block** `DELETE FROM sites` with a foreign-key-violation error if any row exists:

| Table | Column | Current behavior | Row likely to exist? |
|---|---|---|---|
| `growth_targets` | `site_id` (`NOT NULL`) | unspecified → `NO ACTION` (blocks) | Yes, if the tenant ever used AI Growth Platform target-setting |
| `integration_health` | `site_id` (nullable) | unspecified → `NO ACTION` (blocks) | Yes, almost certainly — populated automatically by routine health checks |
| `signup_requests` | `created_site_id` (nullable) | unspecified → `NO ACTION` (blocks) | Yes, for any tenant that originated from an approved signup request |

**Finding — CRITICAL**: As designed, hard-deleting almost any real tenant would throw a foreign-key-violation error the first time it hits one of these three tables — not a clean cascade. This must be fixed with a new migration adding explicit `ON DELETE` behavior before Phase 3/hard-delete work begins. Recommendation: `growth_targets` and `integration_health` → `CASCADE` (purely derived/operational data, safe to remove with the tenant); `signup_requests.created_site_id` → `SET NULL` (preserves the historical fact that a signup request existed and was approved, even after the resulting tenant is later deleted — useful for fraud/abuse history, and consistent with how `api_tokens.created_by`/`drafts.approved_by` already use `SET NULL` for the same "preserve history over the referenced row" reasoning).

**Finding — CRITICAL, self-defeating if missed**: If a new `audit_log` table follows the codebase's dominant convention and adds a plain `tenant_site_id INT REFERENCES sites(id) ON DELETE CASCADE`, then **hard-deleting a tenant automatically deletes that tenant's entire audit history, including the log entries recording the deletion itself.** This defeats the audit log's stated purpose. `audit_log`'s FK(s) to `sites`/`users` must use `ON DELETE SET NULL` at minimum, and should additionally store denormalized snapshot fields (e.g. tenant name/domain, actor email, both captured at write time) precisely so the record remains meaningful even after the referenced rows are gone. This is not covered anywhere in the design.

- **OAuth tables (057-060)**: all correctly use `CASCADE` on both `site_id` and `user_id` — no blocking issue here, and cascading them along with a tenant delete is the right behavior (no reason to retain a deleted tenant's OAuth grants).
- **Indirect cascade worth confirming is intended**: `sites → users (CASCADE)` means deleting a site deletes its users, which then triggers `drafts.approved_by`/`api_tokens.created_by` → `SET NULL` on rows those users touched **outside their own tenant's data** (there are none today, since users only ever act within their own tenant — but worth stating as confirmed-safe rather than assumed).

## 6. Audit logging

- **Must log**: every action explicitly listed in the design's §6 examples (tenant create/approve/update/suspend/delete, user invite/remove/role-change, integration connect/disconnect, MCP token create/revoke by a platform admin, manual agent trigger, config change) — confirmed appropriate, nothing to remove from that list.
- **Should NOT log**: high-frequency reads (dashboard polling, `GET /api/agents/live` SSE stream, health checks) — logging these would drown the signal and isn't what "audit" means here. The design already implicitly scopes to mutating actions via `recordAuditEvent` being called explicitly per-handler rather than wrapped automatically — correct instinct, worth stating as an explicit rule: **never call `recordAuditEvent` from a GET handler.**
- **`actor_id`/`actor_site_id`/`tenant_site_id` — insufficient as specified**:
  - Missing `actor_role` (a snapshot of the actor's role *at the time of the action*). Roles change; looking up "what could this person do" via their *current* role at audit-review time gives a wrong answer for historical entries after any role change.
  - Missing IP/user-agent. The design's own §5/MCP requirement ("suspicious/failed authentication activity") cannot be satisfied without it — "suspicious" is inherently about origin, not just action type.
  - Missing an `actor_type` value for MCP/OAuth-token-initiated mutations. The design's enum (`platform_user`/`tenant_user`/`system`) has no slot for "an `automation`-tier MCP token approved and pushed a draft" — a real, already-existing mutating action path (`mcp/tools/automation.js`) that this audit log should also be able to record. Add `mcp_token` as a fourth `actor_type`, with `actor_id` = the token's id.
- **Sensitive data in `metadata` — real risk, not hypothetical**: the design's own `recordAuditEvent` pattern (call explicitly per-handler, not automatically) is the right mitigation *if followed correctly*, but nothing stops a future handler from doing `metadata: req.body` as a shortcut — which for a password-reset or invitation-accept handler could write a plaintext password or reset token into a permanent, presumably-more-widely-readable table. **Explicit rule needed**: `metadata` must be an allowlisted, per-action-type field set, never a raw dump of `req.body`/`req.query`.
- **Should audit records ever be deletable?** No. Recommend application-layer: no delete route is ever built for `audit_log`, not even for Platform Admin. For real defense-in-depth, also recommend the DB role the app connects as not be granted `DELETE`/`UPDATE` on `audit_log` at all — enforced at the database grant level, not just by omission in the route layer, so a future code change can't accidentally add a delete path.
- **System-generated actions**: the proposed `actor_type = 'system'` (for e.g. an automatic hourly-catchup-triggered action) is correct and sufficient, with `actor_id = NULL`. Combined with the `mcp_token` addition above, that gives four actor types: `platform_user`, `tenant_user`, `mcp_token`, `system` — covering every mutating path this review found.

## 7. Platform Admin cross-tenant access

This is the section with the most direct correctness implications, and the finding in §1 is the crux of it: **the existing `:siteId`-in-URL pattern (`clients.js`) is safe today only because there is exactly one trust tier behind it.** It is not, by itself, IDOR-proof — it's authorization-free at the per-request level, relying entirely on the router-level gate. That's an acceptable trade *only* as long as every route behind that gate is intended to be usable by every user who passes the gate. The moment `platform_support` exists as a genuinely lower tier, this stops being true unless routes are updated together with the role.

**Recommended safest pattern** (concrete, not just "add checks"):
1. **Keep cross-tenant store functions in a separate module**, never mixed into tenant-scoped equivalents. The design already does this implicitly (a new `listAllApiTokensAcrossSites` distinct from `listApiTokensForSite`) — make it explicit as a rule: anything with no `site_id` filter, or a caller-supplied `site_id` filter, lives in e.g. `server/store/admin/*.js`, physically separated so it can never be imported by mistake into a tenant-facing route file. `api-tokens.js`'s existing five functions are a good model of the *opposite* pattern to preserve: `listApiTokensForSite(siteId)` takes `siteId` as its only, trusted filter, and `revokeApiToken(siteId, id)` requires both in the `WHERE` clause — that "always filter by the caller's own scope, defense-in-depth even when the caller is already authorized" habit should carry into the new admin-only functions too, just with the "own scope" being "the explicitly-audited target tenant," not "any tenant the caller feels like passing."
2. **Every platform route handler must validate the target id exists AND is not `COMPANY_SITE_ID`** for any status-changing action (§5), and **must call `recordAuditEvent` before returning success** — make this an explicit per-route requirement, not implied by the audit-log section alone, since the two sections in the design are currently written independently of each other.
3. **Per-route role checks for destructive actions**, not router-level. Concretely: `clients.js`'s existing `router.use(requireAuth, requireInternalSite)` stays as the floor for the whole router (read/connect/onboard-type actions), but new suspend/delete routes add their own `requirePlatformRole('platform_admin')` check inline, layered on top — the router-level check narrows the audience, the route-level check narrows it further for the specific dangerous ones.

No evidence of accidental trust of caller-supplied site IDs was found in *existing* code (§1) — the risk here is entirely about what gets built next, not a bug already present.

## 8. User lifecycle

- **Invitation/reset token replay**: the design's `accepted_at`/`used_at` columns are the right shape, but the acceptance/consumption logic must be a single atomic `UPDATE ... WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > now() RETURNING ...` (or the `used_at` equivalent for password resets) — the same atomic-claim pattern the codebase already uses for `signup_requests` approval (`WHERE status = 'pending'` guard, confirmed in the earlier audit and consistent with this codebase's established style) to prevent a race between two concurrent accept attempts. The design doesn't specify atomicity explicitly — it should, since a naive "check then update" (two statements) has a real TOCTOU race.
- **Expired invitation reuse**: covered by the same atomic clause above (`expires_at > now()`); make sure this is enforced at accept time, not just at invite-creation/display time.
- **Invitation enumeration**: the accept route correctly uses an opaque token, not a sequential id (per the design). Ensure any "resend" or "list pending invites" capability stays tenant-admin-scoped (own tenant only, matching `req.siteId`) and never exposes whether a *specific email* has a pending invite to an unauthenticated caller.
- **Privilege escalation via invite — CRITICAL, not explicitly closed by the design**: the design states "a Tenant Admin cannot elevate anyone to `platform_admin`" as a rule but doesn't specify the concrete server-side check. An invite handler that accepts `{ email, role, site_id }` from the request body and trusts `site_id`/`role` as given would allow a Tenant Admin to invite `{ role: 'platform_admin', site_id: <someone else's tenant> }`. Required, explicit validation: for a Tenant-Admin-initiated invite, `site_id` must be forced server-side to `req.siteId` (never read from the body), and `role` must be restricted to `{tenant_admin, tenant_member, tenant_viewer}` — a Platform-Admin-initiated invite is the only path that may set `role` to a platform tier or an arbitrary `site_id`. This needs to be a named validation step in the route, not an assumed consequence of "roles exist."
- **Disabled users retaining active access — CRITICAL, confirmed as a real, currently-unaddressed gap, not a hypothetical**:
  - **Human sessions**: `requireAuth` checks only `req.session.userId`/`req.session.siteId` presence (`login.js:168-175`) — it does not, and as designed would not, re-check `users.status` per request unless explicitly added (same trade-off discussed in §5 for tenant status). Disabling a user does **not** invalidate their existing 14-day session cookie/server-side session row on its own.
  - **OAuth tokens** (§3, restated here because it's the same root cause applied to a second lane): `oauth_access_tokens`/`oauth_refresh_tokens.user_id` only cascade-clear on hard user deletion, not on a `status` update.
  - **Required fix, one of**: (a) add a `users.status` check alongside the `sites.status` check discussed in §5, accepting the same per-request-DB-cost trade-off and needing the same explicit decision; or (b) actively invalidate on disable — destroy the human session row(s) for that user (connect-pg-simple's `session` table is keyed by session id with an opaque JSON payload, not indexed by `userId`, so "find and destroy all sessions for user X" is not a built-in capability and would need either a secondary index or a full-table scan — this is a real implementation cost the design doesn't currently account for) and separately revoke that user's `oauth_access_tokens`/`oauth_refresh_tokens` rows (this one is easy — direct `UPDATE ... WHERE user_id = $1`). Recommendation: do (b) for OAuth tokens (cheap, direct), and for human sessions either accept a bounded staleness window (shorten `maxAge` for this purpose, or document the up-to-14-day exposure explicitly as a known limitation) or add a lightweight `session.disabledCheckedAt`-style periodic re-validation rather than a per-request DB join. This is a decision the design needs to state explicitly, not leave implicit.
- **Platform staff creation**: same invite mechanism, `site_id` forced to `COMPANY_SITE_ID`, `role` restricted to platform tiers, and — per §2 — only `platform_admin` (not `platform_support`, once meaningful) should be able to invite new platform staff at all.

## 9. Tenant deletion — consolidated

Already detailed in §5. Restated as the direct answer to this section's question: **the earlier audit's FK information was insufficient for this purpose** (it only established that CASCADE existed *somewhere*, not that it existed *everywhere needed*) and **the design's assumption built on top of it is incorrect**. Tables requiring special handling before hard-delete can safely ship: `growth_targets`, `integration_health`, `signup_requests` (missing/wrong `ON DELETE` behavior — blocks deletion), and the new `audit_log` table itself (must not `CASCADE`, or deletion destroys its own audit trail).

## 10. Platform Settings

**Agree with the design's own hedge — and recommend tightening it into an explicit "do not build" rather than a soft "build only if needed."** The two examples the design gives (`AGENTIC_ORCHESTRATION_ENABLED`, a hypothetical "pause all cron") are legitimately deploy-time/infra concerns already served adequately by env vars today — nothing in this review's investigation surfaced a concrete, current need to make either of them runtime-editable through a UI. Moving deployment secrets (`SESSION_SECRET`, SMTP creds, API keys) into a DB-backed settings table would be a straightforward regression, and the design correctly excludes that. Recommendation: remove `platform_settings` from the phased plan entirely for this release; revisit only if a specific, named operational need is identified later.

## 11. Monitoring / System Health

**Agree with the design's restraint; sharpening it slightly.** The three pieces the design proposes reusing (DB ping, `integration_health` rollup, `agent_runs` failure-count aggregation) are genuinely just new read queries over existing data/connections — no new dependency required, correctly scoped. The one item flagged as "worth its own decision point" (a logging/error-tracking library) should be **explicitly excluded from this project's first release**, not left as an open option inside the same phase — introducing a new runtime dependency (Sentry, Pino, etc.) is a separate infrastructure decision with its own rollout/cost considerations and shouldn't ride along with an admin-console feature phase. Recommendation: System Health v1 = existing-data rollups only; a logging/error-tracking dependency, if wanted, becomes its own future initiative.

## 12. Implementation sequencing — see §L below for the full revised plan.

---

# Findings Summary (by severity)

**CRITICAL**
1. Hard-delete would fail with a FK violation against `growth_targets`, `integration_health`, `signup_requests` as currently specified — design's cascade claim is incorrect (§5, §9).
2. `audit_log`, if given a standard `CASCADE` FK to `sites`, would self-destruct its own record of a tenant's deletion — the exact opposite of its purpose (§5, §9).
3. Tenant suspension enforcement (`requireAuth` only) does not reach MCP bearer tokens or OAuth access/refresh tokens — a "suspended" tenant remains fully reachable via MCP (§3, §5).
4. Disabling a user does not invalidate their existing session or their OAuth access/refresh tokens — both remain live until natural expiry (§3, §8).
5. No explicit server-side rule prevents a Tenant Admin from inviting a user with an elevated role or into a different tenant via a body-supplied `role`/`site_id` (§8).
6. No explicit exclusion of `COMPANY_SITE_ID` from suspend/delete targets — a mistaken action here locks out all platform staff simultaneously with no in-app recovery path (§5).

**HIGH**
7. `clients.js`'s router-level-only authorization gate means Phase 1's proposed role swap is not actually a no-op once destructive routes are added later unless those routes are given their own stricter, per-route check (§1, §2, §7).

**MEDIUM**
8. `platform_support` and `tenant_viewer` have no current functionality to differentiate against — building enforcement for them now is premature; reserve the values, defer the enforcement (§2).
9. Hard tenant deletion has no precedent of any comparably destructive existing action — consider a stronger confirmation mechanism (second admin, mandatory reason) given the blast radius (§2).
10. Adding a `sites.status`/`users.status` check to `requireAuth` turns it from a zero-DB-query function into a per-request DB dependency for the entire application — needs an explicit caching/invalidation decision, not left implicit (§5, §8).
11. `audit_log`'s proposed fields (`actor_id`/`actor_site_id`/`tenant_site_id`) omit `actor_role` snapshot, IP/user-agent, and an `actor_type` for MCP-token-initiated actions — insufficient for the "suspicious activity" requirement the design itself states (§6).

**LOW**
12. Global email uniqueness across tenants is a real, if minor, product constraint (no person can hold both a platform account and a same-email tenant account) — should be stated as an accepted decision, not left implicit (§4).
13. `metadata` in `audit_log` needs an explicit allowlist-only rule to avoid a future handler dumping `req.body` wholesale and leaking sensitive fields (§6).

---

# Verdict

## 3. DO NOT IMPLEMENT YET

Not because the architecture is wrong in shape — the layering (same app/DB, role column instead of a new service, additive schema, explicit-target-id platform routes, separate MCP lane) is sound and the right call. But six CRITICAL findings are the kind that are cheap to fix on paper now and expensive to fix after Phase 0/3 schema ships (a wrong FK behavior, a self-destructing audit table, and two lifecycle mechanisms that silently don't cover MCP/OAuth are not "iterate during implementation" issues — they're "get the migration right the first time" issues). Once the exact changes below are folded into the design document, this moves to APPROVED WITH CHANGES / ready for Phase 0.

## Exact changes required before implementation

1. **Fix the three FK behaviors** before any hard-delete work: `growth_targets.site_id` → `ON DELETE CASCADE`, `integration_health.site_id` → `ON DELETE CASCADE`, `signup_requests.created_site_id` → `ON DELETE SET NULL`. Add this as an explicit migration in Phase 0, not Phase 3, so it's in place well before it's needed and can be tested independently.
2. **Specify `audit_log`'s FK behavior explicitly as `ON DELETE SET NULL`** (or no enforced FK, using denormalized snapshot fields instead) for both `actor_site_id` and `tenant_site_id`, and forbid `DELETE`/`UPDATE` on the table at the DB grant level, not just by omitting a route.
3. **Extend suspension/disablement enforcement to the MCP and OAuth lanes explicitly**: add the equivalent status check to `requireMcpToken` and the OAuth token-validation path, called out as its own concrete task in the phase plan — not left as an assumed side effect of the `requireAuth` change.
4. **Add an explicit session/token invalidation step to the "disable user" action**: revoke `oauth_access_tokens`/`oauth_refresh_tokens` directly (cheap `UPDATE`), and make an explicit, stated decision about human session invalidation (status-check-in-requireAuth vs. accepted staleness window) rather than leaving it implicit.
5. **Add explicit server-side role/site_id enforcement to the invite handler**: Tenant-Admin-initiated invites force `site_id = req.siteId` and restrict `role` to tenant-tier values; only Platform-Admin-initiated invites may set a platform role or an arbitrary `site_id`.
6. **Add an explicit `COMPANY_SITE_ID` exclusion check** to every suspend/delete route, unconditionally, at the top of the handler.
7. **Move per-route destructive-action authorization out of the router-level gate**: `clients.js`-style routers keep their existing router-level floor for non-destructive actions; new suspend/delete/cross-tenant-MCP-revoke routes add their own `requirePlatformRole('platform_admin')` check inline.
8. **Defer `platform_support` and `tenant_viewer` enforcement** to a later phase (reserve the CHECK-constraint values now, build nothing that depends on the distinction until Phase 3+ produces routes that need it).
9. **Expand `audit_log`'s schema**: add `actor_role` (snapshot), `ip_address`, `user_agent`, and a fourth `actor_type` value (`mcp_token`) alongside `platform_user`/`tenant_user`/`system`.
10. **State the "one email, one tenant" limitation explicitly** in the design as an accepted constraint.
11. **Remove `platform_settings` from the phase plan** entirely for this release (§10) rather than leaving it as a soft "build if needed" — no concrete need was found.
12. **Scope System Health v1 to existing-data rollups only**; explicitly exclude introducing a logging/error-tracking dependency from this project (§11).

---

# L. Revised Implementation Plan

Each phase restates the original goal from `PLATFORM-ADMIN-DESIGN.md` §K, folding in the fixes above. Still design-only — nothing here is implemented.

### Phase 0 — Foundational schema + the two FK corrections
- **Objective**: Additive schema only, zero behavior change, and close the two schema-level CRITICAL gaps (FK cascade, audit_log FK) before anything depends on them.
- **Existing files/modules affected**: none at the route/UI level.
- **Database changes**: `users.role`/`status` (defaulted, backfilled: `platform_admin` for existing `COMPANY_SITE_ID` users, `tenant_admin` for all others); `sites.status`/`deactivated_at`/`deleted_at` (defaulted `active`); new `audit_log` table with `SET NULL` FKs and denormalized snapshot fields, DB grants excluding `DELETE`/`UPDATE` for the app role; corrective migration for `growth_targets`/`integration_health`/`signup_requests` FK behavior (Finding #1).
- **Backend changes**: none yet — no route reads these columns.
- **Frontend changes**: none.
- **Security risks**: low — additive only. Main risk is an incorrect backfill (verify every existing `users` row gets a non-null role before the `NOT NULL` constraint is added).
- **Verification tests**: run existing full test/dev flow unchanged after migration; confirm `SELECT role, status FROM users` has no nulls; confirm the corrective FK migration with a manual `DELETE FROM sites WHERE id = <test tenant>` in a scratch/dev DB now succeeds past those three tables (test tenant with rows in all three).
- **Rollback**: drop the new columns/table; the FK-behavior migration is the only one with any real rollback complexity (revert `ON DELETE` clauses) — do it in dev against a seeded copy first.

### Phase 1 — RBAC middleware, no new destructive surface
- **Objective**: Introduce `requirePlatformRole`/`requireTenantRole` and prove today's internal console behaves identically — genuinely a no-op this time, because no destructive routes exist yet to worry about the router-level-gate issue (Finding #7 doesn't bite until Phase 3).
- **Existing files/modules affected**: `login.js` (new middleware functions alongside existing `requireInternalSite`, which can either be kept as an alias or replaced call-site-by-call-site), every router currently using `requireInternalSite`.
- **Database changes**: none beyond Phase 0.
- **Backend changes**: `requirePlatformRole('platform_admin')` used everywhere `requireInternalSite` is used today (not `'platform_support'` — see Finding #8, defer that distinction).
- **Frontend changes**: `GET /api/me` response gains a `role` field alongside existing `isInternal`.
- **Security risks**: low, but verify no route was accidentally left ungated during the swap (diff every router's middleware chain before/after).
- **Verification tests**: full regression of existing `/clients` console functionality; confirm a non-platform session still gets 404 (not 403) on every previously-internal route.
- **Rollback**: revert middleware swap, `requireInternalSite` untouched as a fallback.

### Phase 2 — Audit logging, passive, wired to existing routes only
- **Objective**: Start capturing history using the corrected schema from Phase 0, on actions that already exist — no new actions yet.
- **Existing files/modules affected**: `clients.js` (existing connect/retry-baseline/connect-repo/approve/reject handlers), `mcp-tokens.js` (existing revoke handler).
- **Database changes**: none beyond Phase 0.
- **Backend changes**: `recordAuditEvent` helper (allowlisted fields only per Finding #13, includes `actor_role`/IP/UA per Finding #11), called explicitly at the end of each existing mutating handler above.
- **Frontend changes**: none (no UI to view it yet).
- **Security risks**: the allowlist discipline itself — review each call site for accidental `req.body` dumping.
- **Verification tests**: trigger each wired action in dev, confirm exactly the intended fields land in `audit_log`, confirm no route without an explicit call silently logs nothing extra.
- **Rollback**: remove the helper calls; table stays empty but harmless.

### Phase 3 — Tenant lifecycle, MCP/OAuth-aware
- **Objective**: Suspend/reactivate/soft-delete, enforced consistently across session, MCP, and OAuth (Findings #3, #6), with per-route destructive-action gating (Finding #7).
- **Existing files/modules affected**: `login.js` (`requireAuth`, decision from Finding #10 implemented), `mcp/auth.js` (`requireMcpToken`), `server/mcp/oauth-provider.js`, `job.js` (`listConnectedSites` status filter), `clients.js` (new suspend/reactivate/soft-delete routes with inline `requirePlatformRole('platform_admin')` plus the `COMPANY_SITE_ID` exclusion from Finding #6).
- **Database changes**: none beyond Phase 0 (columns already exist).
- **Backend changes**: status checks in all three auth lanes; cron filter update; new routes; every new route calls `recordAuditEvent`.
- **Frontend changes**: status controls added to the existing tenant console (extends `ClientOnboarding.jsx`).
- **Security risks**: this phase carries the bulk of this review's CRITICAL findings — test the `COMPANY_SITE_ID` exclusion explicitly and adversarially (attempt to suspend it directly and via any bulk/indirect path).
- **Verification tests**: suspend a test tenant → confirm session-based, MCP-token-based, and OAuth-token-based access all reject; confirm cron skips it; confirm reactivation restores all three; confirm attempting to suspend `COMPANY_SITE_ID` is rejected at the route.
- **Rollback**: status flip back to `active`; no destructive step yet at this phase (hard-delete is deliberately not in Phase 3).

### Phase 3.5 — Hard tenant deletion (split out as its own phase given the blast radius)
- **Objective**: Irreversible deletion, gated separately from suspend/soft-delete given Finding #9's recommendation.
- **Existing files/modules affected**: `clients.js` (new route), relies on Phase 0's FK corrections.
- **Database changes**: none beyond Phase 0.
- **Backend changes**: two-step confirmation (typed tenant name at minimum; consider the second-admin/reason requirement from Finding #9), mandatory retention window since soft-delete, `recordAuditEvent` before the irreversible step executes (so the log entry exists even if something fails partway).
- **Frontend changes**: destructive-action UI with explicit confirmation flow.
- **Security risks**: the single highest-risk action in the whole design — recommend a feature flag/staged rollout (available to one Platform Admin account first, in production, before general availability) rather than shipping to all platform staff at once.
- **Verification tests**: delete a fully-populated test tenant (with rows in every FK-referencing table, deliberately including `growth_targets`/`integration_health`/`signup_requests`) and confirm it completes without error; confirm the audit log entry for the deletion itself survives the deletion (Finding #2).
- **Rollback**: none — this is why it's split into its own phase with its own explicit sign-off, separate from Phase 3.

### Phase 4 — User/team management
- **Objective**: Invitation flow, role changes, disable/remove, admin-triggered password reset — with the escalation and session/token-invalidation fixes (Findings #4, #5) built in from the start rather than retrofitted.
- **Existing files/modules affected**: new `server/routes/users.js`, `server/routes/user-invitations.js`; `login.js` gains request/complete password-reset routes; `Settings.jsx` gains a "Team" tab for Tenant Admins.
- **Database changes**: new `user_invitations`, `password_resets` tables (atomic single-use consumption per Finding #8's TOCTOU note).
- **Backend changes**: invite (role/site_id enforcement per Finding #5), accept, role-change, disable (with OAuth token revocation + session-invalidation decision from Finding #10/#4), password reset request/complete.
- **Frontend changes**: `admin/Users.jsx` (platform-wide directory), Tenant Admin's own "Team" tab in `Settings.jsx`.
- **Security risks**: the largest net-new attack surface in the whole design — invitation token handling, role-escalation boundaries, and session/token invalidation all land here together; recommend a dedicated focused security pass on this phase specifically before it ships, separate from this document's general review.
- **Verification tests**: attempt a Tenant-Admin-initiated invite with an elevated role/foreign site_id in the request body and confirm rejection; attempt to reuse an accepted invitation token and an expired one; disable a user with a live session and a live OAuth token and confirm both stop working per the Phase 3 decision.
- **Rollback**: feature-gate the invite UI; underlying tables are additive and harmless if unused.

### Phase 5 — Platform MCP oversight
- **Objective**: Cross-tenant token read/revoke, with the separated-module pattern from Finding §7.
- **Existing files/modules affected**: new `server/store/admin/mcp-tokens.js` (physically separate from `api-tokens.js`), new `server/routes/mcp-admin.js`, reuses existing `revokeApiToken` for the actual revoke.
- **Database changes**: none.
- **Backend changes**: `listAllApiTokensAcrossSites` (metadata only, no `token_hash`), revoke reuses existing logic, both call `recordAuditEvent`. If pursuing persisted invalid-auth tracking (currently in-memory only in `mcp/auth.js`), add that as an explicit sub-task with its own table, not folded silently into this phase.
- **Frontend changes**: `admin/McpAdmin.jsx`, deliberately a separate component from tenant-facing `McpTokensCard.jsx`.
- **Security risks**: lower than Phase 3/4 — mostly read, and the one write (revoke) reuses already-hardened logic.
- **Verification tests**: confirm the cross-tenant list never includes `token_hash`; confirm revoking via the platform route actually invalidates the token for MCP auth purposes.
- **Rollback**: feature-gate the new UI/routes; no schema change to undo.

### Phase 6 — Platform Ops / System Health (existing data only, per Finding on §11)
- **Objective**: Read views over `agent_runs`, cron state, `integration_health` — explicitly no new dependency.
- **Existing files/modules affected**: none mutated; new read-only routes over existing tables/pool.
- **Database changes**: none.
- **Backend changes**: aggregation queries only.
- **Frontend changes**: `admin/SystemHealth.jsx`.
- **Security risks**: minimal — read-only, staff-gated.
- **Verification tests**: confirm the DB-ping and rollup views reflect actual state during a simulated failure (e.g., temporarily break a test integration and confirm it surfaces).
- **Rollback**: trivial — remove the read routes/UI.

### Phase 7 — UI consolidation
- **Objective**: Reorganize navigation into the fuller admin structure once the modules above exist.
- **Existing files/modules affected**: `Sidebar.jsx`, route structure.
- **Database changes**: none. (`platform_settings` explicitly excluded per Finding on §10 — not part of this or any phase in this plan unless a concrete need is identified later.)
- **Backend/frontend changes**: navigation/IA only, no new capability.
- **Security risks**: none beyond standard regression risk of a nav reorganization.
- **Verification tests**: full navigation smoke test across both platform and tenant roles.
- **Rollback**: trivial.
