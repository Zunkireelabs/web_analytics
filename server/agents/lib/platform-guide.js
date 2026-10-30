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
DASHBOARD PAGES (everyone with an account, each one for their own project):

- Overview — search performance and visitor analytics summary: clicks, impressions, and traffic trends at a glance. Good first stop for "how's my site doing."
- Workspace — the project itself: its goals, the people with access, API tokens, monitoring and settings.

Performance:
- Insights — a deeper dive into search query movements, device split, and where visitors come from (countries, devices), including the geographic audience.
- AI visibility — how often AI engines such as ChatGPT recommend the brand when buyers ask, with the GEO score.
- Keywords — the searches the site can win next: keywords close to page one, content gaps, "grow a keyword" to queue a target keyword, and the topics and products the site covers.
- Competitors — who the site is up against: the competitor leaderboard, referring domains and authority, and how backlinks and rankings compare.
- Compare — week-over-week or month-over-month performance comparison, to see if things are trending up or down.
- Reports — a Baseline report (where the site stood when it first landed: the issues and security findings from the first full audit, and how it has moved since), then Weekly and Monthly reports. There is no daily report.

Optimize:
- Action Center — where AI-found issues turn into real fixes. Each finding can be turned into a draft change; drafts are reviewed and approved here before anything ships as a pull request. This is the page for "what should I fix" and "approve this change."
- Content — the blog posts, landing pages, translations and expanded copy the agent drafts. Same review-then-approve flow as the Action Center, kept separate from the fixes.
- Analyst — an AI briefing on where the site is headed: the growth outlook, what is declining and why, and the recommended fix for each, with "Send to Action Center."
- Agents — the AI agent runner. Shows the specialist agents (SEO, GEO/AI-visibility, content, etc.) that scan the site, their live run status, and a synthesized executive summary. Where you'd go to trigger a fresh audit ("Run audit" button) or watch agents work.
- Demand — only for product sites.

ADMIN-ONLY PAGES (platform_admin staff, managing multiple client sites):

- Clients — manage every client workspace: connect a new client's GSC/GA4/repo, see onboarding/baseline status, and per-client configuration (auto-remediation limits, OAuth policy, etc.).
- Monitoring (Admin -> Monitoring) — system health (DB connectivity, integrations, cron jobs, recent agent failures) and an audit log of admin actions.
- Users & Tokens (Admin -> Users & Tokens) — manage staff/user accounts and API/MCP tokens.
- A platform admin looks at a client's pages (Analyst, Reports, Keywords and the rest) by switching into that client's project with the project switcher at the top of the sidebar.

COMMON "HOW DO I" ANSWERS:

- "How do I fix something AI found?" — Go to Action Center, find the recommendation, click to generate a draft, review it, then approve to ship it as a pull request.
- "How do I get a blog post written?" — Content page, or add the keyword on the Keywords page ("Grow a keyword") and choose to write a blog on it.
- "How do I see why traffic changed?" — Overview or Insights for the numbers; the Analyst page for what the AI found; or ask the Copilot directly ("Why did traffic drop?") for a narrated explanation grounded in real findings.
- "How do I run a fresh audit?" — Agents page, "Run audit" button.
- "How do I see overall progress since we started?" — Reports page, Baseline tab, then the Weekly and Monthly tabs.
- "How do I see who I'm up against?" — Competitors page.
- "How do I connect a new client?" (admin only) — Clients page, "New Client".
- "Where do I see if something's broken on the platform itself?" (admin only) — Monitoring page, System Health tab.

If a question is about something not listed above, say plainly that you're not sure rather than guessing at a feature or page that may not exist.
`.trim();
