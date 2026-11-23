# Site 8871 (SuperRank marketing site, superrank-web, Astro, superrank.si) — remediation plan

Source: investigator report (read-only), saved verbatim in substance by the lead. Caveat: repo snapshot is local origin/main (2026-11-23), may be slightly stale vs GitHub (needs-verification before any PR). Map: map-8871.json (_rev 26). Audit: audit2-8871.txt.

## 0. Bottom line
| Item | Verdict |
|---|---|
| 81 self-healing items | All `canonical`: 27 `.astro` pages + 54 blog `.md`. Technically safe but redundant (Layout.astro already emits canonical on every page). Recommend dismissing, not applying. |
| Analytics head region | Root cause found and reproduced. Fix is a one-line inert comment pair. BUT the site already has consent-gated GA4, so an analytics-install PR would add a second, un-gated tag. Recommend dismissing that recommendation rather than fixing the marker. |
| Nginx marker | Audit wording is stale: the engine auto-creates the marker. Real blockers: nginx header inheritance (`headers-not-inherited`) and all 5 generated headers already live. Recommend no marker and no security-headers draft. |
| Map change | None required. |

## 1. Analytics head-region problem
### Why detectHeadRegion fails
- `detectHeadRegion` (server/implementers/lib/structural-detect.js:583) runs cheerio (HTML5 parser) over the raw .astro file and needs a `<head>` node with a real end tag.
- Layout.astro has a literal `<head>...</head>`, not built from a slot. Reproduced with cheerio on the snapshot: 1 head found, 0 with an end tag.
- Cause: the first non-plain-HTML line inside `<head>` (head line 5): `{noindex ? <meta name="robots" content="noindex"> : <meta ...>}`. In HTML5 "in head" mode, non-whitespace text (`{noindex ? `) acts as an implied `</head>`; the real `</head>` is ignored. `{!noindex && <link ...>}`, `{graph.length > 0 && <script ...>}` and `<slot name="head" />` do the same.
- Experiments: as-is → 0 heads with end tag; frontmatter stripped → still 0; removing any single head line → still 0 (several offenders); truncating before first expression or replacing expression/slot lines with comments → 1. Confirms cause.
- `classifyMarkerGap` (marker-merge.js:334) tests `blockRegex('HEAD')` BEFORE detection, so a literal HEAD region returns `self-heals`; `insertHeadScopedMarker` nests `SEOAI:ANALYTICSSCRIPTGA4` inside it at apply time.

### Safest change (src/layouts/Layout.astro, one line, no map change)
```
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- SEOAI:HEAD:START --><!-- SEOAI:HEAD:END -->
<title>{title}</title>
```
- Astro keeps template HTML comments (live homepage already emits existing comments). Adds ~52 bytes of two empty comments per page head. Layout, styling, scripts, routing unchanged.
- Do NOT use the JSX `{/* */}` form: `.astro` is not treated as JSX (`isJsxFile` false) so it would not be recognized.

### Do not enable analytics-install here
- src/scripts/cookie-consent.js already loads GA4 (GA_ID G-7V8PXXZF3G, public) only after cookie-banner acceptance; PostHog loaded separately.
- Tracker detection scans fetched HTML (no GA tag before consent) → likely false "GA4 missing" recommendation (needs-verification, detector not run).
- An applied draft would splice an always-on GA4 script into head: loads GA before consent (privacy/legal risk), may double count.
- Recommendation: dismiss with reason "GA4 already installed behind cookie consent". Add the HEAD marker only if another head-scoped field is later wanted. Platform-managed GA4 would first need a consent-gating decision (manual product decision).

