#!/usr/bin/env bash
# PROPOSED FOR ZENNLY'S REPO (Zunkireelabs/zennly-marketplace), next to the workflow. NOT INSTALLED ANYWHERE. Install at .github/scripts/regen-pages.sh (executable).
#
# Decides which /businesses pages a pull request's Eleventy source changes affect, so the workflow re-ports exactly those and nothing else.
#   regen-pages.sh candidates   (before the build)  prints one mirror path per line, derived from the files the PR changed vs $BASE_SHA
#   regen-pages.sh final        (after the build)   reads candidates on stdin; keeps those that really are mirrored pages; skips the hand-ported pilots
#   regen-pages.sh verify       (after the build)   reads the final list on stdin; fails if the build changed any mirrored page that is NOT in that list
# Page paths are the ones scripts/port-businesses-pages.py takes: 'about', 'blog', 'blog/<slug>', 'features/<x>' ...
set -euo pipefail

# Hand-ported pilots (ALREADY in scripts/port-businesses-pages.py): their Next page is written by hand, so the converter must not touch them.
HAND_PORTED_RE='^(blog/spa-booking-app-nepal)?$'
SAFE_RE='^[a-z0-9][a-z0-9/_-]*$'

mode="${1:?usage: regen-pages.sh candidates|final|verify}"

case "$mode" in
  candidates)
    : "${BASE_SHA:?BASE_SHA is required}"
    files=$(git diff --name-only --diff-filter=AM "$BASE_SHA" HEAD -- 'marketing/src/*.njk' 'marketing/src/**/*.njk' 'marketing/src/_data/blogOrder.json' | sort -u)
    out=""
    while IFS= read -r f; do
      [ -z "$f" ] && continue
      case "$f" in
        marketing/src/_data/blogOrder.json) out+=$'blog\n' ;;
        marketing/src/_includes/*|marketing/src/_data/*) echo "::warning::Shared file $f changed: it can affect many pages and is not regenerated automatically." >&2 ;;
        *.njk)
          p="${f#marketing/src/}"; p="${p%.njk}"
          [ "$p" = "index" ] && p=""
          out+="$p"$'\n'
          case "$p" in blog/*) out+=$'blog\n' ;; esac ;;
      esac
    done <<< "$files"
    printf '%s' "$out" | sort -u | { grep -v '^$' || true; } | while IFS= read -r p; do
      if ! printf '%s' "$p" | grep -Eq "$SAFE_RE"; then echo "::error::Unexpected page path: $p" >&2; exit 1; fi
      printf '%s\n' "$p"
    done
    # the home page maps to the empty path: report it so it is not lost silently
    if printf '%s' "$out" | grep -qx ''; then echo "::warning::The home page source changed: its Next page is hand-ported and must be updated by hand." >&2; fi
    ;;
  final)
    while IFS= read -r p; do
      [ -z "$p" ] && continue
      if printf '%s' "$p" | grep -Eq "$HAND_PORTED_RE"; then echo "::warning::/businesses/$p is hand-ported: its Next page must be updated by hand; skipped." >&2; continue; fi
      if [ ! -f "public/businesses/$p/index.html" ]; then echo "::notice::$p is not a mirrored page (no public/businesses/$p/index.html); skipped." >&2; continue; fi
      printf '%s\n' "$p"
    done
    ;;
  verify)
    expected=$(cat)
    changed=$(git ls-files --modified --others --exclude-standard -- public/businesses | grep -E '/index\.html$' | sed -E 's#^public/businesses/##; s#/?index\.html$##' | sort -u)
    bad=""
    while IFS= read -r c; do
      [ -z "$c" ] && continue
      # a hand-ported page's mirrored copy changes whenever its source does (it is only the rollback copy): expected, not drift
      if printf '%s' "$c" | grep -Eq "$HAND_PORTED_RE"; then continue; fi
      printf '%s\n' "$expected" | grep -qxF -- "$c" || bad+="$c"$'\n'
    done <<< "$changed"
    if [ -n "$bad" ]; then echo "::error::The build changed mirrored pages this pull request does not account for (unrelated drift, or a shared file changed):"; printf '%s' "$bad"; exit 1; fi
    echo "Every changed mirrored page is accounted for."
    ;;
  *) echo "unknown mode: $mode" >&2; exit 2 ;;
esac
