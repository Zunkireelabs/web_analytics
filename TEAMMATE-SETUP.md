# Zunkiree Analytics — Teammate Setup Guide
> Hand this file to Claude Code on your machine and say: "Follow TEAMMATE-SETUP.md to set up the analytics project."
> Claude will read this and do every step for you.

---

## Credentials (keep this file private — do not share publicly)

| What | Value |
|------|-------|
| Dashboard URL (local) | http://localhost:3002 |

Dashboard login is now per-person (email + password), not a shared password.
Ask Yukta to run `npm run create-client -- <your-email> <password> --site-id 1`
once to create your login, or ask her directly for credentials if she's
already done this for you.

You will also need from Yukta (ask her directly — not in this file):
- The filled-in `.env` file (has DB URL, API keys, Google OAuth tokens, email password)
- The `secrets/service-account.json` Google credentials file

---

## What this project is

A dashboard that pulls daily data from Google Search Console + Google Analytics 4,
writes an AI summary, sends a morning email, and shows everything on a web dashboard.
It runs 24/7 in the background — you don't need to keep a terminal open.

---

## Prerequisites Claude should install/check

1. **Node.js v20 via nvm**
   ```bash
   # Install nvm if not present:
   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
   # Restart terminal, then:
   nvm install 20
   nvm use 20
   node --version   # should say v20.x.x
   ```

2. **Confirm npm works:**
   ```bash
   npm --version
   ```

---

## Step 1 — Clone the repo

```bash
git clone https://github.com/Zunkireelabs/web_analytics.git
cd web_analytics
```

---

## Step 2 — Place the files Yukta sent you

```bash
# 1. Copy the .env file Yukta sent into the project root:
#    (Claude: ask the user to drag-drop .env into /path/to/web_analytics/)

# 2. Create the secrets folder and place the service-account.json inside:
mkdir -p secrets
#    (Claude: ask the user to copy service-account.json into web_analytics/secrets/)
```

After this, your folder should look like:
```
web_analytics/
  .env                        ← from Yukta
  secrets/
    service-account.json      ← from Yukta
  server/
  web/
  ...
```

---

## Step 3 — Install dependencies

```bash
npm install
```

---

## Step 4 — Run the database migration (first time only)

```bash
npm run migrate
```

You should see: `Migrations complete.` (or similar). This creates the tables in Neon Postgres.

---

## Step 5 — Build the web dashboard

```bash
npm run build:web
```

This compiles the React dashboard into `web/dist/`. The Node server then serves it.

---

## Step 6 — Test it works (one-off run)

```bash
node server/index.js
```

Open http://localhost:3002 — log in with the email and password Yukta gave you
(see the Credentials section above if you don't have one yet).
You should see the dashboard. Press Ctrl+C to stop.

---

## Step 7 — Set up 24/7 background running (macOS only)

This makes the server start automatically when you log in and restart itself if it ever crashes — exactly how Yukta's machine runs it.

### 7a — Find your Node path

```bash
which node
# Copy the output — it will look like:
# /Users/YOURNAME/.nvm/versions/node/v20.19.4/bin/node
```

### 7b — Find your project path

```bash
pwd
# Copy the output — it will look like:
# /Users/YOURNAME/web_analytics
```

### 7c — Create the launchd plist

Claude: create the file `~/Library/LaunchAgents/com.zunkiree.analytics.plist`
replacing `NODE_PATH` with the output from 7a and `PROJECT_PATH` with the output from 7b:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.zunkiree.analytics</string>

  <key>ProgramArguments</key>
  <array>
    <string>NODE_PATH</string>
    <string>PROJECT_PATH/server/index.js</string>
  </array>

  <key>WorkingDirectory</key>
  <string>PROJECT_PATH</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>NODE_PATH_DIR:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>PROJECT_PATH/deploy/analytics.log</string>
  <key>StandardErrorPath</key>
  <string>PROJECT_PATH/deploy/analytics.log</string>
</dict>
</plist>
```

> Note for Claude: `NODE_PATH_DIR` is the directory containing the node binary
> e.g. if `which node` = `/Users/foo/.nvm/versions/node/v20.19.4/bin/node`
> then `NODE_PATH_DIR` = `/Users/foo/.nvm/versions/node/v20.19.4/bin`

### 7d — Create the log folder and start it

```bash
mkdir -p deploy
launchctl load ~/Library/LaunchAgents/com.zunkiree.analytics.plist
```

### 7e — Confirm it's running

```bash
# Check process is alive:
curl http://localhost:3002/api/health
# Should return: {"ok":true}

# Watch logs:
tail -f deploy/analytics.log
```

Open http://localhost:3002 → log in with your email and password ✓

---

## Day-to-day commands

```bash
# Stop the server:
launchctl unload ~/Library/LaunchAgents/com.zunkiree.analytics.plist

# Start it again:
launchctl load ~/Library/LaunchAgents/com.zunkiree.analytics.plist

# Watch live logs:
tail -f deploy/analytics.log

# Pull latest code changes from Yukta:
git pull
npm install          # only needed if packages changed
npm run build:web    # only needed if dashboard UI changed
launchctl unload ~/Library/LaunchAgents/com.zunkiree.analytics.plist
launchctl load ~/Library/LaunchAgents/com.zunkiree.analytics.plist
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `SESSION_SECRET is not set` on startup | Check your `.env` has `SESSION_SECRET=` filled in |
| `DATABASE_URL is not set` | Check your `.env` has `DATABASE_URL=` filled in |
| Dashboard loads but shows no data | Run `npm run ingest -- 2026-06-01 2026-06-12` to backfill |
| Google auth error | Make sure `secrets/service-account.json` is in the right place |
| Port 3002 already in use | Something else is using that port; change `API_PORT=3003` in `.env` |
| Server not restarting after reboot | Re-run the `launchctl load` command from Step 7d |
