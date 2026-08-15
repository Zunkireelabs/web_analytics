// Catches an LLM inventing a third-party service, cookie, or contact detail
// in a legal-content draft (cookie-policy/privacy-policy/terms-of-service)
// that isn't backed by this draft's own `content.factsUsed` (see
// compliance-draft.js's generateCompliancePage — siteName, domain,
// cookiesObserved, trackersDetected). The generator's system prompt already
// instructs the model not to invent facts, but that's trust-the-model, not
// enforced — this is the programmatic check that makes it safe to auto-ship
// unattended (server/agents/lib/risk-tiers.js).
//
// Deliberately conservative in the direction of false positives: an
// unmatched proper-noun flag just means the draft stays open for a human
// glance (the same outcome as any other Quality Gate failure), which is the
// safe failure direction. A missed fabrication publishing unreviewed is the
// real risk, so KNOWN_SERVICE_NAMES below is intentionally broad rather than
// narrow.

// Common analytics/ads/support/marketing services that show up in cookie
// and privacy policies. Not a vocabulary of "every possible SaaS product" —
// just the ones plausible enough for an LLM to invent as a guess at what a
// generic site "probably" uses.
const KNOWN_SERVICE_NAMES = [
  'Google Analytics', 'Google Ads', 'Google Tag Manager', 'Google AdSense',
  'Meta Pixel', 'Facebook Pixel', 'Facebook Ads', 'Instagram',
  'Stripe', 'PayPal', 'Mailchimp', 'HubSpot', 'Hotjar', 'Intercom',
  'Zendesk', 'Salesforce', 'Segment', 'Amplitude', 'Mixpanel',
  'Cloudflare', 'AWS', 'Amazon Web Services', 'Microsoft Clarity',
  'LinkedIn Insight', 'TikTok Pixel', 'Twitter Ads', 'X Ads',
];

// Contact-style data (email, phone, street address) is exactly the kind of
// site-specific claim the generator's prompt says must come only from real
// facts — none of these forms exist in the whitelist below unless a real
// email/phone happens to be embedded in siteName/domain, so any mention at
// all is worth a human glance rather than trying to whitelist "the right"
// contact details (which this guard has no source of truth for).
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const PHONE_RE = /(?:\+?\d[\d\s().-]{7,}\d)/g;

function normalize(s) {
  return (s || '').toString().toLowerCase();
}

function buildWhitelist(factsUsed) {
  const allowed = new Set();
  const add = (v) => { if (v) allowed.add(normalize(v)); };
  add(factsUsed?.siteName);
  add(factsUsed?.domain);
  for (const c of factsUsed?.cookiesObserved || []) add(c?.name || c);
  for (const t of factsUsed?.trackersDetected || []) add(t?.name || t);
  return allowed;
}

function isWhitelisted(name, whitelist) {
  const n = normalize(name);
  for (const allowed of whitelist) {
    if (allowed && (n.includes(allowed) || allowed.includes(n))) return true;
  }
  return false;
}

function sectionText(content) {
  const parts = [content?.headline, ...(content?.sections || []).flatMap((s) => [s?.heading, s?.body])];
  return parts.filter(Boolean).join('\n');
}

export function findUnverifiedLegalClaims(content) {
  const issues = [];
  if (!content || typeof content !== 'object') return issues;
  const text = sectionText(content);
  if (!text) return issues;
  const whitelist = buildWhitelist(content.factsUsed);

  for (const service of KNOWN_SERVICE_NAMES) {
    if (!text.toLowerCase().includes(service.toLowerCase())) continue;
    if (isWhitelisted(service, whitelist)) continue;
    issues.push({
      path: 'content', patternId: 'unverified-legal-claim',
      snippet: `"${service}" is mentioned but isn't in this draft's detected cookies/trackers`,
    });
  }

  for (const match of text.match(EMAIL_RE) || []) {
    if (isWhitelisted(match, whitelist)) continue;
    issues.push({ path: 'content', patternId: 'unverified-legal-claim', snippet: `Email address "${match}" isn't a known site fact` });
  }
  for (const match of text.match(PHONE_RE) || []) {
    // A plain date (e.g. an "effective as of 2026-08-15" line, which every
    // policy legitimately has) matches the same digits-and-separators
    // shape as a phone number — require enough real digits to rule that
    // out (a date has 8, a phone number has 9+).
    if ((match.match(/\d/g) || []).length < 9) continue;
    if (isWhitelisted(match, whitelist)) continue;
    issues.push({ path: 'content', patternId: 'unverified-legal-claim', snippet: `Phone number "${match}" isn't a known site fact` });
  }

  return issues;
}
