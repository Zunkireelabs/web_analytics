---
name: future-multi-client-architecture
description: Long-term architecture roadmap for evolving the Core Dashboard from today's one-deployment-per-client model into a single shared product that serves many isolated clients — one product identity, dynamic per-client company name/website/logo shown after login, isolated credentials, and low-effort onboarding. Planning document only — nothing here is implemented; it is the target end-state to build toward deliberately, phase by phase.
---

# Future Multi-Client Architecture — Roadmap

**Status: Phases 1–5 (§12) are now shipped** — data model, ingestion loop,
per-client isolated auth, tenant branding delivery (logo + company name), and
a Postgres-backed session store all exist and are verified in the codebase.
See `master-product` skill §5/§20 for the current, as-built state. The
implementation was verified against a temporary test site created and then
deleted via `create-client.js`/`connect-site.js` — no real second client has
been onboarded yet. What remains from this roadmap: Phase 6 (onboard the
first real second client as a live proof) and Phase 7 (rewrite
`client-onboarding` for the new data-insert-based flow — not yet done; that
skill still describes the old new-deployment-per-client process). The open
decisions in §13 (URL scheme, one-vs-many users per
client, shared-vs-per-client Google service account) remain open — none were
forced by the Phase 1–5 implementation work.

This document otherwise remains the **target end-state** design reference,
not a description of everything that exists today — read it alongside:

- **master-product** skill — current, verified state of the Core Dashboard
  (Part 1) and the internal-only AI Growth Platform (Part 2). §20 there is
  the exact statement of today's single-tenant reality this document is
  proposing to move past.
- **client-onboarding** skill — the current per-client process (clone the
  repo, stand up a whole new deployment). Once this architecture ships, that
  skill describes the *old* process and will need a full rewrite — don't
  treat both as simultaneously current.
- **multi-client-migration** skill — the hardcoding audit and its own
  "Stage 2 (DB-driven branding)" is the earlier, narrower version of the idea
  this document expands into a full architecture. Where the two disagree on
  detail, this document is the more current, more deliberate design — see
  §1 for why the scope is actually narrower than that Stage 2 sketch implied.

## 0. What "done" looks like

Restating the five target properties precisely, because two of them resolve
an ambiguity worth being explicit about before any design decision below
makes sense:

1. **One product name is used across every deployment.** The product itself
   — its name, logo, favicon, color palette, page layout — is the same for
   every client, everywhere. This is not a white-label product where each
   client gets their own reskinned app.
2. **Clients see their own company name, website, and optional logo — after
   login.** This is *tenant context*, not a re-theme: once authenticated, the
   dashboard shows *whose* data you're looking at (their company name, the
   website being tracked, optionally a small logo/avatar), the same way
   Google Analytics shows "Acme Corp" as the account name without Google
   Analytics itself looking any different per customer.
3. **The dashboard layout remains identical.** No per-client forks of
   components, colors, or page structure. Ever — unless a client explicitly
   requests a custom feature, which is then a deliberate, tracked exception,
   not a template change (this rule already exists in the client-onboarding
   skill; it applies here even more strongly).
4. **Client branding is loaded dynamically from configuration or the
   database**, not baked into a build. One build of `web/dist`, one running
   process, serving every client — the dashboard fetches "who is this
   session's tenant" at runtime.
5. **Client credentials are isolated.** One client's login must never work
   for another client's data, and a compromised or leaked credential for
   Client A must not expose Client B. This does not hold today (§0 detail
   below) and is the largest architectural gap to close.
6. **New clients onboard with minimal development.** Adding a client becomes
   a data operation (insert a row, grant API access, maybe upload a logo) —
   not "clone the repo, stand up a new database, write a new `.env`, deploy a
   new container," which is what client-onboarding currently requires.

**Correction this implies to the multi-client-migration skill's Stage 2
sketch**: that document assumed the brand *color* would eventually become
per-client configurable via DB columns. Item 3 above rules that out — the
color-hardcoding audit findings there are still worth fixing (for
maintainability, DRY-ness, one source of truth), but the fix is
*centralizing* the one true color, not making it a per-tenant variable. The
only genuinely per-client dynamic fields are: **company name, website
(already the `gsc_property`/`ga4_property_id` the client is tracked by), and
an optional logo.**

