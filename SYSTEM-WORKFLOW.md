# How This System Works — Quick Reference

A simple, software-terms walkthrough of how the analytics app and its automated jobs run. Use this to explain the system to your head or teammates without diving into the codebase.

## 1. The system, in one picture

```
┌────────────────────────────────────────────────────────────┐
│                     OUR SERVER (runs 24/7)                   │
│                                                                │
│   ┌──────────────┐        ┌──────────────────────────┐       │
│   │   Web App     │◀──────▶│      Database             │       │
│   │ (dashboard +  │        │  (stores all client data, │       │
│   │  API)         │        │   one row per site)        │       │
│   └──────┬───────┘        └──────────────────────────┘       │
│          │                                                    │
│          │  also runs a built-in                              │
│          │  SCHEDULER (like a timer)                          │
│          ▼                                                    │
│   "At 7am every day, and every Thursday, do X"                │
│                                                                │
└─────────┬──────────────────────────────┬─────────────────────┘
          │                              │
          ▼                              ▼
┌──────────────────┐          ┌──────────────────────┐
│  Google APIs       │          │   AI (ChatGPT/Claude)  │
│  (traffic data)     │          │   (writes summaries)    │
└──────────────────┘          └──────────────────────┘
```

**Say it as:** "One server, one database, one app. It has a timer built into it — no separate machine, no extra moving parts."

## 2. The daily job (a scheduled background task)

```
TRIGGER: scheduler fires at 7:00 AM
   │
   ▼
FOR EACH client site in the database:
   │
   ├─ 1. Call Google's API → pull yesterday's traffic numbers
   ├─ 2. Save numbers to the database
   ├─ 3. Call the AI → "summarize this in plain English"
   ├─ 4. IF not already emailed today → send email
   └─ 5. IF not already logged today → write to report doc
   │
   ▼
DONE — repeats automatically tomorrow, no human involved
```

**Say it as:** "It's a background job — same idea as a nightly backup job, just running a report instead."

## 3. The AI agents (specialist background jobs, once a week)

```
TRIGGER: scheduler fires every Thursday
   │
   ▼
RUN 9 independent checks in parallel:
   [rankings]  [competitors]  [tech health]  [AI visibility]  ...
        │            │              │              │
        └────────────┴──────┬───────┴──────────────┘
                             ▼
                  combine all results
                             ▼
                  one AI call writes the
                  final combined summary
                             ▼
                  saved as a doc + shown
                  on the internal dashboard
```

**Say it as:** "Each agent is just a small function that checks one thing and returns a result — 'good', 'needs attention', or 'no data yet'. Nothing is invented; if a data source isn't connected, it says so instead of guessing."

## The one-liner if they only remember one thing

> "It's a normal web app with a database — the only special part is it has a timer that runs a set of checks automatically, instead of waiting for someone to click a button."
