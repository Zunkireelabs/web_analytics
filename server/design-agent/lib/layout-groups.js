// Look up a page's REAL design from the saved layout survey (profile.layoutGroups,
// written by live-analysis/layout-survey.js + the capture).
//
// The survey fetched every known page, grouped the pages that share a template,
// and the capture opened one sample per group in a browser; that sample's
// sections (with the classes the page really renders) are stored in
// profile.pages. So for any page in a group, "what does this page's design
// use" has a grounded answer: what its group's sample shows. This is more
// exact than the page-TYPE summary (pageTypePatterns), which treats every
// /blog/ URL as one template even when a post is built differently.
//
// Nothing here invents a class. See groupObservedClass for the three possible
// answers; callers keep their existing behaviour when there is no grounded one.

const CHROME_ROLES = new Set(['header', 'nav', 'footer']);

function pathKey(url) {
  try {
    const u = new URL(url, 'https://placeholder.invalid');
    return (u.pathname.replace(/\/index\.html?$/i, '').replace(/\/+$/, '') || '/') + u.search;
  } catch { return null; }
}

export function layoutGroupFor(profile, pageUrl) {
  const groups = profile?.layoutGroups?.groups;
  const key = pageUrl ? pathKey(pageUrl) : null;
  if (!Array.isArray(groups) || !key) return null;
  return groups.find((g) => Array.isArray(g.members) && g.members.some((m) => pathKey(m) === key)) || null;
}

export function groupSamplePage(profile, pageUrl) {
  const group = layoutGroupFor(profile, pageUrl);
  // A page in a saved group is shown by its group's sample. A page that was
  // itself captured (reached by crawl, so not in the survey's list) is shown
  // by its own captured layout.
  const key = group ? pathKey(group.sample) : pathKey(pageUrl);
  if (!key) return null;
  return (profile?.pages || []).find((p) => pathKey(p.url) === key) || null;
}

function isLabelStyle(style) {
  return !!style && (style.textTransform === 'uppercase' || /^0\.[1-9]/.test(String(style.letterSpacing || '').replace('em', '')));
}

// What the page's real design shows for `role` (default: an in-content
// subheading), read from its group sample's own content sections (site chrome
// and label-styled text excluded):
//   - a class string  -> the class most often observed for that role
//   - null            -> the role WAS observed on the sample but carries no
//                        class: its real design is plain, inheriting the
//                        page's own prose styling (common for blog posts)
//   - undefined       -> no grounded answer (page not in a group / not
//                        captured / role never observed); callers keep their
//                        existing fallback
export function groupObservedClass(profile, pageUrl, role = 'subheading') {
  const sample = groupSamplePage(profile, pageUrl);
  if (!sample) return undefined;
  const counts = new Map();
  let observed = 0;
  for (const section of sample.sections || []) {
    if (CHROME_ROLES.has(section.role)) continue;
    for (const item of section.textHierarchy || []) {
      if (item.role !== role || isLabelStyle(item.style)) continue;
      observed++;
      if (item.classes) counts.set(item.classes, (counts.get(item.classes) || 0) + 1);
    }
  }
  if (!observed) return undefined;
  let best = null; let top = 0;
  for (const [cls, n] of counts) if (n > top) { best = cls; top = n; }
  return best; // null when every observed instance is unstyled
}
