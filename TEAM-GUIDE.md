# 📊 Website Analytics — Team Guide

A simple guide for everyone on the team. **No technical knowledge needed.**

---

## What is this?

Every day, a small automated "agent" looks at our website's performance in
**Google Search Console** (how we show up in Google search) and **Google Analytics 4**
(how people use the site). It saves those numbers, writes a short plain-English summary,
emails it out each morning, and shows everything on a **dashboard** you can open in your browser.

Before this, the numbers were only checked **once a week, by hand**. Now they're tracked
**every single day, automatically** — so we can see how the site grows day by day.

---

## How do I open the dashboard?

1. Go to the dashboard link: **https://analytics.zunkireelabs.com** *(your real link may differ)*
2. Log in with the email and password you were given by whoever set up your access.
3. You're in. 🎉

---

## What am I looking at?

### The top row — "KPI cards"
Six big numbers for the selected day, each with a small ▲/▼ showing the change vs the day before:

| Card | What it means |
|------|----------------|
| **Clicks** | How many people clicked our site in Google search results |
| **Impressions** | How many times we *showed up* in Google search (even if not clicked) |
| **Avg position** | Our average ranking in Google. **Lower is better** (position 3 beats position 10) |
| **Users** | How many people visited the site |
| **Sessions** | How many visits there were (one person can have several) |
| **Conversions** | Goal completions (e.g. a booking/lead), if set up in GA4 |

🟢 Green = improved · 🔴 Red = dropped.

### The "AI Daily Summary" box
A few sentences, written automatically, explaining how the day went in plain English —
e.g. *"Traffic rose 12% vs yesterday, mostly from the query 'cheap flights to Goa'."*

### The charts
- **Search: clicks & impressions** — the trend over your selected date range.
- **Audience: users & sessions** — visitor trend over the same range.
- **Top queries** — the Google searches bringing people to us.
- **Top pages** — our most-visited pages.
- **Traffic by channel** — where visitors came from (Organic Search, Direct, Referral, etc.).

### The "Compare" tab
Compare any two months side by side (e.g. **last month vs this month**) with % changes.
This gets useful once we have **two full months** of data.

---

## A couple of things that are normal (not bugs)

- **Search (GSC) data is ~3 days behind.** Google itself takes 2–3 days to finalize search
  numbers, so the most recent fully-accurate "Search day" is about 3 days ago. This is the
  same delay you see inside Google Search Console — not a fault in our tool.
- **Visitor (GA4) data is almost live** — usually complete by the next day.
- That's why the dashboard defaults the "report day" to a few days back: so the numbers shown
  are final and trustworthy.

---

## The morning email

Each morning an email goes out with the day's key numbers and the AI summary, so you can
glance at it without opening the dashboard. The dashboard always has the full picture and history.

---

## Who to ask

For access, your login credentials, or questions about the numbers, contact the person who
maintains this tool (see `README.md` for the technical setup).
