---
name: action-center-onboarding
description: Runbook for connecting a site's real GitHub repo to the Action Center (server/implementers/, server/generators/) so approved drafts can apply as real PRs. Covers every prerequisite discovered the hard way on zunkireelabs-web — url_file_map, renderCapabilities, the shared layout's HEAD region, the nginx security-headers marker, per-provider analytics markers, and adapter data completeness — so a new repo (or this one, re-verified) doesn't repeat the same class of stuck-draft failure. Documentation only; does not implement or change any code.
---

# Action Center Onboarding — Connecting a Site's Repo

This is the runbook the **client-onboarding** skill explicitly excludes (it's
Core Dashboard only — GSC/GA4/email). Use this whenever a site is getting
the Action Center's "apply approved draft as a real PR" capability turned
on, whether that's a brand-new client repo or double-checking an existing
one after hitting repeated failures.

Every item here maps to a real incident (mostly on zunkireelabs-web,
2026-08-07) where a recommendation or draft got stuck — not hypothetical.
Doing all of this once, in order, before relying on Action Center output is
what prevents that class of failure from recurring per-draft.

## 0. Prerequisites to gather

- **GitHub repo**: owner/name, default branch, a fine-grained PAT (Contents
  + Pull Requests, read/write) scoped to that repo, stored in an env var
  (`GITHUB_PAT` by default — `site.github_pat_env_var` for a second repo).
- **The site's shared layout/base template file path** — the one file every
  page extends (e.g. `src/_includes/base.njk`, `src/_layouts/base.njk`).
  This is where sitewide concerns live: HEAD region, security headers
  marker anchor point, analytics scripts.
- **Real content facts** for anything you'll ask Action Center to write
  business copy into (see §4) — nothing here can be fabricated; a human
  supplies the real facts once.

## 1. Connect the repo

```
npm run connect-repo -- --site-id <id> --repo-owner <org> --repo-name <repo> \
  --default-branch main --tech-stack <astro|nextjs|hugo|eleventy|...> \
  [--github-pat-env-var GITHUB_PAT] --url-file-map path.json
```

`url-file-map.json` (migration 028, `server/implementers/lib/url-file-map.js`)
should set, at minimum:

```json
{
  "siteRoot": {
    "layoutTemplate": "src/_includes/base.njk",
    "nginxConfig": "nginx/static.conf",
    "llmsTxt": "public/llms.txt",
    "robotsTxt": "public/robots.txt",
    "sitemap": "public/sitemap.xml"
  },
  "defaults": {
    "placements": {
      "analytics-install": {
        "markers": {
          "analyticsScriptGa4": "ANALYTICSSCRIPTGA4",
          "analyticsScriptFacebookPixel": "ANALYTICSSCRIPTFACEBOOKPIXEL"
        }
      }
    }
  },
  "patterns": [ /* per-URL-shape file + marker/adapter config — see §3 */ ]
}
```

`connect-repo` now **auto-runs** the config-completeness audit right after
saving this (migration 088) — read its output before moving on. Its result
is also persisted and surfaced in Integration Health ("GitHub (Action
Center)").

**Read this output BEFORE letting any recommendation agent run against the
site — not after the fact.** Two real incidents (both 2026-09-11) are why
this line exists: Admizz (site 8862) onboarded with only
`landing-page`/`cookie-policy`/`terms-of-service` in `newContentTargets`,
and its first `blog-outline`/`direct-answer`/`translation`
recommendations sat blocked for days before anyone read the audit output
that had flagged this from day one; separately, a credential check is now
the audit's first section specifically because a dead token used to
degrade into 20+ scattered "file not found" lines with no single place
that said "the credential itself is the problem." The audit now leads with
two sections built for exactly this "check before the agent starts"
moment, in order:

1. **`GITHUB CREDENTIALS`** — one live, authenticated call, PASS/FAIL. If
   this fails, ignore every other section below it in the same run — they
   will misreport as missing files/markers until this is fixed.
2. **`NEW CONTENT TARGETS NOT CONFIGURED`** — every net-new content type
   (`landing-page`, `blog-outline`, `direct-answer`, `translation`,
   `cookie-policy`, `privacy-policy`, `terms-of-service`) this site has NO
   `newContentTargets` entry for at all. Not fatal by design — a site may
   genuinely never need e.g. `translation` — but it must be a deliberate
   choice made here, once, not a gap discovered later as a blocked card. If
   the client's growth strategy will plausibly want any of these, configure
   it now via `connect-repo`'s `--url-file-map`, in the same pass as §1a.

