// Pure, browser-free analysis over font-consistency-capture.js's real
// captured samples — kept separate from the Playwright capture itself so it
// can be unit-tested without a live browser, same "capture vs. analyze"
// split as segment.js is to capture.js for the Design Agent.

// outerHTML always double-quotes attribute values, so this only needs to
// match the double-quoted form.
const STYLE_ATTR_RE = /\sstyle\s*=\s*"([^"]*)"/i;

export function hasInlineFontSizeOverride(outerHtml) {
  const m = (outerHtml || '').match(STYLE_ATTR_RE);
  if (!m) return false;
  return /font-size\s*:/i.test(m[1]);
}

// Removes ONLY the font-size declaration from an element's real inline
// style attribute, operating directly on outerHtml's own literal text (never
// on a decoded/re-encoded copy) so the result is guaranteed to still be
// valid, exact-match-patchable markup. Drops the whole style="" attribute
// when font-size was its only declaration. Returns null when there's no
// inline font-size to remove — never invents a "fix" for a class-driven
// size difference.
export function buildFontSizeOverrideRemoved(outerHtml) {
  const m = (outerHtml || '').match(STYLE_ATTR_RE);
  if (!m) return null;
  const declarations = m[1].split(';').map((d) => d.trim()).filter(Boolean);
  const kept = declarations.filter((d) => !/^font-size\s*:/i.test(d));
  if (kept.length === declarations.length) return null;
  const replacementAttr = kept.length ? ` style="${kept.join('; ')};"` : '';
  return outerHtml.slice(0, m.index) + replacementAttr + outerHtml.slice(m.index + m[0].length);
}

// Finds the CSS declaration governing an element styled via an ancestor
// wrapper class rather than a class of its own — e.g. Chayce's
// `.hiw-hero h1{...font-size:clamp(40px,6vw,74px);...}`, where the h1 itself
// carries no class at all, so the existing class-swap fix (swapAnchorClass
// above) can never apply. Requires the selector to occur EXACTLY ONCE in the
// given HTML and to declare a font-size — never guesses at a location, same
// discipline as buildFontSizeOverrideRemoved above. `html` is the page's own
// real rendered output (or, at apply time, its real template source) — on
// this class of static-site template, an inline <style> block is embedded
// directly in the page and its CSS text has no template syntax inside it, so
// the two are byte-identical for this exact declaration.
function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function scopedRuleRegex(ancestorClass, tag) {
  return new RegExp(`\\.${escapeRegExp(ancestorClass)}\\s+${escapeRegExp(tag)}\\s*\\{[^}]*\\}`, 'g');
}

export function extractScopedFontSizeDeclaration(html, ancestorClass, tag) {
  if (!html || !ancestorClass || !tag) return null;
  const matches = [...html.matchAll(scopedRuleRegex(ancestorClass, tag))];
  if (matches.length !== 1) return null; // not found, or not uniquely identifiable — refuse rather than guess
  const declarationText = matches[0][0];
  const fsMatch = declarationText.match(/font-size\s*:\s*([^;}]+)/i);
  if (!fsMatch) return null;
  return { declarationText, value: fsMatch[1].trim() };
}

// A plain length this platform can confidently swap for another plain
// length (e.g. "48px") — never a fluid/dynamic expression (clamp()/calc()/
// vw/vh/%/var()), where "the correct value" can't be read off a single
// getComputedStyle snapshot without inventing new responsive bounds nobody
// has evidenced. Those stay unfixable by design, not merely undetected.
export function isFlatLength(value) {
  return /^-?[\d.]+(px|pt)$/i.test((value || '').trim());
}

