# PR for Zunkireelabs/zennly-marketplace: regenerate the Next /businesses pages from the Eleventy sources

Status: READY FOR REVIEW, NOT PUSHED. Patch: `zennly-ci-regenerate.patch` (2 files, 184 lines, applies cleanly to the current local checkout). Nothing here is installed or merged.
Suggested branch: `ci/regenerate-businesses-pages`.

## What this adds
- `.github/workflows/generate-blog-pages.yml`
- `.github/scripts/regen-pages.sh`

## Why
`/businesses` pages are authored in Eleventy (`marketing/src`, where every SEOAI marker lives) and served by the Next app from pages **generated** from them by this repo's own scripts (`scripts/sync-businesses-site.mjs`, `scripts/port-businesses-pages.py`). Nothing runs those scripts automatically, so a new blog post, or an automated fix to an existing page (internal links, breadcrumbs, FAQ), changes the source and never reaches the live site.

## What the job does
On a same-repository pull request that adds or changes `marketing/src/**/*.njk` or `marketing/src/_data/blogOrder.json`:
1. Works out which pages the changed files affect.
2. Runs the repo's own build and mirror (`node scripts/sync-businesses-site.mjs`). The repo's own drift check fails the build if a post is missing from `blogOrder.json`.
3. Keeps only real mirrored pages and skips the two hand-ported ones (the `/businesses` home page and `blog/spa-booking-app-nepal`), with a warning that their Next page must be edited by hand.
4. Fails the job, committing nothing, if the build changed any other mirrored page (unrelated drift, or a shared file changed).
5. Runs the repo's own `scripts/port-businesses-pages.py` for those pages (new or existing).
6. Commits only the generated `/businesses` files to the PR branch. A person still reviews and merges. Nothing is deployed from here.

## Safety
Same-repository branches only (never forks); never runs for the bot's own commits; `contents: write` only and no secrets; actions pinned to commit SHAs; allow-list on what may be committed; no `pull_request_target`.

## Tested (local copy of this repo, real build, real port script)
- New posts: four posts through build, mirror, port; the three generated files per post appear and match the existing posts' shape; removing a slug from `blogOrder.json` makes the build fail.
- Edits to existing pages: a blog post, the cookie-policy page, the FAQ page and a solutions page were regenerated with the edits present in the generated files; the hand-ported post and the home page were skipped with warnings; the blog index re-port produced no change.
- An unrelated source change made the verify step fail with exit code 1 and name the page, so nothing would be committed.
- `actionlint` and `shellcheck` are clean.

## Not tested / limits
- It has never run on GitHub: please try it first on a throwaway pull request.
- Changes to shared files (`marketing/src/_includes/**`, `_data/**` other than `blogOrder.json`) do not trigger it; they can affect every page.
- The home page (`/businesses`) and `blog/spa-booking-app-nepal` are hand-ported and are never regenerated.
- No full Next.js build of the generated pages was run.

## Review focus
`.github/scripts/regen-pages.sh` (page derivation and the verify allow-list) and the commit step's allowed paths.
