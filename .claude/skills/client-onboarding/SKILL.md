---
name: client-onboarding
description: Runbook for onboarding a new client onto the shared multi-tenant Zunkiree Analytics instance (Core Dashboard only — see the master-product skill, Part 1). Use this when standing up analytics/reporting for a new client — covers gathering client inputs, provisioning via create-client/connect-site, Google Search Console + Analytics access, email reports, and testing. Documentation only; does not implement or change any code.
---

# Client Onboarding — New Client on the Shared Instance

This skill explains **how**, not **whether** — it documents the process for
onboarding a new client onto the one running, shared dashboard instance. It
does not implement anything itself; follow it manually or hand it to whoever
is doing the onboarding.

Read the **master-product** skill first if you haven't — this onboarding
process only ever touches **Part 1, the Core Dashboard**. The internal AI
Growth Platform (master-product Part 2) is company-only, gated by
`COMPANY_SITE_ID`/`requireInternalSite`, and is never part of a client
build — a new client's login is automatically denied access to it (verified
end-to-end during onboarding, §8 below).

## 0. The one thing to understand before starting

**This is one shared instance serving every client** — one Express process,
one Postgres database, one `sites` row per client (see
`future-multi-client-architecture` skill, Phases 1–5, now shipped). Onboarding
a new client is a **data operation**, not a new deployment:

```
npm run create-client -- <email> <password> --company "Client Name" [--domain client.com] [--timezone Asia/Kolkata]
npm run connect-site -- --site-id <new id> --gsc-property "sc-domain:..." --ga4-property-id <id> [--email-to client-contact@example.com] [--logo path/to/logo.png]
```

No repo clone, no new database, no new server process, no new `.env`, no
Docker/launchd setup. The one already-running instance picks the new client
up automatically on its next scheduled cron cycle the moment both GSC and
GA4 are connected (`listConnectedSites()` in `server/job.js`).

**The dashboard must stay identical between clients unless the client has
explicitly requested a custom feature.** Only company name, logo, and website
differ per client, shown after login — this is tenant context, not a
re-theme. Resist the urge to tweak layout, copy, or behavior "while you're in
there" for one client. If a client does request something custom, treat it
as a deliberate, separately-tracked deviation, not a silent edit.

## 1. Before you start — gather these from the client

Gather one at a time if doing this conversationally — it's easy to get stuck
waiting on one field when the rest could move forward.

- **Company name** (as it should appear in the dashboard, emails, and doc reports).
- **Dashboard login email** + a temporary password (≥8 characters) — or plan
  to have the client set their own later (there's no self-serve reset flow
  yet, so "temporary password, rotate at real handover" is the normal path).
- **GSC property string** — exact, from Search Console → Settings → Property,
  or read directly from the property switcher dropdown: a bare domain like
  `admizzeducation.com` shown with **no** `https://` means a **domain
  property** (`sc-domain:admizzeducation.com`); a full URL like
  `https://example.com/` shown with the protocol means a **URL-prefix
  property** (use that exact string, trailing slash and `www` matter).
- **GA4 numeric Property ID** — from GA4 Admin → Property Settings. You can
  often skip asking the client for this entirely — see §6, the shared OAuth
  account can list every property it already has access to.
- **Daily report recipient email** (one address, or comma-separated for a
  distribution list) — this is per-site (`sites.report_email_to`), never the
  same inbox as another client.
- **Website domain** (display only, also used to auto-detect the client's
  logo — see §2). Optional: a **logo** file, only needed if you want to
  override the auto-detected one. Timezone defaults to `Asia/Kolkata` if not
  given.
- Confirm the client already has Google Search Console **and** GA4 set up on
  that property (this tool reads existing data — it does not set either up).

## 2. Provision the client

```
npm run create-client -- <email> <password> --company "Client Name" --domain client.com --timezone Asia/Kolkata
```
Creates the `sites` row + a bcrypt-hashed login in one step
(`server/scripts/create-client.js`). Prints the new site id — you need it for
the next command.