## 2. Nginx marker
- nginx/static.conf is the only nginx config (Dockerfile copies to conf.d/default.conf in nginx:alpine); one `server {}` block.
- Marker format: `# SEOAI:SECURITY-HEADERS:START` / `# SEOAI:SECURITY-HEADERS:END` on their own lines.
- Audit text "must be hand-placed" is stale: `computeSecurityHeadersMerge` (backend.js ~200) calls `ensureHashMarker`, which auto-inserts the pair into the serving server block. After auto-insert, `locationsDroppingServerHeaders` REFUSES with `headers-not-inherited` if any location sets its own `add_header`. This file has three (`~* \.(js|css|...)$`, `~* \.html$`, `~* (sitemap\.xml|robots\.txt)$`), so auto-insert always fails; a pre-placed marker bypasses that check.
- If a human places it (after the existing server-level header lines):
```
    add_header Referrer-Policy "strict-origin-when-cross-origin";
    # SEOAI:SECURITY-HEADERS:START
    # SEOAI:SECURITY-HEADERS:END

    # Gzip compression
```
  Marker is inert; only locations without their own add_header (e.g. `location /`) inherit server-level headers.
- Generator (generators/security-headers.js) later emits, with `always`: X-Frame-Options SAMEORIGIN, X-Content-Type-Options nosniff, Referrer-Policy strict-origin-when-cross-origin, HSTS `max-age=31536000; includeSubDomains`, CSP-Report-Only `default-src 'self'; report-uri /csp-report`. Emits only missing ones, but falls back to ALL five when the missing list is empty.
- Live HEAD check: enforcing CSP, X-Frame-Options, X-Content-Type-Options, HSTS, Referrer-Policy, X-XSS-Protection all already present. Nothing to add.
- Risks if a draft were applied: duplicate same-name headers; HSTS sent twice with different values (added `includeSubDomains` is a real change that could affect other *.superrank.si hosts such as app.superrank.si); second Report-Only CSP pointing to non-existent `/csp-report` (existing enforced CSP is tuned for GA, PostHog, Google Fonts and must never be replaced); generated block wouldn't reach the `.html` location anyway.
- Recommendation: no marker, no security-headers draft; treat the audit flag as not applicable (needs-verification whether a security-headers finding is raised at all).

## 3. The 81 self-healing items
- All `canonical:canonical`: 27 `src/pages/**/*.astro` + 54 `src/content/blog/*.md`. Blog `.md` reached via map pattern `^/blog/([^/]+)/?$` → `src/content/blog/$1.md`.
- Self-heal path: no HEAD region and no detectable head → front-matter fallback adds `canonicalUrl:` key.
  - Blog `.md`: content.config.ts schema is non-strict `z.object`; unknown key stripped, build doesn't fail; inert (Layout and [slug].astro don't read it).
  - `.astro` pages: `---` fence is JS so `canonicalUrl:` would parse as a JS label — inert junk. needs-verification: `ensureMarkers` not run; check what it writes and that the build passes before approving any PR.
- Redundant: Layout.astro already emits canonical, hreflang, og:url on every non-noindex page → mark canonical recommendations resolved.
- Unsafe page types to keep out: noindex / `chrome=false` pages (e.g. /login; none in the 81); `src/product-pages/*.html` fragments (not mapped).

## 4. Classification
| Change | Class | Layout/styling | Content | Scripts | Routing |
|---|---|---|---|---|---|
| Layout.astro HEAD pair | Manual review, tiny low risk | none | none | none | none |
| analytics-install via marker | Manual decision, recommend decline | none | none | adds ungated GA4 (consent conflict) | none |
| Nginx marker | Manual review, recommend skip | none | none | none | none now; later generated headers risk duplicates/HSTS change |
| 81 canonical self-heals | Automated-safe, redundant, recommend dismiss | none | none | none | none (.astro label line needs-verification) |

Map diff: none. `siteRoot.layoutTemplate` = src/layouts/Layout.astro, `nginxConfig` = nginx/static.conf, no `defaults`; default field `analyticsScriptGa4` → `ANALYTICSSCRIPTGA4` matches audit.

Suggested Plane tickets (SRANK; search for duplicates first): (1) optional Layout.astro HEAD pair (human OK to push/merge); (2) dismiss analytics-install + security-headers recommendations for 8871 with reasons; (3) DECIDE: should platform-managed GA4 ever replace cookie-consent.js; (4) fix stale audit wording ("must be hand-placed" is wrong; real failure is headers-not-inherited).

## needs-verification
Snapshot may lag GitHub main; false GA4-missing detection not run; `ensureMarkers` output on .astro frontmatter not run; whether security-headers finding is raised at all; no browser render check (comment retention confirmed from live homepage HTML only).
