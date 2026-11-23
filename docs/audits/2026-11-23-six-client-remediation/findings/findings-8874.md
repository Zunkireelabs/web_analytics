# MOBILISE (site 8874) remediation plan - PLAN ONLY, nothing implemented

Repo: mobilisecloud-admin/mobilise-website-11ty (Eleventy, input `src`, output `_site`, `templateFormats: ['njk']`), domain mobilise.agency, PR target branch `staging`.
Date of investigation: 2026-11-23. Inputs: audit2-8874.txt, maps/map-8874.json (_rev 30), local snapshot repos/mobilise-website-11ty (= origin/main, files dated 2026-11-20), live GET-only checks of mobilise.agency and (read-only GET) dev-web.mobilise.agency.

## 0. Caveat that shapes everything: the snapshot is main, the PR target is staging, and they differ
- Production map has 45 `pages` entries. The main snapshot has files for only 13 of them. The other 32 (`/compare`, `/locations`, `/locations/{dubai,seattle,bangalore,singapore}`, `/case-studies`, 26 `/blog/<slug>` posts) are absent on main, return 404 on mobilise.agency, but return 200 on dev-web.mobilise.agency (staging; its sitemap lists 45 URLs). So staging is ahead of main; those map entries are valid for staging. Do NOT prune them.
- Staging also differs in nginx: dev-web sends `Content-Security-Policy-Report-Only` (a site-specific policy) which main's `nginx/static.conf` does not have. I could not read staging's files. Everything below about main's files is verified; the equivalent on `staging` is needs-verification (re-run the same greps on the staging branch before applying).

## 1. siteRoot.layoutTemplate

### Evidence (every page -> layout), verified in the snapshot
All pages declare JSON front matter with `"layout": "layouts/base.njk"` and a per-page `"headInclude": "heads/<name>.njk"`:

