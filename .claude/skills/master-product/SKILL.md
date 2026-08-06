---
name: master-product
description: Authoritative, verified reference for the Zunkiree Analytics codebase. Covers the reusable Core Dashboard product (GSC + GA4 ingestion, Postgres store, AI narratives, Google Doc reports, email, React dashboard) that is the shared foundation for any future client build, plus a separate AI Growth Platform section — mostly available to every onboarded client now, with a small remaining company-only surface (AI Copilot, Clients console). Use this whenever working in this repository — to understand architecture, find the right file, follow existing conventions, or reason about extending it. Documents the current implementation as-is; proposed/not-yet-built ideas live in "Future Improvements" sections, clearly marked and never treated as already implemented.
---

# Zunkiree Analytics — Master Product Reference

This is the verified source of truth for this codebase, written by reading every
server and web file, cross-checked against migrations, `package.json`, `.env`,
git history, and the two live macOS `launchd` agents on this machine.

This document has two parts:

- **Part 1 — Core Dashboard (§1–21)**: the reusable product. Everything here
  is the shared foundation any future client build would start from. Nothing
  in this part depends on or assumes the internal-only system in Part 2.
- **Part 2 — AI Growth Platform, Internal / Company Only (§22–23)**: a
  separate, newer, pluggable agents framework running only on our own
  dashboard today. It is **not part of the client template**. Do not assume
  a client has these capabilities unless productizing it later is an
  explicit, separate decision (see §23).

Everything outside a "Future Improvements" section describes code that exists
and runs *today*. Nothing here is aspirational unless explicitly marked as
such. If a fact in this file ever looks stale (a file moved, a route
changed), trust the codebase over this document and treat the mismatch as a
signal this skill needs updating.

---
# Part 1 — Core Dashboard (reusable client product)
---

## 1. What this product is

A Node.js agent + React dashboard that, for **one website** (single-site
today, see §20):

1. Pulls daily **Google Search Console** (GSC) and **Google Analytics 4** (GA4)
   metrics into Postgres (Neon).
2. Writes a short **AI narrative** (Claude or OpenAI) comparing the day to
   yesterday and the trailing 7-day average.
3. Emails a morning summary.
4. Appends entries to running **Google Docs** (daily / weekly / monthly).
5. Serves a password-protected **React dashboard** for trends, top
   queries/pages, channels, device/country breakdowns, movers, and
   month-over-month comparison.

(This repo also runs a separate internal-only AI Agents system — see Part 2,
§22 — which is not part of this client-facing product.)

## 2. Architecture overview

```
Browser (React SPA, Vite build)
        │  fetch /api/*  (credentials: include)
        ▼
Express app (server/index.js)
  ├─ express-session (MemoryStore, cookie-based auth)
  ├─ /api/login, /api/logout, /api/me      (server/routes/login.js)
  ├─ /api/* (requireAuth-gated)            (server/routes/metrics.js)
  ├─ static web/dist (built SPA) + SPA fallback
  └─ startCron() + runStartupCatchup()     (server/cron.js, server/job.js)
        │
        ├─ server/ingest/gsc.js  ──▶ Google Search Console API
        ├─ server/ingest/ga4.js  ──▶ GA4 Data API (BetaAnalyticsDataClient)
        ├─ server/store/upsert.js ─▶ Postgres (idempotent upserts)
        ├─ server/store/read.js  ──▶ Postgres (dashboard/report reads)
        ├─ server/llm.js         ──▶ Anthropic Claude or OpenAI
        ├─ server/report/*.js    ──▶ narrative / email / Google Docs
        └─ server/auth/google.js ──▶ service-account or OAuth2 client factory
```

One Express process does three jobs at once: serves the API, serves the built
SPA, and runs the cron scheduler in-process. There is no separate worker
process or queue. (The same process also mounts the internal-only agents
router described in Part 2 — omitted above because it isn't part of this
client-facing architecture.)

**Two independent daily triggers exist on the deployment machine** (see §11) —
this is a verified, currently-live redundancy, not a hypothetical.

## 3. Folder structure

```
analytics/
├── server/
│   ├── index.js            Express app: middleware, session, static SPA, health check, starts cron + catch-up
│   ├── cron.js              node-cron schedules: daily, weekly, hourly catch-up guard
│   ├── job.js               Pipeline orchestration: runDailyIngest, runDailyJob, runWeeklyIfDue, runStartupCatchup
│   ├── db.js                pg.Pool (Neon), getOrCreateSite()
│   ├── llm.js               Shared callLLM() — picks Anthropic vs OpenAI
│   ├── auth/google.js        Google auth client factory (service account / OAuth2), scopes
│   ├── ingest/
│   │   ├── gsc.js            GSC searchanalytics.query calls, one date at a time
│   │   └── ga4.js            GA4 runReport calls, one date at a time
│   ├── store/
│   │   ├── upsert.js         All INSERT ... ON CONFLICT writes (idempotent)
│   │   └── read.js           All dashboard/report SELECT queries
│   ├── report/
│   │   ├── narrative.js       Daily AI narrative → daily_reports.narrative
│   │   ├── email.js           nodemailer morning email
│   │   ├── daily-doc.js       Daily entry appended to a Google Doc
│   │   ├── weekly-doc.js      Weekly entry appended to a Google Doc
│   │   ├── monthly-doc.js     Monthly entry appended to a Google Doc (not auto-scheduled, §11)
│   │   └── translate.js       On-demand search-query translation (cached)
│   ├── routes/
│   │   ├── login.js           /api/login, /api/logout, /api/me, requireAuth middleware
│   │   └── metrics.js         All other client-facing /api/* routes (requireAuth-gated)
│   ├── scripts/               CLI entry points (see §11 table)
│   ├── migrations/             001–009 *.sql, applied in lexical order by run.js
│   └── util/
│       ├── dates.js            Timezone-aware date math (today/yesterday/week/month in a TZ)
│       └── countries.js        GSC alpha-3 country code → readable name
├── web/
│   ├── index.html
│   ├── public/                 logo.svg, login-illustration.jpeg, analysists.jpeg (+ 2 unreferenced images, §15)
│   └── src/
│       ├── main.jsx             ReactDOM root, wraps <App/> in BrowserRouter
│       ├── App.jsx              Auth gate + site selection + route table
│       ├── api.js               Single fetch wrapper + one function per endpoint
│       ├── index.css            Tailwind v4 import + brand CSS variables
│       ├── pages/                Home, Overview, Insights, Compare, Login
│       └── components/           ~20 components, several currently orphaned (§14)
├── deploy/                     analytics.log (gitignored), com.zunkiree.analytics.plist (template; gitignored *.plist)
├── secrets/                    service-account.json (gitignored, not present in repo)
├── Dockerfile                   Multi-stage: build web/dist, then slim runtime image
├── docker-compose.yml            Traefik-fronted single service, healthcheck via /api/health
├── vite.config.js                root: 'web', dev proxy /api → API_PORT
├── .env.example                   Template for all env vars (see §16)
├── README.md                      Technical setup, stack, one-time Google access setup
├── TEAM-GUIDE.md                  Non-technical guide for using the dashboard
└── TEAMMATE-SETUP.md               Step-by-step onboarding script (written to be handed to Claude Code)
```

`server/agents/`, `server/routes/agents.js`, `server/store/agent-runs.js`,
and `server/migrations/010_agent_runs.sql` also exist in this repo but are
**intentionally omitted above** — they belong to the internal-only system in
Part 2 (§22), not to this reusable folder layout.

## 4. Backend: Express app & request lifecycle (`server/index.js`)

