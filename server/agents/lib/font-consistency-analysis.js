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

// A font-size utility token (text-xl, text-[28px], md:text-[36px]) — what a
// component's classes say about HOW BIG it is, as opposed to what it IS.
const SIZE_TOKEN_RE = /^(?:[a-z0-9-]+:)*text-(?:xs|sm|base|lg|xl|\d+xl|\[[\d.]+(?:px|rem|em)\])$/i;
const RESPONSIVE_SIZE_TOKEN_RE = /^[a-z0-9-]+:.*text-(?:xs|sm|base|lg|xl|\d+xl|\[[\d.]+(?:px|rem|em)\])$/i;

function classTokenList(classes) {
  return (classes || '').trim().split(/\s+/).filter(Boolean);
}

// True when the element's own classes set a size per breakpoint. One
// getComputedStyle snapshot (a single viewport) cannot say what such an
// element is supposed to render at, so it is never judged by that snapshot.
function hasResponsiveSizeClass(classes) {
  return classTokenList(classes).some((t) => RESPONSIVE_SIZE_TOKEN_RE.test(t));
}

// Visually hidden text (sr-only / display:none) has no rendered size a
// visitor sees — comparing it to visible headings is always a false positive.
function isHiddenSample(sample) {
  return sample.srOnly === true || sample.hidden === true
    || classTokenList(sample.classes).some((t) => t === 'sr-only' || t === 'hidden' || t === 'invisible');
}

function isHeroSample(tag, sample) {
  return tag === 'h1' || sample.landmark === 'header'
    || /hero|banner/i.test(`${sample.classes || ''} ${sample.ancestorClass || ''}`);
}

// What COMPONENT an element is, independent of how big it is: tag + the
// landmark it sits in (footer/nav/aside/main/...) + its classes with the
// font-size tokens removed. A bare element (no classes) is identified by its
// nearest classed ancestor instead. A footer h4 and a card h4 therefore never
// share a key, and neither do a hero paragraph and a caption.
function componentKey(tag, sample) {
  const rest = classTokenList(sample.classes).filter((t) => !SIZE_TOKEN_RE.test(t)).sort().join(' ');
  const scope = rest || `@${sample.ancestorClass || ''}`;
  return `${tag}|${sample.landmark || ''}|${scope}`;
}

// Groups real captured samples (from font-consistency-capture.js) by
// COMPONENT (componentKey) — same tag, same landmark, same non-size classes —
// then checks a sample against the real majority of its OWN page-type/
// template within that component. There is deliberately NO sitewide fallback:
// a template with too few sampled pages of its own has no evidence of what it
// is supposed to look like, and "the rest of the site is different" is
// exactly how a deliberately larger homepage h1, or a footer h4 vs. a card
// h4, used to be reported as defects (177 + 219 false outliers audited
// 2026-09-30). Thin evidence abstains.
export function findFontSizeOutliers(pages) {
  const byComponent = new Map(); // componentKey -> {tag, entries:[{url, pageType, sample}]}
  const push = (tag, url, pageType, sample) => {
    if (!sample || isHiddenSample(sample)) return;
    const key = componentKey(tag, sample);
    if (!byComponent.has(key)) byComponent.set(key, { tag, entries: [] });
    byComponent.get(key).entries.push({ url, pageType, sample });
  };
  for (const p of pages || []) {
    const pageType = p.pageType || null;
    for (const h of p.headings || []) push(h.tag, p.url, pageType, h);
    for (const para of p.paragraphs || []) push('p', p.url, pageType, para);
  }

  const outliers = [];
  for (const { tag: group, entries } of byComponent.values()) {
    const byType = new Map();
    for (const e of entries) {
      const key = e.pageType || '__unknown__';
      if (!byType.has(key)) byType.set(key, []);
      byType.get(key).push(e);
    }

    for (const [pageType, typeEntries] of byType) {
      const expected = computeMode(typeEntries);
      if (!expected) continue;
      for (const e of typeEntries) {
        if (e.sample.fontSize === expected) continue;
        const inlineOverride = hasInlineFontSizeOverride(e.sample.outerHtml);
        // A responsive element is only ever judged when an inline style
        // proves a one-element override; otherwise one viewport's computed
        // size says nothing about the authored responsive design.
        if (!inlineOverride && hasResponsiveSizeClass(e.sample.classes)) continue;
        const siteConvention = modeClassesForFontSize(typeEntries, expected);
        // A class swap is only offered when it is the SAME component (the
        // key guarantees it), nobody on either side sizes it per breakpoint,
        // and it is not a hero element — a hero's size is a deliberate
        // design decision, never something to be normalised by a detector.
        const swapSafe = siteConvention && !hasResponsiveSizeClass(siteConvention)
          && !isHeroSample(group, e.sample) && !sameClassTokens(e.sample.classes, siteConvention);
        const resolvedConvention = swapSafe ? siteConvention : null;
        // The page-scoped ancestor-selector fix (buildScopedFontSizeFix) is
        // never offered from here any more: an element is only ever compared
        // to others under the SAME ancestor wrapper (componentKey), so a
        // wrapper class "unique to this one page" can no longer be shown to
        // be the odd one out, and a bare hero h1 must not be normalised.
        // The fields stay on the outlier shape for font-consistency.js.
        outliers.push({
          group,
          pageType: pageType === '__unknown__' ? null : pageType,
          scope: 'template',
          url: e.url,
          expectedFontSize: expected,
          actualFontSize: e.sample.fontSize,
          // null when a class swap is not provably safe (responsive,
          // hero, or the outlier already carries the convention's classes).
          siteConvention: resolvedConvention,
          scopedSelector: null,
          scopedButFluid: null,
          sample: e.sample,
        });
      }
    }
  }
  return outliers;
}