## 1. Today vs. target, at a glance

| | Today (master-product §20, client-onboarding §0) | Target |
|---|---|---|
| Running instances | One per client | One shared instance for all clients |
| Database | One per client | One shared database, `sites` rows already isolate rows by `site_id` |
| Ingestion | `getOrCreateSite()` — exactly one site, resolved from process env | Loop over every active row in `sites` |
| Login | One shared `DASHBOARD_PASSWORD` per deployment, no accounts | Per-client (or per-user) isolated credentials |
| Branding | Hardcoded in JSX/CSS, or (per multi-client-migration Stage 1) baked in at build time per deployment | Company name/website/logo fetched at runtime, resolved from the authenticated session's tenant |
| Onboarding | New repo clone, new DB, new deploy, manual file edits | Insert a row, grant API access, done |
| Deployment identifiers (`docker-compose` container/router names, launchd labels) | One set, reused as-is per client's own isolated instance — no collision because instances don't share infra | Moot — there's only one instance |

## 2. Tenancy model

One Express process, one Postgres database, many `sites` rows — this part is
**already mostly true today** at the schema level (master-product §9, §20):
every fact table has a `site_id` FK, every `store/read.js`/`store/upsert.js`
function takes `siteId` explicitly. What's missing is everything around that
schema: the ingestion loop, the auth model, and the branding delivery. This
document is about building *those*, not about redesigning the schema from
scratch.

**Tenant resolution is session-bound, not URL-bound.** A client logs into
one shared URL (or optionally a client-specific subdomain — see §14, open
decision) and the server's session determines which `site_id` they're
scoped to for the rest of that session. The frontend never sends a
client-suppliable `?site=` and expects the server to trust it for anything
sensitive — see §5's security note, this is the single most important rule
in this whole document.

## 3. Data model changes

Extend `sites` (or introduce a companion table — see the auth discussion in
§5 for why a separate table may be cleaner) with the fields the target state
actually needs:

- **Company name** — already exists (`sites.name`), already flows into
  emails and Google Doc titles today. No new column needed; just needs to
  also flow into the dashboard UI (§6) and be resolved per-session instead
  of from a single-site env-driven row.
- **Website** — already exists in substance (`gsc_property`,
  `ga4_property_id`), but neither is a friendly display string (e.g.
  `sc-domain:example.com` isn't what you'd show a client as "your website").
  Consider a small additional `display_url` (or `website_url`) column purely
  for human-readable display, separate from the GSC/GA4 identifiers used for
  API calls — don't overload one field for two purposes.
- **Logo** — new column, e.g. `logo_url` (pointing at an uploaded asset — see
  §6 for storage options) or `logo_svg` (inline, if logos are small and
  simple enough to store as text safely). Optional per client; the UI must
  handle "no logo set" gracefully (e.g. fall back to initials, the way
  `Header.jsx`'s existing "ZL" badge pattern already does for the *product*
  brand today).
- **Isolated credentials** — see §5; this is the field(s) that don't exist
  in any form today and need the most design care.

## 4. Ingestion & job pipeline changes

Today, `server/db.js`'s `getOrCreateSite()` and every caller in `server/job.js`
(`runDailyIngest`, `runDailyJob`, `runWeeklyIfDue`, `runStartupCatchup`) and
every CLI script assume exactly one site, resolved from process env. Target:

- Replace the single `getOrCreateSite()` call sites with a loop over
  `listSites()` (already exists, already used by the dashboard's `/api/sites`
  route — just not by the ingestion side yet).
- **Isolate failures per client.** One client's GSC/GA4 API error, a revoked
  service-account grant, or an LLM failure must not block or delay another
  client's daily job. The existing per-step try/catch structure in
  `runDailyJob()` (master-product §11) already isolates narrative vs. email
  vs. doc-report failures *within* one site's run — extend that same
  discipline *across* sites: one site's `runDailyJob()` throwing should be
  caught and logged at the loop level, not allowed to abort the whole cron
  tick for every other client.