## 1a. Rendering capability — required before any net-new page can apply

Every net-new-content action type (`landing-page`, `blog-outline`,
`direct-answer`, `translation`, `cookie-policy`/`privacy-policy`/
`terms-of-service`) writes a fresh Markdown-with-front-matter file
(`server/implementers/lib/newpage-render.js`). This app never runs the
target repo's own build, so whether that file's extension actually gets a
Markdown pass from the site's own static-site generator (Eleventy, Hugo,
Astro, ...) can't be inferred from the extension string alone — a `.njk` or
`.html` target with no markdown filter would ship raw `# ## ** -` syntax
straight to the browser. The **Rendering Validation Gate**
(`server/implementers/lib/rendering-gate.js`, wired into every implementer's
shared `pushDraftBranch`) blocks that from ever becoming a real PR — but
only if it has real capability metadata to check against, so this is a
required onboarding fact, not an optional nicety:

```json
{
  "renderCapabilities": {
    "generator": "eleventy",
    "extensions": {
      ".md": { "markdown": true },
      ".11ty.md": { "markdown": true },
      ".njk": { "markdown": false },
      ".html": { "markdown": false }
    },
    "overrides": {
      "landing-page": { "markdown": true }
    }
  }
}
```

Add this to the same `url-file-map.json` passed to `connect-repo` in §1.
Every extension used by any `newContentTargets` entry needs a real
`markdown: true/false` fact here — verify it against the target repo's
actual static-site-generator config (does `.njk` run through a markdown
filter/shortcode there, or not) rather than assuming. No entry, or an
extension recorded `false`, fails the gate closed — by design, since a
blocked PR is recoverable and a raw-Markdown page in production is not (see
the mandatory legal-page rendering standard this gate was built to enforce).
`npm run audit-url-file-map` reports any gap here under "RENDER CAPABILITY
GAPS," folded into the same gap count Integration Health already surfaces —
fix it here, once, rather than per generated page.

## 1b. Client-repo build validation (Phase 2 — optional but recommended)

§1a proves the site's *config* looks safe. It can't catch a broken layout,
a markdown plugin misconfigured for a subset of shortcodes, or any other
failure specific to that repo's real build — only an actual build catches
those. That's what this step adds.

**Build location decision:** this build runs in GitHub Actions, **inside the
client's own repo** — never on this app's own infrastructure. Running
`npm install` (arbitrary postinstall scripts) and a build command from a
third-party repo is genuine remote-code-execution risk; GitHub Actions'
per-repo sandboxed runner is the appropriate isolation boundary for that,
not this app's servers. The real cost of this choice: the check can only
report pass/fail *after* a PR already exists (there's no way to build-check
before one is opened), so "never open a PR known to be broken" becomes
"never treat a red check as safe to merge/approve."

```
node server/scripts/install-rendering-workflow.js --site-id <id> \
  [--install-command "npm ci"] [--build-command "npm run build"] \
  [--output-dir "_site"]
```

Reads `url_file_map.renderCapabilities.build` for defaults (record it once
via `connect-repo`'s `--url-file-map` so re-runs don't need the flags);
CLI flags override for a one-off run only, they don't persist. Opens a PR
into the client repo adding:

