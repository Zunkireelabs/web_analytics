---
name: multi-client-migration
description: Audit of every hardcoded company-specific value in the Core Dashboard (Zunkiree branding, colors, credentials, deployment identifiers), a staged migration plan to move them into configuration or the database, and a reusability checklist for future client builds. Planning document only — no code has been changed to implement this yet; read before starting the actual refactor.
---

# Hardcoded Company Values — Audit, Migration Plan, Reusability Checklist

Scope: the reusable Core Dashboard only (master-product skill, Part 1,
§1–21). The internal AI Growth Platform (Part 2) is out of scope — it's
already excluded from the client template by policy, not by code, so it
isn't part of this hardcoding audit.

**Nothing in this document has been implemented.** It is the analysis and
plan to review before any of it is executed.

## 1. Audit — every hardcoded company-specific value found

Verified by direct grep against the current tree, not assumption.

### A. Real credentials checked into tracked files — highest priority, not just a "hardcoding" issue

| Location | What | Why it matters |
|---|---|---|
| `TEAM-GUIDE.md:22` | Literal current `DASHBOARD_PASSWORD` value in plaintext | This is a **real, current secret** committed to git (git log shows a commit literally titled "Restore dashboard password in team guide" — it was already removed and re-added once). Anyone with repo access — including a future client if this repo is ever handed over or cloned as a template — gets the live password. |
| `TEAM-GUIDE.md:21` | Literal production dashboard URL `https://analytics.zunkireelabs.com` | Not sensitive alone, but paired with the password above it's a working credential pair in a tracked file. |
| `TEAMMATE-SETUP.md:11,114,202` | Same literal password repeated 3 more times | Same issue, multiple copies to clean up. |
| `TEAMMATE-SETUP.md:50` | Hardcoded `git clone https://github.com/Zunkireelabs/web_analytics.git` | Points at *this* company's repo specifically; a copy of this file handed to a new client's onboarding process would tell them to clone the wrong (or inaccessible) repository. |

**This category should be fixed first, independent of the rest of this plan** — it's a live-secret hygiene problem, not a templating inconvenience. See §2.0.

### B. Company/brand name and copy hardcoded in UI strings