- **Google credentials per client** — today one service account (or one
  OAuth token) is configured for the single site via env vars
  (`GOOGLE_APPLICATION_CREDENTIALS` / `GOOGLE_OAUTH_*`). Decide (§14) whether
  multi-client stays on **one shared service account** granted access to
  every client's GSC/GA4 property (simplest — one Google Cloud project, one
  JSON key, N grants), or moves to **per-client credentials** (more
  isolation, more operational overhead per onboarding). The shared-service-
  account model is almost certainly the right starting point; the current
  process (client-onboarding §5–§6) already describes how to grant one
  service account access to a new property, which is exactly what "minimal
  development" onboarding (item 6) should keep relying on.
- **Scheduling stays a single cron**, just iterating N sites instead of
  running once for the one implicit site — no need for one cron job per
  client.

## 5. Authentication & credential isolation — the core gap

This is the part of the target state with **zero existing foundation**
today, and the part most likely to introduce a real security bug if rushed.
Read this section fully before writing any code toward it.

**What's wrong with extending today's model naively**: `server/routes/login.js`
today compares a posted password against one process-wide
`DASHBOARD_PASSWORD` env var and sets `req.session.authed = true` — a
boolean, not a tenant identity. Every route in `server/routes/metrics.js`
then trusts whatever `?site=` query param the client sends. That's fine when
there is exactly one client and one shared password (today), because there's
nothing to isolate *from*. It becomes a serious cross-tenant data leak the
moment a second client's data lives in the same database and the same
process — **anyone with valid login credentials could read any other
client's data just by changing the `site` query parameter**, because nothing
today checks that the authenticated session is *authorized* for the
requested site.

**Target design:**

1. **Move from "one password" to "one identity per client."** Recommended
   shape: a new table (e.g. `client_users` or `accounts`) with
   `id, site_id (FK), email or username, password_hash, created_at` — not a
   password column bolted directly onto `sites`, because a table gives you
   room to support more than one login per client later (§14) without a
   schema change, and because password hashing belongs on a row that
   represents "a credential," not "a tenant."
2. **Hash passwords properly.** `bcryptjs` is already a listed dependency in
   `package.json` and has been unused since this repo's very first commit
   (master-product §5 already flags this) — this is exactly where it
   finally gets used, replacing the current SHA-256 + `timingSafeEqual`
   comparison against a single plaintext env var.
3. **Login resolves an identity, not just a boolean.** `POST /api/login`
   looks up the account by email/username, verifies the password hash,
   and — critically — stores `site_id` (or the account id, with `site_id`
   looked up from it) in the session, not just `authed: true`.
4. **Every route in `metrics.js` must use the session's `site_id`, never the
   client-supplied one.** Concretely: stop reading `req.query.site` as the
   source of truth; read `req.session.siteId` instead (or, if a client
   account can ever belong to more than one site later, validate that the
   requested `site` is in the set the session is authorized for, and reject
   with 403 otherwise — never silently trust it). This is a full audit and
   edit of every handler in `server/routes/metrics.js`, not a one-line fix.
5. **Session store**: `express-session`'s `MemoryStore` (used today,
   already flagged as a scaling risk in master-product §4) becomes a bigger
   problem here — a restart logging out *every client at once* is now a
   multi-tenant incident, not a single-client inconvenience. Move to a
   Postgres- or Redis-backed session store before this ships to more than a
   couple of clients.
6. **Passwords still visible in a Google Doc, an email inbox, or a Slack
   message today (client-onboarding §9) must not become the model for N
   clients** — plan how credentials actually get delivered to a new client
   (a proper invite/reset flow eventually; a secure one-time link is a
   reasonable v1, a plaintext message is not, at this scale).

## 6. Branding delivery