// Builds the {anchorHtml, replacement} pair for a scoped, ancestor-selector
// font-size fix: same declaration text, only the font-size value swapped for
// `expectedFontSize` (the site's own real, already-observed convention —
// never invented). Returns null (refuse, never guess) when the declaration
// can't be uniquely located, is already at the target value (would be a
// no-op patch), or is a fluid/dynamic expression this platform won't
// silently flatten.
export function buildScopedFontSizeFix(html, ancestorClass, tag, expectedFontSize) {
  const found = extractScopedFontSizeDeclaration(html, ancestorClass, tag);
  if (!found) return null;
  if (!isFlatLength(found.value) || found.value === expectedFontSize) return null;
  const idx = found.declarationText.indexOf(found.value, found.declarationText.indexOf('font-size'));
  if (idx < 0) return null;
  const replacement = found.declarationText.slice(0, idx) + expectedFontSize + found.declarationText.slice(idx + found.value.length);
  return { anchorHtml: found.declarationText, replacement };
}

const MIN_DISTINCT_PAGES = 3;
const MIN_MODE_SHARE = 0.6;

// Real class-string token equality, ignoring order/whitespace — same
// discipline content-integrity-repair.js's swapAnchorClass uses to decide
// whether a live anchor still matches what detection observed. Kept as its
// own copy rather than a shared import: that module already imports FROM
// this one (buildFontSizeOverrideRemoved), and this is small enough that a
// second copy is cheaper than the cycle.
function sameClassTokens(a, b) {
  const ta = new Set((a || '').trim().split(/\s+/).filter(Boolean));
  const tb = new Set((b || '').trim().split(/\s+/).filter(Boolean));
  if (ta.size !== tb.size) return false;
  for (const t of ta) if (!tb.has(t)) return false;
  return true;
}

