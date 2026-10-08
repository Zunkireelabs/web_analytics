// True when every variant in a duplicate group already declares the SAME
// canonical URL, i.e. the group is consolidated and there is nothing for a
// person (or a generator) to do. The duplicate detectors used to check this
// only when a traffic winner existed; a group with no winner (e.g. several
// ?position=... variants and no clean URL among them) fell through to a
// "needs a person to confirm whether these already canonicalize correctly"
// report even though the probe data to answer that was already in hand.
//
// A variant with no canonical tag, or a canonical naming a different URL than
// its siblings, means the group is NOT consolidated.
export function allShareCanonical(pages, probeByPage, normalize = (u) => String(u)) {
  if (!Array.isArray(pages) || pages.length < 2) return false;
  let target = null;
  for (const p of pages) {
    const canonical = probeByPage.get(p)?.canonical;
    if (!canonical) return false;
    const n = normalize(canonical);
    if (target === null) target = n;
    else if (n !== target) return false;
  }
  return true;
}
