# Website Analytics Agent + Dashboard

Automated daily ingestion of **Google Search Console (GSC)** + **GA4** metrics into
**Neon Postgres**, with an AI-written daily summary, a morning email, and a
password-protected **React dashboard** (trends, top queries/pages, channels,
month-over-month comparison).

> Non-technical overview for the team: see **TEAM-GUIDE.md**.

---

## Stack

- **Backend:** Node 20 + Express, `pg` (Neon), `googleapis` (GSC), `@google-analytics/data` (GA4),
  `node-cron`, `@anthropic-ai/sdk` (narrative), `nodemailer` (email).
- **Frontend:** Vite + React + Tailwind v4 + Recharts.
- **Deploy:** Docker (multi-stage) + Traefik. The Node server serves the built dashboard *and*
  runs the daily cron in-process.

```
server/
  index.js            Express app + serves web/dist + starts cron
  cron.js             node-cron daily schedule
  job.js              ingest → narrative → email pipeline (idempotent)
  db.js               pg Pool (Neon) + getOrCreateSite()
  auth/google.js      service-account / OAuth client factory
  ingest/gsc.js       searchconsole.searchanalytics.query
  ingest/ga4.js       analyticsdata properties.runReport
  store/upsert.js     ON CONFLICT upserts
  store/read.js       dashboard + report read queries
  report/narrative.js Claude daily summary
  report/email.js     nodemailer morning email
  routes/             /api login + metrics
  migrations/         001_init.sql + run.js
  scripts/ingest.js   manual ingest CLI
web/                  React dashboard (Vite)
```

---

## One-time Google access setup

The GSC + GA4 properties are owned by your manager. The agent needs its **own** credentials.

### Recommended: service account
1. In **Google Cloud Console**, pick/create a project and **enable** both APIs:
   *Google Search Console API* and *Google Analytics Data API*.
2. **IAM & Admin → Service Accounts → Create**. Then **Keys → Add key → JSON**. Download it.
3. Put the JSON at `analytics/secrets/service-account.json` and point
   `GOOGLE_APPLICATION_CREDENTIALS` at it.
4. The service account has an email like `analytics-bot@PROJECT.iam.gserviceaccount.com`.
   **Ask your manager to grant it access:**
   - **GSC:** Search Console → *Settings → Users and permissions* → add the email as **Restricted**.
   - **GA4:** Admin → *Property Access Management* → add the email as **Viewer**.
5. Record the **GA4 numeric Property ID** (Admin → Property Settings) and the
   **GSC property** string (`sc-domain:example.com` or `https://example.com/`).

### Fallback: OAuth refresh token
If a service account can't be granted access, create OAuth credentials and generate a
refresh token from *your* Google account (which already has access), then set
`GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_REFRESH_TOKEN`.

---

## Configuration

```bash
cp .env.example .env   # then fill in REAL values in .env (never commit .env)
```

`.env` is git-ignored. **Do not put real secrets in `.env.example`** — that file is the
shareable template. Key variables:

| Variable | What |
|----------|------|
| `DATABASE_URL` | Neon **pooled** connection string (`...-pooler...`) |
| `GOOGLE_APPLICATION_CREDENTIALS` | Absolute path to the service-account JSON |
| `GSC_PROPERTY` / `GA4_PROPERTY_ID` | Your property identifiers |
| `ANTHROPIC_API_KEY` | For the AI narrative |
| `REPORT_MODEL_DAILY` / `REPORT_MODEL_MONTHLY` | `claude-haiku-4-5` / `claude-opus-4-8` |
| `SMTP_*`, `REPORT_EMAIL_TO` | Morning email (use a Gmail **App Password**) |
| `DASHBOARD_PASSWORD`, `SESSION_SECRET` | Dashboard login |
| `TZ`, `CRON_SCHEDULE` | When the daily job runs (default 07:00 local) |
| `ANALYTICS_DOMAIN` | Public domain for Traefik routing |

---

## Local development

```bash
npm install
npm run migrate          # create tables + seed the site row from .env
npm run ingest -- 2026-06-08          # ingest one day (sanity check)
npm run ingest -- 2026-05-01 2026-06-08   # backfill a date range

# two terminals:
npm run dev:server       # Express API on :3002 (+ cron)
npm run dev:web          # Vite dashboard on :5173 (proxies /api → :3002)
```

Open http://localhost:5173 and log in with `DASHBOARD_PASSWORD`.

### Backfilling history
GSC retains ~16 months and GA4 retains its configured window, so you can seed history:
```bash
npm run ingest -- 2026-04-01 2026-06-08
```
Re-running any date is safe (upserts overwrite, never duplicate).

---

## Production (Docker + Traefik)

Assumes an external Traefik network named `hosting` with a `letsencrypt` cert resolver
(same setup as the `agency` project).

```bash
# on the server, in analytics/
cp .env.example .env          # fill in real values
mkdir -p secrets && cp /path/to/service-account.json secrets/

docker compose up -d --build
docker compose exec analytics node server/migrations/run.js   # first-time migrate
docker compose logs -f analytics
```

The container serves the dashboard at `https://$ANALYTICS_DOMAIN` and runs the daily
cron in-process. To run the pipeline once manually (e.g. to test email):
```bash
docker compose exec analytics node -e "import('./server/job.js').then(m=>m.runDailyJob())"
```

---

## How the daily job works

`runDailyJob()` (cron at `CRON_SCHEDULE`, in `TZ`):
1. **GSC** — re-fetch `today-6 … today-3` (3-day lag + 3-day backfill for late finalization).
2. **GA4** — fetch `today-6 … today-1` (near real-time; extra freshness).
3. **Narrative** — Claude summarizes the report date (`today-3`, where GSC is final) vs prior day / 7-day avg → `daily_reports`.
4. **Email** — nodemailer sends the summary; sets `emailed_at`.

All writes are idempotent (`INSERT … ON CONFLICT DO UPDATE`).

### Gotchas
- **GSC lag** is real (Google-side) — the freshest *final* search day is ~3 days back.
- **Neon:** use the **pooled** connection string; the `pg` pool `max` is kept at 3.
- **Timezone:** set `TZ` to the property's timezone so "yesterday" aligns.
- **GA4 quota** is generous for this volume (~12 report calls/day).

---

## Adding more sites later

The schema is multi-site (`sites` table + `site_id` FKs). Add a row to `sites`, extend the
ingest loop to iterate all sites, and the dashboard's site switcher appears automatically
when more than one site exists.