| File | Line(s) | String |
|---|---|---|
| `web/index.html` | 7 | `<title>Website Analytics</title>` |
| `web/src/components/Header.jsx` | 55 | `"Zunkiree Labs Analytics"` nav brand text |
| `web/src/components/Header.jsx` | 115 | `title="Zunkiree Labs"`, `"ZL"` avatar-badge initials |
| `web/src/components/Logo.jsx` | 1, 9 | Comment + `alt="Zunkiree Labs"` |
| `web/src/pages/Login.jsx` | 55 | `"Zunkiree Labs"` splash text |
| `web/src/pages/Login.jsx` | 56 | `"AI Search Analytics Platform"` tagline |
| `web/src/pages/Home.jsx` | 368 | `"Zunkiree Workspace"` label |
| `web/src/index.css` | 3 | Comment: `"Zunkiree Labs Analytics — design system"` (comment only, zero runtime effect, cosmetic cleanup) |
| `web/src/components/TopPagesCard.jsx` | 9 | Comment example uses `zunkireelabs.com` / `www.zunkireelabs.com` to explain www-dedup logic (comment only, no runtime effect, but confusing if a future reader assumes it's live logic tied to this domain) |

Three different taglines/names appear across these files ("Website Analytics",
"Zunkiree Labs Analytics", "AI Search Analytics Platform") — there is no
single source of truth today, so this isn't just "one string to change," it's
several inconsistent strings to first reconcile, then centralize.

### C. Brand color hardcoded and duplicated inconsistently — 52 occurrences across 18 files

`web/src/index.css` defines the *intended* source of truth
(`--brand: #6C63FF`, `--brand-2: #8b5cf6`), but almost nothing reads it:

- Two files independently redeclare a **local** `PURPLE` constant instead of
  importing a shared one: `Header.jsx` (`const PURPLE = '#6C63FF'`),
  `Home.jsx` (`const PURPLE = '#6C63FF'`), and `MoversList.jsx` (`const
  PURPLE = '#8B5CF6'` — same color as `--brand-2`, different casing, defined
  a third, independent time).
- The remaining 15 files inline raw hex literals directly with **no** named
  constant at all: `NarrativePanel.jsx`, `TopQueriesCard.jsx`,
  `TopPagesCard.jsx`, `CountriesWidget.jsx`, `TrafficDistributionCard.jsx`,
  `StatCard.jsx`, `PerformanceTrendCard.jsx`, `PageHeader.jsx`, `Insights.jsx`,
  `Compare.jsx`, `Overview.jsx`, `AiPanel.jsx`, plus three currently-orphaned
  dead components (`ChannelChart.jsx`, `DataTable.jsx`, `Sparkline.jsx` —
  master-product §14 already flags these as unused; don't spend migration
  effort on dead code, delete them instead per that section's existing
  recommendation).

Changing the client's brand color today means editing color literals in
~15 live files by hand and hoping none are missed — there is no single
switch.

### D. Favicon hardcoded, disconnected from the logo entirely

`web/index.html:6` — an inline 📊 emoji SVG data-URI favicon, unrelated to
`public/logo.svg` or any brand config. Swapping the logo file today does
**not** change the favicon; they're two independent hardcoded assets.

### E. Deployment identifiers that bake in the company name or collide across instances

| Location | Value | Issue |
|---|---|---|
| `TEAMMATE-SETUP.md` (template instructions) | Literal launchd label `com.zunkiree.analytics` | Copy-pasting this file's instructions for a new client produces a launchd job still labeled with our company name. |
| `docker-compose.yml:3` | `container_name: analytics-app` | Not company-named, but also not parameterized — two client instances on the same Docker host would collide on this name. |
| `docker-compose.yml:27,28,29,30,31,32,33,35` | Traefik router/service names `analytics`, `analytics-http` | Same collision risk: Traefik router names must be unique per Traefik instance; running two clients behind one shared Traefik (the `hosting` network this compose file assumes) would conflict today. |

### F. Defaults that silently assume this company's context

| Location | Value | Note |
|---|---|---|
| `server/cron.js:12`, `server/db.js:38`, `server/routes/metrics.js:182`, `server/migrations/001_init.sql:10`, `.env.example:52` | `TZ` default `'Asia/Kolkata'`, repeated independently in **4 separate code locations** plus the example file | Reasonable as *a* fallback, but it's our own timezone baked in as the silent default everywhere a client instance forgets to set `TZ` — and it's defined 4 times rather than once, so fixing the default later means finding all 4. |
| `server/db.js:38`, `.env.example:49` | `SITE_NAME` default `'My Website'` | Already config-driven (not company-specific) — listed here only as a process-hygiene note: if a new client's `.env` is missing `SITE_NAME`, the `sites` row silently gets seeded with a generic placeholder name rather than failing loudly, and nothing currently catches that before go-live. |
| `README.md:115` | `"(same setup as the agency project)"` | An internal cross-reference to a different one of your projects — meaningless (and slightly confusing) if this README is ever read by or handed to an actual client. |

## 2. Migration plan

Two stages, because the right target depends on an architectural decision
this repo hasn't made yet (master-product §20): today every client is a
**separate deployment** (client-onboarding skill §0), not one shared running
instance. Config-per-deployment is the correct target for that reality;
DB-per-site config is the correct target only if/when true multi-tenancy
(one instance, many `sites` rows, actually iterated by the ingestion
pipeline) gets built. Don't build Stage 2 before that decision is made — it
would be solving a problem the app doesn't have yet.

### Stage 0 — Secret hygiene (do this regardless of everything else, first)

1. Remove the literal `DASHBOARD_PASSWORD` value from `TEAM-GUIDE.md` and
   `TEAMMATE-SETUP.md` — replace with an instruction to obtain it through a
   secure channel (password manager entry, ask the maintainer directly),
   the same pattern `TEAMMATE-SETUP.md` already uses for the `.env` file and
   `secrets/service-account.json` a few lines below.
2. Decide whether the exposed password needs rotating — check whether these
   files (or this repo) have ever been pushed anywhere outside your control
   (a public repo, a client's machine, etc.). If there's any doubt, rotate
   `DASHBOARD_PASSWORD` as a precaution; it costs nothing and the current
   value has already been committed and reverted-and-recommitted once.
3. Replace the hardcoded `github.com/Zunkireelabs/web_analytics.git` clone
   URL in `TEAMMATE-SETUP.md` with a placeholder/variable once this file is
   reused as onboarding material for something other than an internal
   teammate (see the client-onboarding skill, which already assumes a
   *new*, isolated instance per client — this file's current wording doesn't
   match that yet).

### Stage 1 — Config-driven single-deployment branding (matches today's architecture)

Goal: one place per deployment to set brand identity; no more hand-editing
JSX per client.

1. **Introduce a small set of new env vars**, read at build time (see step 3):
   `BRAND_NAME` (the display name used in nav/login/footer copy — separate
   from `SITE_NAME`, which is a *data* field stored in the `sites` row and
   used in emails/docs; `BRAND_NAME` is *UI copy*. They'll usually be set to
   the same value per client, but conflating them would make the `sites`
   table's purpose fuzzier than it needs to be), `BRAND_TAGLINE`,
   `BRAND_COLOR_PRIMARY`, `BRAND_COLOR_SECONDARY`, `DASHBOARD_TITLE` (for
   `<title>`), and optionally `BRAND_FAVICON_EMOJI` or a real favicon file
   path if you want per-client favicons rather than a fixed one.
2. **Reconcile the three inconsistent taglines** ("Website Analytics" /
   "Zunkiree Labs Analytics" / "AI Search Analytics Platform") into exactly
   one name + one tagline before centralizing them — centralizing three
   different inconsistent strings just means the inconsistency now lives in
   one config block instead of three files; decide the actual product name
   first.
3. **Create one frontend module**, e.g. `web/src/brand.js`, exporting a
   single `BRAND` object built from `import.meta.env.VITE_*` (Vite requires
   the `VITE_` prefix to expose env vars to client code) with sensible
   fallbacks to today's Zunkiree defaults. Update every file in the §1.B/§1.C
   audit tables to import from this module instead of re-declaring `PURPLE`
   or inlining hex/strings — this is a mechanical, per-file edit, but the
   audit tables above are the exact file list to work through.
4. **`index.html`'s `<title>` and favicon** are static HTML, not React, so
   `import.meta.env` doesn't reach them directly — use Vite's built-in
   `%ENV_VAR%` placeholder substitution in `index.html` (Vite replaces
   `%VITE_FOO%` tokens in the HTML file at build time), so these two also
   become build-time-configurable without a custom build script.
5. **Parameterize deployment identifiers**: add a `CLIENT_SLUG` env var (or
   reuse `SITE_NAME` slugified) and use docker-compose's own `${VAR}`
   interpolation to template `container_name` and every
   `traefik.http.routers.${CLIENT_SLUG}...`/`traefik.http.services.${CLIENT_SLUG}...`
   label key — docker-compose substitutes env vars into the whole label
   string, including the key portion, so this doesn't require restructuring
   the compose file, just adding `${CLIENT_SLUG}` into the existing strings.
   Do the equivalent for the launchd label if a client is deployed that way
   (`com.${CLIENT_SLUG}.analytics` instead of the hardcoded
   `com.zunkiree.analytics`).
6. **Collapse the 4 independent `Asia/Kolkata` defaults** (§1.F) into one
   shared constant (e.g. exported from `server/util/dates.js`, which already
   owns all the other timezone logic) so there's one place to change the
   fallback later, even though the fallback *value* itself can stay as-is
   for now.
7. Update `README.md:115`'s `"agency"` cross-reference or remove it if this
   README is ever going to be client-visible.

None of Stage 1 requires a schema change or a new API endpoint — it's a
frontend build-time config module plus a handful of env vars, consistent
with the one-deployment-per-client model client-onboarding already assumes.

### Stage 2 — DB-driven branding (only if/when true multi-tenancy is actually built)

Do **not** start this until master-product §20's single-tenant-vs-multi-tenant
question has actually been resolved in the other direction (i.e., one running
instance is made to genuinely serve multiple `sites` rows). If that happens:

1. Add brand columns to the `sites` table (`brand_name`, `brand_tagline`,
   `brand_color_primary`, `brand_color_secondary`, `logo_url`,
   `favicon_url` or similar) via a new migration, mirroring the existing
   `weekly_doc_id`/`daily_doc_id`-style incremental column additions.
2. Extend `GET /api/sites` (or add a small `GET /api/brand?site=`) to return
   these fields, and have the frontend fetch brand config at runtime instead
   of baking it in at build time — this is the point where a single build of
   `web/dist` can correctly serve multiple differently-branded clients from
   one Express process, which Stage 1's build-time approach fundamentally
   cannot do.
3. Migrate the Stage 1 env vars into being the *seed* values for the first
   site's row (so existing deployments aren't broken), not a parallel
   config system living alongside the DB columns.

## 3. Reusability checklist for future client builds

A consolidated, priority-ordered checklist derived from §1–2. Nothing here
is done yet — this is the work list, not a status report.

**Must do before onboarding another client from this repo as a template:**
- [ ] Remove the literal `DASHBOARD_PASSWORD` from `TEAM-GUIDE.md` and
      `TEAMMATE-SETUP.md` (§2, Stage 0.1).
- [ ] Decide on, and if needed perform, a password rotation (§2, Stage 0.2).
- [ ] Replace the hardcoded `Zunkireelabs/web_analytics` clone URL in
      `TEAMMATE-SETUP.md` (§2, Stage 0.3).

**Should do before the next client, to avoid a repeat of the same manual
per-file edits the client-onboarding skill currently documents:**
- [ ] Pick one canonical product name + tagline (currently 3 different
      strings exist — §1.B).
- [ ] Add the `BRAND_*` / `DASHBOARD_TITLE` env vars and the `web/src/brand.js`
      config module (§2, Stage 1.1–1.3).
- [ ] Update all 18 files in the §1.C color audit to import from that module
      instead of hardcoding hex values (skip the 3 orphaned/dead files —
      delete them instead, per master-product §14).
- [ ] Wire `index.html`'s title/favicon through Vite's `%VITE_*%`
      placeholder substitution (§2, Stage 1.4).
- [ ] Parameterize `docker-compose.yml`'s container name and Traefik router
      names with a `CLIENT_SLUG` var, and the launchd label if used (§2,
      Stage 1.5).
- [ ] Collapse the 4 separate `Asia/Kolkata` default literals into one
      shared constant (§2, Stage 1.6).

**Can defer — lower risk, cosmetic, or dependent on a future architecture
decision that hasn't been made:**
- [ ] Clean up the `index.css` / `TopPagesCard.jsx` comments that mention
      "Zunkiree" (§1.B) — zero runtime effect, just readability.
- [ ] Remove or reword the `README.md` `"agency"` cross-reference (§2, Stage
      1.7).
- [ ] Everything in Stage 2 (DB-driven branding) — explicitly do not start
      until multi-tenancy is a real, separate, approved decision
      (master-product §20, §22 Future Improvements).

**Verify, don't assume, before calling any of the above "done":**
- [ ] After centralizing colors, visually diff the dashboard against its
      current appearance for this company's own instance — the goal is
      byte-for-byte identical output for this deployment, with only *new*
      client deployments getting different values.
- [ ] After parameterizing deployment identifiers, actually run two
      instances side by side (or at least two `docker compose config`
      renders with different `CLIENT_SLUG`s) to confirm no collision
      remains, rather than assuming the interpolation is correct.
