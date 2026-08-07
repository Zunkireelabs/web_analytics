# Agents

Two different meanings of "agent" in this project. Section A is almost certainly what you're asking about — the AI Growth Platform's own agents that run scans and produce findings. Section B is a separate thing: Claude Code's own helper agents (used only when I'm working in this session, not part of the product).

---

## A. AI Growth Platform agents & generators (the product's own agents)

Two auto-discovery registries — drop a correctly-shaped file in the folder and it's picked up automatically, no manual wiring needed.

- **16 agents** (`server/agents/*.js`, `server/agents/registry.js`) — find problems/opportunities, write "findings"
- **10 generators** (`server/generators/*.js`, `server/generators/registry.js`) — turn a finding into an implementable content draft, run by the Action Center

**16 + 10 = 26 total modules**, but only 16 are "running" on a schedule in the sense of "agent runs" — generators only fire on demand when a finding is turned into a draft.

### A.1 Agents — 16 total (`server/agents/`)

| # | Name | id | Purpose | Cadence / Gating |
|---|---|---|---|---|
| 1 | Query Intelligence | `query-intelligence` | Search queries driving/dragging organic performance | Daily |
| 2 | Opportunity | `opportunity` | Striking-distance queries/pages worth optimizing | Daily |
| 3 | Device Intelligence | `device-intelligence` | Device-split performance, low-CTR devices | Daily |
| 4 | Country Intelligence | `country-intelligence` | Growing/declining markets, localization gaps | Daily |
| 5 | AI Visibility | `ai-visibility` | Scores pages' readiness to be cited by AI answer engines | Daily; citation/SERP-AI-Overview dimension always `insufficient-data` (no provider connected yet, deliberate no-fabrication) |
| 6 | Technical SEO | `technical-seo` | Google index status, Core Web Vitals, broken links, sitemap issues | Daily; CWV checks skipped without `PAGESPEED_API_KEY` |
| 7 | Security Headers | `security-headers` | Checks live HTTP headers (HSTS, CSP, X-Content-Type-Options, etc.) | Daily; no external dependency |
| 8 | Internal Linking | `internal-linking` | Pages with too few outbound internal links vs. site average | Daily |
| 9 | Duplicate Content | `duplicate-content` | Byte-identical content reachable at two URLs | Daily |
| 10 | Accessibility | `accessibility` | Missing labels, duplicate IDs, heading skips, missing `lang` | Daily |
| 11 | Mobile Usability | `mobile-usability` | Missing/broken viewport meta, pinch-zoom blockers | Daily |
| 12 | Competitor Intelligence | `competitor-intelligence` | Identifies + compares competitors, enriches with Common Crawl | Monthly; LLM-only fallback without `DATAFORSEO_LOGIN`/`PASSWORD` — see [[project_competitor-serp-basis-pending]] |
| 13 | Authority | `authority` | Proprietary 0–100 backlink Authority Score | Monthly; falls back to coarser Common Crawl-only estimate without DataForSEO creds |
| 14 | AI Recommendation | `ai-recommendation` | Tests whether ChatGPT actually recommends the company for real buyer prompts | Monthly; **double-gated**: needs `OPENAI_API_KEY` **and** `AI_RECOMMENDATION_ENABLED=true` |
| 15 | Content Gap | `content-gap` | On-page completeness gaps vs. competitors | On-demand + Executive Report only — not in daily/weekly cron |
| 16 | Executive Report | `executive-report` | Meta-agent: synthesizes all others into one growth summary | Weekly (after monthly-throttled agents run) |

Scheduling source of truth: `server/job.js` (`MONTHLY_AGENT_IDS`) and `server/agents/lib/insights.js` (`RECOMMENDATION_AGENT_IDS`, the master 15-id list excluding `executive-report`).

### A.2 Generators — 10 total (`server/generators/`)