- **Product-level branding** (name, logo, favicon, colors — item 1 in §0)
  stays exactly what it is today, centralized for maintainability (per the
  multi-client-migration skill's color-DRY recommendation) but **not** made
  per-tenant configurable. This is a one-time cleanup, done once, for
  everyone, forever — not a per-onboarding step.
- **Tenant-level branding** (company name, website, optional logo) is
  fetched by the frontend once a session exists — extend the existing
  `GET /api/me` (which today only returns `{ authed }`) to also return the
  session's resolved `{ siteId, companyName, websiteDisplay, logoUrl }`, or
  add a small dedicated `GET /api/tenant` alongside it. Either way, resolve
  these fields from the session's `site_id`, consistent with §5 — never from
  a client-supplied parameter.
- **Where it surfaces in the UI**: `Header.jsx` is the natural home (it
  already renders the site switcher for the (currently unused)
  multiple-sites case, master-product §14) — add the company name/logo
  there, likely near the existing site-name display, without touching the
  product logo/nav structure around it (item 3 in §0). Reuse the existing
  "initials badge" fallback pattern already in `Header.jsx` for clients
  without a logo.
- **Logo storage**: decide between an object-storage URL (S3/R2/Cloud
  Storage, referenced by `logo_url`) versus storing small SVGs inline in the
  DB. Object storage is the more conventional choice and avoids bloating
  `sites` rows or DB backups with binary/asset data; treat inline storage as
  a fallback only if adding a storage dependency is undesirable for the
  first version.

## 7. Frontend changes

Deliberately the smallest category of change, because item 3 (§0) rules out
most of what "multi-client frontend" usually implies:

- No new pages, no per-client component variants, no theme system beyond
  what §6 already covers.
- `App.jsx`'s site-selection logic (`GET /api/sites`, pick the first one)
  was written for the *single-tenant-with-a-site-switcher* case
  (master-product §13) — under real multi-tenancy, a logged-in client
  should generally see **only their own site**, so this either simplifies
  (no switcher needed for a single-site client) or needs to explicitly
  support the rare case of one login legitimately having access to more than
  one site (§14, open decision) rather than showing every site in the
  database to everyone, which is what `GET /api/sites` returns *today* with
  no filtering — that route itself needs the same session-scoping treatment
  as everything in §5.

## 8. Deployment model change

- One running instance (or a small, identical, load-balanced pool of them,
  once traffic justifies it) instead of N — this eliminates the
  `docker-compose` container-name/Traefik-router-name collision concerns the
  multi-client-migration skill raised for the *current* per-client-deployment
  model; those concerns simply don't apply once there's only one deployment.
- One domain, or a small number of them (see §14 for the subdomain-per-client
  question) — not one domain per client.
- Migrations apply once, to the one shared database, the same way they do
  today — no change needed there.
- `client-onboarding` skill's Docker/launchd instructions become
  irrelevant for *new client* onboarding under this model (they'd only
  still apply to standing up the shared instance itself, once, not per
  client) — flag that skill for a rewrite when this ships (see intro).

## 9. Onboarding under this architecture (target state)

Compare against client-onboarding's current ~10-section runbook: under this
architecture, adding a client becomes close to:

1. Insert a `sites` row (name, GSC property, GA4 property id, timezone,
   display URL, optional logo).
2. Insert a `client_users` row (or equivalent) with a hashed initial
   password or a one-time invite token (§5).
3. Grant the shared Google service account access to the new client's
   GSC/GA4 properties — this step doesn't go away; it's inherent to how GSC
   and GA4 access works, not an artifact of the current deployment model
   (client-onboarding §5–§6 already documents exactly this and stays
   accurate here).
4. Backfill a date range for the new site (`npm run ingest -- ...` already
   works per-site today, no change needed — master-product §11).
5. Send the client their login.

No repo clone, no new database, no new deployment, no per-client env file —
this is what "minimal development" (item 6, §0) means concretely. Whether
step 1–2 are done via a script, a small internal admin API, or eventually a
self-serve admin UI is an open question (§14), not a blocker to designing
the rest of this architecture.

## 10. Explicitly out of scope

- **The internal AI Growth Platform** (master-product Part 2) is not part of
  this roadmap. Nothing here proposes exposing `/api/agents*` to clients,
  multi-tenant-izing `agent_runs`, or productizing any of the specialist
  agents documented in master-product §22.
  That remains a fully separate, not-yet-made decision (master-product §22,
  §23) — this document doesn't move that decision forward one way or the
  other.
- **Per-client custom features** stay exactly what client-onboarding already
  says: a deliberate, tracked exception when a client explicitly asks for
  one, never a silent template fork. This architecture doesn't change that
  principle; if anything it raises the stakes, since a fork now has to be
  reconciled against a *shared* codebase serving every other client too,
  not just diverge quietly in one client's own isolated deployment.
- **Full white-label re-theming per client** (different logo *as the
  product's own logo*, different color palette, different domain per
  client's own brand) is not part of this vision per §0/item 1 and item 3.
  If that ever becomes a real requirement, it's a different, larger project
  than what this document describes — don't quietly fold it in here.

## 11. Security & isolation checklist (carry into implementation)

- [ ] No route in `metrics.js` (or any future route) ever trusts a
      client-supplied `site` parameter for anything the session isn't
      already authorized for (§5.4) — this is the one item that, if missed,
      turns "multi-client" into "cross-client data leak."
- [ ] Passwords are hashed (`bcryptjs`, already a dependency) — never
      compared against a plaintext value again.
- [ ] Session store survives a restart and doesn't log out every client at
      once (§5.5).
- [ ] `GET /api/sites` (and any similar "list everything" route) is scoped
      to what the current session is authorized to see, not the whole table
      (§7).
- [ ] One client's ingestion/report failure is caught and logged per-site,
      never allowed to abort or delay another client's daily job (§4).
- [ ] Credential delivery to a new client doesn't rely on plaintext
      channels as the permanent model (§5.6) — fine as a stopgap, not as the
      designed process.

## 12. Phased rollout (suggested order, not a fixed timeline)

Each phase should be independently shippable and testable — don't attempt
this as one big-bang rewrite.

1. **Data model**: add the new columns/table from §3 and §5 via migrations.
   No behavior changes yet; purely additive.
2. **Ingestion loop**: move `job.js` and the CLI scripts from
   `getOrCreateSite()` to iterating `listSites()`, with per-site failure
   isolation (§4). Verify against the *existing* single site first — this
   phase should be a no-op in observable behavior when there's still only
   one row in `sites`.
3. **Auth rework**: build the `client_users`-style login, session-bound
   `site_id`, and the full `metrics.js` audit for trusting the session over
   the query param (§5). This is the highest-risk phase; test it explicitly
   with two seeded sites and two accounts, confirming neither can read the
   other's data, before trusting it with real client data.
4. **Branding delivery**: extend `/api/me` (or add `/api/tenant`), wire
   `Header.jsx` to show the resolved company name/logo (§6).
5. **Session store upgrade**: move off `MemoryStore` (§5.5) — can happen in
   parallel with phase 3–4, not strictly sequential.
6. **Onboard the first second client** end-to-end using the §9 process as a
   live test of the whole roadmap, before writing the client-onboarding
   skill's replacement.
7. **Rewrite the client-onboarding skill** once the above is proven, so it
   documents the new (data-insert-based) process instead of the old
   (new-deployment-based) one — don't leave both documents claiming to be
   current at the same time.

## 13. Open decisions — need a product/business call before implementation starts

- **URL scheme**: one shared domain with session-based tenant resolution
  (as designed above), or per-client subdomains (`acme.yourproduct.com`), or
  even custom domains per client eventually? Subdomains would let branding
  be partially resolved before login (e.g. show the company name on the
  login screen itself), which the current §0/item 2 wording ("after login")
  suggests isn't required — but it's worth confirming that's intentional
  and not just unconsidered.
- **One login per client, or multiple users per client account?** The
  `client_users`-style table in §5 supports multiple without a schema
  change; decide whether that's needed now or later.
- **Shared Google service account vs. per-client credentials** (§4) —
  shared is simpler to onboard; per-client is more isolated if a client ever
  asks about your access model.
- **Self-serve admin tooling vs. scripts/direct DB access** for the
  onboarding steps in §9 — a small internal admin UI is more "minimal
  development" for the *operator* long-term, but is itself a real feature to
  build, not a free byproduct of the rest of this architecture.
- **Pricing/tiering implications**, if any — out of scope for this
  document technically, but worth flagging: once onboarding is cheap, the
  business question of how clients are charged/tiered becomes real in a way
  it wasn't when every client was a bespoke deployment.