Middleware order: `express.json()` → `trust proxy` (behind Traefik) →
`express-session` (secret = `SESSION_SECRET`, throws at startup if unset;
cookie `httpOnly`, `sameSite: lax`, `secure` only when `NODE_ENV=production`,
14-day `maxAge`) → `GET /api/health` (no auth, `{ ok: true }`) →
`/api` → `loginRouter` → `/api` → `metricsRouter` (which self-gates with
`requireAuth`) → static `web/dist` (if it exists on disk) with a SPA
catch-all → a 4-arg error handler last.

Sessions use **express-session's default `MemoryStore`** — no Redis/Postgres
session store is configured. Sessions do not survive a process restart and
would not work correctly if the app were ever scaled to more than one
Node process (see Future Improvements).

Startup sequence (`app.listen` callback): `startCron()` unless
`DISABLE_CRON === 'true'`, then **unconditionally** `runStartupCatchup()`
(that function internally checks `DISABLE_CATCHUP` — it is a separate switch
from `DISABLE_CRON`, so catch-up can run even if the in-process cron is
disabled).

## 5. Authentication

Per-client login, not a single shared dashboard password. A `users` table
(migration 011) holds one row per login: `site_id` FK, `email` (globally
unique), `bcryptjs`-hashed password. Provisioned via `npm run create-client`
(`server/scripts/create-client.js`), not self-serve signup — there is no
signup route.

`server/routes/login.js`:
- `POST /api/login` — looks up the user by email (`getUserByEmail`,
  `server/store/users.js`), verifies the password with `bcrypt.compare`.
  On success, stores **both** `req.session.userId` and `req.session.siteId`
  (not just a boolean) — the session encodes *which client* is logged in,
  not merely *that someone* is.
- `POST /api/logout` — destroys the session.
- `GET /api/me` — `{ authed, isInternal }`. `isInternal` is computed
  server-side by comparing the session's `siteId` against `COMPANY_SITE_ID`
  (see §22) — the frontend never decides this itself.
- `export function requireAuth` — 401s unless both `session.userId` and
  `session.siteId` are set; on success attaches `req.userId`/`req.siteId` for
  downstream routes.
- `export function requireInternalSite` — 404s (not 403, so a client can't
  detect the route exists) unless `req.siteId` matches `COMPANY_SITE_ID`.
  Applied after `requireAuth` in `server/routes/agents.js` and
  `server/routes/action-center.js` — see §22.

**Every route in `metrics.js` reads `req.siteId` from the session — never a
client-supplied `?site=` param.** This is the load-bearing security property
of the whole multi-tenant model (§20): a logged-in client cannot read another
client's data by changing a query parameter, because the session, not the
request, determines which site's data a route can touch.

Session store: `express-session` with a Postgres-backed store
(`connect-pg-simple`, reusing the pool from `server/db.js`,
`createTableIfMissing: true`) — not the default `MemoryStore`. This matters
more now than in the old single-tenant model: a process restart no longer
logs out every client at once.

Client side (`web/src/App.jsx`): no route-level "protected route" wrapper.
The whole app is gated by one `authed` state (`null` = checking, `true`/`false`
after `api.me()` resolves). `authed === false` renders `<Login/>` in place of
the entire app tree — Login is not itself a route. No client-side token
storage; the HTTP-only cookie is the only session artifact, sent automatically
via `credentials: 'include'` in `web/src/api.js`. `isInternal` (from
`GET /api/me`) also gates whether the `/ai-growth` and `/action-center`
routes/nav tabs render at all — see §22.

## 6. API reference

All paths are mounted under `/api`. Everything in `metrics.js` requires an
authenticated session (`requireAuth`); the three `login.js` routes do not.

| Method | Path | Query / Body | Returns |
|---|---|---|---|
| POST | `/login` | `{ password }` | sets session |
| POST | `/logout` | — | destroys session |
| GET | `/me` | — | `{ authed }` |
| GET | `/health` | — | `{ ok: true }` (registered in `index.js`, not `metrics.js`) |
| GET | `/sites` | — | all rows of `sites` (site switcher) |
| GET | `/doc-link` | `?site` | weekly Google Doc URL |
| GET | `/daily-doc-link` | `?site` | daily Google Doc URL |
| GET | `/monthly-doc-link` | `?site` | monthly Google Doc URL |
| GET | `/range` | `?site` | `{ earliest, freshest, latest_visitor }` date bounds |
| GET | `/series` | `?site&start&end` | daily GSC+GA4 series, gaps included |
| GET | `/day` | `?site&date` | metrics + top queries/pages + channels + narrative for one day |
| GET | `/channels` | `?site&start&end` | GA4 channel breakdown |
| GET | `/breakdown-range` | `?site&start&end&dim&limit=10` | GSC top-N by dimension (query/page/device/country) |
| GET | `/device` | `?site&start&end` | GA4 device breakdown (top 5) |
| GET | `/country` | `?site&start&end` | `{ visitors, search }` — GA4 + GSC by country |
| GET | `/movers` | `?site` | top 50 query gainers/droppers, this-week vs prior week |
| GET | `/translate` | `?query` | `{ language, translation }`, cached in `query_translations` |
| POST | `/ai-compare` | `{ site, a, b }` (YYYY-MM) | LLM action-plan comparing two months |
| GET | `/compare-range` | `?site&a_start&a_end&b_start&b_end` | raw totals, no LLM |
| POST | `/ai-compare-range` | `{ site, a_start, a_end, b_start, b_end }` | LLM action-plan, arbitrary ranges |
| GET | `/compare` | `?site&a&b` (YYYY-MM) | raw monthly totals |
| GET | `/ai-summary` | `?site&date` | LLM 3-sentence day summary |
| POST | `/ai-ask` | `{ site, date, question }` | LLM answer grounded in that day's data |

All handlers forward errors via `next(e)` to the global error handler in
`index.js`. (The internal-only `/api/agents*` routes exist alongside these
but are documented separately in §22, not in this client-facing table.)

## 7. Google Search Console integration (`server/ingest/gsc.js`)

Uses `searchconsole.searchanalytics.query` (v1) via the client from
`auth/google.js`. **One date per call, no native range support** — callers
loop per day. `fetchGscForDate(gscProperty, date)` issues 6 calls per day, all
with `dataState: 'final'`:

| Call | dimensions | rowLimit |
|---|---|---|
| totals | none | 1 |
| queries | `query` | 25 |
| pages | `page` | 25 |
| devices | `device` | 10 |
| countries | `country` | 25 |
| query+page trace | `query, page, device, country` | 250 |

GSC finalizes data with a real ~2–3 day lag (Google-side, not a bug in this
tool). The pipeline compensates by fetching `today − 3` as the "report date"
and re-fetching a 3-day backfill window (see §11).

## 8. Google Analytics 4 integration (`server/ingest/ga4.js`)

Uses `BetaAnalyticsDataClient.runReport` (`@google-analytics/data`), one date
per call. 4 calls per day:
1. Totals — `totalUsers, newUsers, sessions, engagedSessions, averageSessionDuration, conversions` (mapped positionally by array index — fragile if the API ever reorders response columns).
2. Channels — dimension `sessionDefaultChannelGroup`; unnamed → `'(other)'`.
3–4. `deviceCategory` and `country` breakdowns, `limit: 25`, metrics `sessions, totalUsers`.

GA4 has no query dimension (search terms are Google's, not GA4's), so there is
no GA4 equivalent of `queryPages`. GA4 data is treated as near-real-time —
fetched through `today − 1`/`today − 0` rather than lagged like GSC.

## 9. Database schema & data store

Migrations `001`–`009` (in `server/migrations/`, applied in lexical filename
order by `run.js`, no migration-tracking table — idempotency relies entirely
on `IF NOT EXISTS` guards inside the SQL, so re-running `npm run migrate` is
always safe). Consolidated current schema:

