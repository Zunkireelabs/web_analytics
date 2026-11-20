// Competitor CATEGORY validation: is this candidate domain the kind of site that can be a business competitor at all?
//
// Discovery names candidates from search rankings and model recall. Neither can tell a rival from a site that merely ranks for the
// same searches: a government ministry or an embassy for a study-abroad business, a directory or review site, a marketplace that lists
// the competitors, a news publisher, a social platform, a university (a customer's destination, not a competitor). Until now only a
// 22-domain platform list was checked, so those got stored as "real, configured business competitors" and were shown to the model as such.
//
// Deterministic by design (no model call): every verdict comes with the reasons that produced it, so a person can see why a domain was
// excluded and a wrong exclusion can be corrected. A kind is only EXCLUDED when the project's own business does not make it a rival: a
// directory is a competitor of a directory business, a school of another school.
//
// This module stands alone (no imports from the other competitor modules) so discovery, the classifier and the readers can all use it
// without a circular dependency.

export const KINDS = Object.freeze(['government', 'embassy', 'institution', 'directory', 'review-site', 'marketplace', 'news-media', 'social-platform']);

// Domains that list, review or publish about other businesses, grouped by what they are. Matched as the domain or any subdomain.
const DOMAINS = {
  directory: [
    'techbehemoths.com', 'clutch.co', 'goodfirms.co', 'designrush.com', 'themanifest.com', 'sortlist.com', 'topdevelopers.co',
    'appfutura.com', 'sourceforge.net', 'slashdot.org', 'yellowpages.com', 'justdial.com', 'sulekha.com', 'bbb.org',
    'crunchbase.com', 'producthunt.com', 'housingcare.org', 'upwork.com', 'fiverr.com', 'indeed.com', 'glassdoor.com',
  ],
  'review-site': ['g2.com', 'capterra.com', 'softwareadvice.com', 'getapp.com', 'trustpilot.com', 'trustradius.com', 'yelp.com', 'tripadvisor.com', 'reviews.io'],
  marketplace: ['amazon.com', 'ebay.com', 'etsy.com', 'booking.com', 'airbnb.com', 'expedia.com', 'makemytrip.com', 'anyvan.com', 'reallymoving.com', 'shiply.com', 'airtasker.com', 'thumbtack.com', 'angi.com', 'houzz.com', 'zomato.com', 'swiggy.com'],
  'news-media': ['forbes.com', 'bbc.com', 'bbc.co.uk', 'cnn.com', 'nytimes.com', 'theguardian.com', 'techcrunch.com', 'businessinsider.com', 'medium.com', 'quora.com', 'wikipedia.org'],
  'social-platform': ['facebook.com', 'instagram.com', 'linkedin.com', 'twitter.com', 'x.com', 'youtube.com', 'tiktok.com', 'pinterest.com', 'reddit.com', 'github.com', 'gitlab.com'],
};

const GOV_TLD = /(^|\.)(gov|mil)(\.[a-z]{2})?$|\.(go|gob|gouv|govt|nic)\.[a-z]{2}$/;
// Only registries restricted to accredited institutions prove a school: .edu (US) and .ac.uk (UK). Country-level edu.xx / ac.xx domains
// are NOT proof: Nepal's edu.np, for one, is used by study-abroad consultancies (kiec.edu.np). Those need the homepage's own words.
const EDU_TLD = /(^|\.)edu$|\.ac\.uk$/;
const EMBASSY_NAME = /(embassy|consulate|highcommission|embkathmandu)/;

// What a site says about itself.
const GOV_TEXT = /(ministry of|government of|embassy of|high commission|department of (education|state|immigration|home)|consulate (general )?of|republic of [a-z ]+ (ministry|government))/i;
const EMBASSY_TEXT = /(embassy of|high commission of|consulate (general )?of)/i;
const LISTING_PHRASES = ['directory', 'listings', 'compare quotes', 'compare prices', 'find a ', 'browse ', 'marketplace', 'reviews of', 'top 10 best', 'read reviews', 'classifieds', 'advertise with us', 'list your business'];

const host = (raw) => {
  const d = String(raw || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) ? d : null;
};
const inList = (d, list) => list.some((x) => d === x || d.endsWith(`.${x}`));

