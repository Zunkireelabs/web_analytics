# Zennly: regenerate the Next pages from the Eleventy sources on pull requests (install notes for the owner)

PROPOSAL. Nothing here is installed in Zennly's repository, and nothing in this folder changes any repository, CI or production system.

## The problem it solves
Zennly's `/businesses` pages are written in Eleventy (`marketing/src`, where all the SEOAI markers are) and served by the Next app from pages **generated** from those sources by the repo's own scripts. Nothing runs those scripts automatically, so a new blog post, or a platform fix to an existing page (internal links, breadcrumbs, FAQ), would land in the source and never reach the live site.

## What it does
When a same-repository pull request adds or changes a page source (`marketing/src/**/*.njk`) or `marketing/src/_data/blogOrder.json`:
1. `regen-pages.sh candidates` works out which pages the changed files affect (a changed blog post also affects the blog index).
2. `node scripts/sync-businesses-site.mjs` builds the marketing site and mirrors it into `public/businesses` (the repo's own drift check fails the build if a post is missing from `blogOrder.json`).
3. `regen-pages.sh final` keeps only real mirrored pages and **skips the two hand-ported pages** (the `/businesses` home page and `blog/spa-booking-app-nepal`), with a warning that their Next page must be edited by hand.
4. `regen-pages.sh verify` fails the job if the build changed any other mirrored page (unrelated drift, or a shared file changed). Nothing is committed in that case.
5. `python3 scripts/port-businesses-pages.py <pages>` regenerates those pages (new or existing).
6. Only the generated `/businesses` files are committed back to the PR branch. A person still reviews and merges; nothing is deployed from here.

## Install (two files, one pull request into Zennly's repo, merged by you)
1. `generate-blog-pages.yml` -> `.github/workflows/generate-blog-pages.yml`
2. `regen-pages.sh` -> `.github/scripts/regen-pages.sh` (executable: `chmod +x`)

The job uses `contents: write` only, runs for same-repository branches only, never on the bot's own commits, and uses no secrets.

## Tested locally (real build, real port script, on a copy of the local checkout)
- Three simulated platform edits to existing pages (a blog post's internal links, the cookie-policy page, the hand-ported post): candidates were correct, the build passed, the hand-ported page was skipped with a warning, verify passed, the port regenerated exactly the two ordinary pages (plus an unchanged blog index), the edits appear in the generated files, and nothing outside the allowed paths changed.
- An unrelated, unaccounted source change made verify fail with exit code 1 and name the page, so nothing would be committed.
- Earlier: four new posts went through the same build and port with `blogOrder.json` updated; removing a slug from `blogOrder.json` made the build fail.
- `actionlint` and `shellcheck` are clean.

## Not tested / limits
- It has never run on GitHub. The first run should be on a throwaway pull request.
- A change to a shared file (`marketing/src/_includes/**`, `_data/**` other than `blogOrder.json`) does not trigger it: such a change can affect every page and is not regenerated automatically.
- The two hand-ported pages are never regenerated; their Next page is written by hand.
- No full Next.js build of the generated pages was run.