- **`sites`** — `id SERIAL PK`, `name`, `gsc_property`, `ga4_property_id`
  (both nullable since 011 — a site can exist before GSC/GA4 are connected,
  see §20), `timezone` (default `Asia/Kolkata`), `created_at`,
  `UNIQUE(gsc_property, ga4_property_id)`, plus `weekly_doc_id` (002),
  `weekly_last_done DATE` (003), `daily_doc_id` (005), `monthly_doc_id` +
  `monthly_last_done DATE` (006, **vestigial — never read or written by any
  code**, see §21), `website_domain` (011, human-readable display string,
  distinct from `gsc_property`'s `sc-domain:...`/URL format),
  `logo_data_url` (012, nullable data-URI, shown in `Header.jsx` post-login),
  `executive_doc_id` + `executive_last_done` (013), `report_email_to` (015,
  nullable — per-site email recipient, see §12/§20).
- **`users`** (011) — `id SERIAL PK`, `site_id` FK → `sites` CASCADE, `email`
  (globally unique), `password_hash` (bcrypt), `created_at`. One login per
  site today — see §5.
- **`gsc_daily`** — one row per `(site_id, date)`: clicks, impressions, ctr, position.
- **`gsc_breakdown`** — `(site_id, date, dim_type, dim_value)` → clicks/impressions/ctr/position; `dim_type` ∈ query/page/device/country.
- **`ga4_daily`** — one row per `(site_id, date)`: users, new_users, sessions, engaged_sessions, avg_engagement_time, conversions.
- **`ga4_channels`** — `(site_id, date, channel)` → sessions/users.
- **`ga4_breakdown`** (004) — `(site_id, date, dim_type, dim_value)` → sessions/users; `dim_type` ∈ device/country.
- **`gsc_query_page`** (007, widened in 008) — `(site_id, date, query, page, device, country)` → clicks/impressions/ctr/position. Used for the movers drill-down (top page/device/country per query).
- **`daily_reports`** — `(site_id, date)` → narrative text, `emailed_at`, `daily_doc_done` (005). These two timestamp columns are the idempotency guards for email and daily-doc generation.
- **`query_translations`** (009) — `query TEXT PRIMARY KEY` → language, translation. Keyed by query text only (not per-site), a deliberate global cache since the same phrase means the same thing everywhere.

A tenth table, `agent_runs` (migration 010), also exists — it belongs to the
internal-only system in §22, not to this client-facing schema.

All writes in `server/store/upsert.js` are `INSERT ... ON CONFLICT DO UPDATE`
on `gsc_daily`/`ga4_daily`/`daily_reports`, and delete-then-reinsert for the
breakdown/channel/query-page tables (so a shrinking result set doesn't leave
stale rows) — re-ingesting any date is always safe and never duplicates data.

`server/store/read.js` holds every SELECT the dashboard and reports use —
`getDailySeries`, `getDay`, `getBreakdown`, `getRangeTopQueries`,
`getChannels(Range)`, `getNarrative`, `getDataRange`, `getGscBreakdownRange`,
`getGa4BreakdownRange`, `getTopMovers` (+ its two per-query drill-down
helpers), `get{Weekly,Daily,Monthly}DocUrl`, `getRangeTotals`,
`getMonthlyTotals`, `listSites`.

## 10. AI features

**`server/llm.js`** is the single shared LLM call used by every AI feature.
Provider choice (`pickProvider`) is **static per call, decided once**, not a
runtime fallback: `REPORT_PROVIDER` env var wins if set; otherwise picks
`openai` only if `OPENAI_API_KEY` is set and isn't the placeholder
`sk-xxxx...`, else defaults to `anthropic`. If the chosen provider's call
throws, it is **not** retried or switched — the error propagates to the
caller's try/catch.

Model selection: only `REPORT_MODEL_DAILY` is ever read
(`process.env.REPORT_MODEL_DAILY`, defaulting to `gpt-4o-mini` or
`claude-haiku-4-5` depending on provider). **`REPORT_MODEL_MONTHLY` is defined
in `.env.example` and documented in `README.md` but is never read by any code
— it is a dead/aspirational env var.** Every report type (daily, weekly,
monthly, translation) currently uses the same `REPORT_MODEL_DAILY` model; none
of the report generators pass a `model` override to `callLLM`.

Five distinct AI features exist:

1. **Daily narrative** (`report/narrative.js`) — 8-day window pulled via
   `getDailySeries`; computes % vs prior day and % vs trailing-7-day average
   (excluding the report day) for clicks/impressions/users/sessions, plus %
   vs prior day only for avg position/conversions — all arithmetic done in JS,
   never left to the model. Prompt: 3–5 plain-English sentences, must state
   real numbers, note lower position = better, only mention "still finalizing"
   if both clicks and impressions are zero. Stored to `daily_reports.narrative`
   by the caller (`job.js`), not by `narrative.js` itself.
2. **Daily/Weekly/Monthly Doc narratives** — each report file precomputes its
   own %-deltas the same disciplined way, then asks the LLM only for a short
   prose summary layered on top of numbers the model never has to calculate.
3. **Ask-your-data** (`AiPanel.jsx` on the frontend) — this one component
   drives two distinct endpoints: `POST /ai-ask` answers a free-text question
   grounded in one day's data, and `GET /ai-summary` (its "fresh insight"
   button) generates an unsolicited 3-sentence insight for the same day.
   Both share the same `buildAiContext(site, date)` helper in
   `server/routes/metrics.js` (7-day series + top 5 queries/pages + channels
   + device split, formatted as grounded text), so neither route re-derives
   context independently.
4. **Compare action-plan** (`POST /ai-compare`, `/ai-compare-range`) — LLM
   writes an action plan comparing two months or two ranges.
5. **Query translation** (`report/translate.js`, `GET /translate`) — detects
   language and gives a short literal translation of a single search query
   string; DB-cached in `query_translations`, deliberately **not** cached on
   failure (returns `{language:'unknown', translation: q}` without writing,
   so a later retry can succeed). This is a fully separate, on-demand,
   user-triggered feature — **not** invoked automatically from any narrative
   or doc report, and not part of the top-query lists embedded in those
   reports.

`AiInsightsPanel.jsx` on the frontend is a fully client-side heuristic panel
(top-channel dominance, zero-click queries, etc.) computed from data already
fetched — it makes no AI API call despite the name, and is distinct from
`AiPanel.jsx` (the real LLM chat) and `NarrativePanel.jsx` (renders the stored
daily narrative). All three render together on `Overview.jsx`.

(These five are unrelated to the separate internal AI Agents framework in
§22, which as of today calls no LLM at all.)

## 11. Scheduled jobs & automation

**Verified: two independent daily triggers are currently active on the
deployment machine simultaneously**, not just in code:

1. **In-process node-cron** (`server/cron.js`, started by `server/index.js`
   unless `DISABLE_CRON=true` — this var is **not** set in the live `.env`, so
   it is active):
   - Daily job at `CRON_SCHEDULE` (default `0 7 * * *`, `.env` has it
     explicitly set to `0 7 * * *`), timezone `TZ` (`.env`: `Asia/Kolkata`).
   - Weekly job at `WEEKLY_CRON_SCHEDULE` (default `0 8 * * 4`, Thursday).
   - **Hourly catch-up guard** at `5 * * * *`: if local hour ≥ 7 and no
     narrative exists yet for the expected report date, re-runs the daily job
     (recovers from a missed fire, e.g. Mac asleep at 07:00).