```
npm run connect-site -- --site-id <id> --gsc-property "sc-domain:client.com" --ga4-property-id 123456789 --email-to contact@client.com
```
Attaches GSC/GA4/email (`server/scripts/connect-site.js`). If a `--domain`
was given at step 1 and you don't pass `--logo` here, the logo is
auto-detected from the client's own site (checked in order: an `<img>` with
"logo" in its class/id/alt, an apple-touch-icon, `og:image`, then the
favicon) and stored automatically — the command's own output tells you what
it found (or why it skipped, e.g. no candidates or the site was
unreachable). Pass `--logo path/to/logo.png` to override with a specific
file instead — only `.svg`, `.png`, `.jpg`/`.jpeg` are supported (convert
first if the client's asset is `.webp` or another format, e.g. macOS: `sips
-s format png in.webp --out out.png`). Confirm the command's own output says
**"Both GSC and GA4 are connected"** — that's what makes
`listConnectedSites()` start including this site in automated jobs.

Any field can be set later by re-running `connect-site` with just that flag
(it only touches fields you pass).

## 3. Product branding vs. client branding — don't confuse these

- **Product-level branding** (the dashboard's own name/logo/favicon/colors)
  is shared, global, and the same for every client — this is not a
  white-label product. Never edit this per client.
- **Client-level branding** (company name + optional logo) is per-`sites`-row
  data — the `--company` name from `create-client`, and a logo stored as a
  data URL in `sites.logo_data_url`, either auto-detected from the client's
  site or set manually via `connect-site --logo` (`server/agents/lib/
  logo-discovery.js` does the auto-detection). It's fetched at runtime after
  login (`GET /api/sites`), not baked into any build — `Header.jsx` renders
  it next to the product logo automatically. Nothing to edit in `web/` for a
  new client, ever.

## 4. Google Search Console access

The dashboard needs its own credentials with read access to the client's GSC
property — it does not use the client's personal Google login.

**Check first — you may already have access.** The shared credentials
(`GOOGLE_OAUTH_*` in `.env`, or `GOOGLE_APPLICATION_CREDENTIALS` as a
fallback if OAuth vars aren't set — `server/auth/google.js` tries OAuth
first) might already be able to see the new property, especially if the same
person/team manages multiple client accounts. Confirm directly:

```
node -e "
import('dotenv/config').then(async () => {
  const { google } = await import('googleapis');
  const { GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN } = process.env;
  const oauth2 = new google.auth.OAuth2(GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: GOOGLE_OAUTH_REFRESH_TOKEN });
  const sc = google.searchconsole({ version: 'v1', auth: oauth2 });
  console.log(JSON.stringify((await sc.sites.list()).data, null, 2));
});
"
```
This lists every property the shared account can already read, with its
permission level (`siteOwner`/`siteFullUser`/`siteRestrictedUser` — any of
these is enough, since this tool is read-only). If the new client's property
is already listed, **skip straight to §6, nothing to grant.**

**If it's not listed yet**, someone with **Owner** permission on that
property (not just "Full" — only Owners can add users, verified or
delegated) needs to add the shared account's email under Search Console →
**Settings → Users and permissions** as **Restricted** (read-only is
sufficient). Get that email from whoever set up `GOOGLE_OAUTH_REFRESH_TOKEN`
originally — it does not change per client and is a completely separate
account from `SMTP_USER` (the email-sending account, which never needs GSC
access).

## 5. Google Analytics (GA4) access

Same shared-credentials-first approach as §4. Auto-detect via the Analytics
Admin API (one-time setup, see below):

```
node -e "
import('dotenv/config').then(async () => {
  const { google } = await import('googleapis');
  const { GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, GOOGLE_OAUTH_REFRESH_TOKEN } = process.env;
  const oauth2 = new google.auth.OAuth2(GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET);
  oauth2.setCredentials({ refresh_token: GOOGLE_OAUTH_REFRESH_TOKEN });
  const admin = google.analyticsadmin({ version: 'v1beta', auth: oauth2 });
  console.log(JSON.stringify((await admin.accountSummaries.list({ pageSize: 200 })).data, null, 2));
});
"
```
Each `propertySummaries[].property` (e.g. `properties/483837192`) gives the
exact numeric Property ID directly — no need to ask the client or hunt
through GA4 Admin manually. `canEdit: true` in the response means access is
already sufficient (Viewer would suffice too).

**First-time-only setup**: this call fails with "Analytics Admin API has not
been used in project ... or it is disabled" until you enable it once, ever,
for the whole project — visit the URL in the error message and click
**Enable**. This is a one-time, low-risk, fully reversible toggle (doesn't
grant any new access to anyone, doesn't cost anything, only unlocks this one
read-only listing call) — not a per-client step.

**If the property isn't listed**, ask the client to add the shared account's
email in GA4 → **Admin → Property Access Management** as **Viewer**, then
confirm the exact numeric Property ID matches (a common mistake is granting
access to the wrong property/view under the same account).

**Per-client credentials (rare case)**: if a client insists on using their
own service account instead of the shared one, `server/auth/google.js`
already supports this — drop their key at
`secrets/clients/<site.id>/service-account.json` and it's used exclusively
for that site, no code change needed. Not the default path; only reach for
this if asked.

## 6. SMTP & email reports

- `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS` (in `.env`) configure the
  **one shared sending account** for every client's daily email — this
  never changes per client and never needs any Google property access
  (it's a completely different thing from §4/§5's GSC/GA4 credentials).
- **Recipient is per-site**: `sites.report_email_to`, set via
  `connect-site --email-to`. This is what makes multi-client email safe —
  every client's report goes to their own configured recipient, never a
  shared global inbox (falls back to `REPORT_EMAIL_TO` in `.env` only for
  the one site that predates this column).
- The email content itself (KPI cards + AI narrative) is not
  client-configurable beyond the site name — do not fork the template in
  `server/report/email.js` per client.

## 7. Login credentials

- Per-user bcrypt login, created via `create-client` — no shared password,
  no per-instance secret to manage. `SESSION_SECRET` and the session store
  are shared across all clients (Postgres-backed, `connect-pg-simple`) and
  don't need anything client-specific.
- Hand the client their login email + temporary password through a secure
  channel (not this chat, not committed anywhere) — plan for them to change
  it at real handover; there's no self-serve reset flow yet, so a password
  change today means re-running `create-client`'s user-creation path or a
  direct DB update, not an in-app "forgot password."

## 8. Testing before handoff

1. **Backfill a real range** — `npm run ingest -- <start> <end> --site-id <id>`
   for the last 1–2 weeks; confirm non-zero clicks/impressions/users/sessions
   for both GSC and GA4 (catches a wrong property ID or missing access grant
   immediately, before the client ever logs in).
2. **Log in** with the real credentials and confirm via `GET /api/me`
   (`isInternal: false`) and `GET /api/sites` (only this client's own site
   returned) — and confirm `/api/agents*`/`/api/action-center*` both 404 for
   this login (internal-only features correctly hidden).
3. **Check the dashboard UI** — Overview/Insights/Compare load with real
   data, company name + logo render correctly in the header, no `/ai-growth`
   or `/action-center` nav tabs appear.
4. **Trigger one real daily job**, scoped to just this site (never the
   no-arg legacy functions, which silently operate on the single
   env-configured site instead of the one you're testing):
   ```
   node -e "
   import('./server/db.js').then(async ({ pool }) => {
     const { getSiteById } = await import('./server/store/read.js');
     const { runDailyJobForSite } = await import('./server/job.js');
     await runDailyJobForSite(await getSiteById(<id>));
     await pool.end();
   });
   "
   ```
   Confirm it logs a narrative saved, an email sent (check the configured
   `report_email_to` inbox), and a daily Google Doc entry written.
5. **Open the Google Doc link** the job printed and confirm it's actually
   visible — a doc created via the shared Google account is not
   automatically visible to anyone else; share explicitly if the client
   needs direct access to it (the in-dashboard link works for the client
   regardless, via `/api/daily-doc-link`, since that's just a redirect/URL
   the server already knows).

Only once all of the above pass should you hand the login (and, if relevant,
the Google Doc access) to the client.
