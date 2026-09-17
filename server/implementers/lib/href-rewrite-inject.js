// Targeted anchor rewrite/removal, keyed on an exact href value — a new
// mechanism because neither existing one fits "find one specific anchor
// among possibly many by its href, and change or remove it": there's no
// bounded human-placed marker region an anchor could live in (unlike
// hash-marker-merge.js), and it isn't a single unambiguous singleton tag
// like <html>/<meta name="viewport"> (unlike html-lang-inject.js/
// viewport-inject.js) — a page can have many <a> tags.
import { scanBalanced } from '../adapters/lib/js-data-splice.js';

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

// Blog posts are stored as Markdown (src/blog/$1.md, per url_file_map), not
// HTML — anchorRegex/hrefAttrRegex above never match `[text](url)` syntax at
// all, which silently fell through to the code-search fallback for every
// citation link in a .md file. (?<!!) excludes image syntax (`![alt](url)`)
// — stripping/rewriting those has different semantics (there's no "inner
// text" to keep) and isn't what a broken citation link fix means.
function markdownLinkRegex(href) {
  const escaped = escapeRegExp(href);
  return new RegExp(`(?<!!)\\[([^\\]]*)\\]\\(${escaped}(?:\\s+"[^"]*")?\\)`, 'g');
}

function markdownLinkUrlRegex(href) {
  const escaped = escapeRegExp(href);
  return new RegExp(`(?<!!)(\\[[^\\]]*\\]\\()${escaped}(\\s+"[^"]*")?(\\))`, 'g');
}

// The crawler that records broken links always stores the absolute canonical
// URL, but the source template commonly hardcodes the same link relative to
// the site root (e.g. `href="/solutions/x/"`), sometimes with or without a
// trailing slash. Matching only the exact absolute string misses those and
// falsely reports the link as absent from a file that plainly contains it —
// so every caller tries the absolute href first, then its relative forms.
export function hrefVariants(href) {
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
    if (matches) {
      const newContent = fileContent.replace(regex, (_m, quote) => `href=${quote}${newHref}${quote}`);
      return { ok: true, newContent, replaced: matches.length };
    }
    const mdRegex = markdownLinkUrlRegex(variant);
    const mdMatches = fileContent.match(mdRegex);
    if (mdMatches) {
      const newContent = fileContent.replace(mdRegex, (_m, pre, title, post) => `${pre}${newHref}${title || ''}${post}`);
      return { ok: true, newContent, replaced: mdMatches.length };
    }
  }
  return { ok: false, reason: 'no-match', error: `No href="${oldHref}" found in this file.` };
}

// Removes whatever exact-text span [start, end) sits in an array literal —
// a plain string element (sameAs: ["url1", "url2"]) or an object element
// (socialLinks: [{ href: "url1", icon: <svg/> }, ...]) — along with
// whichever ONE adjacent comma actually separated it from its neighbors,
// so removing the array's only/first/last element never leaves a dangling
// leading or double comma behind. Shared by both data-array strategies
// below; the two differ only in how they locate [start, end).
function removeArrayElementSpan(content, start, end) {
  // This element's own leading indentation/newline (the whitespace that
  // separated it from whatever came before) is never worth preserving once
  // the element itself is gone — trimmed back to the nearest real
  // character first, so neither strategy below leaves a dangling blank line.
  let trimmedStart = start;
  while (trimmedStart > 0 && /[ \t\n\r]/.test(content[trimmedStart - 1])) trimmedStart--;

  // Prefer consuming a TRAILING comma — the common case (element is first
  // or middle, or the array uses a trailing comma after its last element).
  // Only when nothing trails does it fall back to consuming the LEADING
  // comma instead (a true last element with no trailing-comma style),
  // which is exactly the case a trailing-only rule would otherwise leave
  // as `foo,\n]` with a newly-dangling comma after the new last element.
  const after = /^\s*,/.exec(content.slice(end, end + 200));
  if (after) return content.slice(0, trimmedStart) + content.slice(end + after[0].length);
  const before = /,\s*$/.exec(content.slice(Math.max(0, trimmedStart - 200), trimmedStart));
  if (before) return content.slice(0, trimmedStart - before[0].length) + content.slice(end);
  // Sole remaining element (no comma either side) — just remove it.
  return content.slice(0, trimmedStart) + content.slice(end);
}