// What kind of site is this? { kind, confidence, reasons } with kind null when nothing says it is not a business.
// Domain evidence is 'high'; evidence from the homepage's own words is 'medium'.
export function classifyCandidateKind(domain, homepage = {}) {
  const d = host(domain);
  if (!d) return { kind: null, confidence: 'none', reasons: [] };

  if (GOV_TLD.test(d)) return { kind: EMBASSY_NAME.test(d.replace(/[.-]/g, '')) ? 'embassy' : 'government', confidence: 'high', reasons: [`${d} is on a government domain`] };
  if (EMBASSY_NAME.test(d.replace(/[.-]/g, ''))) return { kind: 'embassy', confidence: 'high', reasons: [`${d} names an embassy or consulate`] };
  for (const kind of ['social-platform', 'news-media', 'review-site', 'marketplace', 'directory']) {
    if (inList(d, DOMAINS[kind])) return { kind, confidence: 'high', reasons: [`${d} is a known ${kind.replace('-', ' ')}`] };
  }
  if (EDU_TLD.test(d)) return { kind: 'institution', confidence: 'high', reasons: [`${d} is an educational institution's domain`] };

  const text = [homepage.title, homepage.metaDescription, String(homepage.text || '').slice(0, 1500)].filter(Boolean).join(' ');
  if (text) {
    if (EMBASSY_TEXT.test(text)) return { kind: 'embassy', confidence: 'medium', reasons: ['its homepage describes an embassy, consulate or high commission'] };
    if (GOV_TEXT.test(text)) return { kind: 'government', confidence: 'medium', reasons: ['its homepage describes a ministry or government body'] };
    const lower = text.toLowerCase();
    const hits = LISTING_PHRASES.filter((p) => lower.includes(p));
    if (hits.length >= 2) return { kind: 'directory', confidence: 'medium', reasons: [`its homepage describes itself as a listing site (${hits.slice(0, 3).join(', ')})`] };
  }
  return { kind: null, confidence: 'none', reasons: [] };
}

const EXCLUDE_WORDS = [
  [/direct/i, 'directory'], [/review/i, 'review-site'], [/market ?place|aggregator|comparison/i, 'marketplace'], [/news|media|publish|blog/i, 'news-media'],
  [/government|ministr|public sector|official/i, 'government'], [/embass|consulate/i, 'embassy'], [/universit|college|school|institution|academ/i, 'institution'], [/social/i, 'social-platform'],
];

// Which kinds are excluded for THIS business. Starts from the defaults, adds what the profile says does not compete, and removes the
// kinds the business itself IS (a directory business competes with directories; a school with other schools).
export function excludedKindsFor(profile) {
  const out = new Set(['government', 'embassy', 'directory', 'review-site', 'marketplace', 'news-media', 'social-platform', 'institution']);
  const f = profile?.fields || {};
  for (const phrase of f.competitorCategories?.value?.exclude || []) for (const [re, kind] of EXCLUDE_WORDS) if (re.test(phrase)) out.add(kind);
  const own = String(f.ownIndustry?.value?.label || '').toLowerCase();
  const model = f.businessModel?.value?.model;
  if (model === 'marketplace' || /(directory|marketplace|listing|review|comparison)/.test(own)) { out.delete('directory'); out.delete('marketplace'); out.delete('review-site'); }
  if (/(school|university|college|academy|training provider|education provider)/.test(own)) out.delete('institution');
  if (/(news|media|publish)/.test(own) || model === 'publisher') out.delete('news-media');
  return out;
}

// The single decision discovery and the readers use. { excluded, kind, confidence, reasons }.
export function validateCompetitorCandidate(domain, homepage = {}, profile = null) {
  const c = classifyCandidateKind(domain, homepage);
  if (!c.kind) return { excluded: false, kind: null, confidence: c.confidence, reasons: [] };
  const excluded = excludedKindsFor(profile).has(c.kind);
  return { excluded, kind: c.kind, confidence: c.confidence, reasons: excluded ? c.reasons : [...c.reasons, `${c.kind} is not excluded for this business`] };
}

// For discovery: split a list of candidate domains by what the DOMAIN alone proves, before any page is fetched or any model is paid for.
export function splitByDomainKind(domains, profile = null) {
  const keep = []; const excluded = [];
  for (const d of domains) {
    const v = validateCompetitorCandidate(d, {}, profile);
    if (v.excluded && v.confidence === 'high') excluded.push({ domain: d, ...v }); else keep.push(d);
  }
  return { keep, excluded };
}