| URL | source file | layout (front matter) | headInclude |
|---|---|---|---|
| / | src/index.njk | layouts/base.njk | heads/index.njk |
| /about-us/ | src/about-us/index.njk | layouts/base.njk | heads/about-us-index.njk |
| /careers/ | src/careers/index.njk | layouts/base.njk | heads/careers-index.njk |
| /services/ | src/services/index.njk | layouts/base.njk | heads/services-index.njk |
| /contact/ | src/contact/index.njk | layouts/base.njk | heads/contact-index.njk |
| /inside/ | src/inside/index.njk | layouts/base.njk | heads/inside-index.njk |
| /blog/ai-influencers-brand-marketing/ | src/blog/ai-influencers-brand-marketing/index.njk | layouts/base.njk | heads/blog-ai-influencers-brand-marketing-index.njk |
| /blog/dark-social-attribution/ | src/blog/dark-social-attribution/index.njk | layouts/base.njk | heads/blog-dark-social-attribution-index.njk |
| (also) /blog/, /blog/all/, /blog/death-of-curiosity-in-marketing/, /terms/, /privacy-policy/, 404, /inside/ht, /contact/option2 | their index.njk | layouts/base.njk | one heads/*.njk each |

13 of 13 content pages + 404 + 2 retired drafts use the same layout. There is exactly one layout file: `src/_includes/layouts/base.njk` (only file in `_includes/layouts`; no other `layout:` value anywhere). Its whole content is:
`{{ documentStart | safe }}<head>{% include headInclude %}</head>{{ headBodyGap | safe }}<body{{ bodyAttributes | safe }}>{{ content | safe }}</body>{{ documentEnd | safe }}`

### The structural catch (why auto-discovery left it unset)
- base.njk contains `<head>` but NOT `<html>`. The `<!DOCTYPE html><html lang="en">` text lives in each page's front-matter field `documentStart`. All real head content (title, meta, canonical, OG, JSON-LD, fonts, `analytics.js`) lives in the per-page partials `src/_includes/heads/*.njk`.
- `discovery/layout-template.js` `looksLikeLayout()` requires both `<html` and `<head`, so zero candidates qualify -> unset. I confirmed base.njk has no `<html` and that cheerio does not see a head element with an end tag in it (the leading `{{ documentStart }}` text makes the parser drop the `<head>` tag), so the engine's `detectHeadRegion` (the self-heal for head markers) also fails on it.
- Therefore the correct value is unambiguous (one shared base layout) but it is a "thin" layout: sitewide fixes that edit `<html>` (html-lang) cannot work on it, and head markers will NOT self-heal in it.

### Exact value
`siteRoot.layoutTemplate = "src/_includes/layouts/base.njk"`
Same path Zunkiree (map-1) uses (`src/_includes/layouts/base.njk`). Zunkiree additionally has `inlineProse`, `globalLinkDataFile`, etc. and a full `defaults.placements` block (faq/schema/meta-title/qa-content/breadcrumbs/expand-content/internal-links/analytics-install, markers FAQ, SCHEMA, TITLE, QACONTENT, BREADCRUMBSCHEMA, EXPANDEDCONTENT, INTERNALLINKS, ANALYTICSSCRIPTGA4, ANALYTICSSCRIPTFACEBOOKPIXEL). MOBILISE has no `defaults` key at all and does not need the content ones: its page files already carry all eight content markers inline (verified on all 13 main page files) and the platform default marker names apply.
If analytics-install is wanted, the only required `defaults.placements` entry is:
`"analytics-install": {"markers": {"analyticsScriptGa4": "ANALYTICSSCRIPTGA4"}}` (add `analyticsScriptFacebookPixel` only if a Meta Pixel is really wanted; none exists on the site today).

### IMPORTANT: analytics-install is probably NOT wanted (decision needed, suggest a DECIDE ticket)
- GA4 is already installed on every page: each head partial starts with `<script defer src="analytics.js">` (relative path per depth; also present on staging pages I fetched: /, /contact/, /compare/, /locations/dubai/, a blog post). `src/assets/analytics.js` loads gtag.js dynamically with consent defaults and a hard-coded `G-` measurement ID.
- The platform's tracker detector (`agents/lib/site-trackers.js`, static HTML regex for `googletagmanager.com/gtag/js?id=G-` or `gtag('config','G-`) sees nothing, because the homepage HTML has 0 occurrences of `googletagmanager` (verified by curl). So trust-compliance will keep recommending "install GA4", and once layoutTemplate + marker exist a human-approved draft would add a SECOND GA4 tag (double-counted pageviews, second consent config).
- So enabling analytics-install creates a duplicate-tracking risk. Options for the lead: (a) recommended: leave layoutTemplate/analytics-install unconfigured and record "analytics N/A - GA4 via analytics.js"; accept the audit's two analytics lines as known false positive; or (b) enable it (below) and never approve a GA4 draft, or fix the detector to recognise `analytics.js`-style loaders (engine ticket).
- Other effects of setting layoutTemplate at all: `resolveNewContentLayout()` makes net-new pages written by frontend.js carry front matter `layout: base.njk` (fallback when no sibling contract). base.njk needs `headInclude`, `documentStart`, etc.; a page without them would break the Eleventy build (`{% include headInclude %}` of undefined). Also all 8 `newContentTargets` write `.md` into `docs/`, which is outside Eleventy's input dir (`src`) and `templateFormats` is only `njk`, so those pages would never be built anyway (needs-verification on staging's eleventy.config.js). If layoutTemplate is set, add `"layout": null` to each newContentTargets entry (diff below) so no `layout: base.njk` is emitted. html-lang drafts would fail honestly (`no-html-tag`); a viewport draft would insert a duplicate viewport meta into base.njk, but all pages already have one so none is generated today.

## 2. The one fatal marker gap

- Audit line: `[open-graph:openGraph] https://mobilise.agency/contact/ -> src/contact/index.njk (expected SEOAI:OPENGRAPH, reason: fatal-no-head-region)`.
- It is an AUDIT FALSE POSITIVE, two stacked causes, nothing is missing in the repo:
  1. The audit resolves the file with `resolveFile(page)` (= page file `src/contact/index.njk`, which has no head), not `resolveActionFile` (which honours the map's `placements.open-graph.file = src/_includes/heads/contact-index.njk`). The real apply path (backend.js computeMarkerMerge) uses `resolveActionFile`, and `src/_includes/heads/contact-index.njk` already contains `<!-- SEOAI:OPENGRAPH:START -->...<!-- SEOAI:OPENGRAPH:END -->` (verified; all 13 head partials on main have CANONICAL + OPENGRAPH markers). So the same blind spot explains the 8 "self-healing" canonical lines: they point at page files, while the real markers are already in the head partials.
  2. Why contact alone stayed fatal: the audit's live OG check (`verifyLiveOpenGraph`) rescued the other 7 pages but not contact. Cause is a regex bug in `extractMetaContent`: `content=["']([^"']*)["']` stops at the first quote of either kind; contact's `og:description` is `content="Let's kickstart your growth marketing with MOBILISE."`, so it extracts `Let` (3 chars) and `looksLikeOgPlaceholder` (<4 chars) rejects it. I reproduced this with the exact regex (result: `Let`). Live page has correct og:title/og:description (verified by curl).
- Fix: automated = none needed on the site (no insertion). Do NOT edit the contact head partial. Engine follow-up ticket (not in this plan's scope to implement): (a) `audit-url-file-map.js` should use `resolveActionFile(site, page, actionType)` per action type; (b) `extractMetaContent` should capture with the opening quote type (`content="([^"]*)"|content='([^']*)'`). Optional cosmetic workaround on the site: none recommended (changing content to satisfy an audit).
- Expect the contact page's OG draft to apply fine at approval time (marker present in heads/contact-index.njk).

## 3. nginx security-headers marker

Files read: `nginx/static.conf` (single `server { listen 80; ... }`, behind Traefik), `Dockerfile` (copies it to `/etc/nginx/conf.d/default.conf`), docker-compose.prod/staging (Traefik labels; staging adds `X-Robots-Tag` via middleware), `generators/security-headers.js`, `implementers/lib/hash-marker-merge.js`, `backend.js computeSecurityHeadersMerge`.

- Current live headers on prod (curl -I): `x-content-type-options: nosniff`, `referrer-policy: strict-origin-when-cross-origin`, cache-control. Missing: X-Frame-Options, Strict-Transport-Security, Content-Security-Policy(-Report-Only). (The generator uses `missingHeaders` from the agent; the fallback of ALL keys would re-emit nosniff/referrer-policy - nginx does not de-duplicate repeated add_header, so only the genuinely missing keys should be drafted. needs-verification that the agent passes `missingHeaders`.)
- The generator never chooses a location; it fills a human/engine-placed `# SEOAI:SECURITY-HEADERS:START/END` pair. Note: the audit's wording "must be hand-placed" is stale. Committed code (#243, `ensureHashMarker` in hash-marker-merge.js, used by backend.js:210) auto-inserts the pair immediately after the opening line of the serving `server {` block at apply time, and refuses with `headers-not-inherited` if any location sets its own `add_header`. On main there are none (comment in the file says add_header lives at server level only), so auto-placement works. Hand-placing is therefore optional, for readability/determinism.
- Proposed exact insertion (hand-placed), in the one `server {}` block, directly after the existing server-level headers (NOT inside any `location`, because a location with its own add_header drops inherited ones):

```
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header Cache-Control $cache_control;

    # SEOAI:SECURITY-HEADERS:START
    # SEOAI:SECURITY-HEADERS:END

    gzip on;
```
- Lines the generator would later put between the markers (for the 3 currently missing headers):
```
add_header X-Frame-Options "SAMEORIGIN" always;
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
add_header Content-Security-Policy-Report-Only "default-src 'self'; report-uri /csp-report" always;
```
- The empty marker pair is inert (comments only; nginx ignores it). Cautions: (1) the generic CSP-Report-Only is far narrower than this site needs (Google Fonts, gtag, Apps Script form posts) and `/csp-report` has no handler (it would 404 reports, harmless but useless); staging already has a custom CSP-Report-Only, so on staging a second CSP-Report-Only line would duplicate/conflict - edit the draft before approval. (2) HSTS: confirm Traefik is not already adding it (prod curl shows none) and that all subdomains incl. dev-web are https-only before approving. (3) SAMEORIGIN is safe unless the site is meant to be framed (none seen). (4) Verify the staging branch's static.conf (it differs, see section 0) before relying on any of this; needs-verification.
- Effect: response headers only; no HTML/layout/routing/content change. PR targets `staging`; the Docker image rebuilds on merge.

## 4. The 9 redirect/404 URLs (live GET-only checks, 2026-11-23). Audit format is `status -> redirect-target  probed-url`

| # | Probed URL | Live (prod) | Cause | Mapping action |
|---|---|---|---|---|
| 1 | /inside-mobilise/ | 301 -> /inside/ | nginx legacy rule `location ~ ^/inside-mobilise` | none; target `/inside` already mapped |
| 2 | /blog/?post=death-of-curiosity-in-marketing | 301 -> /blog/death-of-curiosity-in-marketing/ | nginx `$arg_post` rule | none; static post mapped (exact entry + blog pattern) |
| 3 | /about-us/careers-all/group-account-manager/ | 404 (also 404 on staging) | old job page, no source file, no nginx rule | none to create; optional separate decision: redirect-add -> /careers/ |
| 4 | /blog/?post=dark-social-attribution | 301 -> /blog/dark-social-attribution/ | nginx rule | none; mapped |
| 5 | /locations/bangalore/ | 404 on prod, 200 on staging | page exists only on staging (not yet on main/prod) | none; already in map (exact entry + placements); becomes real on promotion |
| 6 | /blog/?view=all | 301 -> /blog/all/ | nginx rule | none; `/blog/all` mapped |
| 7 | /locations/seattle/ | 404 prod, 200 staging | same as 5 | none; already mapped |
| 8 | /blog/b2b-buyers-ai-search-vendor-shortlists/ | 404 prod, 200 staging | post only on staging | none; already mapped |
| 9 | http://mobilise.agency/ | 301 (audit saw 308) -> https://mobilise.agency/ | protocol redirect (Traefik) | none |

No mapping needs to be created. No real live page lacks a mapping: all 13 pages in the prod sitemap (/, /services/, /about-us/, /inside/, /blog/all/, /blog/death-of-curiosity-in-marketing/, /blog/, /blog/dark-social-attribution/, /blog/ai-influencers-brand-marketing/, /careers/, /contact/, /privacy-policy/, /terms/) have a map entry and an existing file.

### How the blog is actually built (corrects the premise)
Posts are NOT served through a query string. Each post is a static Eleventy page `src/blog/<slug>/index.njk` (permalink `/blog/<slug>/index.html`) with its own head partial `heads/blog-<slug>-index.njk`; `/blog/` is itself the "four-day week" article and `/blog/all/` is the archive. The `?post=` / `?view=all` URLs are legacy Google-indexed URLs that nginx 301s to the static URLs (unknown `?post=` -> real 404). GSC still lists the old URLs, which is why they appear in the audit.
Coverage: pattern `^/blog/([^/]+)/?$ -> src/blog/$1/index.njk` is correct for every post, and all 31 `/blog/<slug>` entries are also explicit page entries with `placements.canonical/open-graph.file = src/_includes/heads/blog-<slug>-index.njk` (naming verified consistent for all of them). Only gap: the two patterns carry no `placements`, so a post matched only by the pattern (new, not yet an exact entry) would resolve canonical/open-graph to the page file (no head, would be fatal-no-head-region). Optional hardening diff below. Note `/blog/all` and `/blog` stay exact entries (take precedence over the pattern).

## 5. Proposed config changes - exact JSON diffs against maps/map-8874.json (all optional/conditional; none applied)

A. Minimal "set layoutTemplate" (only if the lead chooses to; see the analytics duplicate-tracking warning in section 1):
```diff
   "siteRoot": {
     "llmsTxt": "src/assets/llms.txt",
     "sitemap": "src/assets/sitemap.xml",
     "robotsTxt": "src/assets/robots.txt",
-    "nginxConfig": "nginx/static.conf",
+    "nginxConfig": "nginx/static.conf",
+    "layoutTemplate": "src/_includes/layouts/base.njk",
     "designProfile": { ... unchanged ... },
```
B. Only if analytics-install is wanted (adds a top-level `defaults`; the file has none today):
```diff
 {
   "_rev": 30,
   "pages": { ... },
   "patterns": [ ... ],
+  "defaults": {
+    "placements": {
+      "analytics-install": { "markers": { "analyticsScriptGa4": "ANALYTICSSCRIPTGA4" } }
+    }
+  },
   "siteRoot": { ... },
```
plus a one-time manual edit in the repo (head marker will not self-heal, see section 1), `src/_includes/layouts/base.njk`, change to:
`{{ documentStart | safe }}<head>{% include headInclude %}<!-- SEOAI:ANALYTICSSCRIPTGA4:START --><!-- SEOAI:ANALYTICSSCRIPTGA4:END --></head>{{ headBodyGap | safe }}<body...` (marker after the include so charset/viewport stay first; empty pair renders as two HTML comments in every page's head, incl. 404/ht/option2; no visual effect). Do not approve a GA4 draft while analytics.js is in place.

C. If A is applied, stop net-new pages from inheriting `layout: base.njk` (repeat for each of the 8 keys: translation, blog-outline, landing-page, cookie-policy, direct-answer, privacy-policy, terms-of-service, missing-page-create):
```diff
     "blog-outline": {
       "dir": "docs",
-      "extension": ".md"
+      "extension": ".md",
+      "layout": null
     },
```
D. Optional hardening so pattern-matched (not exact-entry) pages resolve head markers correctly:
```diff
   "patterns": [
     {
       "file": "src/blog/$1/index.njk",
-      "match": "^/blog/([^/]+)/?$"
+      "match": "^/blog/([^/]+)/?$",
+      "placements": {
+        "canonical": { "file": "src/_includes/heads/blog-$1-index.njk" },
+        "open-graph": { "file": "src/_includes/heads/blog-$1-index.njk" }
+      }
     },
     {
       "file": "src/locations/$1/index.njk",
-      "match": "^/locations/([^/]+)/?$"
+      "match": "^/locations/([^/]+)/?$",
+      "placements": {
+        "canonical": { "file": "src/_includes/heads/location-$1-index.njk" },
+        "open-graph": { "file": "src/_includes/heads/location-$1-index.njk" }
+      }
     }
   ],
```
(The `$1` fill is supported by `resolvePlacementFile`. Location partial naming `location-<slug>-index.njk` taken from the map's own placements; files themselves unverified because they exist only on staging.)

## 6. Effects per change
| Change | Layout/styling | Content | Scripts | Routing |
|---|---|---|---|---|
| No site edit for the OG "fatal" (section 2) | none | none | none | none |
| nginx marker pair (section 3) | none | none | none | none; headers only once a draft is approved (X-Frame-Options/HSTS/CSP-RO) |
| A layoutTemplate | none by itself | none; new pages (if any) would get `layout: base.njk` unless C | none | none |
| B + base.njk marker | none (two HTML comments per page) | none | second GA4 tag if a GA4 draft is ever approved (double counting) | none |
| C newContentTargets layout:null | none | none | none | none |
| D pattern placements | none | none | none | none (config-only; affects which file a future canonical/OG draft edits) |

## 7. Unverified / needs-verification
- Staging branch contents (base.njk, heads, nginx/static.conf, eleventy.config.js, which of the 32 extra pages use base.njk): not read; live staging heads have the same shape (analytics.js first, per-page head) so base.njk is very likely shared, but not proven.
- Whether the security-headers agent passes `missingHeaders` (else duplicate nosniff/referrer lines).
- Whether Traefik adds HSTS in production.
- `detectHeadRegion`/`verifyLayoutFile` results were derived by running cheerio and regex checks directly (importing the engine modules requires DATABASE_URL, which I did not set); behaviour matches the code reading.
- docs/*.md newContentTargets being unbuildable (needs-verification against staging eleventy.config.js).
