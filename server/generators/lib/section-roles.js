// Know what ROLE each generated section plays — hero, cta, faq, etc. — so a
// draft's structure can be compared with the site's real pages.
//
// The site's canonical templates describe pages as an ORDER of roles
// ("hero -> content -> faq -> cta"), but a generated section is just a
// heading and a body of free text. This is the bridge. It is deliberately
// keyword-based and CONSERVATIVE: a section it cannot place is 'content',
// never a guessed specific role, because a wrongly-assigned role would make a
// correct draft look out of order. Position also counts — a hero can only be
// first, a closing cta only last.

const RULES = [
  ['faq', /\b(faq|faqs|frequently asked|common questions|questions? (and|&) answers?|q&a)\b/i],
  ['cta', /\b(get started|get in touch|contact us|book (a|your)|schedule|request (a|your)|sign up|start (your|a|now)|talk to|call us|apply now|free (trial|consultation|quote)|ready to)\b/i],
  ['testimonials', /\b(testimonials?|what (our )?(clients?|customers?|students?) say|reviews?|success stor(y|ies))\b/i],
  ['pricing', /\b(pricing|plans?|packages?|cost|fees?)\b/i],
  ['features', /\b(features?|benefits?|why (choose|us)|what (you|we) (get|offer)|how it works|our (services?|process))\b/i],
];

// Roles a section is only ever plausibly playing at one end of the page.
const OPENING_ONLY = new Set(['hero']);
const CLOSING_PREFERRED = new Set(['cta']);

export function classifySectionRole(section, { index = 0, total = 1 } = {}) {
  const heading = String(section?.heading || '');
  const body = String(section?.body || '');
  // The first section of a page that has a title block above it is the hero
  // only when it is short and punchy; a long body is real content.
  if (index === 0 && total > 1 && body.length < 280 && !/\n/.test(body.trim())) return 'hero';

  for (const [role, re] of RULES) {
    // Heading carries the signal; body is only consulted for a cta, whose
    // tell is often an imperative in the closing line.
    if (re.test(heading) || (role === 'cta' && index === total - 1 && re.test(body.slice(-200)))) {
      if (OPENING_ONLY.has(role) && index !== 0) continue;
      return role;
    }
  }
  return 'content';
}

export function rolesOf(sections) {
  const list = Array.isArray(sections) ? sections : [];
  return list.map((s, i) => classifySectionRole(s, { index: i, total: list.length }));
}

// `expected` is the canonical sectionOrder, which holds role names from the
// capture side. They are normalised onto this vocabulary; anything unknown
// is treated as 'content' so an unfamiliar capture label cannot make every
// draft fail.
const ALIASES = { header: 'hero', banner: 'hero', content: 'content', body: 'content', text: 'content', faq: 'faq', cta: 'cta', 'call-to-action': 'cta', testimonials: 'testimonials', pricing: 'pricing', features: 'features', footer: null, nav: null };

export function normalizeExpectedRoles(sectionOrder) {
  return (Array.isArray(sectionOrder) ? sectionOrder : [])
    .map((r) => { const k = String(r).toLowerCase(); return k in ALIASES ? ALIASES[k] : 'content'; })
    .filter(Boolean);
}

// Subsequence, not equality: a real topic may legitimately add or drop
// sections, so the test is that the SPECIFIC roles the draft has (anything
// but 'content') appear in the same relative order as in the site's own
// pages — a CTA before the FAQ on a site that always closes with the CTA is
// out of order; an extra content section is not.
export function orderIssues(draftRoles, expectedRoles) {
  const specific = (r) => r !== 'content';
  const exp = expectedRoles.filter(specific);
  const issues = [];
  let cursor = -1;
  for (const role of draftRoles.filter(specific)) {
    const at = exp.indexOf(role, cursor + 1);
    if (at === -1) {
      // Not found after the cursor: either absent from the site's pattern
      // (not our concern) or out of order.
      if (exp.includes(role)) issues.push({ role, kind: 'out-of-order' });
      continue;
    }
    cursor = at;
  }
  // A role the site's pages ALWAYS have and the draft lacks entirely.
  const missing = [...new Set(exp)].filter((r) => !draftRoles.includes(r));
  return { outOfOrder: issues, missing };
}

export function isStructureOrderCheckEnabled(env = process.env) {
  return env.STRUCTURE_ORDER_CHECK === 'true';
}
