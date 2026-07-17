# How This System Runs — Data, Dashboard, Email & AI Agents

This doc is for anyone new joining the team who needs to understand, without
reading the source code first, **how the product actually operates once it's
deployed**: how data gets pulled in automatically, how it reaches the
dashboard and the client's inbox, and how the AI agent layer (competitor
intelligence, authority score, executive report, etc.) fits into the same
24/7 loop.

For the exhaustive technical reference (every API route, every DB column),
see the `master-product` skill. This doc is the narrative version — read it
top to bottom once and you'll have the right mental model.

---

## 1. The one-sentence mental model

**One Node.js program runs on the VPS, forever, doing three jobs at the same
time:**

1. It's a **waiter** — serves the dashboard website and its API to browsers.
2. It's a **clock-watcher** — has background timers running inside it (cron).
3. It's a **team of specialist workers** — the AI agents, invoked either by
   those timers or by someone clicking a button.

There is no separate worker process, no job queue, no external scheduler
service. It's all one process (`server/index.js`), running inside one Docker
container, restarted automatically if it ever crashes.

---

## 2. The daily cycle — how data reaches the dashboard and the inbox

This runs every single day, for **every connected client site**, whether or
not anyone ever touches the AI agents.

**07:00, site-local time** — the internal clock fires and, one site at a
time:

```
Google Search Console API ─┐
                            ├─▶ Postgres (raw daily numbers, upserted)
Google Analytics 4 API   ───┘        │
                                      ▼
                          AI narrative written (Claude/OpenAI)
                                      │
                     ┌────────────────┼────────────────┐
                     ▼                ▼                 ▼
              Dashboard API     Email sent to      Google Doc
              (reads Postgres)  the client         entry appended
```

GSC data has a real ~3-day lag on Google's side (not a bug), so the pipeline
fetches `today − 3` as "today's report date." GA4 has almost no lag, so it's
fetched near-real-time. Every write is safe to repeat — if the same day gets
ingested twice, it overwrites rather than duplicates, so nothing breaks if
this fires more than once.

**Two safety nets on top of the 07:00 fire**, so a sleeping laptop or a
container restart never silently loses a day:

- **Hourly catch-up guard** (`:05` past every hour) — if it's past 7am and a
  site's report still hasn't run today, it runs it right then.
- **Startup catch-up** — the moment the container boots (a fresh deploy, a
  crash recovery), it immediately checks "did today's job run yet?" and
  fires it if not.

This whole cycle needs zero AI agents to work — it's the baseline product:
pull numbers, write a summary, email it, log it to a doc.

---

## 3. The weekly cycle — where the AI agents come in

**Thursday, 08:00, site-local time** — a bigger clock fires and runs a chain
of steps, in this order, per site:

1. **Site discovery** — scans what pages exist on the client's website, so
   later steps have a fresh page inventory to work from.
2. **Weekly Google Doc** — writes the week's summary doc.
3. **Competitor SERP check** — pulls real ranking data (only if a paid data
   provider is configured).
4. **Competitor Intelligence agent** — analyzes competitor positioning.
5. **Authority Score agent** — checks backlink strength.
6. **AI Recommendation agent** — checks what ChatGPT recommends for the
   client's niche.
7. **Executive Report agent** — the "manager" (see §5 below) that pulls
   everyone else's findings together into one written briefing.

### Why steps 3–6 don't actually run every week

Some of these calls cost real money (a paid SEO data API, or an OpenAI call
per client). So the system uses a simple rule: **"check every week, but only
actually do the work once a month."** Each of those agents keeps a record of
the last time it *really* ran (in the `agent_runs` table). Every Thursday it
asks "have I done this in the last 30 days?" — if yes, skip; if no, run for
real. This keeps cost predictable without anyone having to manage a separate
schedule for each one.

---

## 4. What "an agent" actually is

Each agent is a small, self-contained worker with one job — e.g.
`query-intelligence` looks at top search queries, `device-intelligence` looks
at mobile vs desktop traffic, `authority` checks backlinks, and so on (11
agents total today).

Every agent follows the same three steps:

1. **Look at real numbers** (from Postgres, or a connected external data
   source).
2. **Decide what matters**, ranked as high/medium/low priority.
3. **Write findings** — plain facts and evidence, never an invented number.