// Icon-only social-link shape (zunkireelabs-web has none of these; found
// live on Admizz's Footer.tsx/layout.tsx 2026-09-17): a broken href that
// isn't inline anchor markup at all, but a `field: "url"` property inside
// one object of an array (`const socialLinks = [{ name: "...", href:
// "...", icon: (<svg>...</svg>) }, ...]`). There is no "inner text" to
// preserve the way a normal <a> has — the visible content IS the icon, so
// the only safe fix is removing the WHOLE object, never rewriting one
// field in place (a link with no href is not a lesser link, it's a
// dead click target still rendered). Anchored on the exact `href: "<url>"`
// (or single-quoted) text — refuses on 0 or >1 occurrences, same ambiguity
// discipline as every anchor-based strategy above, and refuses if the
// enclosing `{...}` can't be bounded (malformed/unbalanced source).
function hrefFieldRegex(href) {
  const escaped = escapeRegExp(href);
  return new RegExp(`href\\s*:\\s*(["'])${escaped}\\1`, 'g');
}

function stripDataArrayObject(fileContent, href) {
  for (const variant of hrefVariants(href)) {
    const matches = [...fileContent.matchAll(hrefFieldRegex(variant))];
    if (matches.length !== 1) continue;
    const anchorIndex = matches[0].index;
    // Walk backward from the anchor tracking brace depth, so a `{` inside
    // the object's OWN nested content (the icon's JSX, if it ever has one)
    // is correctly skipped rather than mistaken for the object's start.
    let depth = 0;
    let objStart = -1;
    for (let i = anchorIndex; i >= 0; i--) {
      const ch = fileContent[i];
      if (ch === '}') depth++;
      else if (ch === '{') {
        if (depth === 0) { objStart = i; break; }
        depth--;
      }
    }
    if (objStart === -1) continue;
    const objEnd = scanBalanced(fileContent, objStart + 1, '{', '}');
    if (objEnd === -1) continue;
    return { ok: true, newContent: removeArrayElementSpan(fileContent, objStart, objEnd + 1), replaced: 1 };
  }
  return null;
}

// A bare string element inside an array — the JSON-LD `sameAs` shape
// (`sameAs: ["https://...", "https://...instagram.../", ...]`), found on
// the same Admizz layout.tsx alongside the socialLinks case above. No
// object to bound, no inner text to preserve — the quoted literal itself
// IS the element.
function stripDataArrayString(fileContent, href) {
  for (const variant of hrefVariants(href)) {
    const escaped = escapeRegExp(variant);
    const regex = new RegExp(`(["'])${escaped}\\1`, 'g');
    const matches = [...fileContent.matchAll(regex)];
    if (matches.length !== 1) continue;
    const m = matches[0];
    return { ok: true, newContent: removeArrayElementSpan(fileContent, m.index, m.index + m[0].length), replaced: 1 };
  }
  return null;
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
    if (matches.length) {
      if (matches.some((m) => /<a\b/i.test(m[1]))) {
        return { ok: false, reason: 'nested-anchor', error: `A matched <a href="${variant}"> contains a nested <a> tag — refusing to risk corrupting the markup.` };
      }
      const newContent = fileContent.replace(regex, (_m, inner) => inner);
      return { ok: true, newContent, replaced: matches.length };
    }
    // Markdown never nests `[...]` links syntactically, so no nested-link
    // guard is needed here the way anchorRegex above needs one for HTML.
    const mdRegex = markdownLinkRegex(variant);
    const mdMatches = [...fileContent.matchAll(mdRegex)];
    if (mdMatches.length) {
      const newContent = fileContent.replace(mdRegex, (_m, text) => text);
      return { ok: true, newContent, replaced: mdMatches.length };
    }
  }
  // Neither a real HTML anchor nor a Markdown link exists for this href —
  // before giving up, check the two real data-array shapes this href might
  // instead be hardcoded as (see the two functions above). Object first:
  // a bare string match inside an object's OWN unrelated field (a name, a
  // label) would false-positive the string-array strategy, so the more
  // specific object-field shape is always tried first.
  const objectResult = stripDataArrayObject(fileContent, href);
  if (objectResult) return objectResult;
  const stringResult = stripDataArrayString(fileContent, href);
  if (stringResult) return stringResult;
  return { ok: false, reason: 'no-match', error: `No <a href="${href}"> or markdown link to "${href}" found in this file.` };
}

// Every live anchor matching this href, verbatim — used for an implemented
// draft's live preview (mirrors getHtmlTag/getViewportMeta).
export function getAnchorsForHref(fileContent, href) {
  for (const variant of hrefVariants(href)) {
    const matches = [...fileContent.matchAll(anchorRegex(variant))].map((m) => m[0]);
    if (matches.length) return matches;
    const mdMatches = [...fileContent.matchAll(markdownLinkRegex(variant))].map((m) => m[0]);
    if (mdMatches.length) return mdMatches;
  }
  return [];
}