2. **`~/Library/LaunchAgents/com.zunkiree.analytics.daily.plist`** (macOS
   launchd, **not committed to the repo** — `deploy/*.plist` is gitignored,
   and this file lives outside the repo in the user's home directory): fires
   `node server/scripts/run-daily.mjs` at 07:15 local time via
   `StartCalendarInterval`, bypassing node-cron entirely so it survives
   display/App Nap sleep. Added in commit `9c7b0c6` ("Fix daily job
   reliability on macOS"), whose intent (per commit message) was for this to
   become "the primary trigger," but `DISABLE_CRON` was never actually set —
   so **both** triggers currently fire independently.

This redundancy is harmless in practice: `runDailyJob()` (`server/job.js`) is
fully idempotent (checks `emailed_at` before emailing, `daily_doc_done` before
appending the daily doc, existing narrative before regenerating), so a
same-morning double-fire just does slightly wasted work, not duplicate
data/emails. Still worth knowing before "fixing" the redundancy — see Future
Improvements.

There is also a **third, separate** long-running launchd agent —
`~/Library/LaunchAgents/com.zunkiree.analytics.plist` — which runs
`server/index.js` itself (`RunAtLoad`+`KeepAlive`, restarts on crash/reboot).
This is the one that hosts the API/dashboard and therefore also owns the
in-process cron described above.

`server/job.js` pipeline functions:
- `ingestDate(site, date)` — manual single-date ingest (used by CLI).
- `runDailyIngest()` — GSC window `today−6 … today−3`; GA4 window `today−6 … today−0`.
- `runDailyJob()` — ingest → generate + save narrative → send email (if not already sent) → append daily doc (if not already done).
- `runWeeklyIfDue(site)` — runs the weekly doc if `sites.weekly_last_done` is before the current week's Monday.
- `runStartupCatchup()` — runs on every server boot unless `DISABLE_CATCHUP=true`; calls `runDailyJob()` then `runWeeklyIfDue()`.

CLI scripts (`server/scripts/`) — only some are wired into `package.json`:

| Script | `npm run` | Purpose |
|---|---|---|
| `ingest.js` | `ingest` | Manual ingest: no date → standard window; 1 date → that day; 2 dates → backfill range |
| `weekly.js` | `weekly` | Manual weekly doc for the previous week or the week containing a given date |
| `daily-doc.js` | `daily-doc` | Manual daily doc entry for `today−3` or a given date |
| `get-oauth-token.js` | `get-token` | One-time OAuth consent flow, writes `GOOGLE_OAUTH_REFRESH_TOKEN` into `.env` |
| `monthly.js` | *(none — run via `node server/scripts/monthly.js [YYYY-MM]`)* | Manual monthly doc report |
| `rebuild-docs.js` | *(none)* | Clears and fully regenerates weekly + monthly + daily Google Docs from historical `gsc_daily` rows |
| `restyle-doc.js` | *(none)* | One-off retroactive text-styling pass over the existing weekly doc |
| `run-daily.mjs` | *(none — invoked directly by launchd, not npm)* | Standalone daily-job runner, see above |

**Monthly doc generation is not scheduled anywhere** — no cron entry, no
`runMonthlyIfDue`, not called from `runDailyJob`/`runStartupCatchup`. It only
runs via manual CLI invocation. The code and Google Doc formatting are fully
built and correct; it's simply not wired into automation (see Future
Improvements).

## 12. Email reports (`server/report/email.js`)

`sendDailyEmail(site, reportDate, day, narrative)` via `nodemailer`, SMTP
config from `SMTP_HOST/PORT/USER/PASS/SECURE` + `REPORT_EMAIL_TO`. If any of
`SMTP_HOST`/`SMTP_USER`/`SMTP_PASS`/`REPORT_EMAIL_TO` is missing, it logs and
returns `false` (silent skip, no throw) — and because the caller only stamps
`emailed_at` on a truthy return, an unconfigured SMTP setup means the job
keeps retrying on every run rather than giving up, which is intentional.
Template is an inline HTML string: site name + date header, a 4-card row
(Clicks/Impressions/Users/Sessions), the AI narrative text, a footer note.
`from` defaults to `SMTP_USER` if `REPORT_EMAIL_FROM` is unset.

## 13. Frontend: dashboard pages (`web/src/pages/`)

Routing is React Router v6 (`App.jsx`), gated by one top-level `authed` state
— there is no per-route auth wrapper; `Login` fully replaces the app tree
when unauthenticated, rather than being a route itself.

- **`Home.jsx`** (`/`) — Static marketing/landing page. No API calls, no
  props. Includes a hard-coded `DashboardMock` with fake numbers purely for
  visual effect.
- **`Overview.jsx`** (`/overview`) — Main dashboard. Fetches `series` (current
  + prior period), `day` (for the narrative), `channels`, and
  `breakdown-range` for both `query` and `page`, plus `range` once per site.
  Composes `KpiCard` ×4, `StatCard` ×4, `NarrativePanel`, `AiPanel`,
  `TopQueriesCard`, `TrafficDistributionCard`, `AiInsightsPanel`,
  `TopPagesCard`, `PerformanceTrendCard`, `PageHeader`.
- **`Insights.jsx`** (`/insights`) — Movers/devices/geography page. Fetches
  `range`, `series`, `device`, `country`, `movers`. Composes `PageHeader`,
  `StatCard` ×4, `MoversList`, `DonutChart`, a locally-defined `CountryCard`,
  `CountriesWidget`.
- **`Compare.jsx`** (`/compare`) — Month-over-month or week-over-week
  comparison with a mode toggle. Fetches `compare`/`compare-range` for
  totals, `series` for sparklines, and on-demand `ai-compare`/`ai-compare-range`
  for the AI action plan. Uses a Recharts `RadarChart` directly (no wrapper).
- **`Login.jsx`** — Single-password form; not a route, rendered in place of
  the whole app when unauthenticated.

No React Context, Redux, or URL query-string state anywhere. Auth state, site
selection, date ranges, and fetched data are all plain `useState`/prop-drilling
local to `App.jsx` or each page — navigating between pages resets each page's
local date-range state (nothing is lifted or reflected in the URL).

`App.jsx` only renders the `<Routes>` block once `siteId` is truthy (i.e. at
least one row exists in `sites` and `GET /api/sites` returned it). If no site
exists yet — e.g. `npm run migrate` hasn't been run, or `GSC_PROPERTY`/
`GA4_PROPERTY_ID` aren't set — the authenticated app shows a plain text
fallback ("No site configured yet. Run the migration to seed your site, then
ingest some data.") instead of the dashboard, with no route match at all.

## 14. Frontend: components (`web/src/components/`)

Actively used:
- **`Header.jsx`** — sticky nav, tab links, a "Reports" dropdown (daily/weekly/monthly Google Doc links), site selector (shown only when >1 site exists), logout.
- **`KpiCard.jsx`** — hero KPI tile with icon, up/down badge, skeleton loading state.
- **`StatCard.jsx`** — compact KPI tile with a **locally-defined** inline sparkline (see orphan note below).
- **`NarrativePanel.jsx`** — presentational; renders the stored daily narrative text.
- **`AiPanel.jsx`** — interactive "ask your data" box (`POST /ai-ask`) + a "fresh insight" button (`GET /ai-summary`).
- **`AiInsightsPanel.jsx`** — client-side heuristic insights, no API call (see §10).
- **`TopQueriesCard.jsx`** / **`TopPagesCard.jsx`** — ranked lists with show-all toggle.
- **`TrafficDistributionCard.jsx`** — donut of channel-bucketed sessions.
- **`PerformanceTrendCard.jsx`** — Recharts area chart, in-card metric toggle.
- **`MoversList.jsx`** — query gainers/droppers with per-row translate buttons and mini sparklines.
- **`DonutChart.jsx`** — generic Recharts donut, used for device split.
- **`CountriesWidget.jsx`** — GSC clicks-by-country choropleth (`react-simple-maps`) + ranked list.
- **`PageHeader.jsx`** — shared page title/subtitle/right-slot layout.
- **`Logo.jsx`** — renders `public/logo.svg` at a configurable size.

**Orphaned — zero imports anywhere in the codebase (verified by grep), safe
to delete or worth deleting deliberately rather than leaving as clutter:**
`ChannelChart.jsx`, `DataTable.jsx`, `MetricCard.jsx`, `RankedBarChart.jsx`,
`TrendChart.jsx`, `Sparkline.jsx` (its logic was duplicated inline inside
`StatCard.jsx` instead of being imported). These read as earlier iterations
superseded by the current card set, consistent with `PerformanceSection.jsx`
having already been deleted in the working tree — this looks like a partial
cleanup that missed six files.

There is no dashboard page or component for the internal AI Agents framework
(§22) — it has no frontend presence at all today.

## 15. Branding & design system

Defined in `web/src/index.css` under a comment literally labeled "Zunkiree
Labs Analytics — design system": CSS custom properties `--brand: #6C63FF`
(primary indigo-purple), `--brand-2: #8b5cf6`, `--ink`, `--ink-soft`,
`--muted`, `--bg: #f7f8fc`, `--line`, `--pos: #059669` (green),
`--neg: #e11d48` (red). Tailwind v4, CSS-first config (`@import "tailwindcss"`,
no separate `tailwind.config.js`).

**In practice the hex values are re-typed directly in JSX** (`#6C63FF`,
gradients like `linear-gradient(135deg,#6C63FF,#8b5cf6)`) across `Home.jsx`,
`Header.jsx`, `Login.jsx`, `PageHeader.jsx`, and most cards, rather than
consuming the CSS variables — the design tokens exist but aren't the single
source of truth yet (relevant if this becomes a themeable multi-client
template, see Future Improvements).

Naming is inconsistent across surfaces: `index.html` title is "Website
Analytics" (favicon is an inline 📊 emoji data-URI, not `logo.svg`);
`Header.jsx` displays "Zunkiree Labs Analytics"; `Login.jsx`/`Home.jsx` say
"Zunkiree Labs" / "AI Search Analytics Platform". `Logo.jsx` renders
`public/logo.svg` ("red circle + white trend chart" per its own comment).
Two public assets are currently unreferenced anywhere: `analytics-bg.jpeg`,
`data-analytics.jpeg`.

## 16. Configuration & environment variables

Copy `.env.example` → `.env` (gitignored). Full inventory, verified against
code (not just the example file):

| Variable | Read in | Default if unset |
|---|---|---|
| `DATABASE_URL` | `server/db.js` | none — throws at startup |
| `GOOGLE_APPLICATION_CREDENTIALS` | `server/auth/google.js` | none — required unless OAuth2 vars are set |
| `GOOGLE_OAUTH_CLIENT_ID` / `_CLIENT_SECRET` / `_REFRESH_TOKEN` | `server/auth/google.js`, `scripts/get-oauth-token.js` | — |
| `GSC_PROPERTY` | `server/db.js` (`getOrCreateSite`) | none — throws |
| `GA4_PROPERTY_ID` | `server/db.js` | none — throws |
| `SITE_NAME` | `server/db.js` | `'My Website'` |
| `ANTHROPIC_API_KEY` | `server/llm.js` | — |
| `OPENAI_API_KEY` | `server/llm.js` | — |
| `REPORT_PROVIDER` | `server/llm.js` | auto-detected from `OPENAI_API_KEY` presence |
| `REPORT_MODEL_DAILY` | `server/llm.js` | `gpt-4o-mini` / `claude-haiku-4-5` |
| `REPORT_MODEL_MONTHLY` | **never read anywhere** — documented but dead, see §10 | — |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_SECURE` | `server/report/email.js` | port 465, secure true |
| `REPORT_EMAIL_FROM` | `server/report/email.js` | falls back to `SMTP_USER` |
| `REPORT_EMAIL_TO` | `server/report/email.js` | fallback only — used when a site's `report_email_to` column is unset |
| `COMPANY_SITE_ID` | `server/routes/login.js` (`requireInternalSite`) | none — no site is treated as internal until set |
| `SESSION_SECRET` | `server/index.js` | none — throws at startup |
| `TZ` | `server/cron.js`, `server/db.js` | `Asia/Kolkata` |
| `CRON_SCHEDULE` | `server/cron.js` | `0 7 * * *` |
| `WEEKLY_CRON_SCHEDULE` | `server/cron.js` | `0 8 * * 4` |
| `DISABLE_CRON` | `server/index.js` | cron enabled unless exactly `'true'` |
| `DISABLE_CATCHUP` | `server/job.js` | catch-up runs unless exactly `'true'` |
| `ANALYTICS_DOMAIN` | `docker-compose.yml` (Traefik label) | — |
| `API_PORT` | `server/index.js`, `vite.config.js` (dev proxy) | `3002` |
| `NODE_ENV` | `server/index.js` (cookie `secure` flag), `Dockerfile` | — |

`.env.example` must stay free of real secrets — it's the shareable template
(enforced by convention, not tooling).

## 17. Deployment

Two deployment modes exist side by side in this repo:

1. **Docker + Traefik** (`Dockerfile`, `docker-compose.yml`) — multi-stage
   build: build stage runs `npm run build:web` producing `web/dist`; runtime
   stage is `node:20-alpine`, copies `server/` + `web/dist`, runs as
   non-root `node` user, `CMD ["node", "server/index.js"]`. Healthcheck hits
   `/api/health`. Traefik labels route `$ANALYTICS_DOMAIN` → container port
   3002 over TLS (letsencrypt resolver) on an external `hosting` network.
   `secrets/` is bind-mounted read-only.
2. **Bare macOS via launchd** (currently what's actually running on this
   machine, per §11) — no Docker involved; Node run directly via `nvm`,
   process supervision by two `launchd` LaunchAgents living in
   `~/Library/LaunchAgents/` (not in the repo). `TEAMMATE-SETUP.md` documents
   this path step-by-step, written to be handed directly to Claude Code for a
   new teammate's machine.

Both paths build the frontend into `web/dist` and serve it from the same
Express process — there is no separate frontend host/CDN.

## 18. Coding standards (observed, not enforced by tooling)

- **No linter/formatter config exists** (no `.eslintrc*`, no `.prettierrc*`,
  no `eslint.config.*`) and **no test suite exists** (no `*.test.js`/`*.spec.js`
  anywhere). Consistency today comes purely from convention, not tooling.
- Pure ESM throughout (`"type": "module"` in `package.json`); `import`/`export`,
  no `require`.
- Server code: small, single-purpose files per concern (one file = one
  integration or one concern — `ingest/gsc.js` vs `ingest/ga4.js`,
  `store/upsert.js` vs `store/read.js`). Env var access is concentrated at the
  edges (`db.js`, `llm.js`, `email.js`, `cron.js`, `index.js`) rather than
  scattered through business logic.
- All financial/percentage arithmetic for AI narratives is computed in plain
  JS **before** calling the LLM, never delegated to the model — this pattern
  repeats identically across `narrative.js`, `daily-doc.js`, `weekly-doc.js`,
  `monthly-doc.js` and is a deliberate, repeated design choice worth
  preserving in any new report type.
- All DB writes are upserts (`ON CONFLICT DO UPDATE`) or delete-then-reinsert
  — re-running any ingest/report step for any date is always safe. New
  write paths should follow this idempotency discipline.
- Frontend: functional components + hooks only, no class components; Tailwind
  utility classes directly in JSX plus a handful of custom classes in
  `index.css` (`.card`, `.card-hover`, `.card-title`, `.fade-up`); components
  are one file each, no barrel `index.js` re-exports.

## 19. Reusable modules (safe building blocks for new features)

- **`server/llm.js`** — `callLLM(system, user, {model, maxTokens})`: the one
  place to add new AI-backed features without duplicating provider logic.
- **`server/util/dates.js`** — `todayInTz`, `daysAgoInTz`, `previousWeek`,
  `previousMonth`, `weekOf`, `dateRange`: all timezone-correct date math:
  reuse rather than re-deriving date logic per feature.
- **`server/auth/google.js`** — `getGoogleAuth`, `getSearchConsole`, `getDocs`,
  `getGa4ClientOptions`: the only place Google auth should be constructed.
- **`server/store/upsert.js` / `read.js`** — the only place SQL should live;
  routes and reports call these, never `pool.query` directly elsewhere.
- **Frontend `web/src/api.js`** — the only fetch wrapper; every new endpoint
  should get one function here rather than ad-hoc `fetch()` calls in
  components.
- **`web/src/components/PageHeader.jsx`, `StatCard.jsx`, `KpiCard.jsx`** —
  the current de-facto shared visual primitives for any new dashboard page.

## 20. Current scalability model — one shared multi-tenant instance

**This is now a real multi-tenant deployment**, not just a multi-tenant-ready
schema. Every fact table has `site_id INT REFERENCES sites(id) ON DELETE
CASCADE`, and:

- **Ingestion/reporting iterates every connected site.** `server/job.js`
  exports `runDailyJobForAllSites`, `runWeeklyIfDueForAllSites`,
  `runExecutiveIfDueForAllSites`, `runHourlyCatchupForAllSites` — each loops
  `listConnectedSites()` (sites with both `gsc_property` and
  `ga4_property_id` set) and isolates failures per site (one client's GSC/GA4
  error is caught and logged, never blocks another client's run).
  `server/cron.js` calls the `*ForAllSites` variants, not the old singular
  ones. `getOrCreateSite()` still exists in `server/db.js` and is still used
  by a handful of CLI scripts (`ingest.js`'s no-args mode, `weekly.js`,
  `daily-doc.js`) for backward-compatible single-shot runs against this
  instance's own env-configured site — it no longer represents "the only
  site the app knows about."
- **Auth is per-client, not per-instance.** See §5 — a `users` table maps
  logins to a `site_id`, and every `metrics.js` route trusts the session's
  `siteId`, never a client-supplied `site` param. This is what actually makes
  "one shared instance, many isolated clients" safe rather than just
  technically possible.
- **Onboarding a new client is a data operation**, not a new deployment:
  `npm run create-client -- <email> <password> --company "Name" [--domain]
  [--timezone]` creates a `sites` row (GSC/GA4 left NULL) + a login in one
  step; `npm run connect-site -- --site-id <id> --gsc-property "..."
  --ga4-property-id ... [--email-to ...] [--logo ...]` attaches GSC/GA4 (and
  optionally a per-site email recipient / logo) afterward. The moment both
  properties are set, `listConnectedSites()` picks the site up automatically
  — no code change, no redeploy.
- **Per-site email recipient**: `sites.report_email_to` (migration 015).
  `server/report/email.js` uses it, falling back to the global
  `REPORT_EMAIL_TO` env var only when unset (keeps the original
  env-configured site working without a backfill).
- **Session store** is Postgres-backed (§5), so a restart doesn't log out
  every client at once — a real concern once more than one client's session
  lives in the same process.

**What this does *not* do**: full white-label re-theming per client (one
product identity, one color palette, one layout for everyone — only company
name/logo/website are per-tenant, shown post-login), or per-client custom
features (still a deliberate, tracked exception per client-onboarding, never
a silent fork). See the `future-multi-client-architecture` skill for the
full design and what's intentionally out of scope.

## 21. Future Improvements (Core Dashboard)

Most of the multi-tenant items formerly listed here are now implemented —
see §5 (auth) and §20 (scalability model). What follows is what's still
genuinely outstanding.

**Toward multi-client / multi-tenant (remaining):**
- Consume the `--brand`/`--brand-2`/etc. CSS variables consistently instead
  of re-typing hex values in JSX, so the one shared product palette lives in
  one place. (Per the `future-multi-client-architecture` skill §0/§6, this is
  a one-time centralization for maintainability — brand color is **not**
  meant to become per-client configurable; only company name/logo/website are
  per-tenant.)
- One login per site today (`users.email` is globally unique, one row per
  site) — no support yet for multiple users per client account, or one user
  belonging to more than one site. Revisit if a client ever needs >1 login.
- Credential delivery to a new client is still manual (hand the email +
  password through a secure channel) — no invite/reset-link flow yet.

**Automation/reliability gaps:**
- Reconcile the two simultaneously-active daily triggers (in-process
  node-cron in `cron.js` vs the `com.zunkiree.analytics.daily` launchd agent
  running `run-daily.mjs`) — either actually set `DISABLE_CRON=true` as the
  original commit intended, or deliberately keep both as a redundancy layer,
  but document the choice instead of leaving it accidental.
- Wire monthly doc generation into automation: add a `runMonthlyIfDue` mirror
  of `runWeeklyIfDue`, a cron entry, and use the already-added-but-unused
  `sites.monthly_last_done` column, or remove that column if monthly stays
  manual-only.
- Add the missing `npm run monthly` / `npm run rebuild-docs` / `npm run
  restyle-doc` entries to `package.json` so these scripts don't require
  remembering raw `node` invocations.
- Fix the `README.md`/code precedence mismatch in `auth/google.js` (comment
  calls service-account "primary," but OAuth2 vars are checked first and win
  when both are present).

**Cleanup:**
- Remove the unused `bcryptjs` dependency, or the dead `REPORT_MODEL_MONTHLY`
  env var/docs, or the vestigial `sites.monthly_last_done` column — pick
  keep-and-wire-up vs delete for each, rather than leaving them ambiguous.
- Delete the six orphaned frontend components (`ChannelChart.jsx`,
  `DataTable.jsx`, `MetricCard.jsx`, `RankedBarChart.jsx`, `TrendChart.jsx`,
  `Sparkline.jsx`) or intentionally revive them — finish the cleanup that
  `PerformanceSection.jsx`'s removal started.
- Remove or use the two unreferenced public images (`analytics-bg.jpeg`,
  `data-analytics.jpeg`).
- Settle on one product name across `index.html` title, favicon, `Header.jsx`,
  `Login.jsx`, and `Home.jsx` copy (currently "Website Analytics" / "Zunkiree
  Labs Analytics" / "AI Search Analytics Platform" all appear).

**Engineering hygiene:**
- Add a linter/formatter config (none exists today) and a test suite (none
  exists today) before this becomes a template other people build client
  variants from — regressions in a shared template are more expensive than
  in a single-site tool.
- Consider lifting date-range/site-selection state in the frontend into a
  shared context or the URL query string, so it survives page navigation and
  is shareable/bookmarkable — today it's fully local `useState` per page.

---
# Part 2 — AI Growth Platform (Internal / Company Only)
---

**Updated (commit `b1bfdc4`) — this used to be a fully internal-only system.
It no longer is.** `/ai-growth` (Command Center), `/ai-orchestration`
(orchestration diagram), `/action-center`, and `/site-audit` were
deliberately opened up to every onboarded client session, each scoped to
that session's own `siteId` — `requireInternalSite` was removed from
`server/routes/agents.js`, `server/routes/command-center.js`,
`server/routes/action-center.js`, and `server/routes/site-audit.js`, which
now only carry `requireAuth`. `web/src/App.jsx` registers those routes
unconditionally for any authed session, and `Sidebar.jsx`'s
`GROWTH_TOOLS_NAV` renders for everyone (comment there: "Client-facing
growth tooling — same page for staff and clients alike"). The default
post-login landing page (`App.jsx`'s `/` redirect) is `/ai-growth`, for the
same reason.

**What's still genuinely internal-only**: AI Copilot (`server/routes/copilot.js`)
and the Clients console (`/clients`, `server/routes/clients.js`) still carry
`requireAuth, requireInternalSite` — `COMPANY_SITE_ID` (env var) names the
one `sites.id` that counts as "internal," and that middleware still 404s any
other site's session for those two surfaces only. `GET /api/me`'s
`isInternal` flag (computed server-side, never trusted from the client)
still gates just those: `App.jsx`/`Sidebar.jsx` only register `/clients` and
the Copilot panel when `isInternal` is true. `server/routes/action-center.js`
also depends on `server/generators/` (9 content-draft generators) and
`server/store/drafts.js` (migration 014) — see §22 for the current
structural reference.

## 22. AI Agents framework (`server/agents/`)

**Updated — this section previously described an early "Phase 1 skeleton"
state (7 agents, no `callLLM` usage, no frontend). That is no longer
accurate; the system below reflects the current, verified implementation.**
The two narrative reference docs at the repo root, `AGENT-WORKFLOW.md` and
`SYSTEM-WORKFLOW.md`, describe this same current state and are kept in sync
with it — read those for a walkthrough; this section is the structural
reference.

A pluggable framework of specialist growth/SEO analysis agents, structurally
and operationally separate from the Part 1 AI features (§10): backend logic
lives entirely in `server/agents/`, and every agent is now both **scheduled**
(daily/weekly cron, throttled per-agent) and **on-demand** (callable directly
from the internal frontend).

**Additional folders/files this system adds** (omitted from the Part 1
folder tree in §3):
```
server/
├── agents/
│   ├── types.js                    Documentation-only contract (AgentMeta/AgentInput/AgentOutput shapes)
│   ├── registry.js                 Auto-discovers every agent module in this folder by meta.id
│   ├── runner.js                    runAgent(id, input) — the one choke point: invokes, times, persists
│   │                                to agent_runs, broadcasts a live SSE event via activity-bus.js
│   ├── orchestrator.js              runOrchestration() — fans out to N agents in parallel, merges
│   │                                findings, calls callLLM once for a synthesized narrative
│   ├── query-intelligence.js        seo — daily
│   ├── opportunity.js               seo — daily
│   ├── device-intelligence.js       seo — daily
│   ├── country-intelligence.js      geo — daily
│   ├── ai-visibility.js             geo — daily; always "insufficient-data", no citation/SERP-AI-Overview
│   │                                source connected (deliberate no-fabrication policy, unchanged from before)
│   ├── technical-seo.js             seo — daily; Core Web Vitals checks skipped if PAGESPEED_API_KEY unset
│   ├── content-gap.js               content — on-demand + Executive Report only, not in the daily cron set
│   ├── competitor-intelligence.js   seo — monthly (throttled); needs DATAFORSEO_LOGIN/PASSWORD, else
│   │                                falls back to LLM-only discovery
│   ├── authority.js                 seo — monthly (throttled); needs DATAFORSEO_LOGIN/PASSWORD, else
│   │                                "insufficient-data" (never estimated) — surfaced in AuthorityScoreCard.jsx
│   ├── ai-recommendation.js         content — monthly (throttled); needs OPENAI_API_KEY **and** an explicit
│   │                                AI_RECOMMENDATION_ENABLED=true opt-in flag (double-gated on purpose)
│   └── executive-report.js          meta — composes the other agents via runOrchestration + callLLM
├── agents/lib/                      24 support modules: command-center.js, copilot.js, watchlist.js,
│                                    activity-bus.js (SSE pub/sub), authority-score.js, competitor-analysis.js,
│                                    growth-report.js, insights.js, recommendations.js, page-content.js,
│                                    site-discovery.js, fix-verification.js, technical-seo-analysis.js,
│                                    model-providers/openai.js, etc.
├── routes/agents.js                 /api/agents* routes, requireAuth-gated (open to any client session)
├── routes/command-center.js         Separate router for the Command Center aggregate view
├── routes/action-center.js          Separate router; depends on server/generators/ (9 content generators)
│                                    and server/store/drafts.js (migration 014) for implementable drafts
├── store/agent-runs.js              Append-only insert + history read for agent_runs
├── cron.js                          node-cron: daily job (CRON_SCHEDULE, default 0 7 * * *) and weekly
│                                    job (WEEKLY_CRON_SCHEDULE, default 0 8 * * 4) — same Express process,
│                                    no separate worker/queue
├── migrations/010_agent_runs.sql
├── migrations/014_*                 Action Center drafts
├── migrations/035_authority_score.sql
└── migrations/036_ai_recommendation_tracking.sql
```

**Wiring**: `server/index.js` mounts `app.use('/api', agentsRouter)`. This
surface (and `command-center`/`action-center`/`site-audit`) only carries
`requireAuth` — any authenticated client session can call it, scoped to its
own `siteId`. `GET /api/me`'s `isInternal` flag is no longer involved in
gating these; it's still used server- and client-side, but only for `/clients`
(`requireInternalSite` on `server/routes/clients.js`) and the AI Copilot
panel (`requireInternalSite` on `server/routes/copilot.js`) — see the Part 2
intro above for the full current/legacy split.

**Contract** (`server/agents/types.js`, documentation-only JSDoc): every
agent module exports `meta` (id, name, description, category ∈
`seo`/`content`/`geo`/`meta`, version) and `async function run(input)`
returning `{ meta, status, facts, narrative, generatedAt, ... }` where
`status` is `'ok'` | `'insufficient-data'` | `'error'`. Every agent now calls
`callLLM` (`server/llm.js`, shared with Part 1 §19) to produce its
`narrative` — this is no longer reserved/unused as it was at the previous
snapshot.

**Registry** (`registry.js`) — auto-discovers every `.js` file in
`server/agents/` (excluding `types.js`/`registry.js`/`runner.js`/
`orchestrator.js`), indexing by `meta.id`; adding a new agent is still a
one-file operation, no registry edits required.

**Runner** (`runner.js`) — `runAgent(id, input)` invokes, times (`tookMs`),
persists to `agent_runs`, and broadcasts a live start/done event via
`activity-bus.js`'s `subscribeActivity`/publish pair. This SSE feed is what
`GET /api/agents/live` streams to the frontend.

**Orchestrator** (`orchestrator.js`) — `runOrchestration()` fans out to
multiple agents in parallel, merges their findings, and makes exactly one
`callLLM` call to synthesize a cross-agent narrative. Used by the Executive
Report, and by the Command Center / Action Center / AI Copilot refresh
actions — all four share this one code path rather than each reimplementing
fan-out + synthesis.

**Frontend — real, not a mock.** `web/src/pages/AiGrowth.jsx` (`/ai-orchestration`)
renders `OrchestrationDiagram.jsx`, which is driven entirely by real data:
`GET /api/agents/status` (latest persisted run per agent, joined from
`agent_runs`), `GET /api/agents/activity` (recent run history), and a live
`GET /api/agents/live` SSE stream — a code comment in `routes/agents.js`
states explicitly this is real state only, never a simulated "running" node.
`CommandCenter.jsx` (`/ai-growth`, the default landing page for this section)
reads already-persisted `agent_runs` via `command-center.js` — fast, not a
live recompute. `ActionCenter.jsx` turns agent findings into drafts, with a
GitHub integration (`server/github/client.js`) for push-branch/merge-to-stage
actions. `CopilotPanel.jsx` is an internal chat UI reusing the orchestrator's
`synthesizeFindings`. `NotificationBell.jsx` is fed by `server/notifications/detect.js`,
which diffs agent findings run-over-run to surface new opportunities.

**Triggers, in full:**
1. **Cron** (`server/cron.js`) — daily job runs `DAILY_AGENT_IDS` (11 agents
   today — `query-intelligence`, `opportunity`, `country-intelligence`,
   `device-intelligence`, `ai-visibility`, `technical-seo`,
   `security-headers`, `internal-linking`, `duplicate-content`,
   `accessibility`, `mobile-usability`; see `server/job.js`); weekly job
   (Thursdays by default) runs the 3 monthly-throttled agents
   (`competitor-intelligence`, `authority`, `ai-recommendation` — each only
   actually executes once per 30 days via `runAgentIfDue`) then
   `executive-report`. `content-gap` is deliberately excluded from the cron
   set — on-demand and Executive-Report-only.
2. **On-demand API** — `POST /api/agents/:id/run` (any single agent),
   `POST /api/command-center/refresh`, `POST /api/action-center/recommendations/refresh`.
3. **No separate scheduler/queue/worker** — same single Express process as
   Part 1; `runStartupCatchup()` (`server/job.js`) runs unawaited at boot to
   catch up any site whose scheduled run was missed while the process was down.

**`insufficient-data` remains a deliberate design choice**, unchanged from
the previous snapshot: `ai-visibility` (no citation-tracking/SERP-AI-Overview
provider) always says so plainly rather than fabricating a number. `authority`
and `competitor-intelligence` are more nuanced when `DATAFORSEO_LOGIN`/
`PASSWORD` are unset — neither one jumps straight to `insufficient-data`:
`authority` falls back to a real, single-signal Common Crawl estimate
(`status: 'ok'`, explicitly labeled coarser in both `facts.note` and its
narrative — only actually returns `insufficient-data` if even Common Crawl
has nothing), and `competitor-intelligence` falls back to LLM-only competitor
discovery (`status: 'ok'`, each competitor tagged `discoverySource: 'llm'` —
honestly labeled as ungrounded-in-SERP-data, but not `insufficient-data`
either). Real DataForSEO-backed data for competitor intelligence is still
pending manager budget approval as of this writing.

**Env vars this system adds** (on top of the Part 1 core vars in §16):
`DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD`, `COMPETITOR_LOCATION_CODE`,
`COMPETITOR_LANGUAGE_CODE`, `COMPETITOR_PROVIDER`, `PAGESPEED_API_KEY`,
`AI_RECOMMENDATION_ENABLED`, `AI_RECOMMENDATION_MODEL`, `COMPANY_SITE_ID`
(the internal-only feature-flag gate), `FIX_VERIFY_DELAY_HOURS`.

**Design conventions worth reusing for any similarly internal, pluggable
feature**: an auto-discovery registry over a fixed directory instead of
manual wiring; a documentation-only contract file (`types.js`) instead of a
base class; an explicit "never fabricate — return `insufficient-data`
instead" rule for anything lacking a real data source; append-only history
logging instead of upsert-by-day when a "run" has no natural coalescing key;
a single orchestrator/runner choke point that every caller (cron, API,
meta-agent) goes through, instead of each caller reimplementing persistence
and broadcast.

## 23. Future Improvements (AI Growth Platform, internal-only)

All of the following applies only to the internal system in §22. None of it
implies or plans a client-facing rollout — that remains a separate, explicit
product decision, not assumed by any item below.

- Wire a real data provider for `ai-visibility` (AI citation tracking / SERP
  AI-Overview detection) so it can move off `insufficient-data` — no source
  is connected yet.
- Get manager budget approval to wire real DataForSEO-backed data for
  `competitor-intelligence` (currently LLM-only fallback when
  `DATAFORSEO_LOGIN`/`PASSWORD` are unset).
- Consider whether `content-gap` should join the daily/weekly cron set now
  that the other agents have proven the scheduling pattern, or stay
  on-demand-only by design.
- **If and only if** this framework is later validated internally and a
  deliberate decision is made to offer it to clients: define per-site
  enablement, decide whether it's a paid tier feature, and only then fold it
  into Part 1 of this document as part of the client template. Nothing today
  should be read as already deciding this.

## Working Rules

These are the governance rules for any future work in this repository — read
them before making an architectural decision, not just before writing code.

1. **Preserve the Master Product separation.** Don't build one-off,
   client-specific solutions. A feature that could be reusable across clients
   belongs in the Core Dashboard (Part 1); a feature that's only useful to us
   belongs isolated inside the Internal AI Growth Platform (Part 2). Never mix
   the two into one codepath.
2. **Verify before changing.** Before modifying anything, find where the
   existing implementation lives, understand the current architecture, and
   follow existing patterns — reuse existing modules (§19) rather than
   duplicating functionality. If something already exists, extend it instead
   of rebuilding it.
3. **Think product first, not just code first.** For any new feature, ask
   whether it will scale to many clients, whether it belongs in the reusable
   product or stays internal, whether there's a cleaner architecture, and
   whether it adds technical debt — choose the option that improves the
   product as a whole, not just the fastest path to shipping.
4. **Do not invent.** Never assume code exists without checking, never
   document hypothetical behavior as if it were real, and never claim a
   feature is implemented unless it's verified in the repository. Keep
   existing implementation and future improvements clearly separated, the
   same way §21 and §23 are separated from the rest of this document.
5. **Preserve backward compatibility.** Don't break existing APIs, database
   schema, or dashboard behavior unless a change is explicitly requested —
   prefer extending over replacing.
6. **Maintain the architecture's separation of concerns.** Backend stays
   split into Routes, Store, Reports, Agents, and Utilities; frontend stays
   split into Pages, Components, and the API layer (`web/src/api.js`). Avoid
   mixing concerns across these boundaries.
7. **Follow the AI development standard.** Before implementing any AI
   feature, decide whether it belongs in the Core Dashboard or the Internal
   AI Platform, reuse the existing `callLLM()` infrastructure (`server/llm.js`,
   §19) rather than writing a new LLM wrapper, and keep prompts centralized
   where possible.
8. **Keep this document current.** Whenever the architecture changes, update
   this skill, remove information that's gone stale, and clearly mark new
   proposals as future improvements rather than blending them with verified
   fact. This file is meant to stay the single source of truth for the
   codebase — treat edits to it with the same care as edits to the code it
   describes.

## 24. Future Architecture — Always-On AI Runtime (Internal Only)

**Entirely aspirational — no code referenced below exists in this repository
today.** This section documents a possible future direction for the Internal
AI Growth Platform (Part 2), not a plan already in motion; treat it with the
same caution as §21 and §23.

**Current state:** the AI Growth Platform (§22) now has basic cron scheduling
(daily/weekly, throttled per-agent — see §22) in addition to on-demand runs,
but everything still executes in-process in the same Express server; there is
no separate runtime, queue, event-driven triggering, or agent memory. What's
described below — a fully independent always-on runtime — remains
aspirational.

**The long-term idea** is an "Always-On AI Runtime" that keeps operating
independently of the dashboard — continuing to run whether or not anyone is
logged in, the dashboard is open, or a session is active. The dashboard would
become a pure interface layer (visualization, configuration, monitoring,
approvals, reporting) while a separate runtime owns decision-making, analysis,
planning, task execution, and automation; under this model the dashboard
should never contain business logic itself.

Speculative future components, none of which exist yet: an Agent Scheduler, a
Background Worker, an Event Queue, Agent Memory, a Task Queue, a Health
Monitor, and a Notification Service, running continuously as backend services
that the dashboard only visualizes.

If built, agents would need to support three execution modes sharing one
implementation (no duplicated logic per mode): **scheduled** (hourly/daily/
weekly), **event-driven** (triggered by new GSC data, GA4 changes, ranking
drops, indexing issues, or traffic anomalies), and **manual** (today's only
mode — user-triggered from the dashboard).

**Client boundary stays the same as the rest of Part 2:** this runtime, if
built, is part of the Internal AI Growth Platform, not the Core Dashboard.
Clients would keep using the standard dashboard unless this is deliberately
productized as a separate premium module later — the same conditional
decision gate described in §23.

**Suggested maturity lifecycle for any new AI capability**, if this direction
is pursued: research → internal AI runtime → validation → internal AI
platform → optimization → stable internal feature → a deliberate
productization decision (only then, if valuable for clients, does it move
into the Core Dashboard as an optional module; otherwise it stays internal).
The Core Dashboard should stay clean, reusable, stable, and client-focused
throughout.