If an agent doesn't have a real data source connected (e.g. no competitor
API key configured yet), it honestly reports "not enough data" instead of
guessing. This is a deliberate rule, not an oversight.

**Adding a new agent is a one-file operation** — drop a new file in
`server/agents/` and it's automatically discovered and runnable. Nothing
else needs to be edited to wire it in.

### The one door every agent run walks through

Whether an agent was triggered by the Thursday cron, or by someone clicking
a button on the dashboard, or by the Executive Report calling it as part of
a bigger briefing — **every single run passes through one function**,
`runAgent()`. That one function is what:

- times how long the run took,
- saves the result to the `agent_runs` table (a permanent history log —
  nothing is ever overwritten, every run is a new row), and
- broadcasts a live "this agent just started / just finished" event, so if
  someone has the dashboard open, they see real activity happening, not a
  simulation.

Because everything funnels through this one place, there's no separate
logic for "automatic" vs "manual" agent runs — it's the same code path.

---

## 5. The Executive Report — the "manager" agent

Most agents look at one slice of data. The Executive Report agent is
different: it doesn't analyze anything itself — it's a manager that:

1. Calls **every other agent at once** (in parallel — it doesn't wait for
   one to finish before starting the next),
2. Collects all of their findings into one list, sorted by priority,
3. Hands that whole list to Claude/OpenAI with one instruction: *"write a
   short, plain-English morning briefing from these real findings, and if
   anything's missing or errored, say so plainly rather than hiding it."*

That's what produces the executive summary a client actually reads.

**This exact "ask everyone, then summarize" logic is shared, not
duplicated** — the AI Copilot chat and the Action Center's refresh button
both call the same underlying function. There's one synthesis brain in this
system, not three separate copies of similar logic.

---

## 6. Two ways an agent run gets triggered — same destination

```
   Thursday cron fires  ──┐
                          │
   Someone clicks         ├──▶  runAgent()  ──▶  saves to agent_runs
   "run this agent" ──────┘                 ──▶  broadcasts live event
   on the dashboard
```

There is no meaningful difference between an automatic run and a manual
one — both call the same function, get logged the same way, and show up the
same way in the live activity feed.

---

## 7. How this actually runs on the VPS

```
VPS (Linux server)
 └── Docker container "analytics-app-prod"   ← ONE process, always running
       ├── serves the dashboard + API
       ├── runs the cron timers (daily/weekly/hourly)
       └── runs agents when triggered
 └── Traefik (in front — handles the domain + HTTPS certificate)
```

- If the container crashes or the VPS reboots, Docker brings it back up
  automatically (`restart: unless-stopped`) — the cron timers just start
  fresh inside the new process, and the startup catch-up (§2) makes sure
  nothing was missed.
- A healthcheck hits `/api/health` every 30 seconds; if it fails repeatedly,
  the container is marked unhealthy so a deploy can catch it before going
  live.

### How new code gets there

```
git push to main
      │
      ▼
GitHub Actions: build + basic checks
      │
      ▼
SSH into the VPS
      │
      ▼
git pull the new code, regenerate .env from GitHub secrets
      │
      ▼
docker compose up -d --build   (rebuilds and restarts the one container)
      │
      ▼
wait for "healthy" status, then verify the live site returns HTTP 200
```

No one manually touches the VPS for a normal release — pushing to `main` is
the entire deploy step.

---

## 8. Quick reference — files to open when you actually need to change something

| What you want to change | File |
|---|---|
| When things run (times, schedules) | `server/cron.js` |
| What the daily/weekly jobs actually do, and the monthly-throttle logic | `server/job.js` |
| The list of agents, and how one gets discovered | `server/agents/registry.js` |
| The one place every agent run passes through (logging, live events) | `server/agents/runner.js` |
| The "ask every agent, then summarize" manager logic | `server/agents/orchestrator.js` |
| A specific agent's own analysis logic | `server/agents/<agent-id>.js` |
| The API routes for triggering/viewing agent runs | `server/routes/agents.js` |
| How the app is packaged into a container | `Dockerfile` |
| How the container is run in production (domain, TLS, restart policy) | `docker-compose.yml` |
| The deploy pipeline itself | `.github/workflows/deploy.yml` |

---

*Note: there's a longer-term idea floating around (an "Always-On AI
Runtime" that would run independently of the dashboard, with its own
scheduler/memory/event queue) — that does **not** exist today. Everything
above describes what's actually running right now.*
