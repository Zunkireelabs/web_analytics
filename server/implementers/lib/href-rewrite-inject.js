// Targeted anchor rewrite/removal, keyed on an exact href value — a new
// mechanism because neither existing one fits "find one specific anchor
// among possibly many by its href, and change or remove it": there's no
// bounded human-placed marker region an anchor could live in (unlike
// hash-marker-merge.js), and it isn't a single unambiguous singleton tag
// like <html>/<meta name="viewport"> (unlike html-lang-inject.js/
// viewport-inject.js) — a page can have many <a> tags.

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hrefAttrRegex(href) {
  const escaped = escapeRegExp(href);
  return new RegExp(`href=(["'])${escaped}\\1`, 'g');
}

function anchorRegex(href) {
  const escaped = escapeRegExp(href);
  // Non-greedy across the tag's own attributes and its inner content —
  // [\s\S] so it matches across newlines, same technique as marker-merge.js's
  // blockRegex.
  return new RegExp(`<a\\b[^>]*href=["']${escaped}["'][^>]*>([\\s\\S]*?)<\\/a>`, 'g');
}

// The crawler that records broken links always stores the absolute canonical
// URL, but the source template commonly hardcodes the same link relative to
// the site root (e.g. `href="/solutions/x/"`), sometimes with or without a
// trailing slash. Matching only the exact absolute string misses those and
// falsely reports the link as absent from a file that plainly contains it —
// so every caller tries the absolute href first, then its relative forms.
function hrefVariants(href) {
  const variants = [href];
  try {
    const { pathname } = new URL(href);
    variants.push(pathname);
    if (pathname.length > 1) {
      variants.push(pathname.replace(/\/+$/, ''), `${pathname.replace(/\/+$/, '')}/`);
    }
  } catch {
    // href isn't an absolute URL (already relative, or malformed) — nothing to derive.
  }
  return [...new Set(variants)];
}

// Rewrites every exact-match `href="{oldHref}"` (either quote style) to
// `newHref`. Every match points at the identical old href and gets the
// identical new href — no per-occurrence ambiguity, so all matches are
// rewritten together, not just the first. Zero matches is an honest
// no-match (link already fixed/removed since detection, or lives outside
// this page's own template file, e.g. a shared partial).
export function rewriteHref(fileContent, oldHref, newHref) {
  for (const variant of hrefVariants(oldHref)) {
    const regex = hrefAttrRegex(variant);
    const matches = fileContent.match(regex);
    if (!matches) continue;
    const newContent = fileContent.replace(regex, (_m, quote) => `href=${quote}${newHref}${quote}`);
    return { ok: true, newContent, replaced: matches.length };
  }
  return { ok: false, reason: 'no-match', error: `No href="${oldHref}" found in this file.` };
}

// Strips every anchor whose href exactly matches, replacing the whole
// `<a ...>inner</a>` with just its inner content — always safe (never worse
// than the current dead link). Refuses (rather than corrupts) if a matched
// anchor's own inner content contains a nested `<a `, since that means the
// simple non-greedy match found the wrong closing `</a>`.
export function stripLink(fileContent, href) {
  for (const variant of hrefVariants(href)) {
    const regex = anchorRegex(variant);
    const matches = [...fileContent.matchAll(regex)];
    if (!matches.length) continue;
    if (matches.some((m) => /<a\b/i.test(m[1]))) {
      return { ok: false, reason: 'nested-anchor', error: `A matched <a href="${variant}"> contains a nested <a> tag — refusing to risk corrupting the markup.` };
    }
    const newContent = fileContent.replace(regex, (_m, inner) => inner);
    return { ok: true, newContent, replaced: matches.length };
  }
  return { ok: false, reason: 'no-match', error: `No <a href="${href}"> found in this file.` };
}

// Every live anchor matching this href, verbatim — used for an implemented
// draft's live preview (mirrors getHtmlTag/getViewportMeta).
export function getAnchorsForHref(fileContent, href) {
  for (const variant of hrefVariants(href)) {
    const matches = [...fileContent.matchAll(anchorRegex(variant))].map((m) => m[0]);
    if (matches.length) return matches;
  }
  return [];
}
