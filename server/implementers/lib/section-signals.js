// WHAT THIS SITE CALLS ITS OWN FAQ AND CALL-TO-ACTION SECTIONS, learned from its captured pages.
//
// expand-placement.js puts a new block above a page's trailing FAQ / call to action, and it recognises those by generic words ("FAQ", "Get started", "Contact us", "Book a …").
// A site that words them differently (a closing banner called `closing-banner`, a heading "Let's talk about your move") was not recognised, so the block stayed at the end of the
// content area, which can sit below the call to action. The design profile already records every captured section with its role (faq, cta, content, hero, footer …), its class
// names and its headings, so the site's own words are known. This reads them.
//
// A word is taken only when it is distinctive: it appears on that role's sections on at least two pages and NEVER on an ordinary content, hero, header, footer or pricing section,
// so a utility class (`px-4`, `py-12`) that every section shares can never become a signal. Navigation, menus and overlays are never a call to action (a captured mega-menu was
// tagged "cta"), so their words are refused. Pure: takes the profile, returns { faq: RegExp|null, cta: RegExp|null }.

const ROLES = ['faq', 'cta'];
const NEVER_SIGNAL_ROLES = new Set(['content', 'hero', 'header', 'nav', 'footer', 'pricing', 'team', 'testimonials', 'gallery', 'logos', 'features']);
const NOT_A_SECTION = /nav|menu|mega|dropdown|drawer|modal|popup|cookie|banner-top|search|breadcrumb|skip|toast|tooltip|header|footer|sidebar|widget|legal|terms|privacy|policy|(?:^|[-_])(?:mm|dd|nv)(?:[-_]|$)/i;
// A heading that introduces related reading is a related-guides block, not a call to action.
const RELATED_HEADING = /related|insights?|articles?|posts?|guides?|read (?:next|more)|more from|you may also|latest/i;
const UTILITY = /^(?:-?[a-z0-9]+:|-?[a-z]+-\[|-?[a-z]+-\d|-?\d)|^(?:flex|grid|block|inline|hidden|relative|absolute|fixed|container|wrapper|section|row|col|text|bg|border|rounded|shadow|font|w|h|p|m|px|py|pt|pb|mx|my|gap|space|items|justify|overflow)$/i;
const MIN_PAGES = 2;

const tokensOf = (classes) => String(classes || '').split(/\s+/).filter(Boolean);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').replace(/[?!.:]+$/, '').trim();

function headingsOf(section) {
  return (section?.textHierarchy || [])
    .filter((h) => /^h[1-3]$/i.test(h?.tag || '') && (h.text || h.t))
    .map((h) => norm(h.text || h.t))
    .filter((t) => t.length >= 4 && t.length <= 60);
}

export function learnSectionSignals(profile) {
  const pages = Array.isArray(profile?.pages) ? profile.pages : [];
  if (!pages.length) return { faq: null, cta: null };

  const seen = { faq: { tokens: new Map(), headings: new Map() }, cta: { tokens: new Map(), headings: new Map() } };
  const ordinaryTokens = new Set();
  const ordinaryHeadings = new Set();
  const note = (map, key, url) => { if (!map.has(key)) map.set(key, new Set()); map.get(key).add(url); };

  for (const pg of pages) {
    const url = pg?.url || '';
    for (const sec of pg?.sections || []) {
      const role = String(sec?.role || '').toLowerCase();
      const own = [...tokensOf(sec?.classes), ...tokensOf(sec?.containerClasses)];
      if (ROLES.includes(role)) {
        for (const t of own) note(seen[role].tokens, t, url);
        for (const h of headingsOf(sec)) note(seen[role].headings, h, url);
      } else if (NEVER_SIGNAL_ROLES.has(role) || role) {
        for (const t of own) ordinaryTokens.add(t);
        for (const h of headingsOf(sec)) ordinaryHeadings.add(h);
      }
    }
  }

  const build = (role) => {
    const tokens = [...seen[role].tokens].filter(([t, urls]) => urls.size >= MIN_PAGES && t.length >= 4 && !ordinaryTokens.has(t) && !UTILITY.test(t) && !NOT_A_SECTION.test(t)).map(([t]) => t);
    const headings = [...seen[role].headings].filter(([h, urls]) => urls.size >= MIN_PAGES && !ordinaryHeadings.has(h) && !NOT_A_SECTION.test(h) && !(role === 'cta' && RELATED_HEADING.test(h))).map(([h]) => h);
    const parts = [];
    // a class token matches as a whole word in a tag's attributes (hyphens are part of the word), a heading phrase anywhere in the nearest heading
    if (tokens.length) parts.push(`(?:^|[\\s"'=])(?:${tokens.map(esc).join('|')})(?=$|[\\s"'])`);
    if (headings.length) parts.push(`(?:${headings.map(esc).join('|')})`);
    return parts.length ? new RegExp(parts.join('|'), 'i') : null;
  };
  return { faq: build('faq'), cta: build('cta') };
}