| # | Name | id | Purpose |
|---|---|---|---|
| 1 | Blog Outline | `blog-outline` | Outline for a topic the site doesn't cover, with internal-link suggestions |
| 2 | FAQ | `faq` | FAQ section + FAQPage schema |
| 3 | HTML Lang Attribute | `html-lang` | Drafts missing `<html lang="...">` on the shared layout — see [[project_security-headers-html-lang-generators]] |
| 4 | Internal Links | `internal-links` | Internal-link suggestions from real page text |
| 5 | Landing Page | `landing-page` | Landing-page structure for a growing market/topic |
| 6 | llms.txt & AI-Crawler Robots.txt | `llms-txt` | Site-wide `llms.txt` + AI-crawler robots.txt directives — see [[project_llms-txt-duplicate-finding-fix]] |
| 7 | Meta Title & Description | `meta-title` | Title tag + meta description draft |
| 8 | Schema Markup | `schema` | JSON-LD structured data from verifiable page content only |
| 9 | Security Headers | `security-headers` | nginx security-headers block for exactly the missing headers — see [[project_security-headers-html-lang-generators]] (same id as agent #7 above, distinct module/registry: agent finds the problem, generator drafts the fix) |
| 10 | Translation | `translation` | Translates title/meta/key content into a target language |

None of the generators are flag-gated; all always-on, invoked on demand from Action Center findings.

**Required setup before a site's drafts can actually apply as PRs**: see the **action-center-onboarding** skill for the full runbook (repo connect, the shared layout's HEAD region, the nginx security-headers marker, per-provider analytics markers, adapter data completeness). Short version: `npm run connect-repo -- --site-id <id> --repo-owner ... --repo-name ... --url-file-map path.json` (migration 028) now auto-runs `npm run audit-url-file-map -- --site-id <id>` immediately afterward (migration 088) and persists the result, surfaced in Integration Health for "GitHub (Action Center)" — so a stuck-draft class of failure is caught at onboarding time, not discovered later when an already-approved draft fails to push.

### A.3 Related, but not agents in the framework sense

- **Common Crawl ETL** — `server/scripts/refresh-commoncrawl-graph.js`. Standalone, manually-run pipeline (no `meta`/`run()` contract, not in `server/agents/`). Feeds free fallback backlink data to Authority + Competitor Intelligence. See [[project_commoncrawl-etl-pending]] — still needs a re-run against staging/prod's own DB.
- **Orchestrator / Runner / Registry** (`server/agents/orchestrator.js`, `runner.js`, `registry.js`) — infrastructure, not agents.
- **Command Center / Action Center / Copilot / Watchlist** (`server/agents/lib/`) — consumers of agent output, not agents themselves.

### A.4 Gating summary

Only `ai-recommendation` uses the "dedicated opt-in flag" pattern (needs both an API key and a separate enable flag — see [[project_authority-ai-recommendation-agents]]). `authority`, `competitor-intelligence`, and `technical-seo` degrade gracefully instead of being disabled outright when their optional provider credentials are missing.

Every `*_ENABLED`/`ENABLE_*` flag is checked in CI (`.github/workflows/ci.yml` → `npm run check-env-parity`, `server/scripts/check-env-parity.js`) against `.env.example` and both deploy workflows' env blocks. It fails the build only if a flag is referenced in code but set NOWHERE (the "feature can never turn on" case — this is what happened with `ENABLE_CONTENT_CITATION_SEARCH` missing from `deploy-staging.yml`); a flag differing between staging and prod is printed as an informational note, not a failure, since staged rollouts are legitimate.

---

## B. Claude Code session agents (not part of the product — my own tooling)

These are only relevant to how I (Claude Code) work in this session; they don't run in your app.

### Project-defined (`.claude/agents/`)
- **SEO Specialist** — technical SEO audits, keyword strategy, cannibalization checks, link building. Tools: WebFetch, WebSearch, Read, Write, Edit.
- **AEO Foundations Architect** — AI-crawler discoverability/parsability infrastructure (robots.txt, llms.txt, token budgets). Tools: all.

### Built-in
- **general-purpose** — multi-step research/search tasks. Tools: all.
- **Explore** — fast read-only code search. Tools: all except Agent/Artifact/ExitPlanMode/Edit/Write/NotebookEdit.
- **Plan** — implementation planning. Same tool restrictions as Explore.
- **claude-code-guide** — questions about Claude Code/Agent SDK/API. Tools: Bash, Read, WebFetch, WebSearch.
- **statusline-setup** — configures the status line. Tools: Read, Edit.
- **claude** — catch-all default. Tools: all.