- `.github/workflows/rendering-validation.yml` — builds the site on every
  PR, job name `rendering-validation` (must stay in sync with
  `server/implementers/lib/rendering-gate.js`'s `CLIENT_BUILD_CHECK_NAME`).
- `scripts/check-rendered-output.mjs` — zero-dependency, walks the real
  build output directory's `.html` files and fails if any visible text
  still contains raw Markdown syntax or an unresolved `{{ }}`/`{% %}` tag
  (script/style/pre/code/comments excluded, so real code samples never
  false-positive).

Review and merge that PR like any other. Then, in the client repo's own
GitHub Settings → Branches, consider making `rendering-validation` a
**required status check** — this app's PAT can open the workflow PR but
can't set branch protection itself, so that's a one-time manual step.

Once installed, `implementers/lib/rendering-gate.js`'s
`checkClientBuildStatus(site, ref)` reads the check result back via the
GitHub API — same `{ok, reason, error}` shape as the §1a config check — for
any future caller that wants to gate on it (a merge-readiness badge, an
"approved" guard) before treating a draft as genuinely safe.

## 1c. Author/org avatar aspect-ratio declaration (optional, but a real recurring defect class)

Real incident, zunkireelabs-web (2026-09): the "Zunkiree Labs Team" blog
byline used the org's wide wordmark logo (SVG viewBox ~7.3:1) as an author
avatar, but the template rendered it inside a circular `object-cover` frame
sized for square headshots — `object-cover` crops to fill, so the wordmark
got cropped down to an unrecognizable sliver on every post using that
author (~72 posts, discovered by eye on a live page, not caught by
anything in this app).

If a site's author/team byline uses an image inside a fixed circular crop
(`rounded-full` + `object-cover`, or equivalent), declare each such avatar
in the same `url-file-map.json` passed to `connect-repo`:

```json
{
  "siteRoot": {
    "authorAvatars": [
      { "label": "Jane Doe", "imagePath": "src/assets/team/jane.webp", "expectedFit": "circular-cover" },
      { "label": "Acme Corp Team", "imagePath": "src/assets/acme-logo.svg", "expectedFit": "contain" }
    ]
  }
}
```

`expectedFit` is the human-declared truth about how the template actually
renders that image — `"circular-cover"` (crops to fill) or `"contain"`
(natural aspect ratio preserved, no forced circle). Nothing auto-discovers
these paths from the repo — same manual-declaration discipline as every
other `url_file_map` field in this runbook — but once declared,
`audit-url-file-map.js` (and `connect-repo`'s auto-run of it, see §1)
fetches each image, checks its real SVG dimensions
(`server/implementers/lib/avatar-aspect-check.js`), and reports a fatal
"AUTHOR AVATAR ASPECT-RATIO GAP" if a non-square image is declared
`circular-cover` — before any blog post ships it cropped. A personal
headshot is virtually always safe to skip declaring (photos are already
close to square); this is worth doing specifically for any org/team/brand
logo used as a byline avatar, since a wordmark logo is the shape that
actually breaks. Raster avatars (png/jpg/webp) are reported "unverified"
rather than checked — only SVG viewBox/width+height is currently parsed.

## 2. One-time manual template bootstrap (nothing can safely automate these)

These two anchors are sitewide layout concerns with no framework-agnostic
way to locate them — guessing risks silently producing content that never
renders, or headers that never take effect. A human places each **once**,
directly in the real repo:

1. **HEAD region**, inside the real `<head>...</head>` of the shared layout
   template from §1: `<!-- SEOAI:HEAD:START --><!-- SEOAI:HEAD:END -->`.
   Required before `canonical`, `open-graph`, or `analytics-install` can
   ever apply — every other field auto-nests inside this region once it
   exists (`server/implementers/lib/marker-merge.js`'s `ensureMarkers`).
2. **Nginx security-headers marker**, inside the real `server {}` block of
   the site's live nginx config from §1:
   `# SEOAI:SECURITY-HEADERS:START` / `# SEOAI:SECURITY-HEADERS:END` (plain
   comments, hash-based — see `server/generators/security-headers.js`).
   Skip if this site's headers aren't managed through this app.

**Body-content anchors (`qaContent`/`expandedContent`) no longer need a
manual step.** They still auto-insert at end-of-file on plain `.md`/`.mdx`
(EOF genuinely is the end of the rendered article there — unchanged). On a
component-based template (`.jsx`/`.tsx`/`.astro`/`.njk`/`.html`/`.vue`/...),
where EOF is outside the rendered tree, `server/implementers/lib/
structural-detect.js` now parses the file for real (a JSX AST for React/
Next.js, a located DOM for Astro/HTML-shaped templates) to find the actual
`<main>`/`<article>` content container, and `server/implementers/lib/
marker-bootstrap.js` opens a small PR adding the marker there — never a
silent direct commit, since a structural match is real evidence, not proof
of correct intent on someone else's production repo. This happens two ways:

- **Lazily**, the first time a real recommendation needs that marker and
  it's missing — `backend.js`'s `computeMarkerMerge` already tries this
  before falling back to today's manual-placement error.
- **Proactively**, for a whole site at once:
  ```
  npm run bootstrap-structural-markers -- --site-id <id>
  ```
  Run this once right after §1/§3 are configured (new client) or any time
  on an existing site to catch newly-added pages. Merge whatever PR(s) it
  opens — after that, `qa-content`/`expand-content` recommendations for
  those pages apply automatically, no manual marker-editing step, ever.
  A page whose file has no confident `<main>`/`<article>` container (or
  multiple ambiguous JSX-returning components in one file) still falls back
  to the honest manual-placement message — detection refuses rather than
  guesses on those, same discipline as everywhere else in this app.

Run `npm run audit-url-file-map -- --site-id <id>` after this step — its
"MARKERS MISSING, FATAL" and "NGINX SECURITY-HEADERS MARKER" sections
report exactly what's still missing from this list, `classifyMarkerGap`
(`marker-merge.js`) is the shared source of truth for what's genuinely
fatal vs. what self-heals automatically at apply time, so this list and
`ensureMarkers`'s real behavior can never quietly disagree.

## 3. Per-page config — files, patterns, and adapter routing

For existing-page generators (`schema`, `meta-title`, `faq`,
`internal-links`, `canonical`, `open-graph`, `breadcrumbs`), `resolveFile`
(`url-file-map.js`) needs either an exact `pages[url].file` entry or a
`patterns[]` regex covering the URL shape. Two ways to populate this:

`breadcrumbs` needs its own marker field, `breadcrumbSchema` — deliberately
NOT shared with `schema`'s own marker, since a page can carry both real
Article/Product/etc. schema AND a `BreadcrumbList` at once, and
`marker-merge.js`'s splice is a wholesale replace, not an append (see that
file's `buildMergeValues` comment for the `'breadcrumbs'` case). Add a
`SEOAI:breadcrumbSchema` marker comment pair wherever the site's template
should render it (same convention as the `SEOAI:schema`/`SEOAI:faq`
markers already documented above), or it will 404 at apply time with "No
merge strategy"/"marker not found" the same way any other unconfigured
field does. `schema-repair` and `alt-text` need no new marker at all — both
patch an EXISTING element's real source text directly (a malformed/
duplicate `<script type="application/ld+json">` block, or a specific
`<img>` tag missing `alt=""`) rather than filling in a designated slot, so
they only need the same `pages`/`patterns` file mapping every other
existing-page generator already needs.

- **Manual, one entry/pattern at a time** via `--url-file-map`.
- **Self-healing** — if a draft's page has no mapping, `pushDraftBranch`
  (`server/routes/action-center.js`) now tries `autoHealFileMapping`
  (`server/implementers/lib/discover-file-mapping.js`) automatically: a
  single, real, unambiguous filename match in the repo gets persisted with
  zero manual step. Ambiguous or no match still fails honestly — same
  evidence bar as `discover-url-file-map.js`'s manual CLI.

**If pages are generated from a shared data file** (Eleventy pagination,
a JSON/JS array — e.g. `src/_data/locations.js`), route that URL shape to
the `data-array-content` adapter (`patterns[].adapters`) instead of a
per-page file/marker. See `server/implementers/adapters/data-array-content.js`'s
module comment for the full config shape (including `nestedField` for
location×service-style nested pages).

**A configured adapter route is not the same as usable data.** A route can
exist while the specific entry the adapter needs (e.g.
`locations["lalitpur"].services["web-development"]`) genuinely doesn't
exist in the data file yet — this is a **content gap, not a config gap**,
and nothing in this app fabricates business copy to fill it.
`agents/lib/recommendations.js`'s pre-flight filter (`isDataReady`) already
stops a recommendation from resurfacing once it's confirmed not-ready, so
you won't see the same dead-end recommendation every refresh — but the real
fix is a human (or this session, with your explicit review) writing the
missing entries, the same way Lalitpur/Bhaktapur/Pokhara's `services{}`
gaps got filled on 2026-08-07: reusing the site's own already-published,
honest facts, never inventing a local office/team-size claim that isn't
true.

## 4. Environment/flag parity (only relevant if this site's agents use opt-in features)

Any `*_ENABLED`/`ENABLE_*` flag (e.g. `ENABLE_CONTENT_CITATION_SEARCH`)
needs to be set in **every** environment that should have the feature, and
its required credentials need to travel with it —
`npm run check-env-parity` (wired into CI) catches both "flag set nowhere"
and "flag on, credentials missing" automatically on every PR. Not specific
to per-site onboarding, but worth a manual run the first time a new site
turns on an opt-in agent/generator.

## 5. Verify clean before calling onboarding done

```
npm run audit-url-file-map -- --site-id <id>
```

Should report `CLEAN — no gaps found.` (or only self-healing/non-fatal
notes) — including a `RENDER CAPABILITY GAPS (0)` line with the "every
configured newContentTargets extension has a recorded, markdown-safe
renderCapabilities entry" confirmation (§1a), and an `AUTHOR AVATAR
ASPECT-RATIO GAPS (0)` line if any avatars were declared (§1c). Also check
Integration Health → "GitHub (Action Center)" is `ok` with no
`recoveryAction` warning attached.

If it isn't clean, that's the actual list of what's still blocking — work
through it here rather than discovering each gap one stuck draft at a time.
