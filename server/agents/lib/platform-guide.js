// Static reference the Copilot draws on for "how do I / where do I find X"
// questions about the dashboard itself, as opposed to questions about a
// site's SEO data (which are answered from real agent findings instead —
// see copilot.js). Kept as one hand-authored block rather than pulled from
// route/component names so the wording stays plain-English and accurate to
// what a user actually sees, not to internal file/route naming.
//
// Admin-only pages are labelled as such so a client-facing answer can
// omit them (the persona prompt already forbids exposing admin machinery;
// this keeps the guide itself honest about who can actually see what).
export const PLATFORM_GUIDE = `
DASHBOARD PAGES (everyone with an account):

- Overview — search performance and visitor analytics summary: clicks, impressions, and traffic trends at a glance. Good first stop for "how's my site doing."
- Insights — a deeper dive into search query movements, device split, and visitor geography (which countries/cities, which devices).
- Compare — week-over-week or month-over-month performance comparison, to see if things are trending up or down.
- Reports — the AI Executive Briefing: a written narrative summary of what happened and why, plus standing recommendations.
- Milestones — real progress since onboarding: a running record of health score, traffic, and other metrics measured against the site's original baseline. This is "how far have we actually come," not a live dashboard.
- Orchestration — the AI Agent Audit Runner. Shows the specialist agents (SEO, GEO/AI-visibility, content, etc.) that scan the site, their live run status, and a synthesized executive summary. Where you'd go to trigger a fresh audit ("Run Audit" button) or watch one in progress.
- Action Center — where AI-found recommendations turn into real fixes. Each finding can be turned into a draft change; drafts are reviewed and approved here before anything ships as a pull request. This is the page for "what should I fix" and "approve this change."
- Settings — account and security: password, connected integrations, notification preferences.

ADMIN-ONLY PAGES (platform_admin staff, managing multiple client sites):

- Clients — manage every client workspace: connect a new client's GSC/GA4/repo, see onboarding/baseline status, and per-client configuration (auto-remediation limits, OAuth policy, etc.).
- Analyst — cross-client analyst workspace for deeper investigation into a specific client's metrics/recommendations.
- Monitoring (Admin -> Monitoring) — system health (DB connectivity, integrations, cron jobs, recent agent failures) and an audit log of admin actions.
- Users & Tokens (Admin -> Users & Tokens) — manage staff/user accounts and API/MCP tokens.
- The client picker at the top of Milestones/Analyst lets an admin switch which client's data they're looking at.

COMMON "HOW DO I" ANSWERS:

- "How do I fix something AI found?" — Go to Action Center, find the recommendation, click to generate a draft, review it, then approve to ship it as a pull request.
- "How do I see why traffic changed?" — Overview or Insights for the numbers; ask the Copilot directly ("Why did traffic drop?") for a narrated explanation grounded in real findings.
- "How do I run a fresh audit?" — Orchestration page, "Run Audit" button.
- "How do I see overall progress since we started?" — Milestones page.
- "How do I connect a new client?" (admin only) — Clients page, "New Client".
- "Where do I see if something's broken on the platform itself?" (admin only) — Monitoring page, System Health tab.

If a question is about something not listed above, say plainly that you're not sure rather than guessing at a feature or page that may not exist.
`.trim();