// The real majority font-size within one set of entries, or null when there
// isn't a trustworthy one — same two guards as before, just factored out so
// they can be applied per-template AND sitewide:
//   - needs samples from at least MIN_DISTINCT_PAGES different pages (several
//     paragraphs on ONE page sharing a size proves nothing);
//   - the majority must actually BE a majority (>=60% of samples) — no
//     dominant size means "this site intentionally varies this here," not
//     "everyone but one is wrong."
function computeMode(entries) {
  const distinctPages = new Set(entries.map((e) => e.url));
  if (distinctPages.size < MIN_DISTINCT_PAGES) return null;
  const counts = new Map();
  for (const e of entries) counts.set(e.sample.fontSize, (counts.get(e.sample.fontSize) || 0) + 1);
  const [modeSize, modeCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (modeCount / entries.length < MIN_MODE_SHARE) return null;
  return modeSize;
}

// The real class string most commonly carried by entries that already render
// at `targetFontSize` — the site's own observed convention for "how you get
// this size", used as the exact-match-or-refuse replacement value a
// typography-drift fix patches an outlier's classes to. Never invented, and
// never borrowed from another bucket or another site: only entries already
// in the same bucket that produced `targetFontSize` are eligible.
function modeClassesForFontSize(entries, targetFontSize) {
  const matching = entries.filter((e) => e.sample.fontSize === targetFontSize && e.sample.classes);
  if (!matching.length) return null;
  const counts = new Map();
  for (const e of matching) counts.set(e.sample.classes, (counts.get(e.sample.classes) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

// Whether `targetEntry`'s ancestor wrapper class is not shared by ANY other
// page's entry in this same run's real captured evidence for this element
// group — bounded to what was actually captured, never a guess about pages
// that weren't sampled. A name reused across pages (Chayce's own
// ".page-hero", independently duplicated into 8 separate templates) means a
// fix keyed on it could land on more than the one intended page, so this
// only ever returns true for a wrapper class genuinely unique in the
// evidence gathered.
function ancestorClassIsPageUnique(entries, targetEntry) {
  const cls = targetEntry.sample.ancestorClass;
  if (!cls) return false;
  return !entries.some((e) => e.url !== targetEntry.url && e.sample.ancestorClass === cls);
}

// Groups real captured samples (from font-consistency-capture.js) by real
// role — one group per heading level (h1/h2/h3/h4), one group for body
// paragraphs — then, WITHIN each role, checks a sample against its own
// page-type/template's real majority first, falling back to the sitewide
// majority only when that template doesn't have enough of its own evidence
// to have an opinion. This is what lets a site that legitimately runs a
// bigger h1 on its landing-style templates than on its interior pages (a
// real, confirmed design decision on THIS site, never a rule carried over
// from another tenant) stay unflagged, while a template with too few sampled
// pages of its own still gets checked against something.
export function findFontSizeOutliers(pages) {
  const byTag = new Map(); // tag -> [{url, pageType, sample}]
  const push = (tag, url, pageType, sample) => {
    if (!byTag.has(tag)) byTag.set(tag, []);
    byTag.get(tag).push({ url, pageType, sample });
  };
  for (const p of pages || []) {
    const pageType = p.pageType || null;
    for (const h of p.headings || []) push(h.tag, p.url, pageType, h);
    for (const para of p.paragraphs || []) push('p', p.url, pageType, para);
  }

  const outliers = [];
  for (const [group, entries] of byTag) {
    const siteMode = computeMode(entries);

    const byType = new Map();
    for (const e of entries) {
      const key = e.pageType || '__unknown__';
      if (!byType.has(key)) byType.set(key, []);
      byType.get(key).push(e);
    }

    for (const [pageType, typeEntries] of byType) {
      const typeMode = computeMode(typeEntries);
      const expected = typeMode || siteMode;
      if (!expected) continue;
      const scope = typeMode ? 'template' : 'site';
      const poolEntries = typeMode ? typeEntries : entries;
      for (const e of typeEntries) {
        if (e.sample.fontSize !== expected) {
          const siteConvention = modeClassesForFontSize(poolEntries, expected);
          const resolvedConvention = siteConvention && !sameClassTokens(e.sample.classes, siteConvention) ? siteConvention : null;
          // The scoped-selector fix only ever applies where the class-swap
          // fix genuinely cannot: the element itself carries no class at all
          // (styled purely via an ancestor wrapper + tag selector), so there
          // is nothing for modeClassesForFontSize/swapAnchorClass to act on.
          // Only offered when this run's own evidence already proves BOTH
          // that the ancestor wrapper class is unique to this one page, AND
          // that the real authored declaration (captured alongside the
          // computed value — see font-consistency-capture.js) is a plain
          // length, not a fluid/responsive expression (clamp()/vw/calc()) —
          // flattening one of those would require inventing new responsive
          // bounds nobody has evidenced, so it stays genuinely unfixable,
          // not merely undetected.
          const pageScoped = !resolvedConvention && !e.sample.classes && e.sample.ancestorClass
            && ancestorClassIsPageUnique(entries, e);
          const rawDeclaration = e.sample.rawFontSizeDeclaration;
          const scopedSelector = pageScoped && rawDeclaration && isFlatLength(rawDeclaration)
            ? { ancestorClass: e.sample.ancestorClass, tag: group }
            : null;
          // Surfaced even when NOT fixable, so the reportOnly reason can
          // name the real, specific cause (a page-scoped fluid expression)
          // instead of the generic "shared CSS, ask a human" text this used
          // to give regardless of the actual reason.
          const scopedButFluid = pageScoped && rawDeclaration && !isFlatLength(rawDeclaration) ? rawDeclaration : null;
          outliers.push({
            group,
            pageType: pageType === '__unknown__' ? null : pageType,
            scope,
            url: e.url,
            expectedFontSize: expected,
            actualFontSize: e.sample.fontSize,
            // null when the outlier's own classes already token-match the
            // resolved convention (or there's nothing to compare) — a
            // class-swap fix would be a no-op, so this stays unfixable by
            // class, same as before.
            siteConvention: resolvedConvention,
            scopedSelector,
            scopedButFluid,
            sample: e.sample,
          });
        }
      }
    }
  }
  return outliers;
}
