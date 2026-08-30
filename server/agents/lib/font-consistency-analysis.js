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

const MIN_DISTINCT_PAGES = 3;
const MIN_MODE_SHARE = 0.6;

// Groups real captured samples (from font-consistency-capture.js) by real
// role — one group per heading level (h1/h2/h3/h4), one group for body
// paragraphs — then flags any sample whose real computed font-size differs
// from that group's real majority value. Two guards against false
// positives on a site that genuinely varies size by design:
//   - a group needs samples from at least MIN_DISTINCT_PAGES different
//     pages before it says anything at all (several paragraphs on ONE page
//     sharing a size proves nothing about site-wide consistency);
//   - the majority value must actually BE a majority (>=60% of samples) —
//     a group with no dominant size is read as "this site intentionally
//     varies this," not as everyone-but-one being wrong.
export function findFontSizeOutliers(pages) {
  const groups = new Map(); // group key -> [{url, sample}]
  const push = (key, url, sample) => {
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ url, sample });
  };
  for (const p of pages || []) {
    for (const h of p.headings || []) push(h.tag, p.url, h);
    for (const para of p.paragraphs || []) push('p', p.url, para);
  }

  const outliers = [];
  for (const [group, entries] of groups) {
    const distinctPages = new Set(entries.map((e) => e.url));
    if (distinctPages.size < MIN_DISTINCT_PAGES) continue;
    const counts = new Map();
    for (const e of entries) counts.set(e.sample.fontSize, (counts.get(e.sample.fontSize) || 0) + 1);
    const [modeSize, modeCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (modeCount / entries.length < MIN_MODE_SHARE) continue;
    for (const e of entries) {
      if (e.sample.fontSize !== modeSize) {
        outliers.push({ group, url: e.url, expectedFontSize: modeSize, actualFontSize: e.sample.fontSize, sample: e.sample });
      }
    }
  }
  return outliers;
}
